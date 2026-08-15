const query = new URLSearchParams(window.location.search)
export const frame = query.get("frame")?.trim()
export const parent = query.get("parentOrigin")?.trim()
if (!frame) throw new Error("Data preparation frame identifier is missing")
if (!parent) throw new Error("Data preparation parent origin is missing")
const origin = new URL(parent).origin
if (origin !== parent) throw new Error("Data preparation parent origin must be canonical")

export type Open = {
  type: "veritly.iframe.open"
  frame: string
  request: number
  path: string
  payload: { recipe: string }
}
export type Flush = {
  type: "veritly.iframe.flush"
  frame: string
  request: number
  path: string
}
export type FrameInvoke = {
  type: "veritly.iframe.invoke"
  frame: string
  request: number
  path: string
  method: string
  payload: unknown
}
export type Result =
  | { type: "result"; id: string; ok: true; value: unknown }
  | { type: "result"; id: string; ok: false; error: string }
export type Incoming = Open | Flush | FrameInvoke | Result

export type Ready = {
  type: "veritly.iframe.ready"
  frame: string
  methods: ["open", "flush", "invoke"]
  events: ["loaded"]
}
export type Loaded = {
  type: "veritly.iframe.loaded"
  frame: string
  request: number
  path: string
}
export type Flushed = {
  type: "veritly.iframe.flushed"
  frame: string
  request: number
  path: string
}
export type FrameResult = {
  type: "veritly.iframe.result"
  frame: string
  request: number
  path: string
  value: unknown
}
export type FrameError = {
  type: "veritly.iframe.error"
  frame: string
  request: number
  error: string
}
export type Invoke = { type: "invoke"; id: string; path: string; action: string; input?: unknown }
export type Ai = { type: "veritly.data.ai"; path: string; issues: string[] }
export type Outgoing = Ready | Loaded | Flushed | FrameResult | FrameError | Invoke | Ai

export type Preview = {
  dataset: string
  columns: Array<{
    id: string
    name: string
    type: "text" | "boolean" | "integer" | "decimal" | "date" | "timestamp"
    owner: "shared" | "workbook" | "database" | "formula" | "derived"
    nullable: boolean
    system?: boolean
    key?: boolean
  }>
  rows: Array<{ id: string; version: number; values: Record<string, unknown> }>
  total: number
  truncated: boolean
}

export function send(message: Outgoing) {
  window.parent.postMessage(message, origin)
}

export function ready() {
  send({
    type: "veritly.iframe.ready",
    frame,
    methods: ["open", "flush", "invoke"],
    events: ["loaded"],
  })
}
