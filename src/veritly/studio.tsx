import AddIcon from "@mui/icons-material/Add"
import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh"
import CloudUploadIcon from "@mui/icons-material/CloudUpload"
import CompareArrowsIcon from "@mui/icons-material/CompareArrows"
import DataObjectIcon from "@mui/icons-material/DataObject"
import DeleteIcon from "@mui/icons-material/Delete"
import DownloadIcon from "@mui/icons-material/Download"
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline"
import GridViewIcon from "@mui/icons-material/GridView"
import KeyIcon from "@mui/icons-material/Key"
import RefreshIcon from "@mui/icons-material/Refresh"
import SaveAltIcon from "@mui/icons-material/SaveAlt"
import StorageIcon from "@mui/icons-material/Storage"
import TableChartIcon from "@mui/icons-material/TableChart"
import {
  Alert,
  Box,
  Button,
  ButtonGroup,
  Chip,
  CircularProgress,
  CssBaseline,
  Divider,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  IconButton,
  LinearProgress,
  MenuItem,
  Select,
  Stack,
  Tab,
  Tabs,
  TextField,
  ThemeProvider,
  Tooltip,
  Typography,
  createTheme,
} from "@mui/material"
import { DataGrid, type GridColDef, type GridValidRowModel } from "@mui/x-data-grid"
import React, { useCallback, useEffect, useMemo, useSyncExternalStore } from "react"
import { PrepStudio, studio } from "./controller"
import { output as recipeOutput } from "./model"
import type {
  Command,
  PrepConfig,
  PrepRecipe,
  StudioGate,
  StudioPreview as Preview,
  StudioState,
  StudioTransform,
} from "./model"
import type { Profile, Row } from "./protocol"

type GridRow = GridValidRowModel & {
  _veritly_id: string
  _veritly_version: number
}

const theme = createTheme({
  palette: {
    primary: { main: "#6750a4" },
    background: { default: "#f5f5f5", paper: "#fff" },
  },
  shape: { borderRadius: 4 },
  typography: { fontFamily: 'Inter, "Roboto", sans-serif', button: { textTransform: "none" } },
  components: {
    MuiButton: { defaultProps: { size: "small" } },
    MuiTab: { styleOverrides: { root: { minHeight: 34, padding: "5px 14px", textTransform: "none" } } },
  },
})

export function App() {
  const model = useMemo(studio, [])
  const subscribe = useCallback((watch: () => void) => model.subscribe(watch), [model])
  const snapshot = useCallback(() => model.get(), [model])
  const state = useSyncExternalStore(subscribe, snapshot, snapshot)

  useEffect(() => {
    model.mount()
    return () => model.unmount()
  }, [model])

  if (!state.prep || state.phase !== "ready") {
    return (
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <Box className="waiting"><CircularProgress size={24} /> Loading data preparation…</Box>
      </ThemeProvider>
    )
  }

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box className="studio">
        <Header model={model} state={state} />
        <Ribbon model={model} state={state} />
        <Box className="studio-alert">
          {state.error && <Alert severity="error" onClose={() => model.clear()}>{state.error}</Alert>}
        </Box>
        <Box className="studio-body">
          <Queries model={model} state={state} />
          <Workspace model={model} state={state} />
          <Settings model={model} state={state} />
        </Box>
        <Status state={state} />
        <Transform model={model} state={state} />
      </Box>
    </ThemeProvider>
  )
}

function Header({ model, state }: ViewProps) {
  if (!state.prep) throw new Error("Data preparation header requires an open workflow")
  const recipe = state.recipe
  const published = recipe?.state === "published"
  const mode = recipe?.source.kind === "native" ? "replace" : "upsert"
  return (
    <Box className="studio-header">
      <Box className="studio-title">
        <DataObjectIcon color="primary" />
        <Box minWidth={0}>
          <Typography fontSize={15} fontWeight={650} noWrap>{state.prep.path}</Typography>
          <Typography color="text.secondary" fontSize={11} noWrap>
            {recipe ? `${recipe.schema} · recipe v${recipe.version}` : "Loading recipe"}
          </Typography>
        </Box>
        {recipe && <Chip size="small" label={stateLabel(recipe.state)} color={published ? "success" : "default"} />}
      </Box>
      <Box className="studio-actions">
        <Action gate={state.gates.writeback} label="Write back">
          <Button startIcon={<SaveAltIcon />} onClick={() => act(model.writeback())}>Write back</Button>
        </Action>
        <Action gate={state.gates.reconcile} label="Reconcile">
          <Button startIcon={<CompareArrowsIcon />} onClick={() => act(model.reconcile())}>Reconcile</Button>
        </Action>
        <Action gate={state.gates.publish} label="Publish">
          <Button variant="contained" startIcon={<CloudUploadIcon />} onClick={() => act(model.publish({ mode }))}>
            Publish
          </Button>
        </Action>
      </Box>
    </Box>
  )
}

