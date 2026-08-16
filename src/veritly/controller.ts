import { BehaviorSubject } from "rxjs"
import { z } from "zod"
import {
  Bridge,
  Datasets,
  Incoming,
  Job,
  OpenGuard,
  Preview,
  Profile,
  Project,
  Quota,
  Receipt,
  Recipe,
  Result,
  Row,
  Rows,
  WorkbookCatalog,
  frame,
  parent,
  ready,
  send,
  type Dataset,
  type Job as JobType,
  type Open,
  type Preview as PreviewType,
} from "./protocol"
import {
  Cells,
  Command,
  Config,
  Draft,
  EditInput,
  InsertInput,
  IssueList,
  PageInput,
  PreviewInput,
  PublishInput,
  RemoveInput,
  ResolveInput,
  TransformDraft,
  TransformKind,
  View,
  ViewInput,
  blank,
  bounds,
  catalog,
  config,
  gates,
  nav,
  output,
  recipe,
  source,
  transform,
  type Command as CommandType,
  type PrepConfig,
  type PrepRecipe,
  type StudioAction,
  type StudioDraft,
  type StudioGate,
  type StudioPreview,
  type StudioState,
  type StudioTransform,
  type StudioView,
} from "./model"

type Core = Omit<StudioState, "gates">

const DatasetInput = z.strictObject({ dataset: z.string().trim().min(1).max(256) })
const Patch = z.record(z.string(), z.unknown())
export class PrepStudio {
  readonly #opens = new OpenGuard()
  readonly #bridge = new Bridge(() => this.#state.value.prep?.path)
  readonly #state: BehaviorSubject<StudioState>
  readonly #cursors = new Map<number, string | undefined>()
  #mounted = false

  constructor() {
    const state: Core = Object.freeze({
      phase: "idle",
      config: blank(),
      view: nav(),
      datasets: Object.freeze([]),
      issues: Object.freeze([]),
      paging: Object.freeze({ page: 0, pageSize: 100 }),
    })
    this.#state = new BehaviorSubject(Object.freeze({ ...state, gates: gates(state) }))
    this.#cursors.set(0, undefined)
  }

  subscribe(listener: () => void) {
    const sub = this.#state.subscribe(listener)
    return () => sub.unsubscribe()
  }

  get() {
    return this.#state.value
  }

