import AddIcon from "@mui/icons-material/Add"
import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh"
import AccountTreeIcon from "@mui/icons-material/AccountTree"
import ArrowForwardIcon from "@mui/icons-material/ArrowForward"
import CloudUploadIcon from "@mui/icons-material/CloudUpload"
import CompareArrowsIcon from "@mui/icons-material/CompareArrows"
import DataObjectIcon from "@mui/icons-material/DataObject"
import DeleteIcon from "@mui/icons-material/Delete"
import DownloadIcon from "@mui/icons-material/Download"
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline"
import FactCheckIcon from "@mui/icons-material/FactCheck"
import GridViewIcon from "@mui/icons-material/GridView"
import KeyIcon from "@mui/icons-material/Key"
import RefreshIcon from "@mui/icons-material/Refresh"
import SaveAltIcon from "@mui/icons-material/SaveAlt"
import StorageIcon from "@mui/icons-material/Storage"
import TableChartIcon from "@mui/icons-material/TableChart"
import VisibilityIcon from "@mui/icons-material/Visibility"
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
import { z } from "zod"
import { PrepStudio, studio } from "./controller"
import { graph, output as recipeOutput } from "./model"
import type {
  Command,
  PrepConfig,
  PrepRecipe,
  StudioGate,
  StudioIssue,
  StudioPreview as Preview,
  StudioState,
  StudioTransform,
} from "./model"
import type { Mapping as WireMapping, Profile, Row } from "./protocol"

type GridRow = GridValidRowModel & {
  _veritly_id: string
  _veritly_version: number
}

type SampleRow = GridValidRowModel & {
  $id: string
  $row: number
}

const RowIndex = z.coerce.number().int().positive().max(1_048_576)
const ColumnIndex = z.coerce.number().int().positive().max(16_384)

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
        <Navigation model={model} state={state} />
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
        <Button startIcon={<AutoFixHighIcon />} onClick={() => model.ai("configure")}>Configure with AI</Button>
        <Button onClick={() => model.ai("explain")}>Explain mapping</Button>
        <Action gate={state.gates.writeback} label="Write back">
          <Button startIcon={<SaveAltIcon />} onClick={() => act(model.writeback())}>Write back</Button>
        </Action>
        <Action gate={state.gates.reconcile} label="Reconcile">
          <Button startIcon={<CompareArrowsIcon />} onClick={() => act(model.reconcile())}>Reconcile</Button>
        </Action>
      </Box>
    </Box>
  )
}

function Navigation({ model, state }: ViewProps) {
  const dataset = state.view.dataset
  return (
    <Box className="ribbon">
      <Tabs
        className="ribbon-tabs"
        value={state.view.surface}
        onChange={(_, surface: StudioState["view"]["surface"]) => model.view({ surface })}
      >
        <Tab value="source" label="1  Source" />
        <Tab value="map" label="2  Map" disabled={!state.recipe?.commands.length} />
        <Tab value="model" label="3  Model" disabled={!state.recipe?.commands.length} />
        <Tab value="rows" label="4  Rows" disabled={!state.preview} />
        <Tab value="review" label="5  Review" disabled={!state.recipe?.commands.length} />
      </Tabs>
      <Box className="ribbon-tools">
        {state.view.surface === "source" && (
          <Box className="ribbon-group">
            <Action gate={state.gates.prepare} label="Preview the selected worksheet region">
              <Button startIcon={<VisibilityIcon />} onClick={() => act(model.sample())}>Preview rows</Button>
            </Action>
            <Action gate={state.gates.prepare} label="Analyze the selected worksheet region">
              <Button variant="contained" startIcon={<TableChartIcon />} onClick={() => act(model.prepare())}>
                Analyze selection
              </Button>
            </Action>
            <Typography color="text.secondary" fontSize={11}>One selected Excel row becomes one PostgreSQL row.</Typography>
          </Box>
        )}
        {state.view.surface === "map" && <MapTools model={model} state={state} />}
        {state.view.surface === "model" && (
          <Box className="ribbon-group"><Typography color="text.secondary" fontSize={11}>Tables, keys, and relationships</Typography></Box>
        )}
        {state.view.surface === "rows" && <RowTools model={model} state={state} dataset={dataset} />}
        {state.view.surface === "review" && <ReviewTools model={model} state={state} />}
      </Box>
    </Box>
  )
}

