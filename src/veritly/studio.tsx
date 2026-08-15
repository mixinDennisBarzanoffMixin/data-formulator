import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh"
import CloudUploadIcon from "@mui/icons-material/CloudUpload"
import CompareArrowsIcon from "@mui/icons-material/CompareArrows"
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
import { DataGrid, type GridColDef, type GridValidRowModel } from "@mui/x-data-grid"
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { frame, parent, type Incoming, type Preview, ready, send } from "./protocol"

type Prep = { path: string; recipe: string }
type Source =
  | { kind: "workbook"; file: string; path: string; revision: number }
  | { kind: "native" }
type Recipe = {
  id: string
  path: string
  schema: string
  source: Source
  version: number
  state: "draft" | "ready" | "published" | "source_missing" | "repairing"
}
type Profile = {
  dataset: string
  rows: number
  columns: Array<{ column: string; type: string }>
  issues: number
}
type Issue = { id: string; state: "open" | "resolved" }
type Row = { id: string; version: number; values: Record<string, unknown> }
type Job = { id: string; state: "queued" | "running" | "succeeded" | "failed" | "cancelled"; error?: string }
type Quota = { used: number; limit: number; percent: number }
type Pending = { resolve(value: unknown): void; reject(error: Error): void }

const theme = createTheme({
  palette: { primary: { main: "#6750a4" }, background: { default: "#f7f7fb" } },
  shape: { borderRadius: 10 },
  typography: { fontFamily: 'Inter, "Roboto", sans-serif' },
})

