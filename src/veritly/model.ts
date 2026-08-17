import { z } from "zod"
import type {
  Dataset,
  Issue,
  Job,
  Mapping,
  Preview,
  Profile,
  Quota,
  Recipe as WireRecipe,
  Row,
  WorkbookCatalog as WireCatalog,
  WorkbookRegion,
  Workbook,
} from "./protocol"

const Id = z.string().trim().min(1).max(256)
const Name = z.string().trim().min(1).max(128)
const Path = z.string().trim().min(1).max(1024)
const Value = z.union([z.string(), z.number().finite(), z.boolean(), z.null()])
export const Cells = z.record(Name, Value)
const Type = z.enum(["text", "boolean", "integer", "decimal", "date", "timestamp"])
const Owner = z.enum(["shared", "workbook", "database", "formula", "derived"])

const Node = {
  id: Id,
  after: z.array(Id),
}

const Flow = {
  ...Node,
  input: Id,
  output: Id,
}

export const Range = z.strictObject({
  header: z.number().int().positive(),
  start: z.number().int().positive(),
  end: z.number().int().positive(),
  left: z.number().int().positive(),
  right: z.number().int().positive(),
}).refine((value) => value.start > value.header, { message: "Data rows must start after the header row" })
  .refine((value) => value.end >= value.start, { message: "Range end must not precede its start" })
  .refine((value) => value.right >= value.left, { message: "Range right must not precede its left" })

const Source = z.strictObject({
  ...Node,
  kind: z.literal("source"),
  output: Id,
  file: Id,
  path: Path,
  revision: z.number().int().positive(),
  sheet: Name,
  range: Range,
})

const Native = z.strictObject({
  ...Node,
  kind: z.literal("native"),
  output: Id,
  columns: z.array(z.strictObject({
    id: z.string().trim().regex(/^[a-z][a-z0-9_]{0,127}$/, "Native column IDs must be physical PostgreSQL names"),
    name: Name,
    type: Type,
    nullable: z.boolean(),
  })).min(1).max(512),
}).superRefine((command, ctx) => {
  if (command.after.length) ctx.addIssue({ code: "custom", path: ["after"], message: "Native table declarations must be graph roots" })
  const ids = new Set<string>()
  const names = new Set<string>()
  command.columns.forEach((column, index) => {
    if (ids.has(column.id)) {
      ctx.addIssue({ code: "custom", path: ["columns", index, "id"], message: `Duplicate native column ID ${column.id}` })
    }
    ids.add(column.id)
    const name = column.name.toLowerCase()
    if (names.has(name)) {
      ctx.addIssue({ code: "custom", path: ["columns", index, "name"], message: `Duplicate native column name ${column.name}` })
    }
    names.add(name)
  })
})

const Key = z.strictObject({
  ...Flow,
  kind: z.literal("key"),
  key: z.discriminatedUnion("strategy", [
    z.strictObject({ strategy: z.literal("existing"), columns: z.array(Name).min(1) }),
    z.strictObject({ strategy: z.literal("generated"), name: Name }),
  ]),
})

