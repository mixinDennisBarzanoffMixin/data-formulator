import { DataClient } from "@veritly/data-client"
import {
  ApplyCommandsInput,
  ApplyInput,
  EditInput,
  InsertInput,
  Mapping as DataMapping,
  PreviewInput,
  ProfileInput,
  PublishInput,
  RebindPrepInput,
  ReconcileInput,
  RemoveInput,
  Resolution,
  RowsInput,
  UpsertInput,
  WritebackInput,
  Workbook as DataWorkbook,
  Workbooks as DataWorkbooks,
} from "@veritly/data-protocol"
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
  api: z.string().url().refine((value) => new URL(value).origin === value, "Data API URL must be a canonical origin"),
})

const query = Query.parse(Object.fromEntries(new URLSearchParams(window.location.search)))
export const frame = query.frame
export const parent = new URL(query.parentOrigin).origin
if (parent !== query.parentOrigin) throw new Error("Data preparation parent origin must be canonical")
const client = new DataClient(query.api, (input, init) => window.fetch(input, init))

export const Open = z.object({
  type: z.literal("veritly.iframe.open"),
  frame: Id,
  request: Request,
  path: Path,
  payload: z.object({ recipe: Id, project: Id }),
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

export const Incoming = z.union([Open, Flush, FrameInvoke])
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
const Ai = z.object({
  type: z.literal("veritly.data.ai"),
  path: Path,
  intent: z.enum(["configure", "explain", "fix"]),
  issues: z.array(Id).max(100),
})
export const Outgoing = z.union([Ready, Loaded, Flushed, FrameResult, FrameError, Ai])
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

const WorkbookRows = z.strictObject({
  start: z.number().int().positive().max(1_048_576),
  end: z.number().int().positive().max(1_048_576),
}).refine((value) => value.end >= value.start, { message: "Worksheet row end must not precede its start" })

const WorkbookColumns = z.strictObject({
  start: z.number().int().positive().max(16_384),
  end: z.number().int().positive().max(16_384),
}).refine((value) => value.end >= value.start, { message: "Worksheet column end must not precede its start" })

export const WorkbookRegion = z.strictObject({
  header: z.number().int().positive().max(1_048_575),
  start: z.number().int().positive().max(1_048_576),
  end: z.number().int().positive().max(1_048_576),
  left: z.number().int().positive().max(16_384),
  right: z.number().int().positive().max(16_384),
}).refine((value) => value.start > value.header, { message: "Recommended data rows must start after the header" })
  .refine((value) => value.end >= value.start, { message: "Recommended row end must not precede its start" })
  .refine((value) => value.right >= value.left, { message: "Recommended column end must not precede its start" })
export type WorkbookRegion = z.infer<typeof WorkbookRegion>

export const WorkbookSheet = z.strictObject({
  name: z.string().trim().min(1).max(31),
  rows: WorkbookRows,
  columns: WorkbookColumns,
  visibility: z.enum(["visible", "hidden", "veryHidden"]),
  regions: z.array(WorkbookRegion).max(32),
})
export type WorkbookSheet = z.infer<typeof WorkbookSheet>

export const WorkbookCatalog = z.strictObject({
  file: Id,
  revision: z.number().int().positive(),
  sheets: z.array(WorkbookSheet).min(1).max(1_024),
})
export type WorkbookCatalog = z.infer<typeof WorkbookCatalog>
export const Workbook = DataWorkbook
export type Workbook = z.infer<typeof Workbook>
export const Workbooks = DataWorkbooks
export const Mapping = DataMapping
export type Mapping = z.infer<typeof Mapping>

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
    input: Id.optional(),
    output: Id.optional(),
    sheet: z.string().trim().min(1).max(128).optional(),
    range: z.object({
      header: z.number().int().positive(),
      start: z.number().int().positive(),
      end: z.number().int().positive(),
      left: z.number().int().positive(),
      right: z.number().int().positive(),
    }).optional(),
    key: z.discriminatedUnion("strategy", [
      z.object({ strategy: z.literal("existing"), columns: z.array(z.string().trim().min(1).max(128)).min(1) }),
      z.object({ strategy: z.literal("generated"), name: z.string().trim().min(1).max(128) }),
    ]).optional(),
    schema: z.string().trim().min(1).max(128).optional(),
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
    nulls: z.number().int().nonnegative(),
    distinct: z.number().int().nonnegative(),
    invalid: z.number().int().nonnegative(),
    formulas: z.number().int().nonnegative(),
    stale: z.number().int().nonnegative(),
    expressions: z.array(z.string().min(1)).max(20),
    min: Value.optional(),
    max: Value.optional(),
  })),
  issues: z.number().int().nonnegative(),
})
export type Profile = z.infer<typeof Profile>

