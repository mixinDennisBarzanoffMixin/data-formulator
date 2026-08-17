import { afterEach, beforeAll, describe, expect, test, vi } from "vitest"
import { z } from "zod"

beforeAll(() => {
  window.history.replaceState({}, "", "/veritly/workspace?frame=dataprep%3Aproject&parentOrigin=http%3A%2F%2Flocalhost&api=http%3A%2F%2Fdata.localhost")
})

afterEach(() => vi.restoreAllMocks())

describe("Veritly preparation protocol", () => {
  test("creates secure UUIDs without randomUUID", async () => {
    const random = vi.spyOn(crypto, "getRandomValues")
    const protocol = await import("../../src/veritly/protocol")
    expect(protocol.uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(random).toHaveBeenCalledOnce()
  })

  test("accepts new opens and identifies only exact duplicates", async () => {
    const protocol = await import("../../src/veritly/protocol")
    const opens = new protocol.OpenGuard()
    const open = protocol.Open.parse({
      type: "veritly.iframe.open",
      frame: "dataprep:project",
      request: 1,
      path: "Sales.prep",
      payload: { recipe: "recipe", project: "project" },
    })
    expect(opens.accept(open)).toBe(true)
    expect(opens.accept(open)).toBe(false)
    expect(() => opens.accept({ ...open, path: "Changed.prep" })).toThrow("changed while opening")
    expect(opens.accept({ ...open, request: 2 })).toBe(true)
    expect(() => opens.accept(open)).toThrow("Stale data preparation request")
  })

  test("rejects malformed iframe messages", async () => {
    const protocol = await import("../../src/veritly/protocol")
    expect(protocol.parse({ type: "result", id: "call", ok: true }).success).toBe(false)
    expect(protocol.parse({
      type: "veritly.iframe.open",
      frame: "dataprep:project",
      request: 1,
      path: "Sales.prep",
      payload: { recipe: "recipe", project: "project" },
    }).success).toBe(true)
  })

  test("requires ranked typed workbook regions independently from styled bounds", async () => {
    const protocol = await import("../../src/veritly/protocol")
    const sheet = {
      name: "Rows",
      rows: { start: 1, end: 1_048_576 },
      columns: { start: 1, end: 16_384 },
      visibility: "visible" as const,
      regions: [{ header: 2, start: 3, end: 100, left: 2, right: 5 }],
    }
    expect(protocol.WorkbookSheet.parse(sheet).regions[0]).toEqual(sheet.regions[0])
    expect(() => protocol.WorkbookSheet.parse({ ...sheet, regions: undefined })).toThrow()
    expect(() => protocol.WorkbookSheet.parse({
      ...sheet,
      regions: [{ header: 3, start: 3, end: 100, left: 2, right: 5 }],
    })).toThrow("Recommended data rows must start after the header")
  })

  test("calls the authenticated data service directly and validates results", async () => {
    const protocol = await import("../../src/veritly/protocol")
    const fetcher = vi.spyOn(window, "fetch").mockResolvedValue(Response.json({
      id: "recipe",
      project: "project",
      path: "Sales.prep",
      schema: "sales_abcd1234",
      source: { kind: "native" },
      version: 3,
      state: "draft",
      commands: [],
      created: 1,
      updated: 1,
    }))
    const bridge = new protocol.Bridge(() => ({ path: "Sales.prep", project: "project", recipe: "recipe" }))
    await expect(bridge.invoke("inspect", undefined, z.object({ version: z.number().int().positive() }))).resolves.toEqual({ version: 3 })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0]?.[0]).toBe("http://data.localhost/project/project/api/data/preps/recipe")
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ credentials: "include" })
  })

  test.each(["replace", "append", "upsert"] as const)("publishes %s through the typed data client", async (mode) => {
    const protocol = await import("../../src/veritly/protocol")
    const fetcher = vi.spyOn(window, "fetch").mockResolvedValue(Response.json({
      id: "job",
      kind: "publish",
      state: "queued",
      progress: 0,
      created: 1,
      updated: 1,
    }))
    const bridge = new protocol.Bridge(() => ({ path: "Sales.prep", project: "project", recipe: "recipe" }))

    await expect(bridge.invoke("publish", {
      expectedVersion: 7,
      mode,
      dataset: "entity-rows",
    }, protocol.Job)).resolves.toMatchObject({ kind: "publish", state: "queued" })

    expect(fetcher.mock.calls[0]?.[0]).toBe("http://data.localhost/project/project/api/data/preps/recipe/publish")
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "POST", credentials: "include" })
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      expectedVersion: 7,
      mode,
      dataset: "entity-rows",
      overwrite: false,
    })
  })

  test("resolves a ready export to the direct authenticated content URL", async () => {
    const protocol = await import("../../src/veritly/protocol")
    const fetcher = vi.spyOn(window, "fetch").mockResolvedValue(Response.json({
      id: "export-file",
      state: "ready",
      name: "Project Data.dump",
      size: 1_024,
      hash: "a".repeat(64),
      expires: Date.now() + 60_000,
    }))
    const bridge = new protocol.Bridge(() => ({ path: "Sales.prep", project: "project", recipe: "recipe" }))

    await expect(bridge.invoke("exportFile", { export: "export-file" }, protocol.ExportFile)).resolves.toEqual({
      name: "Project Data.dump",
      url: "http://data.localhost/project/project/api/data/exports/export-file/content",
    })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0]?.[0]).toBe("http://data.localhost/project/project/api/data/exports/export-file")
  })

  test("uses a transient anchor for the browser-owned download", async () => {
    const protocol = await import("../../src/veritly/protocol")
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined)
    new protocol.BrowserSaver().save({
      name: "Project Data.dump",
      url: "http://data.localhost/project/project/api/data/exports/export-file/content",
    })
    expect(click).toHaveBeenCalledOnce()
    expect(document.querySelector('a[download="Project Data.dump"]')).toBeNull()
  })

  test("throws unsupported operations without a parent relay", async () => {
    const protocol = await import("../../src/veritly/protocol")
    const bridge = new protocol.Bridge(() => ({ path: "Sales.prep", project: "project", recipe: "recipe" }))
    expect(() => bridge.invoke("unknown", undefined, z.unknown())).toThrow("Unsupported data preparation action")
  })
})