  mount() {
    if (this.#mounted) throw new Error("Data preparation controller is already mounted")
    this.#mounted = true
    window.addEventListener("message", this.#receive)
    ready()
  }

  unmount() {
    if (!this.#mounted) throw new Error("Data preparation controller is not mounted")
    window.removeEventListener("message", this.#receive)
    this.#bridge.reset()
    this.#mounted = false
    this.#next({ phase: "idle", busy: undefined })
  }

  select(input: unknown) {
    const value = Config.parse(input)
    const book = this.get().catalog
    const selected = book ? this.#selection(value, book) : freeze(value)
    this.#next({ config: selected })
    return selected
  }

  view(input: unknown) {
    const value = ViewInput.parse(input)
    const current = this.get().view
    const next = View.parse({
      ribbon: value.ribbon === undefined ? current.ribbon : value.ribbon,
      detail: value.detail === undefined ? current.detail : value.detail,
      ...((Object.hasOwn(value, "step") ? value.step : current.step) === undefined ? {} : {
        step: Object.hasOwn(value, "step") ? value.step : current.step,
      }),
      ...((Object.hasOwn(value, "dataset") ? value.dataset : current.dataset) === undefined ? {} : {
        dataset: Object.hasOwn(value, "dataset") ? value.dataset : current.dataset,
      }),
    })
    this.#assertView(next)
    const selected = Object.freeze(next)
    this.#next({ view: selected })
    return selected
  }

  draft(input?: unknown) {
    if (input === undefined) {
      this.#next({ draft: undefined })
      return undefined
    }
    const selected = Object.freeze({ ...Draft.parse(input) })
    this.#next({ draft: selected })
    return selected
  }

  openTransform(input: unknown) {
    this.#assert(this.get().gates.transform)
    const kind = TransformKind.parse(input)
    const preview = need(this.get().preview, "Preview rows are required before adding a transform")
    const prep = need(this.get().recipe, "Preparation recipe is not loaded")
    const target = need(output(prep), "Preparation has no output")
    if (preview.dataset !== target.input) throw new Error("Load the final query preview before adding a transform")
    const column = preview.columns.find((item) => !item.system && !target.keys.includes(item.name))
    if (kind !== "derive" && !column) throw new Error("Preview has no transformable columns")
    const draft: StudioTransform = kind === "trim"
      ? { kind, columns: [need(column, "Trim requires a transformable column").name] }
      : kind === "case"
        ? { kind, columns: [need(column, "Case conversion requires a transformable column").name], mode: "lower" }
        : kind === "rename"
          ? {
            kind,
            column: need(column, "Rename requires a transformable column").name,
            name: `${need(column, "Rename requires a transformable column").name} renamed`,
          }
          : kind === "cast"
            ? { kind, column: need(column, "Type conversion requires a transformable column").name, type: "text", invalid: "reject" }
            : { kind, name: "New column", type: "text", expression: "" }
    this.#next({ transform: Object.freeze(draft) })
    return draft
  }

  patchTransform(input: unknown) {
    const current = need(this.get().transform, "Transform editor is not open")
    const next = Object.freeze(TransformDraft.parse({ ...current, ...Patch.parse(input), kind: current.kind }))
    this.#next({ transform: next })
    return next
  }

  closeTransform() {
    this.#next({ transform: undefined })
  }

  commitTransform() {
    return this.#run("transform", async () => {
      const draft = need(this.get().transform, "Transform editor is not open")
      const prep = need(this.get().recipe, "Preparation recipe is not loaded")
      const next = transform(prep, draft)
      const result = await this.#invoke("preview", {
        dataset: next.command.output,
        limit: 100,
        draft: { expectedVersion: prep.version, commands: next.commands },
      }, Preview)
      await this.#commitAll("patch", [next.command, next.output])
      this.#cursors.clear()
      this.#cursors.set(0, undefined)
      this.#next({
        transform: undefined,
        preview: result,
        profile: undefined,
        paging: Object.freeze({ page: 0, pageSize: 100 }),
        view: Object.freeze({ ...this.get().view, step: next.command.id, dataset: result.dataset }),
      })
      return result
    })
  }

  prepare() {
    this.#assert(this.get().gates.prepare)
    return this.#run("prepare", async () => {
      const state = this.get()
      const prep = need(state.recipe, "Preparation recipe is not loaded")
      if (prep.source.kind !== "workbook") throw new Error("Native data does not have a workbook range")
      const form = selected(state.config)
      const left = Math.min(...form.columns)
      const right = Math.max(...form.columns)
      const source = Command.parse({
        kind: "source",
        id: "source-command",
        after: [],
        output: "source-rows",
        file: prep.source.file,
        path: prep.source.path,
        revision: prep.source.revision,
        sheet: form.sheet,
        range: { header: form.header, start: form.start, end: form.end, left, right },
      })
      if (source.kind !== "source") throw new Error("Source command parser returned another command kind")
      const report = await this.#invoke("profile", {
        dataset: source.output,
        draft: { expectedVersion: prep.version, commands: [source] },
      }, Profile)
      const names = report.columns.map((item) => item.column)
      form.keys.forEach((key) => {
        if (!names.includes(key)) throw new Error(`Business key column does not exist: ${key}`)
      })
      const identity = form.keys.length ? [...form.keys] : ["Veritly ID"]
      const key = Command.parse({
        kind: "key",
        id: "key-command",
        after: ["source-command"],
        input: "source-rows",
        output: "entity-rows",
        key: form.keys.length
          ? { strategy: "existing", columns: [...form.keys] }
          : { strategy: "generated", name: identity[0] },
      })
      if (key.kind !== "key") throw new Error("Key command parser returned another command kind")
      const target = Command.parse({
        kind: "output",
        id: "output-command",
        after: ["key-command"],
        input: "entity-rows",
        schema: prep.schema,
        table: table(prep.source.kind === "workbook" ? prep.source.path : prep.path),
        class: "entity",
        keys: identity,
        owners: Object.fromEntries([
          ...report.columns.map((column) => [column.column, column.formulas ? "formula" as const : "shared" as const]),
          ...(form.keys.length ? [] : [[identity[0], "workbook" as const]]),
        ]),
      })
      if (target.kind !== "output") throw new Error("Output command parser returned another command kind")
      const commands = [source, key, target]
      const checked = await this.#invoke("preview", {
        dataset: target.id,
        limit: 100,
        draft: { expectedVersion: prep.version, commands },
      }, Preview)
      await this.#commitAll("replace", commands)
      const value = Preview.parse({ ...checked, dataset: target.input })
      const issues = await this.#invoke("issues", {}, IssueList)
      this.#cursors.clear()
      this.#cursors.set(0, undefined)
      this.#next({
        profile: Object.freeze({ ...report, dataset: value.dataset }),
        preview: value,
        issues: Object.freeze([...issues]),
        paging: Object.freeze({ page: 0, pageSize: 100 }),
        view: Object.freeze({ ...this.get().view, detail: "profile", dataset: value.dataset }),
      })
    })
  }

  apply(input: unknown) {
    const command = Command.parse(input)
    return this.#run("apply", () => this.#commit(command))
  }

  profile(input: unknown) {
    const value = DatasetInput.parse({ dataset: input })
    return this.#run("profile", () => this.#invoke("profile", value, Profile).then((report) => {
      this.#next({ profile: report, view: Object.freeze({ ...this.get().view, detail: "profile", dataset: report.dataset }) })
      return report
    }))
  }

  preview(input: unknown) {
    const value = PreviewInput.parse(input)
    return this.#run("preview", () => this.#invoke("preview", value, Preview).then((result) => {
      this.#cursors.clear()
      this.#cursors.set(0, undefined)
      this.#next({
        preview: result,
        profile: this.get().profile?.dataset === result.dataset ? this.get().profile : undefined,
        paging: Object.freeze({ page: 0, pageSize: 100 }),
        view: Object.freeze({ ...this.get().view, dataset: result.dataset }),
      })
      return result
    }))
  }

  page(input: unknown) {
    const value = PageInput.parse(input)
    const current = this.get()
    const preview = need(current.preview, "Database rows are not loaded")
    if (!current.recipe || current.recipe.state !== "published") throw new Error("Database pagination requires a published preparation")
    if (value.page === current.paging.page) return Promise.resolve()
    const cursor = this.#cursors.get(value.page)
    if (value.page > 0 && !cursor) throw new Error(`Database page ${value.page} has no cursor`)
    return this.#run("rows", () => this.#invoke("rows", {
      dataset: preview.dataset,
      input: { ...(cursor ? { cursor } : {}), limit: value.pageSize },
    }, Rows).then((result) => {
      this.#cursors.set(value.page + 1, result.cursor)
      this.#next({
        paging: Object.freeze(value),
        preview: Object.freeze({ ...preview, rows: Object.freeze([...result.rows]), truncated: result.cursor !== undefined }),
      })
    }))
  }

  edit(input: unknown) {
    this.#assert(this.get().gates.edit)
    const value = EditInput.parse(input)
    const preview = need(this.get().preview, "Database rows are not loaded")
    return this.#run("edit", () => this.#invoke("edit", {
      dataset: preview.dataset,
      row: value.row,
      input: { expectedVersion: value.expectedVersion, values: value.values },
    }, Row).then((row) => {
      this.#next({
        preview: Object.freeze({
          ...preview,
          rows: Object.freeze(preview.rows.map((item) => item.id === row.id ? row : item)),
        }),
      })
      return row
    }))
  }

  insert(input?: unknown) {
    this.#assert(this.get().gates.insert)
    const preview = need(this.get().preview, "Database rows are not loaded")
    const value = input === undefined
      ? InsertInput.parse({ values: values(need(this.get().draft, "Database row draft is not open"), preview) })
      : InsertInput.parse(input)
    return this.#run("insert", () => this.#invoke("insert", { dataset: preview.dataset, input: value }, Row).then(async (row) => {
      this.#next({ draft: undefined })
      await this.#refresh()
      return row
    }))
  }

  remove(input: unknown) {
    this.#assert(this.get().gates.remove)
    const value = RemoveInput.parse(input)
    const preview = need(this.get().preview, "Database rows are not loaded")
    return this.#run("remove", () => this.#invoke("remove", {
      dataset: preview.dataset,
      row: value.row,
      input: { expectedVersion: value.expectedVersion },
    }, Receipt).then(async (receipt) => {
      await this.#refresh()
      return receipt
    }))
  }

  publish(input: unknown) {
    this.#assert(this.get().gates.publish)
    const value = PublishInput.parse(input)
    const prep = need(this.get().recipe, "Preparation recipe is not loaded")
    const target = need(output(prep), "Preparation has no output")
    return this.#execute("publish", {
      expectedVersion: prep.version,
      mode: value.mode,
      dataset: target.id,
    })
  }

  writeback() {
    this.#assert(this.get().gates.writeback)
    const prep = need(this.get().recipe, "Preparation recipe is not loaded")
    return this.#execute("writeback", { expectedVersion: prep.version })
  }

  reconcile() {
    this.#assert(this.get().gates.reconcile)
    const prep = need(this.get().recipe, "Preparation recipe is not loaded")
    return this.#execute("reconcile", { expectedVersion: prep.version })
  }

  resolve(input: unknown) {
    const value = ResolveInput.parse(input)
    const issue = this.get().issues.find((item) => item.id === value.issue)
    if (!issue) throw new Error(`Preparation issue is not loaded: ${value.issue}`)
    if (issue.version !== value.expectedVersion) throw new Error(`Preparation issue version changed: ${value.issue}`)
    return this.#run("resolve", () => this.#invoke("resolve", {
      issue: value.issue,
      resolution: { expectedVersion: value.expectedVersion, decision: value.decision },
    }, Receipt).then(async (receipt) => {
      await this.#issues()
      return receipt
    }))
  }

  cancel() {
    this.#assert(this.get().gates.cancel)
    const job = need(this.get().job, "No active data job")
    return this.#run("cancel", () => this.#invoke("cancel", { job: job.id }, Job).then((value) => {
      this.#next({ job: value })
      return value
    }))
  }

  export() {
    this.#assert(this.get().gates.export)
    return this.#run("export", () => this.#invoke("export", undefined, Job).then((job) => {
      this.#next({ job })
      return this.#poll(job, Date.now() + 60_000)
    }).then((job) => {
      this.#next({ job })
      return job
    }))
  }

  ai() {
    this.#assert(this.get().gates.ai)
    const prep = need(this.get().prep, "Data preparation is not open")
    send({
      type: "veritly.data.ai",
      path: prep.path,
      issues: this.get().issues.filter((item) => item.state === "open").map((item) => item.id),
    })
  }

  clear() {
    this.#next({ error: undefined })
  }

  readonly #receive = (event: MessageEvent<unknown>) => {
    if (event.origin !== parent || event.source !== window.parent) return
    const parsed = Incoming.safeParse(event.data)
    if (!parsed.success) return
    const data = parsed.data
    if (data.type === "result") {
      this.#bridge.settle(Result.parse(data))
      return
    }
    if (data.frame !== frame) return
    if (data.type === "veritly.iframe.open") {
      if (!this.#opens.accept(data)) {
        send({ type: "veritly.iframe.loaded", frame, request: data.request, path: data.path })
        return
      }
      this.#open(data)
      return
    }
    if (data.type === "veritly.iframe.flush") {
      send({ type: "veritly.iframe.flushed", frame, request: data.request, path: data.path })
      return
    }
    if (data.method === "state") {
      send({
        type: "veritly.iframe.result",
        frame,
        request: data.request,
        path: data.path,
        value: { path: data.path },
      })
      return
    }
    send({
      type: "veritly.iframe.error",
      frame,
      request: data.request,
      error: `Unsupported data preparation method: ${data.method}`,
    })
  }

  #open(input: Open) {
    this.#bridge.reset()
    this.#cursors.clear()
    this.#cursors.set(0, undefined)
    this.#next({
      phase: "loading",
      prep: Object.freeze({ path: input.path, recipe: input.payload.recipe }),
      recipe: undefined,
      catalog: undefined,
      config: blank(),
      view: nav(),
      draft: undefined,
      transform: undefined,
      datasets: Object.freeze([]),
      profile: undefined,
      preview: undefined,
      issues: Object.freeze([]),
      quota: undefined,
      job: undefined,
      busy: "open",
      error: undefined,
      paging: Object.freeze({ page: 0, pageSize: 100 }),
    })
    send({ type: "veritly.iframe.loaded", frame, request: input.request, path: input.path })
    void this.#load(input.path).then(
      () => this.#next({ phase: "ready", busy: undefined }),
      (error: unknown) => this.#fail(error, input.path),
    )
  }

  async #load(path: string) {
    const wire = await this.#invoke("inspect", undefined, Recipe)
    const [project, list, issues, book] = await Promise.all([
      this.#invoke("project", undefined, Project),
      this.#invoke("datasets", undefined, Datasets),
      this.#invoke("issues", {}, IssueList),
      wire.source.kind === "workbook" ? this.#invoke("workbook", undefined, WorkbookCatalog) : Promise.resolve(undefined),
    ])
    if (this.get().prep?.path !== path) throw new Error(`Data preparation changed while opening ${path}`)
    const prep = recipe(wire)
    const cataloged = book ? catalog(book) : undefined
    if (cataloged && prep.source.kind === "workbook" &&
      (cataloged.file !== prep.source.file || cataloged.revision !== prep.source.revision)) {
      throw new Error("Workbook catalog does not match the immutable preparation source")
    }
    this.#next({
      recipe: prep,
      catalog: cataloged,
      config: cataloged && !source(prep) ? bounds(cataloged) : config(prep),
      view: nav(prep),
      quota: Quota.parse(project.quota),
      datasets: Object.freeze([...list.datasets]),
      issues: Object.freeze([...issues]),
    })
    await this.#database(prep, list.datasets)
  }

  async #refresh() {
    const wire = await this.#invoke("inspect", undefined, Recipe)
    const [project, list, issues, book] = await Promise.all([
      this.#invoke("project", undefined, Project),
      this.#invoke("datasets", undefined, Datasets),
      this.#invoke("issues", {}, IssueList),
      wire.source.kind === "workbook" ? this.#invoke("workbook", undefined, WorkbookCatalog) : Promise.resolve(undefined),
    ])
    const prep = recipe(wire)
    const cataloged = book ? catalog(book) : undefined
    if (cataloged && prep.source.kind === "workbook" &&
      (cataloged.file !== prep.source.file || cataloged.revision !== prep.source.revision)) {
      throw new Error("Workbook catalog does not match the immutable preparation source")
    }
    this.#next({
      recipe: prep,
      catalog: cataloged,
      quota: Quota.parse(project.quota),
      datasets: Object.freeze([...list.datasets]),
      issues: Object.freeze([...issues]),
    })
    await this.#database(prep, list.datasets)
  }

  async #database(prep: PrepRecipe, list: Dataset[]) {
    if (prep.state !== "published") return
    const target = need(output(prep), "Published preparation has no output")
    const dataset = list.find((item) => item.prep === prep.id && item.table === target.table && item.class === target.class)
    if (!dataset) throw new Error(`Published dataset is unavailable: ${target.table}`)
    const page = await this.#invoke("rows", { dataset: dataset.id, input: { limit: 100 } }, Rows)
    this.#cursors.clear()
    this.#cursors.set(0, undefined)
    this.#cursors.set(1, page.cursor)
    this.#next({
      preview: Object.freeze({
        dataset: dataset.id,
        columns: Object.freeze([...dataset.columns]),
        rows: Object.freeze([...page.rows]),
        total: dataset.rows,
        truncated: page.cursor !== undefined,
      }),
      paging: Object.freeze({ page: 0, pageSize: 100 }),
      view: Object.freeze({ ...this.get().view, dataset: dataset.id }),
    })
  }

  #issues() {
    return this.#invoke("issues", {}, IssueList).then((issues) => {
      this.#next({ issues: Object.freeze([...issues]) })
      return issues
    })
  }

  #commit(command: CommandType) {
    const prep = need(this.get().recipe, "Preparation recipe is not loaded")
    return this.#invoke("apply", { expectedVersion: prep.version, command }, Receipt).then(async (receipt) => {
      const wire = await this.#invoke("inspect", undefined, Recipe)
      const next = recipe(wire)
      this.#next({ recipe: next, view: Object.freeze({ ...this.get().view, step: command.id }) })
      return receipt
    })
  }

  #commitAll(mode: "patch" | "replace", commands: CommandType[]) {
    const prep = need(this.get().recipe, "Preparation recipe is not loaded")
    return this.#invoke("applyAll", { expectedVersion: prep.version, mode, commands }, Receipt).then(async (receipt) => {
      const wire = await this.#invoke("inspect", undefined, Recipe)
      const next = recipe(wire)
      const command = commands.at(-1)
      this.#next({
        recipe: next,
        ...(command ? { view: Object.freeze({ ...this.get().view, step: command.id }) } : {}),
      })
      return receipt
    })
  }

  #execute(action: "publish" | "writeback" | "reconcile", input: unknown) {
    return this.#run(action, () => this.#invoke(action, input, Job).then((job) => {
      this.#next({ job, view: Object.freeze({ ...this.get().view, detail: "jobs" }) })
      return this.#poll(job, Date.now() + 60_000)
    }).then(async (job) => {
      if (job.state !== "succeeded") {
        if (job.error) throw new Error(job.error)
        throw new Error(`${action} ended in ${job.state}`)
      }
      this.#next({ job })
      await this.#refresh()
      return job
    }))
  }

  #poll(job: JobType, end: number): Promise<JobType> {
    if (job.state !== "queued" && job.state !== "running") return Promise.resolve(job)
    if (Date.now() >= end) throw new Error(`${job.kind} is still running; check its job status`)
    return delay(500).then(() => this.#invoke("status", { job: job.id }, Job)).then((next) => {
      this.#next({ job: next })
      return this.#poll(next, end)
    })
  }

  #run<T>(action: StudioAction, work: () => Promise<T>) {
    if (this.get().busy) throw new Error(`Data preparation is already running ${this.get().busy}`)
    this.#next({ busy: action, error: undefined })
    return Promise.resolve().then(work).then(
      (value) => {
        this.#next({ busy: undefined })
        return value
      },
      (error: unknown) => {
        this.#next({ busy: undefined, error: message(error) })
        throw error
      },
    )
  }

  #invoke<T>(action: string, input: unknown, schema: z.ZodType<T>) {
    return this.#bridge.invoke(action, input, schema)
  }

  #next(patch: Partial<Core>) {
    const current = this.#state.value
    const state: Core = Object.freeze({ ...current, ...patch })
    this.#state.next(Object.freeze({ ...state, gates: gates(state) }))
  }

  #fail(error: unknown, path: string) {
    if (this.get().prep?.path !== path) return
    this.#next({ phase: "ready", busy: undefined, error: message(error) })
  }

  #assert(gate: StudioGate) {
    if (!gate.enabled) throw new Error(gate.reason)
  }

  #assertView(view: StudioView) {
    const prep = this.get().recipe
    if (view.step && (!prep || !prep.commands.some((item) => item.id === view.step))) {
      throw new Error(`Preparation step is unavailable: ${view.step}`)
    }
    if (!view.dataset) return
    const ids = new Set(this.get().datasets.map((item) => item.id))
    const preview = this.get().preview
    if (preview) ids.add(preview.dataset)
    prep?.commands.forEach((item) => {
      if ("output" in item) ids.add(item.output)
      if (item.kind === "output") ids.add(item.id)
    })
    if (!ids.has(view.dataset)) throw new Error(`Preparation dataset is unavailable: ${view.dataset}`)
  }

  #selection(value: z.infer<typeof Config>, book: StudioState["catalog"]): PrepConfig {
    const cataloged = need(book, "Workbook catalog is not loaded")
    if (value.sheet !== this.get().config.sheet) return bounds(cataloged, value.sheet)
    const sheet = cataloged.sheets.find((item) => item.name === value.sheet)
    if (!sheet) throw new Error(`Workbook worksheet is unavailable: ${value.sheet}`)
    const header = Math.min(Math.max(value.header, sheet.rows.start), sheet.rows.end)
    const start = Math.min(Math.max(value.start, header + 1), sheet.rows.end)
    const end = Math.min(Math.max(value.end, start), sheet.rows.end)
    const columns = [...new Set(value.columns.map((column) =>
      Math.min(Math.max(column, sheet.columns.start), sheet.columns.end),
    ))].sort((left, right) => left - right)
    return freeze({ ...value, header, start, end, columns })
  }
}