const Select = z.strictObject({ ...Flow, kind: z.literal("select"), columns: z.array(Name).min(1) })
const Drop = z.strictObject({ ...Flow, kind: z.literal("drop"), columns: z.array(Name).min(1) })
const Rename = z.strictObject({ ...Flow, kind: z.literal("rename"), columns: z.record(Name, Name) })
const Reorder = z.strictObject({ ...Flow, kind: z.literal("reorder"), columns: z.array(Name).min(1) })
const Cast = z.strictObject({
  ...Flow,
  kind: z.literal("cast"),
  columns: z.array(z.strictObject({
    column: Name,
    type: Type,
    locale: z.string().trim().min(1).optional(),
    timezone: z.string().trim().min(1).optional(),
    invalid: z.enum(["reject", "null"]),
  })).min(1),
})
const Trim = z.strictObject({ ...Flow, kind: z.literal("trim"), columns: z.array(Name).min(1) })
const Case = z.strictObject({
  ...Flow,
  kind: z.literal("case"),
  columns: z.array(Name).min(1),
  mode: z.enum(["lower", "upper", "title"]),
})
const Replace = z.strictObject({
  ...Flow,
  kind: z.literal("replace"),
  column: Name,
  find: z.string(),
  replacement: z.string(),
  exact: z.boolean(),
})
const Null = z.strictObject({ ...Flow, kind: z.literal("null"), columns: z.array(Name).min(1), values: z.array(Value).min(1) })
const Split = z.strictObject({
  ...Flow,
  kind: z.literal("split"),
  column: Name,
  separator: z.string().min(1),
  columns: z.array(Name).min(2),
})
const Merge = z.strictObject({
  ...Flow,
  kind: z.literal("merge"),
  columns: z.array(Name).min(2),
  separator: z.string(),
  column: Name,
})
const Fill = z.strictObject({
  ...Flow,
  kind: z.literal("fill"),
  columns: z.array(Name).min(1),
  mode: z.enum(["down", "up", "value"]),
  value: Value.optional(),
})
const Filter = z.strictObject({ ...Flow, kind: z.literal("filter"), expression: z.string().min(1) })
const Dedupe = z.strictObject({
  ...Flow,
  kind: z.literal("dedupe"),
  columns: z.array(Name).min(1),
  keep: z.enum(["first", "last"]),
})

const Rule = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("required"), column: Name }),
  z.strictObject({ kind: z.literal("unique"), columns: z.array(Name).min(1) }),
  z.strictObject({ kind: z.literal("range"), column: Name, min: z.number().finite().optional(), max: z.number().finite().optional() }),
  z.strictObject({ kind: z.literal("pattern"), column: Name, pattern: z.string().min(1) }),
  z.strictObject({ kind: z.literal("expression"), expression: z.string().min(1), message: z.string().min(1) }),
])

const Validate = z.strictObject({ ...Flow, kind: z.literal("validate"), rules: z.array(Rule).min(1) })
const Derive = z.strictObject({
  ...Flow,
  kind: z.literal("derive"),
  columns: z.array(z.strictObject({ name: Name, type: Type, expression: z.string().min(1) })).min(1),
})
const Join = z.strictObject({
  ...Node,
  kind: z.literal("join"),
  left: Id,
  right: Id,
  output: Id,
  mode: z.enum(["inner", "left", "right", "full"]),
  on: z.array(z.strictObject({ left: Name, right: Name })).min(1),
})
const Union = z.strictObject({ ...Node, kind: z.literal("union"), inputs: z.array(Id).min(2), output: Id, distinct: z.boolean() })
const Pivot = z.strictObject({
  ...Flow,
  kind: z.literal("pivot"),
  rows: z.array(Name),
  columns: z.array(Name).min(1),
  values: z.array(z.strictObject({
    column: Name,
    aggregate: z.enum(["count", "sum", "min", "max", "average"]),
  })).min(1),
})
const Unpivot = z.strictObject({
  ...Flow,
  kind: z.literal("unpivot"),
  keys: z.array(Name),
  columns: z.array(Name).min(1),
  name: Name,
  value: Name,
})
const Output = z.strictObject({
  ...Node,
  kind: z.literal("output"),
  input: Id,
  schema: Name,
  table: Name,
  class: z.enum(["entity", "derived", "native"]),
  keys: z.array(Name),
  owners: z.record(Name, Owner),
})
const Code = z.strictObject({
  ...Node,
  kind: z.literal("code"),
  language: z.enum(["sql", "python"]),
  source: z.string().min(1),
  signature: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  inputs: z.array(Id).min(1),
  output: Id,
  columns: z.array(z.strictObject({ name: Name, type: Type, nullable: z.boolean() })).min(1),
})

export const Command = z.discriminatedUnion("kind", [
  Source,
  Native,
  Key,
  Select,
  Drop,
  Rename,
  Reorder,
  Cast,
  Trim,
  Case,
  Replace,
  Null,
  Split,
  Merge,
  Fill,
  Filter,
  Dedupe,
  Validate,
  Derive,
  Join,
  Union,
  Pivot,
  Unpivot,
  Output,
  Code,
])
export type Command = z.infer<typeof Command>

