import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh"
import AddIcon from "@mui/icons-material/Add"
import CloudUploadIcon from "@mui/icons-material/CloudUpload"
import CompareArrowsIcon from "@mui/icons-material/CompareArrows"
import DeleteIcon from "@mui/icons-material/Delete"
import SaveAltIcon from "@mui/icons-material/SaveAlt"
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  CssBaseline,
  Paper,
  Stack,
  TextField,
  ThemeProvider,
  Typography,
  createTheme,
} from "@mui/material"
import { DataGrid, GridActionsCellItem, type GridColDef, type GridValidRowModel } from "@mui/x-data-grid"
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { z } from "zod"
import {
  Bridge,
  Datasets,
  Issues,
  Job,
  OpenGuard,
  Preview,
  Profile,
  Project,
  Quota,
  Receipt,
  Recipe,
  Row,
  Rows,
  frame,
  parent,
  parse,
  ready,
  send,
  type Preview as PreviewType,
  type Quota as QuotaType,
  type Recipe as RecipeType,
  type Row as RowType,
} from "./protocol"

type Prep = { path: string; recipe: string }

const theme = createTheme({
  palette: { primary: { main: "#6750a4" }, background: { default: "#f7f7fb" } },
  shape: { borderRadius: 10 },
  typography: { fontFamily: 'Inter, "Roboto", sans-serif' },
})