function MapTools({ model, state }: ViewProps) {
  return (
    <>
      <Box className="ribbon-group">
        <Action gate={state.gates.transform} label="Trim values"><Button onClick={() => model.openTransform("trim")}>Trim</Button></Action>
        <Action gate={state.gates.transform} label="Change case"><Button onClick={() => model.openTransform("case")}>Change case</Button></Action>
        <Action gate={state.gates.transform} label="Rename column"><Button onClick={() => model.openTransform("rename")}>Rename</Button></Action>
        <Action gate={state.gates.transform} label="Change data type"><Button onClick={() => model.openTransform("cast")}>Data type</Button></Action>
        <Action gate={state.gates.transform} label="Add custom column"><Button onClick={() => model.openTransform("derive")}>Custom column</Button></Action>
      </Box>
    </>
  )
}

function RowTools({ model, state, dataset }: ViewProps & { dataset?: string }) {
  return (
    <>
      <Box className="ribbon-group">
        <Button startIcon={<RefreshIcon />} disabled={!dataset || Boolean(state.busy)} onClick={() => dataset && act(model.show({ dataset }))}>
          Refresh rows
        </Button>
        <Action gate={state.gates.profile} label="Profile the selected query">
          <Button startIcon={<TableChartIcon />} onClick={() => dataset && act(model.profile(dataset))}>Profile columns</Button>
        </Action>
        <Action gate={state.gates.insert} label="Add database row"><Button startIcon={<AddIcon />} onClick={() => model.draft({})}>New row</Button></Action>
        <Action gate={state.gates.export} label="Export project database"><Button startIcon={<DownloadIcon />} onClick={() => act(model.export())}>Export</Button></Action>
      </Box>
      <Box className="ribbon-group">
        <Button onClick={() => model.view({ detail: "profile" })}>Profile</Button>
        <Button onClick={() => model.view({ detail: "issues" })}>Issues</Button>
        <Button onClick={() => model.view({ detail: "jobs" })}>Job</Button>
      </Box>
    </>
  )
}

