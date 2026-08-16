import { beforeAll, describe, expect, test, vi } from "vitest"
import { feeds } from "./setup"

beforeAll(() => {
  window.history.replaceState({}, "", "/veritly/workspace?frame=dataprep%3Aproject&parentOrigin=http%3A%2F%2Flocalhost&api=http%3A%2F%2Fdata.localhost")
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
    const { PrepStudio } = await import("../../src/veritly/controller")
    const post = vi.spyOn(window, "postMessage").mockImplementation(() => undefined)
    const calls: { url: string; init?: RequestInit }[] = []
    const fetcher = vi.spyOn(window, "fetch").mockImplementation(async (input, init) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.endsWith("/preps/recipe") && !init?.method) return Response.json({
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
      if (url.endsWith("/project")) return Response.json({
        id: "project",
        state: "unprovisioned",
        quota: { used: 0, limit: 10_737_418_240, percent: 0 },
        revision: 0,
        preps: [],
      })
      if (url.endsWith("/datasets")) return Response.json({ datasets: [] })
      if (url.endsWith("/issues")) return Response.json({ issues: [] })
      if (url.endsWith("/workbooks")) return Response.json({
        workbooks: [{ file: "file-1", path: "Sales.xlsx", revision: 4, updated: 1 }],
      })
      if (url.endsWith("/mapping")) return Response.json({
        prep: "recipe",
        version: 1,
        state: "draft",
        source: { kind: "workbook", file: "file-1", path: "Sales.xlsx", revision: 4 },
        sources: [],
        targets: [],
      })
      if (url.endsWith("/workbook")) return Response.json({
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
          {
            name: "Empty",
            rows: { start: 1, end: 1 },
            columns: { start: 1, end: 1 },
            visibility: "visible",
            regions: [],
          },
        ],
      })
      if (url.endsWith("/profile")) return Response.json({
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
      if (url.endsWith("/preview")) return Response.json(
        { code: "identity_invalid", message: "identity_invalid" },
        { status: 409 },
      )
      throw new Error(`Unexpected data request: ${url}`)
    })
    const model = new PrepStudio()
    model.mount()

    receive({
      type: "veritly.iframe.open",
      frame: "dataprep:project",
      request: 1,
      path: "Sales.prep",
      payload: { recipe: "recipe", project: "project" },
    })
    await vi.waitFor(() => expect(model.get().phase).toBe("ready"))
    const count = calls.filter((call) => call.url.endsWith("/preps/recipe")).length
    const feed = feeds.at(-1)
    if (!feed) throw new Error("Controller did not subscribe to project data changes")
    feed.dispatchEvent(new Event("row"))
    await vi.waitFor(() => expect(calls.filter((call) => call.url.endsWith("/preps/recipe")).length).toBeGreaterThan(count))
    await vi.waitFor(() => expect(model.get().busy).toBeUndefined())

    expect(model.get().config).toEqual({
      sheet: "Transactions",
      header: 2,
      start: 3,
      end: 1_000,
      columns: [2, 3, 4, 5],
      keys: [],
    })
    expect(model.sheet("Empty")).toEqual({
      sheet: "Empty",
      header: 1,
      start: 1,
      end: 1,
      columns: [],
      keys: [],
    })
    expect(model.get().gates.prepare.enabled).toBe(false)
    expect(model.sheet("Transactions")).toEqual({
      sheet: "Transactions",
      header: 2,
      start: 3,
      end: 1_000,
      columns: [2, 3, 4, 5],
      keys: [],
    })
    expect(model.region(1)).toEqual({
      sheet: "Transactions",
      header: 2,
      start: 3,
      end: 20,
      columns: [9, 10],
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
    await expect(task).rejects.toThrow("identity_invalid")
    const preview = calls.find((call) => call.url.endsWith("/preview"))
    if (!preview?.init?.body) throw new Error("Controller did not preflight the preparation output")
    expect(JSON.parse(String(preview.init.body))).toMatchObject({
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
    expect(calls.some((call) => call.url.endsWith("/commands/batch"))).toBe(false)

    model.unmount()
    post.mockRestore()
    fetcher.mockRestore()
  })

  test("invalidates derived state only when an external recipe changes", async () => {
    const { PrepStudio } = await import("../../src/veritly/controller")
    const post = vi.spyOn(window, "postMessage").mockImplementation(() => undefined)
    const server = { wire: recipe(), reads: 0 }
    const fetcher = vi.spyOn(window, "fetch").mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith("/preps/recipe")) {
        server.reads += 1
        return Response.json(server.wire)
      }
      if (url.endsWith("/project")) return Response.json({
        id: "project",
        state: "unprovisioned",
        quota: { used: 0, limit: 10_737_418_240, percent: 0 },
        revision: 0,
        preps: [],
      })
      if (url.endsWith("/datasets")) return Response.json({ datasets: [] })
      if (url.endsWith("/issues")) return Response.json({ issues: [] })
      if (url.endsWith("/workbooks")) return Response.json({
        workbooks: [{ file: "file-1", path: "Sales.xlsx", revision: 4, updated: 1 }],
      })
      if (url.endsWith("/mapping")) return Response.json({
        prep: "recipe",
        version: server.wire.version,
        state: server.wire.state,
        source: server.wire.source,
        sources: [],
        targets: [],
      })
      if (url.endsWith("/workbook")) return Response.json({
        file: "file-1",
        revision: 4,
        sheets: [{
          name: "Rows",
          rows: { start: 1, end: 100 },
          columns: { start: 1, end: 5 },
          visibility: "visible",
          regions: [{ header: 1, start: 2, end: 100, left: 1, right: 5 }],
        }],
      })
      if (url.endsWith("/profile")) return Response.json({
        dataset: "entity-rows",
        rows: 9,
        columns: [{
          column: "Order ID",
          type: "text",
          nulls: 0,
          distinct: 9,
          invalid: 0,
          formulas: 0,
          stale: 0,
          expressions: [],
        }],
        issues: 0,
      })
      if (url.endsWith("/preview")) return Response.json({
        dataset: "entity-rows",
        columns: [],
        rows: [],
        total: 9,
        truncated: false,
      })
      throw new Error(`Unexpected data request: ${url}`)
    })
    const model = new PrepStudio()
    model.mount()

    receive({
      type: "veritly.iframe.open",
      frame: "dataprep:project",
      request: 2,
      path: "Sales.prep",
      payload: { recipe: "recipe", project: "project" },
    })
    await vi.waitFor(() => expect(model.get().phase).toBe("ready"))
    await model.profile("entity-rows")
    await model.preview({ dataset: "entity-rows", limit: 100 })
    expect(model.get().profile).toBeDefined()
    expect(model.get().preview).toBeDefined()

    server.wire = {
      ...recipe(),
      commands: recipe().commands.map((command) => command.kind === "source"
        ? { ...command, range: { ...command.range, end: 20, right: 2 } }
        : command),
    }
    const feed = feeds.at(-1)
    if (!feed) throw new Error("Controller did not subscribe to project data changes")
    feed.dispatchEvent(new Event("project"))
    await vi.waitFor(() => expect(model.get().config.end).toBe(20))
    await vi.waitFor(() => expect(model.get().busy).toBeUndefined())

    expect(model.get().recipe?.version).toBe(1)
    expect(model.get().config).toEqual({
      sheet: "Rows",
      header: 1,
      start: 2,
      end: 20,
      columns: [1, 2],
      keys: ["Order ID"],
    })
    expect(model.get().profile).toBeUndefined()
    expect(model.get().preview).toBeUndefined()

    await model.profile("entity-rows")
    await model.preview({ dataset: "entity-rows", limit: 100 })
    server.wire = { ...server.wire, version: 2 }
    feed.dispatchEvent(new Event("project"))
    await vi.waitFor(() => expect(model.get().recipe?.version).toBe(2))
    await vi.waitFor(() => expect(model.get().busy).toBeUndefined())
    expect(model.get().profile).toBeUndefined()
    expect(model.get().preview).toBeUndefined()

    await model.profile("entity-rows")
    await model.preview({ dataset: "entity-rows", limit: 100 })
    const profile = model.get().profile
    const preview = model.get().preview
    const config = model.select({ ...model.get().config, end: 18 })
    const reads = server.reads
    feed.dispatchEvent(new Event("issue"))
    await vi.waitFor(() => expect(server.reads).toBeGreaterThan(reads))
    await vi.waitFor(() => expect(model.get().busy).toBeUndefined())

    expect(model.get().config).toBe(config)
    expect(model.get().profile).toBe(profile)
    expect(model.get().preview).toBe(preview)

    model.unmount()
    post.mockRestore()
    fetcher.mockRestore()
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
