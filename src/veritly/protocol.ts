import { z } from "zod"

const Id = z.string().trim().min(1).max(256)
const Path = z.string().trim().min(1).max(1024)
const Request = z.number().int().nonnegative()
const Value = z.union([z.string(), z.number().finite(), z.boolean(), z.null()])
const Cells = z.record(z.string().trim().min(1).max(128), Value)
const ColumnType = z.enum(["text", "boolean", "integer", "decimal", "date", "timestamp"])
const ColumnOwner = z.enum(["shared", "workbook", "database", "formula", "derived"])
const Class = z.enum(["entity", "derived", "native"])

const Query = z.object({
  frame: Id,
  parentOrigin: z.string().url(),
})

const query = Query.parse(Object.fromEntries(new URLSearchParams(window.location.search)))
export const frame = query.frame
export const parent = new URL(query.parentOrigin).origin
if (parent !== query.parentOrigin) throw new Error("Data preparation parent origin must be canonical")

export const Open = z.object({
  type: z.literal("veritly.iframe.open"),
  frame: Id,
  request: Request,
  path: Path,
  payload: z.object({ recipe: Id }),
})
export type Open = z.infer<typeof Open>

export const Flush = z.object({
  type: z.literal("veritly.iframe.flush"),
  frame: Id,
  request: Request,
  path: Path,
})
export type Flush = z.infer<typeof Flush>

export const FrameInvoke = z.object({
  type: z.literal("veritly.iframe.invoke"),
  frame: Id,
  request: Request,
  path: Path,
  method: Id,
  payload: z.unknown(),
}).refine((value) => Object.hasOwn(value, "payload"), { message: "Iframe invocation payload is required" })
export type FrameInvoke = z.infer<typeof FrameInvoke>

export const Result = z.discriminatedUnion("ok", [
  z.object({ type: z.literal("result"), id: Id, ok: z.literal(true), value: z.unknown() })
    .refine((value) => Object.hasOwn(value, "value"), { message: "Invocation result value is required" }),
  z.object({ type: z.literal("result"), id: Id, ok: z.literal(false), error: z.string().min(1) }),
])
export type Result = z.infer<typeof Result>

export const Incoming = z.union([Open, Flush, FrameInvoke, Result])
export type Incoming = z.infer<typeof Incoming>

const Ready = z.object({
  type: z.literal("veritly.iframe.ready"),
  frame: Id,
  methods: z.tuple([z.literal("open"), z.literal("flush"), z.literal("invoke")]),
  events: z.tuple([z.literal("loaded")]),
})
const Loaded = z.object({
  type: z.literal("veritly.iframe.loaded"),
  frame: Id,
  request: Request,
  path: Path,
})
const Flushed = z.object({
  type: z.literal("veritly.iframe.flushed"),
  frame: Id,
  request: Request,
  path: Path,
})
const FrameResult = z.object({
  type: z.literal("veritly.iframe.result"),
  frame: Id,
  request: Request,
  path: Path,
  value: z.unknown(),
}).refine((value) => Object.hasOwn(value, "value"), { message: "Iframe result value is required" })
const FrameError = z.object({
  type: z.literal("veritly.iframe.error"),
  frame: Id,
  request: Request,
  error: z.string().min(1),
})
const Invoke = z.object({
  type: z.literal("invoke"),
  id: Id,
  path: Path,
  action: Id,
  input: z.unknown().optional(),
})
const Ai = z.object({
  type: z.literal("veritly.data.ai"),
  path: Path,
  issues: z.array(Id).max(100),
})
export const Outgoing = z.union([Ready, Loaded, Flushed, FrameResult, FrameError, Invoke, Ai])
export type Outgoing = z.infer<typeof Outgoing>

export const Column = z.object({
  id: Id,
  name: z.string().trim().min(1).max(128),
  type: ColumnType,
  owner: ColumnOwner,
  nullable: z.boolean(),
  formula: z.string().min(1).optional(),
  system: z.boolean().optional(),
  key: z.boolean().optional(),
})

export const Row = z.object({
  id: z.string().uuid(),
  version: z.number().int().nonnegative(),
  values: Cells,
})
export type Row = z.infer<typeof Row>