export function App() {
  const [prep, setPrep] = useState<Prep>()
  const [recipe, setRecipe] = useState<Recipe>()
  const [sheet, setSheet] = useState("")
  const [header, setHeader] = useState(1)
  const [start, setStart] = useState(2)
  const [end, setEnd] = useState(1000)
  const [columns, setColumns] = useState("")
  const [key, setKey] = useState("")
  const [preview, setPreview] = useState<Preview>()
  const [issues, setIssues] = useState<string[]>([])
  const [quota, setQuota] = useState<Quota>()
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const pending = useRef(new Map<string, Pending>())

  const invoke = useCallback((action: string, input?: unknown) => {
    const id = crypto.randomUUID()
    send({ type: "invoke", id, action, input })
    return new Promise<unknown>((resolve, reject) => pending.current.set(id, { resolve, reject }))
  }, [])

  useEffect(() => {
    const receive = (event: MessageEvent<Incoming>) => {
      if (event.origin !== parent) return
      if (event.data.type === "result") {
        const call = pending.current.get(event.data.id)
        if (!call) return
        pending.current.delete(event.data.id)
        if (event.data.ok) {
          call.resolve(event.data.value)
          return
        }
        call.reject(new Error(event.data.error))
        return
      }
      if (event.data.frame !== frame) return
      if (event.data.type === "veritly.iframe.open") {
        setPrep({ path: event.data.path, recipe: event.data.payload.recipe })
        send({ type: "veritly.iframe.loaded", frame, request: event.data.request, path: event.data.path })
        void Promise.all([invoke("inspect"), invoke("project")]).then(
          ([value, project]) => {
            setRecipe(value as Recipe)
            setQuota((project as { quota: Quota }).quota)
          },
          (cause: Error) => setError(cause.message),
        )
        return
      }
      if (event.data.type === "veritly.iframe.flush") {
        send({ type: "veritly.iframe.flushed", frame, request: event.data.request, path: event.data.path })
        return
      }
      if (event.data.method === "state") {
        send({
          type: "veritly.iframe.result",
          frame,
          request: event.data.request,
          path: event.data.path,
          value: { path: event.data.path },
        })
        return
      }
      send({
        type: "veritly.iframe.error",
        frame,
        request: event.data.request,
        error: `Unsupported data preparation method: ${event.data.method}`,
      })
    }
    window.addEventListener("message", receive)
    ready()
    return () => window.removeEventListener("message", receive)
  }, [invoke])

  const run = useCallback(
    async (name: string, input?: unknown) => {
      setBusy(name)
      setError(undefined)
      return invoke(name, input).finally(() => setBusy(undefined))
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
      await run("apply", { expectedVersion: current.version, command })
      current = (await invoke("inspect")) as Recipe
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

    const profile = (await run("profile", { dataset: "source-rows" })) as Profile
    const names = profile.columns.map((item) => item.column)
    const identity = key.trim() || "Veritly ID"
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
      owners: Object.fromEntries([...names, identity].map((name) => [name, "shared"])),
    })

    const value = (await run("preview", { dataset: "entity-rows", limit: 100 })) as Preview
    setPreview(value)
    const found = (await invoke("issues", {})) as Issue[]
    setIssues(found.filter((issue) => issue.state === "open").map((issue) => issue.id))
  }, [bounds, invoke, key, recipe, run, sheet])

  const edit = useCallback(
    async (row: GridValidRowModel, old: GridValidRowModel) => {
      if (!preview) throw new Error("Preview is not loaded")
      const changed = Object.fromEntries(
        Object.entries(row).filter(([field, value]) => value !== old[field] && !field.startsWith("_veritly_")),
      )
      if (Object.keys(changed).length === 0) return row
      const value = (await run("edit", {
        dataset: preview.dataset,
        row: row._veritly_id,
        input: { expectedVersion: row._veritly_version, values: changed },
      })) as Row
      return gridrow(value)
    },
    [preview, run],
  )

  if (!prep) {
    return (
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <Box className="waiting"><CircularProgress size={24} /> Waiting for a preparation workflow…</Box>
      </ThemeProvider>
    )
  }

  const grid: GridColDef[] = (preview?.columns || []).map((item) => ({
    field: item.name,
    headerName: item.name,
    editable: recipe?.state === "published" && item.owner !== "formula" && item.owner !== "derived",
    minWidth: 140,
    flex: 1,
  }))
  const rows = (preview?.rows || []).map(gridrow)

  const execute = (name: "publish" | "writeback" | "reconcile") => {
    if (!recipe) return Promise.reject(new Error("Preparation recipe is not loaded"))
    const input = name === "publish"
      ? { expectedVersion: recipe.version, mode: "upsert", dataset: "entity-rows" }
      : { expectedVersion: recipe.version }
    return run(name, input).then(async (value) => {
      const job = value as Job
      const end = Date.now() + 60_000
      let current = job
      while (current.state === "queued" || current.state === "running") {
        if (Date.now() >= end) throw new Error(`${name} is still running; check its job status`)
        await new Promise((resolve) => window.setTimeout(resolve, 500))
        current = (await invoke("status", { job: current.id })) as Job
      }
      if (current.state !== "succeeded") throw new Error(current.error || `${name} ended in ${current.state}`)
      const [next, project] = await Promise.all([invoke("inspect"), invoke("project")])
      setRecipe(next as Recipe)
      setQuota((project as { quota: Quota }).quota)
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
            {quota && <Chip label={`${bytes(quota.used)} / ${bytes(quota.limit)} (${quota.percent.toFixed(1)}%)`} color={quota.percent >= 100 ? "error" : quota.percent >= 80 ? "warning" : "default"} />}
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
            <Button variant="contained" disabled={!recipe || Boolean(busy)} onClick={() => prepare().catch((cause: Error) => setError(cause.message))}>Profile and preview</Button>
          </Stack>
        </Paper>

        <Paper className="grid" variant="outlined">
          <DataGrid
            rows={rows}
            columns={grid}
            getRowId={(row) => row._veritly_id}
            pageSizeOptions={[100]}
            initialState={{ pagination: { paginationModel: { page: 0, pageSize: 100 } } }}
            processRowUpdate={edit}
            onProcessRowUpdateError={(cause) => setError(cause instanceof Error ? cause.message : "Row update failed")}
            loading={Boolean(busy)}
            disableRowSelectionOnClick
          />
        </Paper>

        <Stack className="actions" direction="row" gap={1} justifyContent="flex-end">
          <Button startIcon={<SaveAltIcon />} disabled={!recipe || Boolean(busy)} onClick={() => execute("writeback").catch((cause: Error) => setError(cause.message))}>Write back</Button>
          <Button startIcon={<CompareArrowsIcon />} disabled={!recipe || Boolean(busy)} onClick={() => execute("reconcile").catch((cause: Error) => setError(cause.message))}>Reconcile</Button>
          <Button variant="contained" startIcon={<CloudUploadIcon />} disabled={!recipe || Boolean(busy)} onClick={() => execute("publish").catch((cause: Error) => setError(cause.message))}>Publish</Button>
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

function gridrow(row: Row) {
  return { ...row.values, _veritly_id: row.id, _veritly_version: row.version }
}

function bytes(value: number) {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GiB`
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MiB`
  return `${value} B`
}
