import { beforeAll, describe, expect, test, vi } from "vitest"

beforeAll(() => {
  window.history.replaceState({}, "", "/veritly/workspace?frame=dataprep%3Aproject&parentOrigin=http%3A%2F%2Flocalhost")
})

describe("Veritly preparation controller", () => {
  test("owns immutable navigation, range, and draft state", async () => {
    const { PrepStudio } = await import("../../src/veritly/controller")
    const model = new PrepStudio()
    const watch = vi.fn()
    const stop = model.subscribe(watch)

    const config = model.select({ sheet: "Rows", header: 2, start: 3, end: 20, columns: [2, 3], keys: ["Order ID"] })
    expect(Object.isFrozen(config)).toBe(true)
    expect(Object.isFrozen(config.columns)).toBe(true)
    expect(model.view({ ribbon: "view", detail: "issues" })).toMatchObject({ ribbon: "view", detail: "issues" })
    expect(model.draft({ Amount: "42.5" })).toEqual({ Amount: "42.5" })
    expect(() => model.view({ ribbon: "unknown" })).toThrow()
    expect(() => model.draft({ Amount: 42.5 })).toThrow()
    expect(watch).toHaveBeenCalledTimes(4)

    stop()
  })

  test("loads workbook metadata and resets bounds when worksheets change", async () => {
    const protocol = await import("../../src/veritly/protocol")
    const { PrepStudio } = await import("../../src/veritly/controller")
    const post = vi.spyOn(window, "postMessage").mockImplementation(() => undefined)
    const model = new PrepStudio()
    model.mount()

    receive({
      type: "veritly.iframe.open",
      frame: "dataprep:project",
      request: 1,
      path: "Sales.prep",
      payload: { recipe: "recipe" },
    })
    await answer(post, protocol, "inspect", {
      id: "recipe",
      project: "project",
      path: "Sales.prep",
      schema: "sales_abcd1234",
      source: { kind: "workbook", file: "file-1", path: "Sales.xlsx", revision: 4 },
      version: 1,
      state: "draft",
      commands: [],
      created: 1,
      updated: 1,
    })
    await Promise.all([
      answer(post, protocol, "project", {
        id: "project",
        state: "unprovisioned",
        quota: { used: 0, limit: 10_737_418_240, percent: 0 },
        revision: 0,
        preps: [],
      }),
      answer(post, protocol, "datasets", { datasets: [] }),
      answer(post, protocol, "issues", []),
      answer(post, protocol, "workbook", {
        file: "file-1",
        revision: 4,
        sheets: [
          {
            name: "Archive",
            rows: { start: 4, end: 70 },
            columns: { start: 7, end: 12 },
            visibility: "hidden",
            regions: [{ header: 4, start: 5, end: 7, left: 7, right: 8 }],
          },
          {
            name: "Transactions",
            rows: { start: 1, end: 1_000 },
            columns: { start: 1, end: 20 },
            visibility: "visible",
            regions: [
              { header: 2, start: 3, end: 1_000, left: 2, right: 5 },
              { header: 2, start: 3, end: 20, left: 9, right: 10 },
            ],
          },
        ],
      }),
    ])
    await vi.waitFor(() => expect(model.get().phase).toBe("ready"))

    expect(model.get().config).toEqual({
      sheet: "Transactions",
      header: 2,
      start: 3,
      end: 1_000,
      columns: [2, 3, 4, 5],
      keys: [],
    })
    expect(model.select({ ...model.get().config, sheet: "Archive" })).toEqual({
      sheet: "Archive",
      header: 4,
      start: 5,
      end: 7,
      columns: [7, 8],
      keys: [],
    })
    expect(model.select({ ...model.get().config, header: 1, start: 100, end: 100, columns: [1, 2, 3, 4, 5, 6, 7, 8, 9] })).toEqual({
      sheet: "Archive",
      header: 4,
      start: 70,
      end: 70,
      columns: [7, 8, 9],
      keys: [],
    })

    const task = model.prepare()
    await answer(post, protocol, "profile", {
      dataset: "source-rows",
      rows: 1,
      columns: [{
        column: "Code",
        type: "text",
        nulls: 0,
        distinct: 1,
        invalid: 0,
        formulas: 0,
        stale: 0,
        expressions: [],
      }],
      issues: 0,
    })
    await vi.waitFor(() => expect(invoke(post, protocol, "preview")).toBeDefined())
    const preview = invoke(post, protocol, "preview")
    if (!preview) throw new Error("Controller did not preflight the preparation output")
    expect(preview.input).toMatchObject({
      dataset: "output-command",
      draft: {
        expectedVersion: 1,
        commands: [
          { id: "source-command", kind: "source" },
          { id: "key-command", kind: "key" },
          { id: "output-command", kind: "output" },
        ],
      },
    })
    expect(invoke(post, protocol, "applyAll")).toBeUndefined()
    receive({ type: "result", id: preview.id, ok: false, error: "identity_invalid" })
    await expect(task).rejects.toThrow("identity_invalid")
    expect(invoke(post, protocol, "applyAll")).toBeUndefined()

    model.unmount()
    post.mockRestore()
  })

  test("builds typed transform steps and preserves output ownership", async () => {
    const model = await import("../../src/veritly/model")
    const prep = model.recipe(recipe())
    const trimmed = model.transform(prep, { kind: "trim", columns: ["Name"] })
    expect(trimmed.command).toEqual({
      id: "trim-2",
      kind: "trim",
      after: ["key-command"],
      input: "entity-rows",
      output: "trim-rows-2",
      columns: ["Name"],
    })
    expect(trimmed.output).toMatchObject({ id: "output-command", after: ["trim-2"], input: "trim-rows-2" })
    expect(trimmed.commands.map((command) => command.id)).toEqual([
      "source-command",
      "key-command",
      "trim-2",
      "output-command",
    ])

    const derived = model.transform(prep, { kind: "derive", name: "Margin", type: "decimal", expression: "Revenue - Cost" })
    expect(derived.output).toMatchObject({ owners: { "Order ID": "shared", Name: "shared", Margin: "derived" } })
    expect(() => model.transform(prep, { kind: "derive", name: " Name ", type: "text", expression: "Name" })).toThrow(
      "Output column already exists: Name",
    )
    expect(() => model.transform(prep, { kind: "rename", column: "Order ID", name: "Key" })).toThrow(
      "Row identity column cannot be transformed",
    )
    expect(() => model.transform(prep, { kind: "trim", columns: ["Order ID"] })).toThrow(
      "Row identity column cannot be transformed",
    )
    expect(() => model.transform(prep, { kind: "cast", column: "Order ID", type: "text", invalid: "reject" })).toThrow(
      "Row identity column cannot be transformed",
    )
  })

  test("only enables row CRUD for a persisted database dataset", async () => {
    const model = await import("../../src/veritly/model")
    const base = {
      phase: "ready" as const,
      recipe: model.recipe({ ...recipe(), state: "published", baseline: { source: 1 } }),
      config: model.blank(),
      view: model.nav(),
      draft: undefined,
      transform: undefined,
      datasets: [{
        id: "stored",
        prep: "recipe",
        project: "project",
        class: "entity" as const,
        schema: "sales_abcd1234",
        table: "sales",
        columns: [],
        keys: ["Order ID"],
        rows: 1,
        bytes: 1,
        version: 1,
      }],
      profile: undefined,
      issues: [],
      quota: undefined,
      job: undefined,
      busy: undefined,
      error: undefined,
      paging: { page: 0, pageSize: 100 as const },
    }
    const transient = model.gates({
      ...base,
      preview: { dataset: "entity-rows", columns: [], rows: [], total: 0, truncated: false },
    })
    const stored = model.gates({
      ...base,
      preview: { dataset: "stored", columns: [], rows: [], total: 1, truncated: false },
    })
    expect(transient.edit.enabled).toBe(false)
    expect(stored.edit.enabled).toBe(true)
    expect(transient.transform.enabled).toBe(true)
    expect(model.gates({ ...base, preview: { dataset: "source-rows", columns: [], rows: [], total: 1, truncated: false } }).transform.enabled).toBe(false)
  })
})