export function studio() {
  return new PrepStudio()
}

function selected(value: PrepConfig) {
  if (!value.sheet) throw new Error("Worksheet is required")
  if (!value.columns.length) throw new Error("At least one bounded Excel column is required")
  if (value.start <= value.header || value.end < value.start) throw new Error("Workbook row bounds are invalid")
  return value
}

function table(path: string) {
  const name = path.split("/").at(-1)?.replace(/\.[^.]+$/, "")
  if (!name) throw new Error("Workbook path does not contain a table name")
  const value = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
  if (!value) throw new Error("Workbook name cannot produce a PostgreSQL table name")
  return value
}

function values(draft: StudioDraft, preview: StudioPreview) {
  return Cells.parse(Object.fromEntries(
    preview.columns.filter((item) => !item.system && item.owner !== "formula" && item.owner !== "derived").map((item) => {
      const value = draft[item.name]
      if (value === undefined) throw new Error(`Database row draft is missing ${item.name}`)
      return [item.name, cell(value, item.type)]
    }),
  ))
}

function cell(value: string, type: PreviewType["columns"][number]["type"]) {
  if (!value) return null
  if (type === "boolean") {
    if (value.toLowerCase() === "true") return true
    if (value.toLowerCase() === "false") return false
    throw new Error(`Invalid boolean: ${value}`)
  }
  if (type === "integer") {
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed)) throw new Error(`Invalid integer: ${value}`)
    return parsed
  }
  if (type === "decimal") {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) throw new Error(`Invalid number: ${value}`)
    return parsed
  }
  return value
}

function need<T>(value: T | undefined, error: string): T {
  if (value === undefined) throw new Error(error)
  return value
}

function message(error: unknown) {
  if (error instanceof Error) return error.message
  throw new Error("Data preparation failed with a non-error rejection", { cause: error })
}

function delay(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms))
}

function freeze(value: z.infer<typeof Config>): PrepConfig {
  return Object.freeze({
    ...value,
    columns: Object.freeze([...value.columns]),
    keys: Object.freeze([...value.keys]),
  })
}