export const Issue = z.object({
  id: Id,
  prep: Id,
  run: Id.optional(),
  code: z.enum([
    "version_conflict",
    "source_revision_changed",
    "dataset_revision_changed",
    "sync_conflict",
    "identity_invalid",
    "mapping_not_invertible",
    "formula_stale",
    "quota_exceeded",
    "repairing",
    "job_failed",
  ]),
  severity: z.enum(["warning", "error"]),
  row: z.string().min(1).optional(),
  column: z.string().trim().min(1).max(128).optional(),
  message: z.string().min(1),
  state: z.enum(["open", "resolved"]),
  version: z.number().int().nonnegative(),
})
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
const Summary = Recipe.pick({
  id: true,
  path: true,
  schema: true,
  source: true,
  state: true,
  version: true,
  updated: true,
})
export const Project = z.strictObject({
  id: Id,
  state: z.enum(["unprovisioned", "provisioning", "ready", "repairing", "deleting"]),
  source: z.strictObject({ path: Path, database: z.number().int().positive() }).optional(),
  quota: Quota,
  revision: z.number().int().nonnegative(),
  preps: z.array(Summary),
})

export const Receipt = z.object({
  id: Id,
  version: z.number().int().nonnegative(),
  created: z.number().int().nonnegative(),
})

export class OpenGuard {
  #open?: Open

  accept(next: Open) {
    const open = this.#open
    if (!open || next.request > open.request) {
      this.#open = next
      return true
    }
    if (next.request < open.request) throw new Error(`Stale data preparation request: ${next.request}`)
    if (next.path !== open.path || next.payload.recipe !== open.payload.recipe || next.payload.project !== open.payload.project) {
      throw new Error(`Data preparation request ${next.request} changed while opening`)
    }
    return false
  }
}

export function uuid() {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export class Bridge {
  constructor(private readonly current: () => Readonly<{ path: string; project: string; recipe: string }> | undefined) {}

  invoke<T>(action: string, input: unknown, schema: { parse(value: unknown): T }) {
    const current = this.current()
    if (!current) throw new Error("Data preparation is not open")
    return this.call(current, action, input).then((value) => schema.parse(value))
  }

  reset() {}

  private call(current: Readonly<{ project: string; recipe: string }>, action: string, input: unknown) {
    if (action === "inspect") return client.prep(current.project, current.recipe)
    if (action === "workbooks") return client.workbooks(current.project)
    if (action === "workbook") return client.workbook(current.project, current.recipe)
    if (action === "mapping") return client.mapping(current.project, current.recipe)
    if (action === "rebind") return client.rebind(current.project, current.recipe, RebindPrepInput.parse(input))
    if (action === "project") return client.project(current.project)
    if (action === "datasets") return client.datasets(current.project)
    if (action === "apply") return client.apply(current.project, current.recipe, ApplyInput.parse(input))
    if (action === "applyAll") return client.applyBatch(current.project, current.recipe, ApplyCommandsInput.parse(input))
    if (action === "profile") return client.profile(current.project, current.recipe, ProfileInput.parse(input))
    if (action === "preview") return client.preview(current.project, current.recipe, PreviewInput.parse(input))
    if (action === "publish") return client.publish(current.project, current.recipe, PublishInput.parse(input))
    if (action === "writeback") return client.writeback(current.project, current.recipe, WritebackInput.parse(input))
    if (action === "reconcile") return client.reconcile(current.project, current.recipe, ReconcileInput.parse(input))
    if (action === "issues") return client.issues(current.project, current.recipe, RunInput.parse(input).run)
    if (action === "resolve") {
      const value = IssueInput.parse(input)
      return client.resolve(current.project, value.issue, Resolution.parse(value.resolution))
    }
    if (action === "rows") {
      const value = RowInput.parse(input)
      return client.rows(current.project, value.dataset, RowsInput.parse(value.input))
    }
    if (action === "insert") {
      const value = RowInput.parse(input)
      return client.insert(current.project, value.dataset, InsertInput.parse(value.input))
    }
    if (action === "edit") {
      const value = EditRowInput.parse(input)
      return client.edit(current.project, value.dataset, value.row, EditInput.parse(value.input))
    }
    if (action === "remove") {
      const value = EditRowInput.parse(input)
      return client.removeRow(current.project, value.dataset, value.row, RemoveInput.parse(value.input))
    }
    if (action === "upsert") {
      const value = RowInput.parse(input)
      return client.upsert(current.project, value.dataset, UpsertInput.parse(value.input))
    }
    if (action === "status") return client.job(current.project, JobInput.parse(input).job)
    if (action === "cancel") return client.cancel(current.project, JobInput.parse(input).job)
    if (action === "quota") return client.quota(current.project)
    if (action === "export") return client.export(current.project)
    throw new Error(`Unsupported data preparation action: ${action}`)
  }
}

const RunInput = z.strictObject({ run: Id.optional() })
const IssueInput = z.strictObject({ issue: Id, resolution: z.unknown() })
const RowInput = z.strictObject({ dataset: Id, input: z.unknown() })
const EditRowInput = RowInput.extend({ row: Id })
const JobInput = z.strictObject({ job: Id })

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

export function events(project: string) {
  return client.events(Id.parse(project))
}