export const Config = z.strictObject({
  sheet: z.string().trim().max(128),
  header: z.number().int().positive(),
  start: z.number().int().positive(),
  end: z.number().int().positive(),
  columns: z.array(z.number().int().positive().max(16_384)).max(16_384)
    .refine((value) => new Set(value).size === value.length, { message: "Selected columns must be unique" })
    .refine(
      (value) => value.every((column, index) => index === 0 || column === value[index - 1] + 1),
      { message: "Workbook source columns must form one explicit bounded range" },
    ),
  keys: z.array(Name).refine((value) => new Set(value).size === value.length, { message: "Business keys must be unique" }),
})
export type PrepConfig = Readonly<Omit<z.infer<typeof Config>, "columns" | "keys"> & {
  columns: readonly number[]
  keys: readonly string[]
}>

export const View = z.strictObject({
  ribbon: z.enum(["home", "transform", "column", "combine", "view"]),
  surface: z.enum(["source", "map", "model", "rows", "review"]),
  detail: z.enum(["profile", "issues", "jobs"]),
  step: Id.optional(),
  dataset: Id.optional(),
})
export const ViewInput = View.partial().strict()
export type StudioView = Readonly<z.infer<typeof View>>

export const Draft = z.record(Name, z.string())
export type StudioDraft = Readonly<Record<string, string>>

export const TransformKind = z.enum(["trim", "case", "rename", "cast", "derive"])
export type TransformKind = z.infer<typeof TransformKind>
const TransformColumns = z.array(Name).min(1).refine((value) => new Set(value).size === value.length, {
  message: "Transform columns must be unique",
})

export const TransformDraft = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("trim"), columns: TransformColumns }),
  z.strictObject({
    kind: z.literal("case"),
    columns: TransformColumns,
    mode: z.enum(["lower", "upper", "title"]),
  }),
  z.strictObject({ kind: z.literal("rename"), column: Name, name: z.string().max(128) }),
  z.strictObject({
    kind: z.literal("cast"),
    column: Name,
    type: Type,
    invalid: z.enum(["reject", "null"]),
  }),
  z.strictObject({
    kind: z.literal("derive"),
    name: z.string().max(128),
    type: Type,
    expression: z.string().max(8_192),
  }),
])
export type StudioTransform = Readonly<z.infer<typeof TransformDraft>>

export const PreviewInput = z.strictObject({
  dataset: Id.optional(),
  limit: z.number().int().positive().max(1000).default(100),
  draft: z.strictObject({
    expectedVersion: z.number().int().positive(),
    commands: z.array(Command),
  }).optional(),
})
export const PageInput = z.strictObject({ page: z.number().int().nonnegative(), pageSize: z.literal(100) })
export const EditInput = z.strictObject({ row: z.string().uuid(), expectedVersion: z.number().int().nonnegative(), values: Cells })
export const InsertInput = z.strictObject({ values: Cells })
export const RemoveInput = z.strictObject({ row: z.string().uuid(), expectedVersion: z.number().int().nonnegative() })
export const PublishInput = z.strictObject({ mode: z.enum(["replace", "append", "upsert"]) })
export const ResolveInput = z.strictObject({
  issue: Id,
  expectedVersion: z.number().int().nonnegative(),
  decision: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("source") }),
    z.strictObject({ kind: z.literal("database") }),
    z.strictObject({ kind: z.literal("base") }),
    z.strictObject({ kind: z.literal("value"), value: Value }),
    z.strictObject({ kind: z.literal("delete") }),
  ]),
})

export const IssueDetail = z.strictObject({
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
  message: z.string().min(1),
  state: z.enum(["open", "resolved"]),
  version: z.number().int().nonnegative(),
  row: z.string().min(1).optional(),
  column: Name.optional(),
})
export type StudioIssue = z.infer<typeof IssueDetail>
export const IssueList = z.array(IssueDetail)