export function App() {
  const [prep, setPrep] = useState<Prep>()
  const [recipe, setRecipe] = useState<RecipeType>()
  const [sheet, setSheet] = useState("")
  const [header, setHeader] = useState(1)
  const [start, setStart] = useState(2)
  const [end, setEnd] = useState(1000)
  const [columns, setColumns] = useState("")
  const [key, setKey] = useState("")
  const [preview, setPreview] = useState<PreviewType>()
  const [paging, setPaging] = useState({ page: 0, pageSize: 100 })
  const [cursors, setCursors] = useState<Record<number, string | undefined>>({ 0: undefined })
  const [draft, setDraft] = useState<Record<string, string>>()
  const [issues, setIssues] = useState<string[]>([])
  const [quota, setQuota] = useState<QuotaType>()
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const active = useRef<string>()
  const opens = useMemo(() => new OpenGuard(), [])
  const bridge = useMemo(() => new Bridge(() => active.current), [])

  const invoke = useCallback(<T,>(action: string, input: unknown, schema: z.ZodType<T>) =>
    bridge.invoke(action, input, schema), [bridge])

  const database = useCallback(async (next: RecipeType) => {
    if (next.state !== "published") return
    const path = active.current
    if (!path) throw new Error("Data preparation is not open")
    const target = output(next)
    const list = await invoke("datasets", undefined, Datasets)
    if (active.current !== path) return
    const dataset = list.datasets.find(
      (item) => item.prep === next.id && item.table === target.table && item.class === target.class,
    )
    if (!dataset) throw new Error(`Published dataset is unavailable: ${target.table}`)
    const page = await invoke("rows", { dataset: dataset.id, input: { limit: 100 } }, Rows)
    if (active.current !== path) return
    setPaging({ page: 0, pageSize: 100 })
    setCursors({ 0: undefined, 1: page.cursor })
    setPreview({
      dataset: dataset.id,
      columns: dataset.columns,
      rows: page.rows,
      total: dataset.rows,
      truncated: Boolean(page.cursor),
    })
  }, [invoke])

  useEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      if (event.origin !== parent || event.source !== window.parent) return
      const parsed = parse(event.data)
      if (!parsed.success) return
      if (parsed.data.type === "result") {
        bridge.settle(parsed.data)
        return
      }
      if (parsed.data.frame !== frame) return
      if (parsed.data.type === "veritly.iframe.open") {
        if (!opens.accept(parsed.data)) {
          send({ type: "veritly.iframe.loaded", frame, request: parsed.data.request, path: parsed.data.path })
          return
        }
        const path = parsed.data.path
        bridge.reset()
        active.current = path
        setRecipe(undefined)
        setPreview(undefined)
        setDraft(undefined)
        setIssues([])
        setQuota(undefined)
        setBusy(undefined)
        setError(undefined)
        setSheet("")
        setHeader(1)
        setStart(2)
        setEnd(1000)
        setColumns("")
        setKey("")
        setPaging({ page: 0, pageSize: 100 })
        setCursors({ 0: undefined })
        setPrep({ path: parsed.data.path, recipe: parsed.data.payload.recipe })
        send({ type: "veritly.iframe.loaded", frame, request: parsed.data.request, path: parsed.data.path })
        void Promise.all([
          invoke("inspect", undefined, Recipe),
          invoke("project", undefined, Project),
        ]).then(async ([next, project]) => {
            if (active.current !== path) return
            setRecipe(next)
            setQuota(project.quota)
            await database(next)
          }).catch((cause: unknown) => {
            if (active.current === path) setError(message(cause))
          })
        return
      }
      if (parsed.data.type === "veritly.iframe.flush") {
        send({ type: "veritly.iframe.flushed", frame, request: parsed.data.request, path: parsed.data.path })
        return
      }
      if (parsed.data.method === "state") {
        send({
          type: "veritly.iframe.result",
          frame,
          request: parsed.data.request,
          path: parsed.data.path,
          value: { path: parsed.data.path },
        })
        return
      }
      send({
        type: "veritly.iframe.error",
        frame,
        request: parsed.data.request,
        error: `Unsupported data preparation method: ${parsed.data.method}`,
      })
    }
    window.addEventListener("message", receive)
    ready()
    return () => window.removeEventListener("message", receive)
  }, [database, invoke, opens])

  const run = useCallback(
    async <T,>(name: string, input: unknown, schema: z.ZodType<T>) => {
      const path = active.current
      if (!path) throw new Error("Data preparation is not open")
      setBusy(name)
      setError(undefined)
      return invoke(name, input, schema).finally(() => {
        if (active.current === path) setBusy(undefined)
      })
    },
    [invoke],
  )

  const bounds = useMemo(() => {
    const selected = columns
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map(column)
    return {
      header,
      start,
      end,
      left: selected.length ? Math.min(...selected) : 0,
      right: selected.length ? Math.max(...selected) : 0,
    }
  }, [header, start, end, columns])

  const prepare = useCallback(async () => {
    if (!recipe) throw new Error("Preparation recipe is not loaded")
    if (recipe.source.kind !== "workbook") throw new Error("Native data does not have a workbook range")
    if (!sheet.trim()) throw new Error("Worksheet is required")
    if (!bounds.left || !bounds.right) throw new Error("At least one bounded Excel column is required")

    const apply = async (command: unknown) => {
      await run("apply", { expectedVersion: current.version, command }, Receipt)
      current = await invoke("inspect", undefined, Recipe)
      setRecipe(current)
    }
    let current = recipe
    await apply({
      kind: "source",
      id: "source-command",
      after: [],
      output: "source-rows",
      file: recipe.source.file,
      path: recipe.source.path,
      revision: recipe.source.revision,
      sheet: sheet.trim(),
      range: bounds,
    })

    const profile = await run("profile", { dataset: "source-rows" }, Profile)
    const names = profile.columns.map((item) => item.column)
    const identity = key.trim() ? key.trim() : "Veritly ID"
    if (key.trim() && !names.includes(identity)) throw new Error(`Business key column does not exist: ${identity}`)
    await apply({
      kind: "key",
      id: "key-command",
      after: ["source-command"],
      input: "source-rows",
      output: "entity-rows",
      key: key.trim()
        ? { strategy: "existing", columns: [identity] }
        : { strategy: "generated", name: identity },
    })
    await apply({
      kind: "output",
      id: "output-command",
      after: ["key-command"],
      input: "entity-rows",
      schema: current.schema,
      table: table(current.source.kind === "workbook" ? current.source.path : current.path),
      class: "entity",
      keys: [identity],
      owners: Object.fromEntries([
        ...names.map((name) => [name, "shared"]),
        [identity, key.trim() ? "shared" : "workbook"],
      ]),
    })

    const value = await run("preview", { dataset: "entity-rows", limit: 100 }, Preview)
    setPaging({ page: 0, pageSize: 100 })
    setCursors({ 0: undefined })
    setPreview(value)
    const found = await invoke("issues", {}, Issues)
    setIssues(found.filter((issue) => issue.state === "open").map((issue) => issue.id))
  }, [bounds, invoke, key, recipe, run, sheet])

  const edit = useCallback(
    async (row: GridValidRowModel, old: GridValidRowModel) => {
      if (!preview) throw new Error("Preview is not loaded")
      const next = z.object({
        _veritly_id: z.string().uuid(),
        _veritly_version: z.number().int().nonnegative(),
      }).passthrough().parse(row)
      const changed = Object.fromEntries(
        Object.entries(next).filter(([field, value]) => value !== old[field] && !field.startsWith("_veritly_")),
      )
      if (Object.keys(changed).length === 0) return next
      const value = await run("edit", {
        dataset: preview.dataset,
        row: next._veritly_id,
        input: { expectedVersion: next._veritly_version, values: changed },
      }, Row)
      setPreview((current) => current ? {
        ...current,
        rows: current.rows.map((item) => item.id === value.id ? value : item),
      } : current)
      return gridrow(value)
    },
    [preview, run],
  )

  const insert = useCallback(async () => {
    if (!preview || !draft) throw new Error("Database row draft is not ready")
    const values = Object.fromEntries(
      preview.columns
        .filter((item) => !item.system && item.owner !== "formula" && item.owner !== "derived")
        .map((item) => {
          const value = draft[item.name]
          return [item.name, cell(value === undefined ? "" : value, item.type)]
        }),
    )
    await run("insert", { dataset: preview.dataset, input: { values } }, Row)
    setDraft(undefined)
    if (recipe) await database(recipe)
  }, [database, draft, preview, recipe, run])

  const drop = useCallback(async (id: string) => {
    if (!preview) throw new Error("Database rows are not loaded")
    const row = preview.rows.find((item) => item.id === id)
    if (!row) throw new Error("Database row is no longer visible")
    await run("remove", { dataset: preview.dataset, row: id, input: { expectedVersion: row.version } }, Receipt)
    if (recipe) await database(recipe)
  }, [database, preview, recipe, run])

  const paginate = useCallback(async (model: { page: number; pageSize: number }) => {
    if (!preview || recipe?.state !== "published" || model.page === paging.page) return
    const cursor = cursors[model.page]
    if (model.page > 0 && !cursor) return
    setBusy("rows")
    setError(undefined)
    try {
      const page = await invoke("rows", {
        dataset: preview.dataset,
        input: { cursor, limit: 100 },
      }, Rows)
      setPaging(model)
      setCursors((current) => ({ ...current, [model.page + 1]: page.cursor }))
      setPreview((current) => current ? { ...current, rows: page.rows, truncated: Boolean(page.cursor) } : current)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Database page failed")
    } finally {
      setBusy(undefined)
    }
  }, [cursors, invoke, paging.page, preview, recipe?.state])

  if (!prep) {
    return (
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <Box className="waiting"><CircularProgress size={24} /> Waiting for a preparation workflow…</Box>
      </ThemeProvider>
    )
  }

  const grid: GridColDef[] = [
    ...(preview ? preview.columns : []).map((item) => ({
      field: item.name,
      headerName: item.name,
      editable: recipe?.state === "published" && !item.system && !item.key && item.owner !== "formula" && item.owner !== "derived",
      minWidth: 140,
      flex: 1,
    })),
    ...(recipe?.state === "published" ? [{
      field: "__actions",
      type: "actions" as const,
      width: 52,
      getActions: ({ id }: { id: string | number }) => [
        <GridActionsCellItem
          key="delete"
          icon={<DeleteIcon />}
          label="Delete row"
          onClick={() => drop(String(id)).catch((cause: unknown) => setError(message(cause)))}
        />,
      ],
    }] : []),
  ]
  const rows = (preview ? preview.rows : []).map(gridrow)

  const execute = async (name: "publish" | "writeback" | "reconcile") => {
    if (!recipe) throw new Error("Preparation recipe is not loaded")
    const target = output(recipe)
    const input = name === "publish"
      ? {
          expectedVersion: recipe.version,
          mode: recipe.source.kind === "native" ? "replace" : "upsert",
          dataset: target.id,
        }
      : { expectedVersion: recipe.version }
    return run(name, input, Job).then(async (job) => {
      const end = Date.now() + 60_000
      let current = job
      while (current.state === "queued" || current.state === "running") {
        if (Date.now() >= end) throw new Error(`${name} is still running; check its job status`)
        await new Promise((resolve) => window.setTimeout(resolve, 500))
        current = await invoke("status", { job: current.id }, Job)
      }
      if (current.state !== "succeeded") {
        if (current.error) throw new Error(current.error)
        throw new Error(`${name} ended in ${current.state}`)
      }
      const [next, project] = await Promise.all([
        invoke("inspect", undefined, Recipe),
        invoke("project", undefined, Project),
      ])
      setRecipe(next)
      setQuota(project.quota)
      await database(next)
      return current
    })
  }

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box className="studio">
        <Stack className="title" direction="row" justifyContent="space-between" alignItems="center">
          <Box>
            <Typography variant="h5">Prepare project data</Typography>
            <Typography color="text.secondary" variant="body2">{prep.path}</Typography>
          </Box>
          <Stack direction="row" gap={1}>
            {quota && <Chip label={quotaLabel(quota)} color={quota.percent >= 90 ? "error" : quota.percent >= 80 ? "warning" : "default"} />}
            <Chip label={issues.length ? `${issues.length} issues` : "Ready to profile"} color={issues.length ? "warning" : "default"} />
            <Button startIcon={<AutoFixHighIcon />} disabled={!issues.length} onClick={() => send({ type: "veritly.data.ai", path: prep.path, issues })}>Fix with AI</Button>
          </Stack>
        </Stack>

        {error && <Alert severity="error" onClose={() => setError(undefined)}>{error}</Alert>}

        <Paper className="recipe" variant="outlined">
          <Stack direction="row" gap={1.5} flexWrap="wrap" alignItems="center">
            <TextField size="small" label="Worksheet" value={sheet} onChange={(event) => setSheet(event.target.value)} />
            <TextField size="small" label="Header row" type="number" value={header} onChange={(event) => setHeader(Number(event.target.value))} />
            <TextField size="small" label="First data row" type="number" value={start} onChange={(event) => setStart(Number(event.target.value))} />
            <TextField size="small" label="Last data row" type="number" value={end} onChange={(event) => setEnd(Number(event.target.value))} />
            <TextField size="small" label="Columns (A,B,C)" value={columns} onChange={(event) => setColumns(event.target.value)} />
            <TextField size="small" label="Business key (optional)" value={key} onChange={(event) => setKey(event.target.value)} />
            <Button variant="contained" disabled={!recipe || Boolean(busy)} onClick={() => prepare().catch((cause: unknown) => setError(message(cause)))}>Profile and preview</Button>
          </Stack>
        </Paper>

        <Paper className="grid" variant="outlined">
          <DataGrid
            rows={rows}
            columns={grid}
            getRowId={(row) => row._veritly_id}
            pageSizeOptions={[100]}
            paginationMode={recipe?.state === "published" ? "server" : "client"}
            paginationModel={paging}
            {...(recipe?.state === "published" ? { rowCount: preview ? preview.total : 0 } : {})}
            onPaginationModelChange={(model) => void paginate(model)}
            processRowUpdate={edit}
            onProcessRowUpdateError={(cause) => setError(cause instanceof Error ? cause.message : "Row update failed")}
            loading={Boolean(busy)}
            disableRowSelectionOnClick
          />
        </Paper>

        {draft && preview && (
          <Paper className="recipe" variant="outlined">
            <Stack direction="row" gap={1.5} flexWrap="wrap" alignItems="center">
              {preview.columns.filter((item) => !item.system && item.owner !== "formula" && item.owner !== "derived").map((item) => (
                <TextField
                  key={item.id}
                  size="small"
                  label={item.name}
                  value={draft[item.name] === undefined ? "" : draft[item.name]}
                  onChange={(event) => setDraft((current) => ({ ...current, [item.name]: event.target.value }))}
                />
              ))}
              <Button variant="contained" disabled={Boolean(busy)} onClick={() => insert().catch((cause: unknown) => setError(message(cause)))}>Create row</Button>
              <Button disabled={Boolean(busy)} onClick={() => setDraft(undefined)}>Cancel</Button>
            </Stack>
          </Paper>
        )}

        <Stack className="actions" direction="row" gap={1} justifyContent="flex-end">
          <Button startIcon={<AddIcon />} disabled={recipe?.state !== "published" || Boolean(busy)} onClick={() => setDraft({})}>Add row</Button>
          <Button startIcon={<SaveAltIcon />} disabled={!recipe || recipe.source.kind !== "workbook" || Boolean(busy)} onClick={() => execute("writeback").catch((cause: unknown) => setError(message(cause)))}>Write back</Button>
          <Button startIcon={<CompareArrowsIcon />} disabled={!recipe || recipe.source.kind !== "workbook" || Boolean(busy)} onClick={() => execute("reconcile").catch((cause: unknown) => setError(message(cause)))}>Reconcile</Button>
          <Button variant="contained" startIcon={<CloudUploadIcon />} disabled={!recipe || Boolean(busy)} onClick={() => execute("publish").catch((cause: unknown) => setError(message(cause)))}>Publish</Button>
        </Stack>
      </Box>
    </ThemeProvider>
  )
}