function Ribbon({ model, state }: ViewProps) {
  const dataset = state.view.dataset
  return (
    <Box className="ribbon">
      <Tabs
        className="ribbon-tabs"
        value={state.view.ribbon}
        onChange={(_, value: StudioState["view"]["ribbon"]) => model.view({ ribbon: value })}
      >
        <Tab value="home" label="Home" />
        <Tab value="transform" label="Transform" disabled={!state.gates.transform.enabled} />
        <Tab value="column" label="Add column" disabled={!state.gates.transform.enabled} />
        <Tab
          value="combine"
          disabled
          label={<Tooltip title="Join, union, and pivot editors are not implemented yet"><span>Combine</span></Tooltip>}
        />
        <Tab value="view" label="View" />
      </Tabs>
      <Box className="ribbon-tools">
        {state.view.ribbon === "home" && <Home model={model} state={state} dataset={dataset} />}
        {state.view.ribbon === "transform" && <TransformTools model={model} state={state} />}
        {state.view.ribbon === "column" && <ColumnTools model={model} state={state} />}
        {state.view.ribbon === "view" && <Views model={model} state={state} />}
      </Box>
    </Box>
  )
}

function TransformTools({ model, state }: ViewProps) {
  return (
    <>
      <Box className="ribbon-group">
        <Typography color="text.secondary" fontSize={11}>Text</Typography>
        <Action gate={state.gates.transform} label="Trim values"><Button onClick={() => model.openTransform("trim")}>Trim</Button></Action>
        <Action gate={state.gates.transform} label="Change case"><Button onClick={() => model.openTransform("case")}>Change case</Button></Action>
        <Action gate={state.gates.transform} label="Rename column"><Button onClick={() => model.openTransform("rename")}>Rename</Button></Action>
      </Box>
      <Box className="ribbon-group">
        <Typography color="text.secondary" fontSize={11}>Type</Typography>
        <Action gate={state.gates.transform} label="Change data type"><Button onClick={() => model.openTransform("cast")}>Data type</Button></Action>
      </Box>
    </>
  )
}

function ColumnTools({ model, state }: ViewProps) {
  return (
    <Box className="ribbon-group">
      <Typography color="text.secondary" fontSize={11}>Expression</Typography>
      <Action gate={state.gates.transform} label="Add custom column"><Button onClick={() => model.openTransform("derive")}>Custom column</Button></Action>
    </Box>
  )
}

function Home({ model, state, dataset }: ViewProps & { dataset?: string }) {
  return (
    <>
      <Box className="ribbon-group">
        <Action gate={state.gates.prepare} label="Profile and preview source">
          <Button variant="outlined" startIcon={<TableChartIcon />} onClick={() => act(model.prepare())}>
            Profile & preview
          </Button>
        </Action>
        <Button
          startIcon={<RefreshIcon />}
          disabled={!dataset || Boolean(state.busy)}
          onClick={() => dataset && act(model.preview({ dataset, limit: 100 }))}
        >
          Refresh
        </Button>
        <Action gate={state.gates.profile} label="Profile the selected query">
          <Button startIcon={<TableChartIcon />} onClick={() => dataset && act(model.profile(dataset))}>Run profile</Button>
        </Action>
      </Box>
      <Box className="ribbon-group">
        <Action gate={state.gates.insert} label="Add database row">
          <Button startIcon={<AddIcon />} onClick={() => model.draft({})}>New row</Button>
        </Action>
        <Action gate={state.gates.export} label="Export project database">
          <Button startIcon={<DownloadIcon />} onClick={() => act(model.export())}>Export</Button>
        </Action>
      </Box>
      <Box className="ribbon-group">
        <Typography color="text.secondary" fontSize={11}>Publish mode</Typography>
        <ButtonGroup size="small" disabled={!state.gates.publish.enabled}>
          <Button onClick={() => act(model.publish({ mode: "replace" }))}>Replace</Button>
          <Button onClick={() => act(model.publish({ mode: "append" }))}>Append</Button>
          <Button onClick={() => act(model.publish({ mode: "upsert" }))}>Upsert</Button>
        </ButtonGroup>
      </Box>
      <Box className="ribbon-group">
        <Action gate={state.gates.ai} label="Fix diagnostics with AI">
          <Button startIcon={<AutoFixHighIcon />} onClick={() => model.ai()}>Fix with AI</Button>
        </Action>
        <Action gate={state.gates.cancel} label="Cancel running job">
          <Button color="error" onClick={() => act(model.cancel())}>Cancel job</Button>
        </Action>
      </Box>
    </>
  )
}