export type PrepRecipe = Readonly<Omit<WireRecipe, "commands"> & { commands: readonly Command[] }>
export type StudioCatalog = Readonly<Omit<WireCatalog, "sheets"> & {
  sheets: readonly Readonly<Omit<WireCatalog["sheets"][number], "rows" | "columns" | "regions"> & {
    rows: Readonly<WireCatalog["sheets"][number]["rows"]>
    columns: Readonly<WireCatalog["sheets"][number]["columns"]>
    regions: readonly Readonly<WireCatalog["sheets"][number]["regions"][number]>[]
  }>[]
}>

export type StudioAction = "open" | "apply" | "rebind" | "sample" | "prepare" | "profile" | "preview" | "rows" | "insert" | "edit" |
  "remove" | "transform" | "publish" | "writeback" | "reconcile" | "resolve" | "cancel" | "export"

export type StudioGate = Readonly<{ enabled: true } | { enabled: false; reason: string }>

export type StudioGates = Readonly<{
  prepare: StudioGate
  rebind: StudioGate
  profile: StudioGate
  transform: StudioGate
  publish: StudioGate
  writeback: StudioGate
  reconcile: StudioGate
  insert: StudioGate
  edit: StudioGate
  remove: StudioGate
  ai: StudioGate
  cancel: StudioGate
  export: StudioGate
}>

export type StudioState = Readonly<{
  phase: "idle" | "loading" | "ready"
  prep?: Readonly<{ path: string; recipe: string; project: string }>
  recipe?: PrepRecipe
  catalog?: StudioCatalog
  workbooks: readonly Workbook[]
  mapping?: Mapping
  config: PrepConfig
  view: StudioView
  draft?: StudioDraft
  transform?: StudioTransform
  datasets: readonly Dataset[]
  profile?: Profile
  sample?: StudioPreview
  preview?: StudioPreview
  issues: readonly StudioIssue[]
  quota?: Quota
  job?: Job
  busy?: StudioAction
  error?: string
  paging: Readonly<{ page: number; pageSize: 100 }>
  gates: StudioGates
}>

export type StudioRow = Row
export type StudioDataset = Dataset
export type StudioProfile = Profile
export type StudioPreview = Readonly<Omit<Preview, "columns" | "rows"> & {
  columns: readonly Preview["columns"][number][]
  rows: readonly Preview["rows"][number][]
}>
export type StudioQuota = Quota
export type StudioJob = Job
export type WireIssue = Issue

export function recipe(value: WireRecipe): PrepRecipe {
  return Object.freeze({ ...value, commands: Object.freeze(Command.array().parse(value.commands)) })
}

export function catalog(value: WireCatalog): StudioCatalog {
  return Object.freeze({
    ...value,
    sheets: Object.freeze(value.sheets.map((sheet) => Object.freeze({
      ...sheet,
      rows: Object.freeze({ ...sheet.rows }),
      columns: Object.freeze({ ...sheet.columns }),
      regions: Object.freeze(sheet.regions.map((region) => Object.freeze({ ...region }))),
    }))),
  })
}

export function config(value?: PrepRecipe): PrepConfig {
  const base: PrepConfig = Object.freeze({
    sheet: "",
    header: 1,
    start: 2,
    end: 1000,
    columns: Object.freeze([]),
    keys: Object.freeze([]),
  })
  if (!value) return base
  const source = value.commands.find((item) => item.kind === "source")
  const key = value.commands.find((item) => item.kind === "key")
  if (!source) return base
  return Object.freeze({
    sheet: source.sheet,
    header: source.range.header,
    start: source.range.start,
    end: source.range.end,
    columns: Object.freeze(Array.from({ length: source.range.right - source.range.left + 1 }, (_, index) => source.range.left + index)),
    keys: Object.freeze(key && key.key.strategy === "existing" ? [...key.key.columns] : []),
  })
}

export function blank(): PrepConfig {
  return config()
}

