import { afterEach, beforeAll, describe, expect, test, vi } from "vitest"
import { z } from "zod"

beforeAll(() => {
  window.history.replaceState({}, "", "/veritly/workspace?frame=dataprep%3Aproject&parentOrigin=http%3A%2F%2Flocalhost")
})

afterEach(() => vi.restoreAllMocks())

describe("Veritly preparation protocol", () => {
  test("rejects malformed iframe messages", async () => {
    const protocol = await import("../../src/veritly/protocol")
    expect(protocol.parse({ type: "result", id: "call", ok: true }).success).toBe(false)
    expect(protocol.parse({
      type: "veritly.iframe.open",
      frame: "dataprep:project",
      request: 1,
      path: "Sales.prep",
      payload: { recipe: "recipe" },
    }).success).toBe(true)
  })

  test("owns pending calls and validates results", async () => {
    const protocol = await import("../../src/veritly/protocol")
    const post = vi.spyOn(window, "postMessage").mockImplementation(() => undefined)
    const bridge = new protocol.Bridge(() => "Sales.prep")
    const result = bridge.invoke("inspect", undefined, z.object({ version: z.number().int().positive() }))
    const call = post.mock.calls[0]
    if (!call) throw new Error("Bridge did not post an invocation")
    const sent = protocol.Outgoing.parse(call[0])
    if (sent.type !== "invoke") throw new Error("Bridge did not send an invocation")
    expect(bridge.settle({ type: "result", id: sent.id, ok: true, value: { version: 3 } })).toBe(true)
    await expect(result).resolves.toEqual({ version: 3 })
  })

  test("fails pending work when the retained workspace changes", async () => {
    const protocol = await import("../../src/veritly/protocol")
    vi.spyOn(window, "postMessage").mockImplementation(() => undefined)
    const bridge = new protocol.Bridge(() => "Sales.prep")
    const result = bridge.invoke("inspect", undefined, z.object({ version: z.number() }))
    bridge.reset()
    await expect(result).rejects.toThrow("changed while a request was running")
  })
})