function recipe() {
  return {
    id: "recipe",
    project: "project",
    path: "Sales.prep",
    schema: "sales_abcd1234",
    source: { kind: "workbook" as const, file: "file-1", path: "Sales.xlsx", revision: 4 },
    version: 1,
    state: "ready" as const,
    commands: [
      {
        id: "source-command",
        kind: "source" as const,
        after: [],
        output: "source-rows",
        file: "file-1",
        path: "Sales.xlsx",
        revision: 4,
        sheet: "Rows",
        range: { header: 1, start: 2, end: 10, left: 1, right: 3 },
      },
      {
        id: "key-command",
        kind: "key" as const,
        after: ["source-command"],
        input: "source-rows",
        output: "entity-rows",
        key: { strategy: "existing" as const, columns: ["Order ID"] },
      },
      {
        id: "output-command",
        kind: "output" as const,
        after: ["key-command"],
        input: "entity-rows",
        schema: "sales_abcd1234",
        table: "sales",
        class: "entity" as const,
        keys: ["Order ID"],
        owners: { "Order ID": "shared" as const, Name: "shared" as const },
      },
    ],
    created: 1,
    updated: 1,
  }
}

function receive(data: unknown) {
  window.dispatchEvent(new MessageEvent("message", { data, origin: "http://localhost", source: window }))
}

async function answer(
  post: ReturnType<typeof vi.spyOn>,
  protocol: typeof import("../../src/veritly/protocol"),
  action: string,
  value: unknown,
) {
  await vi.waitFor(() => expect(invoke(post, protocol, action)).toBeDefined())
  const message = invoke(post, protocol, action)
  if (!message) throw new Error(`Controller did not invoke ${action}`)
  receive({ type: "result", id: message.id, ok: true, value })
}

function invoke(
  post: ReturnType<typeof vi.spyOn>,
  protocol: typeof import("../../src/veritly/protocol"),
  action: string,
) {
  return post.mock.calls.flatMap((call) => {
    const parsed = protocol.Outgoing.safeParse(call[0])
    if (!parsed.success || parsed.data.type !== "invoke") return []
    return [parsed.data]
  }).find((message) => message.action === action)
}