export function bounds(value: StudioCatalog, name?: string): PrepConfig {
  const sheet = name
    ? value.sheets.find((item) => item.name === name)
    : value.sheets.find((item) => item.visibility === "visible" && item.regions.length > 0)
  if (!sheet) throw new Error(name ? `Workbook worksheet is unavailable: ${name}` : "Workbook has no visible table-like data region")
  const region = sheet.regions[0]
  if (!region) return Object.freeze({
    sheet: sheet.name,
    header: sheet.rows.start,
    start: Math.min(sheet.rows.start + 1, sheet.rows.end),
    end: sheet.rows.end,
    columns: Object.freeze([]),
    keys: Object.freeze([]),
  })
  return regionBounds(sheet.name, region)
}

export function regionBounds(name: string, region: WorkbookRegion): PrepConfig {
  return Object.freeze({
    sheet: name,
    header: region.header,
    start: region.start,
    end: region.end,
    columns: Object.freeze(Array.from(
      { length: region.right - region.left + 1 },
      (_, index) => region.left + index,
    )),
    keys: Object.freeze([]),
  })
}

export function nav(value?: PrepRecipe): StudioView {
  if (!value) return Object.freeze({ ribbon: "home", surface: "source", detail: "profile" })
  const step = value.commands.at(-1)
  const output = [...value.commands].reverse().find((item) => item.kind === "output")
  return Object.freeze({
    ribbon: "home",
    surface: output ? "rows" : "source",
    detail: "profile",
    ...(step ? { step: step.id } : {}),
    ...(output && output.kind === "output" ? { dataset: output.input } : {}),
  })
}

export function allow(): StudioGate {
  return Object.freeze({ enabled: true })
}

export function block(reason: string): StudioGate {
  return Object.freeze({ enabled: false, reason })
}

export function output(value: PrepRecipe) {
  return [...value.commands].reverse().find((item): item is Extract<Command, { kind: "output" }> => item.kind === "output")
}

export function source(value: PrepRecipe) {
  return value.commands.find((item): item is Extract<Command, { kind: "source" }> => item.kind === "source")
}

export function transform(value: PrepRecipe, input: unknown) {
  const draft = TransformDraft.parse(input)
  const target = output(value)
  if (!target) throw new Error("Preparation has no output to transform")
  const producer = value.commands.find((item) => "output" in item && item.output === target.input)
  if (!producer) throw new Error(`Preparation output input is unavailable: ${target.input}`)
  identity(draft, target)
  const id = `${draft.kind}-${value.version + 1}`
  const dataset = `${draft.kind}-rows-${value.version + 1}`
  const node = { id, after: [producer.id], input: target.input, output: dataset }
  const command = draft.kind === "trim"
    ? Trim.parse({ ...node, kind: "trim", columns: draft.columns })
    : draft.kind === "case"
      ? Case.parse({ ...node, kind: "case", columns: draft.columns, mode: draft.mode })
      : draft.kind === "rename"
        ? rename(node, draft, target)
        : draft.kind === "cast"
          ? Cast.parse({
            ...node,
            kind: "cast",
            columns: [{ column: draft.column, type: draft.type, invalid: draft.invalid }],
          })
          : Derive.parse({
            ...node,
            kind: "derive",
            columns: [{ name: Name.parse(draft.name), type: draft.type, expression: z.string().min(1).parse(draft.expression) }],
          })
  const owners = draft.kind === "rename"
    ? Object.fromEntries(Object.entries(target.owners).map(([name, owner]) => [name === draft.column ? Name.parse(draft.name) : name, owner]))
    : draft.kind === "derive"
      ? { ...target.owners, [derived(draft, target)]: "derived" as const }
      : { ...target.owners }
  const next = Command.parse({ ...target, after: [command.id], input: dataset, owners })
  return Object.freeze({
    command,
    output: next,
    commands: Object.freeze([
      ...value.commands.filter((item) => item.id !== target.id),
      command,
      next,
    ]),
  })
}

function rename(
  node: { id: string; after: string[]; input: string; output: string },
  draft: Extract<StudioTransform, { kind: "rename" }>,
  target: Extract<Command, { kind: "output" }>,
) {
  if (target.keys.includes(draft.column)) throw new Error(`Row identity column cannot be renamed: ${draft.column}`)
  const name = Name.parse(draft.name)
  if (Object.hasOwn(target.owners, name)) throw new Error(`Output column already exists: ${name}`)
  return Rename.parse({ ...node, kind: "rename", columns: { [draft.column]: name } })
}