export const Preview = z.object({
  dataset: Id,
  columns: z.array(Column),
  rows: z.array(Row),
  total: z.number().int().nonnegative(),
  truncated: z.boolean(),
})
export type Preview = z.infer<typeof Preview>

export const Source = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workbook"), file: Id, path: Path, revision: z.number().int().positive() }),
  z.object({ kind: z.literal("native") }),
])

export const Recipe = z.object({
  id: Id,
  project: Id,
  path: Path,
  schema: z.string().trim().min(1).max(128),
  source: Source,
  version: z.number().int().positive(),
  state: z.enum(["draft", "ready", "published", "source_missing", "repairing"]),
  commands: z.array(z.object({
    id: Id,
    kind: Id,
    table: z.string().trim().min(1).max(128).optional(),
    class: Class.optional(),
  }).passthrough()),
  baseline: z.unknown().optional(),
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
})
export type Recipe = z.infer<typeof Recipe>

export const Profile = z.object({
  dataset: Id,
  rows: z.number().int().nonnegative(),
  columns: z.array(z.object({
    column: z.string().trim().min(1).max(128),
    type: z.string().min(1),
  }).passthrough()),
  issues: z.number().int().nonnegative(),
})
export type Profile = z.infer<typeof Profile>

export const Issue = z.object({
  id: Id,
  state: z.enum(["open", "resolved"]),
}).passthrough()
export type Issue = z.infer<typeof Issue>
export const Issues = z.array(Issue)

export const Dataset = z.object({
  id: Id,
  prep: Id.optional(),
  project: Id,
  schema: z.string().trim().min(1).max(128),
  table: z.string().trim().min(1).max(128),
  class: Class,
  columns: z.array(Column),
  keys: z.array(z.string().trim().min(1).max(128)),
  rows: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  version: z.number().int().positive(),
})
export type Dataset = z.infer<typeof Dataset>
export const Datasets = z.object({ datasets: z.array(Dataset) })

export const Rows = z.object({ rows: z.array(Row), cursor: z.string().min(1).optional() })
export type Rows = z.infer<typeof Rows>

export const Job = z.object({
  id: Id,
  resource: Id.optional(),
  kind: z.enum(["profile", "preview", "publish", "writeback", "reconcile", "export", "cleanup"]),
  state: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  progress: z.number().min(0).max(1),
  error: z.string().min(1).optional(),
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
})
export type Job = z.infer<typeof Job>

export const Quota = z.object({
  used: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  percent: z.number().nonnegative(),
})
export type Quota = z.infer<typeof Quota>
export const Project = z.object({ quota: Quota }).passthrough()

export const Receipt = z.object({
  id: Id,
  version: z.number().int().nonnegative(),
  created: z.number().int().nonnegative(),
})

type Pending = { resolve(value: unknown): void; reject(error: Error): void }

export class Bridge {
  readonly #calls = new Map<string, Pending>()

  constructor(private readonly current: () => string | undefined) {}

  invoke<T>(action: string, input: unknown, schema: z.ZodType<T>) {
    const path = this.current()
    if (!path) throw new Error("Data preparation is not open")
    const id = crypto.randomUUID()
    return new Promise<unknown>((resolve, reject) => {
      this.#calls.set(id, { resolve, reject })
      send({ type: "invoke", id, path, action, input })
    }).then((value) => schema.parse(value))
  }

  settle(result: Result) {
    const call = this.#calls.get(result.id)
    if (!call) return false
    this.#calls.delete(result.id)
    if (result.ok) {
      call.resolve(result.value)
      return true
    }
    call.reject(new Error(result.error))
    return true
  }

  reset() {
    this.#calls.forEach((call) => call.reject(new Error("Data preparation changed while a request was running")))
    this.#calls.clear()
  }
}

export function parse(value: unknown) {
  return Incoming.safeParse(value)
}

export function send(message: Outgoing) {
  window.parent.postMessage(Outgoing.parse(message), parent)
}

export function ready() {
  send({
    type: "veritly.iframe.ready",
    frame,
    methods: ["open", "flush", "invoke"],
    events: ["loaded"],
  })
}