function Views({ model, state }: ViewProps) {
  return (
    <Box className="ribbon-group">
      <Button variant={state.view.detail === "profile" ? "contained" : "text"} onClick={() => model.view({ detail: "profile" })}>
        Column profile
      </Button>
      <Button variant={state.view.detail === "issues" ? "contained" : "text"} onClick={() => model.view({ detail: "issues" })}>
        Issues
      </Button>
      <Button variant={state.view.detail === "jobs" ? "contained" : "text"} onClick={() => model.view({ detail: "jobs" })}>
        Job
      </Button>
    </Box>
  )
}

function Queries({ model, state }: ViewProps) {
  const recipe = state.recipe
  if (!recipe) return <Box className="queries" />
  const commands = recipe.commands.filter((command) => target(command))
  return (
    <Box className="queries">
      <Box className="pane-title"><Typography fontSize={12} fontWeight={650}>Queries</Typography></Box>
      <Box className="pane-scroll">
        <button className="query-row" type="button">
          {recipe.source.kind === "workbook" ? <TableChartIcon fontSize="small" /> : <StorageIcon fontSize="small" />}
          <Box minWidth={0}>
            <Typography fontSize={12} fontWeight={600} noWrap>
              {recipe.source.kind === "workbook" ? name(recipe.source.path) : "Native table"}
            </Typography>
            <Typography color="text.secondary" fontSize={10} noWrap>{recipe.source.kind}</Typography>
          </Box>
        </button>
        <Divider />
        {commands.map((command) => {
          const dataset = target(command)
          const selected = dataset && dataset === state.view.dataset
          return (
            <button
              className={`query-row${selected ? " selected" : ""}`}
              key={command.id}
              type="button"
              onClick={() => dataset && show(model, dataset, command.id)}
            >
              <GridViewIcon fontSize="small" color={command.kind === "output" ? "primary" : "inherit"} />
              <Box minWidth={0}>
                <Typography fontSize={12} noWrap>{command.kind === "output" ? command.table : label(command.kind)}</Typography>
                <Typography color="text.secondary" fontSize={10} noWrap>{label(command.kind)}</Typography>
              </Box>
            </button>
          )
        })}
        {state.datasets.map((dataset) => (
          <button
            className={`query-row${state.view.dataset === dataset.id ? " selected" : ""}`}
            key={dataset.id}
            type="button"
            onClick={() => show(model, dataset.id)}
          >
            <StorageIcon fontSize="small" color="primary" />
            <Box minWidth={0}>
              <Typography fontSize={12} noWrap>{dataset.table}</Typography>
              <Typography color="text.secondary" fontSize={10} noWrap>{dataset.rows.toLocaleString()} database rows</Typography>
            </Box>
          </button>
        ))}
      </Box>
    </Box>
  )
}

function Workspace({ model, state }: ViewProps) {
  const command = state.recipe?.commands.find((item) => item.id === state.view.step)
  return (
    <Box className="workspace">
      <Box className="formula">
        <Typography className="formula-kind" fontSize={12}>fx</Typography>
        <Typography className="formula-text" fontSize={12}>
          {command ? describe(command.kind) : "Select a source or applied step to inspect its rows"}
        </Typography>
      </Box>
      <Box className="grid-shell">
        {state.preview ? <Grid model={model} state={state} preview={state.preview} /> : <Source model={model} state={state} />}
      </Box>
      <Details model={model} state={state} />
    </Box>
  )
}