function derived(
  draft: Extract<StudioTransform, { kind: "derive" }>,
  target: Extract<Command, { kind: "output" }>,
) {
  const name = Name.parse(draft.name)
  if (Object.hasOwn(target.owners, name)) throw new Error(`Output column already exists: ${name}`)
  return name
}

function identity(draft: StudioTransform, target: Extract<Command, { kind: "output" }>) {
  const columns = draft.kind === "trim" || draft.kind === "case"
    ? draft.columns
    : draft.kind === "cast" || draft.kind === "rename"
      ? [draft.column]
      : []
  const key = columns.find((column) => target.keys.includes(column))
  if (key) throw new Error(`Row identity column cannot be transformed: ${key}`)
}

export function gates(value: Omit<StudioState, "gates">): StudioGates {
  const idle = value.busy ? block(`Wait for ${value.busy} to finish`) : allow()
  const prep = value.recipe
  const target = prep ? output(prep) : undefined
  const workbook = prep && prep.source.kind === "workbook"
  const ready = prep && prep.state !== "repairing" && prep.state !== "source_missing"
  const selected = value.config.sheet.length > 0 && value.config.columns.length > 0 && value.config.start > value.config.header && value.config.end >= value.config.start
  const published = prep && prep.state === "published" && prep.baseline !== undefined
  const transformable = target && value.preview?.dataset === target.input
  const profiled = prep && value.view.dataset && prep.commands.some((item) =>
    ("output" in item && item.output === value.view.dataset) || (item.kind === "output" && item.id === value.view.dataset))
  const blocked = prep ? prep.commands.some((item) => ["split", "merge", "filter", "dedupe", "derive", "join", "union", "pivot", "unpivot", "code"].includes(item.kind)) : false
  const rows = published && value.preview !== undefined && value.datasets.some((item) => item.id === value.preview?.dataset)
  const active = value.job && (value.job.state === "queued" || value.job.state === "running")
  return Object.freeze({
    prepare: value.busy ? idle : !prep ? block("Preparation is not loaded") : !workbook ? block("Native data has no workbook range") : !ready ? block("Preparation is not writable") : !selected ? block("Select a worksheet and bounded range") : allow(),
    rebind: value.busy ? idle : !prep ? block("Preparation is not loaded") : !workbook ? block("Native data has no workbook binding") : prep.state !== "draft" && prep.state !== "source_missing" ? block("Published data requires a new preparation before changing its workbook") : allow(),
    profile: value.busy ? idle : !profiled ? block("Select a recipe query to profile") : allow(),
    transform: value.busy ? idle : !prep ? block("Preparation is not loaded") : !target ? block("Preparation has no output") : !transformable ? block("Load the final query preview before adding a step") : allow(),
    publish: value.busy ? idle : !prep ? block("Preparation is not loaded") : !ready ? block("Preparation is not writable") : !target ? block("Preparation has no output") : allow(),
    writeback: value.busy ? idle : !workbook ? block("Write-back requires a workbook") : !published ? block("Publish before writing back") : blocked ? block("Recipe is not invertible") : allow(),
    reconcile: value.busy ? idle : !workbook ? block("Reconciliation requires a workbook") : !published ? block("Publish before reconciling") : blocked ? block("Recipe is not invertible") : allow(),
    insert: value.busy ? idle : !rows ? block("Publish and load database rows first") : allow(),
    edit: value.busy ? idle : !rows ? block("Publish and load database rows first") : allow(),
    remove: value.busy ? idle : !rows ? block("Publish and load database rows first") : allow(),
    ai: value.issues.some((item) => item.state === "open") ? allow() : block("No open issues"),
    cancel: active ? allow() : block("No active job"),
    export: value.busy ? idle : !published ? block("Publish project data before exporting") : allow(),
  })
}