function column(value: string) {
  if (/^[1-9][0-9]*$/.test(value)) return Number(value)
  if (!/^[a-z]+$/i.test(value)) throw new Error(`Invalid Excel column: ${value}`)
  return [...value.toUpperCase()].reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0)
}

function table(path: string) {
  const name = path.split("/").at(-1)?.replace(/\.[^.]+$/, "")
  if (!name) throw new Error("Workbook path does not contain a table name")
  const value = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
  if (!value) throw new Error("Workbook name cannot produce a PostgreSQL table name")
  return value
}

function output(recipe: RecipeType) {
  const command = recipe.commands.filter((item) => item.kind === "output").at(-1)
  if (!command) throw new Error("Preparation recipe has no published output")
  if (!command.table) throw new Error("Preparation output has no table")
  if (!command.class) throw new Error("Preparation output has no class")
  return { id: command.id, table: command.table, class: command.class }
}

function gridrow(row: RowType) {
  return { ...row.values, _veritly_id: row.id, _veritly_version: row.version }
}

function bytes(value: number) {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GiB`
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MiB`
  return `${value} B`
}

function quotaLabel(quota: QuotaType) {
  const state = quota.percent >= 90 ? " — critical" : quota.percent >= 80 ? " — warning" : ""
  return `${bytes(quota.used)} / ${bytes(quota.limit)} (${quota.percent.toFixed(1)}%)${state}`
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

function message(cause: unknown) {
  if (cause instanceof Error) return cause.message
  throw new Error("Data preparation failed with a non-error rejection", { cause })
}