function Grid({ model, state, preview }: ViewProps & { preview: Preview }) {
  const rows = preview.rows.map(gridrow)
  const columns = gridcols(model, state, preview)
  const server = state.recipe?.state === "published" && state.datasets.some((dataset) => dataset.id === preview.dataset)
  return (
    <Box className="grid">
      <DataGrid<GridRow>
        rows={rows}
        columns={columns}
        getRowId={(row) => row._veritly_id}
        pageSizeOptions={[100]}
        paginationMode={server ? "server" : "client"}
        paginationModel={state.paging}
        rowCount={server ? preview.total : rows.length}
        onPaginationModelChange={(page) => act(model.page(page))}
        processRowUpdate={(row) => update(model, preview, row)}
        onProcessRowUpdateError={() => undefined}
        loading={Boolean(state.busy)}
        disableRowSelectionOnClick
        density="compact"
        showToolbar
        sx={{ border: 0, "& .MuiDataGrid-columnHeaders": { background: "#fafafa" } }}
      />
    </Box>
  )
}

function Source({ model, state }: ViewProps) {
  const recipe = state.recipe
  if (!recipe) return <Box className="waiting"><CircularProgress size={22} /></Box>
  if (recipe.source.kind === "native") {
    return (
      <Box className="waiting">
        <StorageIcon color="primary" />
        <Typography>Create the native table schema before publishing.</Typography>
      </Box>
    )
  }
  return (
    <Box height="100%" overflow="auto" bgcolor="#fff" border="1px solid #d4d4d4">
      <Box className="source-card">
        <Stack direction="row" alignItems="center" gap={1} mb={1.5}>
          <TableChartIcon color="primary" />
          <Box>
            <Typography fontSize={14} fontWeight={650}>Select workbook data</Typography>
            <Typography color="text.secondary" fontSize={11}>{recipe.source.path}</Typography>
          </Box>
        </Stack>
        <Box className="source-fields">
          <FormControl className="wide" size="small">
            <InputLabel id="worksheet-label">Worksheet</InputLabel>
            <Select
              labelId="worksheet-label"
              label="Worksheet"
              value={state.config.sheet}
              onChange={(event) => select(model, state.config, { sheet: event.target.value })}
            >
              {state.catalog?.sheets.map((sheet) => (
                <MenuItem key={sheet.name} value={sheet.name}>
                  {sheet.name}{sheet.visibility === "visible" ? "" : ` (${label(sheet.visibility)})`}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <TextField
            size="small"
            type="number"
            label="Header row"
            value={state.config.header}
            onChange={(event) => select(model, state.config, { header: Number(event.target.value) })}
          />
          <TextField
            size="small"
            type="number"
            label="First data row"
            value={state.config.start}
            onChange={(event) => select(model, state.config, { start: Number(event.target.value) })}
          />
          <TextField
            size="small"
            label="First column"
            value={letters(state.config.columns[0])}
            onChange={(event) => select(model, state.config, { columns: span(index(event.target.value), last(state.config.columns)) })}
          />
          <TextField
            size="small"
            label="Last column"
            value={letters(last(state.config.columns))}
            onChange={(event) => select(model, state.config, { columns: span(state.config.columns[0], index(event.target.value)) })}
          />
          <TextField
            className="wide"
            size="small"
            type="number"
            label="Last data row"
            value={state.config.end}
            onChange={(event) => select(model, state.config, { end: Number(event.target.value) })}
          />
          <TextField
            className="wide"
            size="small"
            label="Business key"
            helperText="Leave blank to add a visible Veritly ID column."
            value={state.config.keys.join(", ")}
            onChange={(event) => select(model, state.config, { keys: names(event.target.value) })}
          />
        </Box>
        <Stack direction="row" justifyContent="flex-end" mt={2}>
          <Action gate={state.gates.prepare} label="Profile and preview source">
            <Button variant="contained" onClick={() => act(model.prepare())}>Profile & preview</Button>
          </Action>
        </Stack>
      </Box>
    </Box>
  )
}

function Settings({ model, state }: ViewProps) {
  const recipe = state.recipe
  return (
    <Box className="settings">
      <Box className="pane-title"><Typography fontSize={12} fontWeight={650}>Query settings</Typography></Box>
      <Box className="property">
        <Typography color="text.secondary" fontSize={11}>Name</Typography>
        <Typography fontSize={11} noWrap>{state.prep?.path}</Typography>
        <Typography color="text.secondary" fontSize={11}>Output</Typography>
        <Typography fontSize={11} noWrap>{output(recipe)}</Typography>
        <Typography color="text.secondary" fontSize={11}>Sync</Typography>
        <Typography fontSize={11}>{recipe ? stateLabel(recipe.state) : "Loading"}</Typography>
      </Box>
      <Box className="pane-title">
        <Typography fontSize={12} fontWeight={650}>Applied steps</Typography>
      </Box>
      <Box className="pane-scroll">
        {recipe?.commands.map((command, offset) => (
          <button
            className={`step-row${state.view.step === command.id ? " selected" : ""}`}
            key={command.id}
            type="button"
            onClick={() => {
              const dataset = target(command)
              if (dataset) show(model, dataset, command.id)
              if (!dataset) model.view({ step: command.id })
            }}
          >
            <Chip size="small" label={offset + 1} sx={{ width: 25, height: 21, fontSize: 10 }} />
            <Box minWidth={0}>
              <Typography fontSize={11} fontWeight={550} noWrap>{label(command.kind)}</Typography>
              <Typography color="text.secondary" fontSize={9} noWrap>{command.id}</Typography>
            </Box>
          </button>
        ))}
        {!recipe?.commands.length && (
          <Box p={2}>
            <Typography color="text.secondary" fontSize={11}>Select a workbook range to create the source step.</Typography>
          </Box>
        )}
      </Box>
    </Box>
  )
}

function Transform({ model, state }: ViewProps) {
  const draft = state.transform
  const target = state.recipe ? recipeOutput(state.recipe) : undefined
  const columns = state.preview?.columns.filter((item) => !item.system && !target?.keys.includes(item.name)).map((item) => item.name)
  return (
    <Dialog open={Boolean(draft)} onClose={() => model.closeTransform()} fullWidth maxWidth="sm">
      <DialogTitle>{draft ? transformTitle(draft.kind) : "Transform"}</DialogTitle>
      <DialogContent>
        {draft && columns && <TransformFields model={model} draft={draft} columns={columns} />}
      </DialogContent>
      <DialogActions>
        <Button onClick={() => model.closeTransform()}>Cancel</Button>
        <Button variant="contained" disabled={Boolean(state.busy)} onClick={() => act(model.commitTransform())}>Add step</Button>
      </DialogActions>
    </Dialog>
  )
}

function TransformFields({ model, draft, columns }: {
  model: PrepStudio
  draft: StudioTransform
  columns: string[]
}) {
  if (draft.kind === "trim" || draft.kind === "case") {
    return (
      <Stack gap={2} pt={1}>
        <Typography color="text.secondary" fontSize={12}>Choose one or more columns.</Typography>
        <Stack direction="row" gap={1} flexWrap="wrap">
          {columns.map((column) => (
            <Chip
              key={column}
              clickable
              disabled={draft.columns.length === 1 && draft.columns[0] === column}
              color={draft.columns.includes(column) ? "primary" : "default"}
              label={column}
              onClick={() => model.patchTransform({ columns: toggle(draft.columns, column) })}
            />
          ))}
        </Stack>
        {draft.kind === "case" && (
          <Field label="Case">
            <Select value={draft.mode} label="Case" onChange={(event) => model.patchTransform({ mode: event.target.value })}>
              <MenuItem value="lower">lowercase</MenuItem>
              <MenuItem value="upper">UPPERCASE</MenuItem>
              <MenuItem value="title">Title Case</MenuItem>
            </Select>
          </Field>
        )}
      </Stack>
    )
  }
  if (draft.kind === "rename") {
    return (
      <Stack gap={2} pt={1}>
        <ColumnField columns={columns} value={draft.column} onChange={(column) => model.patchTransform({ column })} />
        <TextField label="New name" value={draft.name} onChange={(event) => model.patchTransform({ name: event.target.value })} />
      </Stack>
    )
  }
  if (draft.kind === "cast") {
    return (
      <Stack gap={2} pt={1}>
        <ColumnField columns={columns} value={draft.column} onChange={(column) => model.patchTransform({ column })} />
        <Field label="Data type">
          <Select value={draft.type} label="Data type" onChange={(event) => model.patchTransform({ type: event.target.value })}>
            {types.map((type) => <MenuItem key={type} value={type}>{label(type)}</MenuItem>)}
          </Select>
        </Field>
        <Field label="Invalid values">
          <Select value={draft.invalid} label="Invalid values" onChange={(event) => model.patchTransform({ invalid: event.target.value })}>
            <MenuItem value="reject">Block the run</MenuItem>
            <MenuItem value="null">Convert to null</MenuItem>
          </Select>
        </Field>
      </Stack>
    )
  }
  return (
    <Stack gap={2} pt={1}>
      <TextField label="Column name" value={draft.name} onChange={(event) => model.patchTransform({ name: event.target.value })} />
      <Field label="Data type">
        <Select value={draft.type} label="Data type" onChange={(event) => model.patchTransform({ type: event.target.value })}>
          {types.map((type) => <MenuItem key={type} value={type}>{label(type)}</MenuItem>)}
        </Select>
      </Field>
      <TextField
        label="Expression"
        value={draft.expression}
        multiline
        minRows={3}
        helperText="Use the typed recipe expression syntax. The worker validates the result before publication."
        onChange={(event) => model.patchTransform({ expression: event.target.value })}
      />
    </Stack>
  )
}

function ColumnField({ columns, value, onChange }: { columns: string[]; value: string; onChange(value: string): void }) {
  return (
    <Field label="Column">
      <Select value={value} label="Column" onChange={(event) => onChange(event.target.value)}>
        {columns.map((column) => <MenuItem key={column} value={column}>{column}</MenuItem>)}
      </Select>
    </Field>
  )
}

function Field({ label: title, children }: { label: string; children: React.ReactNode }) {
  return (
    <FormControl fullWidth>
      <InputLabel>{title}</InputLabel>
      {children}
    </FormControl>
  )
}

function Details({ model, state }: ViewProps) {
  return (
    <Box className="details">
      <Tabs
        className="details-tabs"
        value={state.view.detail}
        onChange={(_, value: StudioState["view"]["detail"]) => model.view({ detail: value })}
      >
        <Tab value="profile" label="Column profile" />
        <Tab value="issues" label={`Issues (${state.issues.length})`} />
        <Tab value="jobs" label="Job" />
      </Tabs>
      <Box className="details-body">
        {state.draft && state.preview ? <Draft model={model} state={state} /> : detail(state)}
      </Box>
    </Box>
  )
}

function Draft({ model, state }: ViewProps) {
  if (!state.draft || !state.preview) throw new Error("Row editor requires a draft and preview")
  const draft = state.draft
  const columns = state.preview.columns.filter((column) => !column.system && column.owner !== "formula" && column.owner !== "derived")
  return (
    <Stack direction="row" alignItems="center" gap={1} flexWrap="wrap">
      {columns.map((column) => (
        <TextField
          key={column.id}
          size="small"
          label={column.name}
          value={value(draft[column.name])}
          onChange={(event) => model.draft({ ...draft, [column.name]: event.target.value })}
        />
      ))}
      <Button variant="contained" onClick={() => act(model.insert())}>Create row</Button>
      <Button onClick={() => model.draft()}>Cancel</Button>
    </Stack>
  )
}

function Status({ state }: { state: StudioState }) {
  const preview = state.preview
  return (
    <Box className="studio-status">
      <Typography fontSize={10} noWrap>
        {preview ? `${preview.total.toLocaleString()} rows · ${preview.columns.length} columns · preview limited to 100 rows` : "No preview loaded"}
      </Typography>
      <Stack direction="row" alignItems="center" gap={1.5}>
        {state.job && <Typography fontSize={10}>{label(state.job.kind)} · {state.job.state} · {Math.round(state.job.progress * 100)}%</Typography>}
        {state.quota && <Typography fontSize={10}>{quota(state.quota.used)} / {quota(state.quota.limit)} · {state.quota.percent.toFixed(1)}%</Typography>}
        {state.busy && <CircularProgress size={12} />}
      </Stack>
    </Box>
  )
}

function gridcols(model: PrepStudio, state: StudioState, preview: Preview): GridColDef<GridRow>[] {
  const profile = state.profile?.dataset === preview.dataset ? state.profile : undefined
  const columns: GridColDef<GridRow>[] = preview.columns.map((column) => ({
    field: column.name,
    headerName: column.name,
    type: column.type === "integer" || column.type === "decimal" ? "number" : column.type === "boolean" ? "boolean" : "string",
    editable: state.gates.edit.enabled && !column.system && !column.key && column.owner !== "formula" && column.owner !== "derived",
    minWidth: 145,
    flex: 1,
    renderHeader: () => <Column name={column.name} type={column.type} profile={profile} />,
  }))
  if (!state.gates.remove.enabled) return columns
  return [...columns, {
    field: "__actions",
    width: 48,
    sortable: false,
    filterable: false,
    renderCell: ({ row }) => (
      <Tooltip title="Delete row">
        <IconButton
          aria-label="Delete row"
          size="small"
          onClick={() => act(model.remove({ row: row._veritly_id, expectedVersion: row._veritly_version }))}
        >
          <DeleteIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    ),
  }]
}

function Column({ name: title, type, profile }: { name: string; type: string; profile?: Profile }) {
  const column = profile?.columns.find((item) => item.column === title)
  const rows = profile ? profile.rows : 0
  const empty = column && rows ? Math.min(100, column.nulls / rows * 100) : 0
  const error = column && rows ? Math.min(100 - empty, column.invalid / rows * 100) : 0
  const valid = Math.max(0, 100 - empty - error)
  return (
    <Box width="100%" overflow="hidden">
      <Stack direction="row" alignItems="center" gap={0.75} minWidth={0}>
        <Typography color="primary" fontSize={10} fontWeight={700}>{glyph(type)}</Typography>
        <Typography fontSize={11} fontWeight={600} noWrap>{title}</Typography>
      </Stack>
      {column && (
        <Box className="quality" sx={{ gridTemplateColumns: `${valid}fr ${error}fr ${empty}fr` }}>
          <Box className="quality-valid" />
          <Box className="quality-error" />
          <Box className="quality-empty" />
        </Box>
      )}
    </Box>
  )
}

function detail(state: StudioState) {
  if (state.view.detail === "issues") {
    if (!state.issues.length) return <Typography color="text.secondary" fontSize={11}>No open diagnostics.</Typography>
    return (
      <Stack gap={0.75}>
        {state.issues.map((issue) => (
          <Stack key={issue.id} direction="row" alignItems="center" gap={1}>
            <ErrorOutlineIcon color={issue.severity === "error" ? "error" : "warning"} fontSize="small" />
            <Typography fontSize={11}>{issue.message}</Typography>
            {issue.column && <Chip size="small" label={issue.column} />}
          </Stack>
        ))}
      </Stack>
    )
  }
  if (state.view.detail === "jobs") {
    if (!state.job) return <Typography color="text.secondary" fontSize={11}>No active or recent job.</Typography>
    return (
      <Stack gap={0.75}>
        <Typography fontSize={11}>{label(state.job.kind)} · {state.job.state}</Typography>
        <LinearProgress variant="determinate" value={state.job.progress * 100} />
        {state.job.error && <Typography color="error" fontSize={11}>{state.job.error}</Typography>}
      </Stack>
    )
  }
  if (!state.profile || state.profile.dataset !== state.view.dataset)
    return <Typography color="text.secondary" fontSize={11}>Run a profile to inspect types, nulls, distinct values, and errors.</Typography>
  return (
    <Stack direction="row" gap={1} flexWrap="wrap">
      <Chip size="small" label={`${state.profile.rows.toLocaleString()} rows`} />
      <Chip size="small" label={`${state.profile.columns.length} columns`} />
      <Chip size="small" color={state.profile.issues ? "warning" : "success"} label={`${state.profile.issues} issues`} />
      {state.profile.columns.map((column) => (
        <Chip key={column.column} size="small" variant="outlined" label={`${column.column}: ${column.type} · ${column.nulls} empty · ${column.distinct} distinct`} />
      ))}
    </Stack>
  )
}

function Action({ gate, label: title, children }: { gate: StudioGate; label: string; children: React.ReactElement }) {
  return (
    <Tooltip title={gate.enabled ? title : gate.reason}>
      <span>{React.cloneElement(children, { disabled: !gate.enabled })}</span>
    </Tooltip>
  )
}

type ViewProps = { model: PrepStudio; state: StudioState }

function act(task: Promise<unknown>) {
  void task.then(() => undefined, () => undefined)
}

function show(model: PrepStudio, dataset: string, step?: string) {
  model.view(step ? { dataset, step } : { dataset })
  act(model.preview({ dataset, limit: 100 }))
}

function select(model: PrepStudio, config: PrepConfig, patch: Partial<PrepConfig>) {
  model.select({ ...config, ...patch })
}

async function update(model: PrepStudio, preview: Preview, row: GridRow) {
  const values = Object.fromEntries(
    preview.columns
      .filter((column) => !column.system && !column.key && column.owner !== "formula" && column.owner !== "derived")
      .filter((column) => Object.hasOwn(row, column.name))
      .map((column) => [column.name, row[column.name]]),
  )
  return gridrow(await model.edit({ row: row._veritly_id, expectedVersion: row._veritly_version, values }))
}

function gridrow(row: Row): GridRow {
  return { ...row.values, _veritly_id: row.id, _veritly_version: row.version }
}

function target(command: Command) {
  if (command.kind === "output") return command.input
  if ("output" in command) return command.output
  return undefined
}

function output(recipe?: PrepRecipe) {
  if (!recipe) return "Not configured"
  const command = recipe.commands.filter((item) => item.kind === "output").at(-1)
  if (!command) return "Not configured"
  if (!command.table) return command.id
  return `${command.schema ? `${command.schema}.` : ""}${command.table}`
}

function stateLabel(state: PrepRecipe["state"]) {
  return state.replaceAll("_", " ").replace(/^./, (char) => char.toUpperCase())
}

function label(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase())
}

function describe(kind: string) {
  const labels: Record<string, string> = {
    source: "Read the selected worksheet range from the immutable workbook revision",
    key: "Assign stable row identity for synchronization",
    output: "Publish this prepared result as a stable PostgreSQL table",
    cast: "Convert selected columns to declared data types",
    trim: "Trim surrounding whitespace in selected columns",
    case: "Normalize text casing in selected columns",
    replace: "Replace matching values in a selected column",
    null: "Convert declared values to null",
    split: "Split a column into derived columns",
    merge: "Merge selected columns into a derived column",
    fill: "Fill missing values using the declared policy",
    filter: "Keep rows matching the declared expression",
    dedupe: "Remove duplicate rows using selected key columns",
    validate: "Validate rows against declared constraints",
    derive: "Create typed derived columns",
    join: "Join two prepared datasets",
    union: "Append compatible prepared datasets",
    pivot: "Create a derived pivot table",
    unpivot: "Normalize selected columns into row values",
  }
  const value = labels[kind]
  if (value) return value
  return label(kind)
}

function glyph(type: string) {
  if (type === "integer" || type === "decimal") return "123"
  if (type === "date" || type === "timestamp") return "▣"
  if (type === "boolean") return "T/F"
  return "ABC"
}

function name(path: string) {
  const value = path.split("/").at(-1)
  if (!value) throw new Error("Workbook path has no name")
  return value
}

function names(value: string) {
  return value.split(",").map((item) => item.trim()).filter(Boolean)
}

function index(value: string) {
  const raw = value.trim()
  if (!/^[a-z]+$/i.test(raw)) throw new Error(`Invalid Excel column: ${value}`)
  return [...raw.toUpperCase()].reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0)
}

function letters(value: number | undefined) {
  if (!value) return "A"
  const chars: string[] = []
  for (let current = value; current > 0; current = Math.floor((current - 1) / 26)) {
    chars.unshift(String.fromCharCode((current - 1) % 26 + 65))
  }
  return chars.join("")
}

function last(columns: readonly number[]) {
  const value = columns.at(-1)
  if (!value) return 1
  return value
}

function span(left: number | undefined, right: number | undefined) {
  if (!left || !right || right < left) throw new Error("Source columns must form a non-empty contiguous range")
  return Array.from({ length: right - left + 1 }, (_, offset) => left + offset)
}

function value(raw: string | undefined) {
  if (raw === undefined) return ""
  return raw
}

function quota(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  return `${bytes} B`
}

const types = ["text", "boolean", "integer", "decimal", "date", "timestamp"] as const

function toggle(values: readonly string[], value: string) {
  if (values.includes(value)) {
    if (values.length === 1) throw new Error("A transform requires at least one column")
    return values.filter((item) => item !== value)
  }
  return [...values, value]
}

function transformTitle(kind: StudioTransform["kind"]) {
  if (kind === "case") return "Change case"
  if (kind === "cast") return "Change data type"
  if (kind === "derive") return "Add custom column"
  return label(kind)
}