function ReviewTools({ model, state }: ViewProps) {
  return (
    <>
      <Box className="ribbon-group">
        <Typography color="text.secondary" fontSize={11}>Publish workbook rows to PostgreSQL</Typography>
        <ButtonGroup size="small" disabled={!state.gates.publish.enabled}>
          <Button onClick={() => act(model.publish({ mode: "replace" }))}>Replace</Button>
          <Button onClick={() => act(model.publish({ mode: "append" }))}>Append</Button>
          <Button variant="contained" startIcon={<CloudUploadIcon />} onClick={() => act(model.publish({ mode: "upsert" }))}>Upsert</Button>
        </ButtonGroup>
      </Box>
      <Box className="ribbon-group">
        <Action gate={state.gates.ai} label="Fix diagnostics with AI"><Button startIcon={<AutoFixHighIcon />} onClick={() => model.ai("fix")}>Fix issues with AI</Button></Action>
        <Action gate={state.gates.cancel} label="Cancel running job"><Button color="error" onClick={() => act(model.cancel())}>Cancel job</Button></Action>
      </Box>
    </>
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
        <button
          className={`query-row${state.view.surface === "source" ? " selected" : ""}`}
          type="button"
          onClick={() => model.view({ surface: "source" })}
        >
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
              onClick={() => dataset && act(model.show({ dataset, step: command.id }))}
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
            onClick={() => act(model.show({ dataset: dataset.id }))}
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
  const content = state.view.surface === "source"
    ? <Source model={model} state={state} />
    : state.view.surface === "map"
      ? <Mapping model={model} state={state} />
      : state.view.surface === "model"
        ? <Model state={state} />
        : state.view.surface === "review"
          ? <Review state={state} />
          : state.preview
            ? <Grid model={model} state={state} preview={state.preview} />
            : <Empty title="No row preview" detail="Analyze a workbook selection or load a published table." />
  return (
    <Box className="workspace">
      <Box className="formula">
        <Typography className="formula-kind" fontSize={12}>fx</Typography>
        <Typography className="formula-text" fontSize={12}>
          {command ? describe(command.kind) : "Select a source or applied step to inspect its rows"}
        </Typography>
      </Box>
      <Box className="grid-shell">
        {content}
      </Box>
      {state.view.surface === "rows" || state.view.surface === "review"
        ? <Details model={model} state={state} />
        : <Guide state={state} />}
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
  const source = recipe.source
  if (source.kind === "native") {
    return (
      <Box className="waiting">
        <StorageIcon color="primary" />
        <Typography>Create the native table schema before publishing.</Typography>
      </Box>
    )
  }
  const sheet = state.catalog?.sheets.find((item) => item.name === state.config.sheet)
  return (
    <Box className="source-workspace">
      <Box className="source-book">
        <Box className="source-book-title">
          <TableChartIcon color="primary" />
          <Box minWidth={0}>
            <Typography fontSize={13} fontWeight={700} noWrap>{name(source.path)}</Typography>
            <Typography color="text.secondary" fontSize={10} noWrap>Immutable revision {source.revision}</Typography>
          </Box>
        </Box>
        <Box className="source-workbook">
          <FormControl fullWidth size="small">
            <InputLabel id="workbook-label">Workbook</InputLabel>
            <Tooltip title={state.gates.rebind.enabled ? "Choose another project workbook" : state.gates.rebind.reason}>
              <Select
                labelId="workbook-label"
                label="Workbook"
                value={source.path}
                disabled={!state.gates.rebind.enabled}
                onChange={(event) => {
                  if (event.target.value === source.path) return
                  act(model.rebind(event.target.value))
                }}
              >
                {state.workbooks.map((workbook) => (
                  <MenuItem key={workbook.file} value={workbook.path}>{name(workbook.path)} · r{workbook.revision}</MenuItem>
                ))}
              </Select>
            </Tooltip>
          </FormControl>
        </Box>
        <Typography className="source-label">WORKSHEETS</Typography>
        <Box className="source-sheets">
          {state.catalog?.sheets.map((item) => (
            <button
              className={`source-sheet${item.name === state.config.sheet ? " selected" : ""}`}
              key={item.name}
              type="button"
              onClick={() => model.sheet(item.name)}
            >
              <TableChartIcon fontSize="small" />
              <Box minWidth={0}>
                <Typography fontSize={11} fontWeight={600} noWrap>{item.name}</Typography>
                <Typography color="text.secondary" fontSize={9} noWrap>
                  {item.regions.length} suggested {item.regions.length === 1 ? "table" : "tables"}
                  {item.visibility === "visible" ? "" : ` · ${label(item.visibility)}`}
                </Typography>
              </Box>
            </button>
          ))}
        </Box>
      </Box>
      <Box className="source-main">
        <Box className="section-head">
          <Box>
            <Typography fontSize={15} fontWeight={700}>Choose a table-like region</Typography>
            <Typography color="text.secondary" fontSize={11}>Only this bounded range becomes row-level project data. Everything else remains untouched.</Typography>
          </Box>
        </Box>
        {!sheet?.regions.length && (
          <Alert severity="info">No table-like range was detected. Enter the exact worksheet bounds below.</Alert>
        )}
        <Box className="region-grid">
          {sheet?.regions.map((region, offset) => {
            const active = state.config.header === region.header && state.config.start === region.start &&
              state.config.end === region.end && state.config.columns[0] === region.left && last(state.config.columns) === region.right
            return (
              <button
                className={`region-card${active ? " selected" : ""}`}
                key={`${region.header}:${region.left}:${region.right}`}
                type="button"
                onClick={() => model.region(offset)}
              >
                <Box className="region-meta">
                  <Typography fontSize={12} fontWeight={700}>Suggested table {offset + 1}</Typography>
                  <Typography color="text.secondary" fontSize={10}>
                    {letters(region.left)}{region.header}:{letters(region.right)}{region.end} · {(region.end - region.start + 1).toLocaleString()} rows
                  </Typography>
                  <Chip size="small" color={active ? "primary" : "default"} label={active ? "Selected" : "Select range"} />
                </Box>
              </button>
            )
          })}
        </Box>
        {sheet ? (
          <Box className="range-settings">
            <Box className="range-settings-head">
              <Box>
                <Typography fontSize={12} fontWeight={650}>Exact source range</Typography>
                <Typography color="text.secondary" fontSize={10}>Set the header, data rows, and contiguous source columns. Detected tables are suggestions only.</Typography>
              </Box>
              <Chip
                size="small"
                color={state.config.columns.length ? "primary" : "default"}
                label={selection(state.config)}
              />
            </Box>
            <Box className="range-fields">
              <TextField
                size="small"
                type="number"
                label="Header row"
                value={state.config.header}
                slotProps={{ htmlInput: { min: sheet.rows.start, max: sheet.rows.end } }}
                onChange={(event) => change(event.target.value, RowIndex, (header) => select(model, state.config, { header }))}
              />
              <TextField
                size="small"
                type="number"
                label="First data row"
                value={state.config.start}
                slotProps={{ htmlInput: { min: sheet.rows.start, max: sheet.rows.end } }}
                onChange={(event) => change(event.target.value, RowIndex, (start) => select(model, state.config, { start }))}
              />
              <TextField
                size="small"
                type="number"
                label="Last data row"
                value={state.config.end}
                slotProps={{ htmlInput: { min: sheet.rows.start, max: sheet.rows.end } }}
                onChange={(event) => change(event.target.value, RowIndex, (end) => select(model, state.config, { end }))}
              />
              <TextField
                size="small"
                type="number"
                label="First column"
                value={state.config.columns[0] === undefined ? "" : state.config.columns[0]}
                slotProps={{ htmlInput: { min: sheet.columns.start, max: sheet.columns.end } }}
                onChange={(event) => change(event.target.value, ColumnIndex, (left) =>
                  select(model, state.config, { columns: span(left, last(state.config.columns)) }))}
              />
              <TextField
                size="small"
                type="number"
                label="Last column"
                value={last(state.config.columns) === undefined ? "" : last(state.config.columns)}
                slotProps={{ htmlInput: { min: sheet.columns.start, max: sheet.columns.end } }}
                onChange={(event) => change(event.target.value, ColumnIndex, (right) =>
                  select(model, state.config, { columns: span(state.config.columns[0], right) }))}
              />
            </Box>
            <Box className="identity-settings">
              <Box>
              <Typography fontSize={12} fontWeight={650}>Row identity</Typography>
              <Typography color="text.secondary" fontSize={10}>Choose immutable business keys, or leave empty to create a visible Veritly ID.</Typography>
              </Box>
              <TextField
                size="small"
                label="Business key columns"
                placeholder="Customer ID"
                value={state.config.keys.join(", ")}
                onChange={(event) => select(model, state.config, { keys: names(event.target.value) })}
              />
            </Box>
          </Box>
        ) : undefined}
        <SourceSample model={model} state={state} />
      </Box>
    </Box>
  )
}

function SourceSample({ model, state }: ViewProps) {
  const sample = state.sample
  return (
    <Box className="source-preview">
      <Box className="source-preview-head">
        <Box>
          <Typography fontSize={12} fontWeight={700}>Workbook row preview</Typography>
          <Typography color="text.secondary" fontSize={10}>
            {sample
              ? `${sample.total.toLocaleString()} selected rows · showing ${sample.rows.length.toLocaleString()}`
              : "Preview the bounded selection before creating the mapping."}
          </Typography>
        </Box>
        <Action gate={state.gates.prepare} label="Reload the selected worksheet region">
          <Button startIcon={<VisibilityIcon />} onClick={() => act(model.sample())}>
            {sample ? "Refresh preview" : "Load preview"}
          </Button>
        </Action>
      </Box>
      {sample ? <Sample state={state} sample={sample} /> : (
        <Box className="source-preview-empty">
          <TableChartIcon color="disabled" sx={{ fontSize: 38 }} />
          <Typography color="text.secondary" fontSize={11}>The workbook stays unchanged while this read-only preview is generated.</Typography>
        </Box>
      )}
    </Box>
  )
}

function Sample({ state, sample }: { state: StudioState; sample: Preview }) {
  const rows: SampleRow[] = sample.rows.map((row, index) => ({
    ...Object.fromEntries(sample.columns.map((column) => [column.id, row.values[column.name]])),
    $id: row.id,
    $row: state.config.start + index,
  }))
  const columns: GridColDef<SampleRow>[] = [
    { field: "$row", headerName: "Row", width: 62, sortable: false, filterable: false },
    ...sample.columns.map((column, index) => ({
      field: column.id,
      headerName: `${letters(state.config.columns[index])}  ${column.name}`,
      minWidth: 145,
      flex: 1,
    })),
  ]
  return (
    <Box className="source-preview-grid">
      <DataGrid<SampleRow>
        rows={rows}
        columns={columns}
        getRowId={(row) => row.$id}
        density="compact"
        disableRowSelectionOnClick
        hideFooter
        showToolbar
        sx={{ border: 0, "& .MuiDataGrid-columnHeaders": { background: "#fafafa" } }}
      />
    </Box>
  )
}

function Mapping({ model, state }: ViewProps) {
  const mapped = state.mapping ? graph(state.mapping, state.view.step) : undefined
  const target = mapped?.target
  if (!mapped || !target) {
    return <Empty title="No mapping yet" detail="Choose and analyze a workbook region to create the row and column mapping." />
  }
  return (
    <Box className="mapping">
      <Box className="mapping-head">
        <Box className="mapping-nodes">
          <Typography className="mapping-group">SOURCES · {mapped.sources.length}</Typography>
          {mapped.sources.map((source) => (
            <NodeCard
              key={source.command}
              icon={<TableChartIcon />}
              eyebrow="XLSX SOURCE"
              title={`${name(source.path)} · ${source.sheet}`}
              detail={`${letters(source.range.left)}${source.range.header}:${letters(source.range.right)}${source.range.end} · r${source.revision}`}
            />
          ))}
        </Box>
        <Box className="mapping-flow"><ArrowForwardIcon /><Typography fontSize={10}>{cardinality(target.rows)}</Typography></Box>
        <Box className="mapping-nodes">
          <Typography className="mapping-group">TARGETS · {mapped.targets.length}</Typography>
          {mapped.targets.map((item) => (
            <button
              className={`mapping-choice${item.command === target.command ? " selected" : ""}`}
              key={item.command}
              type="button"
              onClick={() => model.view({ surface: "map", step: item.command, dataset: item.input })}
            >
              <NodeCard
                icon={<StorageIcon />}
                eyebrow="POSTGRESQL TARGET"
                title={`${item.schema}.${item.table}`}
                detail={`${label(item.class)} · ${cardinality(item.rows)}`}
              />
            </button>
          ))}
        </Box>
      </Box>
      <Box className="mapping-table">
        <Box className="mapping-row mapping-labels">
          <Typography>Workbook column</Typography><Typography>Transform</Typography><Typography>PostgreSQL column</Typography><Typography>Ownership</Typography>
        </Box>
        {target.columns.map((column) => (
          <Box className="mapping-row" key={column.target}>
            <Stack direction="row" alignItems="center" gap={1} minWidth={0}>
              {column.key ? <KeyIcon color="primary" fontSize="small" /> : <Typography className="type-glyph">{glyph(column.type ? column.type : "text")}</Typography>}
              <Typography fontSize={11} fontWeight={600} noWrap>{column.source ? column.source : "Generated"}</Typography>
            </Stack>
            <Stack direction="row" alignItems="center" gap={0.5}>
              <Divider sx={{ flex: 1 }} />
              <Typography color="text.secondary" fontSize={8} noWrap>{column.transforms.length ? `${column.transforms.length} steps` : "Direct"}</Typography>
              <ArrowForwardIcon color="disabled" fontSize="small" />
              <Divider sx={{ flex: 1 }} />
            </Stack>
            <Stack direction="row" alignItems="center" gap={1} minWidth={0}>
              <Typography className="type-glyph">{glyph(column.type ? column.type : "text")}</Typography>
              <Typography fontSize={11} fontWeight={600} noWrap>{column.target}</Typography>
              <Chip size="small" label={column.type ? label(column.type) : "Inferred"} />
            </Stack>
            <Stack alignItems="flex-start" gap={0.25}>
              <Chip size="small" variant="outlined" color={column.owner === "formula" ? "warning" : "default"} label={label(column.owner)} />
              <Typography color="text.secondary" fontSize={8}>{label(column.direction)}</Typography>
            </Stack>
          </Box>
        ))}
        {!target.columns.length && <Box p={3}><Typography color="text.secondary" fontSize={11}>This target has no mapped columns.</Typography></Box>}
      </Box>
      <Box className="mapping-note">
        {!target.invertible ? <ErrorOutlineIcon color="warning" fontSize="small" /> : <KeyIcon color="primary" fontSize="small" />}
        <Typography fontSize={11}>
          {!target.invertible
            ? target.blockers.map((blocker) => blocker.message).join(" · ")
            : `Row identity: ${identity(target)}`}
        </Typography>
        <Button startIcon={<AutoFixHighIcon />} onClick={() => model.ai("configure")}>Change with AI</Button>
      </Box>
    </Box>
  )
}

function Model({ state }: { state: StudioState }) {
  const mapped = state.mapping ? graph(state.mapping, state.view.step) : undefined
  if (!mapped?.targets.length) return <Empty title="No model yet" detail="Analyze a source before modeling tables and relationships." />
  return (
    <Box className="model-canvas">
      {mapped.targets.map((target) => {
        const dataset = state.datasets.find((item) => item.schema === target.schema && item.table === target.table)
        const columns = dataset
          ? dataset.columns.filter((column) => !column.system).map((column) => ({ name: column.name, type: column.type, key: Boolean(column.key) }))
          : target.columns.map((column) => ({ name: column.target, type: column.type ? column.type : "text", key: column.key }))
        return (
          <Box className="model-table" key={target.command}>
            <Box className="model-title"><StorageIcon /><Typography fontSize={12} fontWeight={700}>{target.schema}.{target.table}</Typography><Chip size="small" label={target.class} /></Box>
            {columns.map((column) => (
              <Box className="model-column" key={column.name}>
                {column.key ? <KeyIcon color="primary" fontSize="small" /> : <Typography className="type-glyph">{glyph(column.type)}</Typography>}
                <Typography fontSize={11} flex={1} noWrap>{column.name}</Typography>
                <Typography color="text.secondary" fontSize={9}>{label(column.type)}</Typography>
              </Box>
            ))}
            <Box className="model-meta"><Typography fontSize={9}>{cardinality(target.rows)} · {target.invertible ? "Write-back enabled" : "Read-only output"}</Typography></Box>
          </Box>
        )
      })}
      <Box className="model-empty">
        <AccountTreeIcon color="disabled" sx={{ fontSize: 46 }} />
        <Typography fontSize={13} fontWeight={650}>{mapped.sources.length} sources · {mapped.targets.length} targets</Typography>
        <Typography color="text.secondary" fontSize={11}>Derived tables remain separate from original row-level entity outputs.</Typography>
      </Box>
    </Box>
  )
}

function Review({ state }: { state: StudioState }) {
  const recipe = state.recipe
  const target = recipe ? recipeOutput(recipe) : undefined
  const source = recipe?.commands.find((item) => item.kind === "source")
  if (!recipe || !target || !source || source.kind !== "source") return <Empty title="Nothing to review" detail="Analyze a workbook range first." />
  const issues = state.issues.filter((issue) => issue.state === "open")
  const checks = [
    { title: "Bounded workbook range", detail: `${source.sheet}!${letters(source.range.left)}${source.range.header}:${letters(source.range.right)}${source.range.end}`, ok: true },
    { title: "Row identity", detail: target.keys.join(", "), ok: target.keys.length > 0 },
    { title: "Typed row preview", detail: state.preview ? `${state.preview.total.toLocaleString()} rows · ${state.preview.columns.length} columns` : "Not loaded", ok: Boolean(state.preview) },
    { title: "Diagnostics", detail: issues.length ? `${issues.length} open issues` : "No blocking issues", ok: !issues.some((item) => item.severity === "error") },
  ]
  return (
    <Box className="review">
      <Box className="review-summary">
        <FactCheckIcon color="primary" sx={{ fontSize: 34 }} />
        <Box><Typography fontSize={15} fontWeight={700}>Review before publication</Typography><Typography color="text.secondary" fontSize={11}>Publication is explicit. The workbook stays intact and PostgreSQL receives one row per selected Excel row.</Typography></Box>
      </Box>
      <Box className="review-grid">
        {checks.map((check) => (
          <Box className="review-check" key={check.title}>
            <Box className={`review-mark ${check.ok ? "ok" : "warn"}`}>{check.ok ? "✓" : "!"}</Box>
            <Box><Typography fontSize={11} fontWeight={650}>{check.title}</Typography><Typography color="text.secondary" fontSize={10}>{check.detail}</Typography></Box>
          </Box>
        ))}
      </Box>
      <Box className="publish-target"><StorageIcon color="primary" /><Box><Typography fontSize={11} fontWeight={700}>{target.schema}.{target.table}</Typography><Typography color="text.secondary" fontSize={10}>Stable PostgreSQL target · {target.class}</Typography></Box></Box>
    </Box>
  )
}

function NodeCard({ icon, eyebrow, title, detail }: { icon: React.ReactNode; eyebrow: string; title: string; detail: string }) {
  return (
    <Box className="node-card">{icon}<Box minWidth={0}><Typography className="node-eyebrow">{eyebrow}</Typography><Typography fontSize={12} fontWeight={700} noWrap>{title}</Typography><Typography color="text.secondary" fontSize={10} noWrap>{detail}</Typography></Box></Box>
  )
}

function Empty({ title, detail }: { title: string; detail: string }) {
  return <Box className="surface-empty"><DataObjectIcon color="disabled" sx={{ fontSize: 44 }} /><Typography fontSize={13} fontWeight={650}>{title}</Typography><Typography color="text.secondary" fontSize={11}>{detail}</Typography></Box>
}

function Guide({ state }: { state: StudioState }) {
  const text = state.view.surface === "source"
    ? "Select only the worksheet region that contains row-level data. Charts, pivots, notes, and side calculations outside it are ignored."
    : state.view.surface === "map"
      ? "The mapping is the durable contract between source cells and typed database columns. Formula columns remain workbook-owned."
      : "Relationships belong to the analytical model. They do not change the original row-level table."
  return <Box className="surface-guide"><Typography fontSize={11}>{text}</Typography></Box>
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
              if (dataset) act(model.show({ dataset, step: command.id }))
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
  const issues = state.issues.filter((issue) => issue.state === "open").length
  return (
    <Box className="details">
      <Tabs
        className="details-tabs"
        value={state.view.detail}
        onChange={(_, value: StudioState["view"]["detail"]) => model.view({ detail: value })}
      >
        <Tab value="profile" label="Column profile" />
        <Tab value="issues" label={`Issues (${issues})`} />
        <Tab value="jobs" label="Job" />
      </Tabs>
      <Box className="details-body">
        {state.draft && state.preview ? <Draft model={model} state={state} /> : detail(model, state)}
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

function detail(model: PrepStudio, state: StudioState) {
  if (state.view.detail === "issues") {
    if (!state.issues.length) return <Typography color="text.secondary" fontSize={11}>No open diagnostics.</Typography>
    return (
      <Stack gap={0.75}>
        {state.issues.map((issue) => (
          <Stack key={issue.id} direction="row" alignItems="center" gap={1}>
            <ErrorOutlineIcon color={issue.severity === "error" ? "error" : "warning"} fontSize="small" />
            <Typography fontSize={11} flex={1}>{issue.message}</Typography>
            {issue.column && <Chip size="small" label={issue.column} />}
            {issue.state === "resolved" && <Chip size="small" color="success" label="Resolved" />}
            {issue.state === "open" && issue.code === "sync_conflict" && <IssueActions model={model} issue={issue} />}
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

function IssueActions({ model, issue }: { model: PrepStudio; issue: StudioIssue }) {
  return (
    <ButtonGroup size="small" aria-label={`Resolve ${issue.message}`}>
      <Button onClick={() => act(model.resolve({
        issue: issue.id,
        expectedVersion: issue.version,
        decision: { kind: "source" },
      }))}>Use workbook</Button>
      <Button onClick={() => act(model.resolve({
        issue: issue.id,
        expectedVersion: issue.version,
        decision: { kind: "database" },
      }))}>Use database</Button>
    </ButtonGroup>
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

function select(model: PrepStudio, config: PrepConfig, patch: Partial<PrepConfig>) {
  model.select({ ...config, ...patch })
}

function change(value: string, schema: typeof RowIndex, apply: (value: number) => void) {
  if (!value) return
  apply(schema.parse(value))
}

function span(first: number | undefined, second: number | undefined) {
  const left = first === undefined ? second : first
  const right = second === undefined ? first : second
  if (left === undefined || right === undefined) throw new Error("Workbook column selection has no boundary")
  const start = Math.min(left, right)
  return Array.from({ length: Math.max(left, right) - start + 1 }, (_, index) => start + index)
}

function selection(config: PrepConfig) {
  const left = config.columns[0]
  const right = last(config.columns)
  if (left === undefined || right === undefined) return "No columns selected"
  return `${letters(left)}${config.header}:${letters(right)}${config.end} · ${(config.end - config.start + 1).toLocaleString()} rows`
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

function cardinality(rows: WireMapping["targets"][number]["rows"]) {
  if (rows === "one_to_one") return "1 source row → 1 entity row"
  if (rows === "derived") return "Derived rows · no write-back"
  return "Database-native rows"
}

function identity(target: Pick<WireMapping["targets"][number], "schema" | "table" | "identity">) {
  if (target.identity.strategy === "generated") return target.identity.column
  if (target.identity.strategy === "existing") return target.identity.columns.join(", ")
  throw new Error(`Invertible target has no row identity: ${target.schema}.${target.table}`)
}

function name(path: string) {
  const value = path.split("/").at(-1)
  if (!value) throw new Error("Workbook path has no name")
  return value
}

function names(value: string) {
  return value.split(",").map((item) => item.trim()).filter(Boolean)
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
  return columns.at(-1)
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
