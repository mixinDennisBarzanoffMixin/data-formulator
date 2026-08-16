"""Bounded typed recipe execution for Veritly project data.

The executor accepts only server-staged Parquet files and the protocol command
graph. User expressions are scalar DuckDB expressions with a deliberately small
function surface; statements, subqueries, file readers, extensions, and network
access are rejected.
"""

from __future__ import annotations

import json
import math
import re
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import duckdb
import pyarrow.parquet as pq


MAX_ROWS = 1_000_000
MAX_COLUMNS = 512
MAX_INPUTS = 16
MAX_COMMANDS = 256
MAX_EXPR = 4_096
MAX_BYTES = 100 * 1024 * 1024
MAX_EXPANDED = 2 * 1024 * 1024 * 1024
MEMORY = "256MB"
TEMP = "1GB"
INTERNAL = "__veritly_order"
SYSTEM = "_veritly_id"
SAFE_FUNCTIONS = {
    "abs", "ceil", "ceiling", "coalesce", "concat", "concat_ws", "date_diff",
    "date_part", "date_trunc", "day", "floor", "greatest", "ifnull", "least",
    "cast", "left", "length", "lower", "lpad", "month", "nullif", "regexp_extract",
    "regexp_matches", "replace", "right", "round", "rpad", "split_part",
    "starts_with", "ends_with", "strftime", "substr", "substring", "trim",
    "try_cast", "upper", "week", "year",
}
DENIED = re.compile(
    r"(?is)(;|--|/\*|\*/|\b(select|from|copy|attach|detach|install|load|pragma|call|export|import|"
    r"read_csv|read_json|read_parquet|parquet_scan|httpfs|shell|glob)\b)"
)
CALL = re.compile(r"(?i)\b([a-z_][a-z0-9_]*)\s*\(")
NONINVERTIBLE = {"split", "merge", "filter", "dedupe", "derive", "join", "union", "pivot", "unpivot", "code"}


class RecipeError(ValueError):
    """A stable preparation diagnostic safe to expose to a project member."""

    def __init__(self, code: str, message: str, command: str | None = None):
        super().__init__(message)
        self.code = code
        self.command = command


@dataclass(frozen=True)
class Execution:
    path: Path
    manifest: dict[str, object]


class Executor:
    def __init__(
        self,
        root: Path,
        inputs: dict[str, Path],
        commands: list[dict[str, object]],
        lineage: dict[str, object] | None = None,
        rows: int = MAX_ROWS,
    ):
        if not inputs or len(inputs) > MAX_INPUTS:
            raise RecipeError("invalid_input", f"A recipe requires 1 to {MAX_INPUTS} inputs")
        if not commands or len(commands) > MAX_COMMANDS:
            raise RecipeError("invalid_input", f"A recipe requires 1 to {MAX_COMMANDS} commands")
        if rows < 1 or rows > MAX_ROWS:
            raise RecipeError("invalid_input", f"Recipe row limit must be between 1 and {MAX_ROWS}")
        root.mkdir(parents=True, exist_ok=True)
        self.root = root
        self.inputs = inputs
        self.commands = order(commands)
        self.maxrows = rows
        self.rels: dict[str, str] = {}
        self.meta: dict[str, dict[str, dict[str, object]]] = {}
        self.seed = normalize_lineage(lineage)
        self.diagnostics: list[dict[str, object]] = []
        self.outputs: dict[str, dict[str, object]] = {}
        self.traits: dict[str, dict[str, object]] = {}
        self.expanded = 0
        self.counter = 0
        self.tmppath = root / "spill"
        self.tmppath.mkdir()
        self.db = duckdb.connect(":memory:")
        self.db.execute(f"set memory_limit = '{MEMORY}'")
        self.db.execute("set threads = 2")
        self.db.execute(f"set temp_directory = {lit(str(self.tmppath))}")
        self.db.execute(f"set max_temp_directory_size = '{TEMP}'")
        self.db.execute("set preserve_insertion_order = true")
        self.db.execute("set allow_unsigned_extensions = false")
        self.db.execute(f"set allowed_directories = [{lit(str(root))}]")
        self.db.execute("set enable_external_access = false")
        self.db.execute("set lock_configuration = true")

    def run(self, output: str, writeback: bool = False) -> Execution:
        try:
            needed = closure(self.commands, output)
            commands = [item for item in self.commands if needstr(item, "id") in needed]
            uses = Counter(source for command in commands for source in command_inputs(command))
            for command in commands:
                self.command(command)
                for source in command_inputs(command):
                    uses[source] -= 1
                    if uses[source] == 0 and source != output:
                        rel = self.rels.get(source)
                        if rel:
                            self.db.execute(f"drop table if exists {rel}")
            if output not in self.outputs:
                raise RecipeError("invalid_input", "Requested recipe output does not exist")
            final = self.outputs[output]
            traits = self.traits[output]
            blocks = list(traits["blocks"])
            if writeback and blocks:
                kinds = ", ".join(blocks)
                raise RecipeError("mapping_not_invertible", f"Write-back is not invertible after: {kinds}")
            rel = needstr(final, "relation")
            target = self.root / "result.parquet"
            cols = [name for name in self.columns(rel) if name != INTERNAL]
            if not cols:
                raise RecipeError("invalid_input", "Recipe output has no columns")
            select = ", ".join(quote(name) for name in cols)
            self.db.execute(
                f"copy (select {select} from {rel} order by {quote(INTERNAL)}) "
                f"to {lit(str(target))} (format parquet, compression zstd, row_group_size 10000)"
            )
            count = self.count(rel)
            schema = self.schema(rel)
            owners = final.get("owners")
            if not isinstance(owners, dict):
                owners = {}
            names = [name for name in cols if name != SYSTEM]
            nulls = self.nulls(rel, names)
            columns = [self.column(rel, name, schema[name], owners, nulls[name]) for name in names]
            keys = set(final["keys"])
            used: set[str] = set()
            for column in columns:
                if column["name"] in keys:
                    column["key"] = True
                pid = str(column["id"])
                if pid in used:
                    pid = suffix(pid, used)
                    column["id"] = pid[:128]
                used.add(pid)
            manifest: dict[str, object] = {
                "output": output,
                "schema": final["schema"],
                "table": final["table"],
                "class": final["class"],
                "keys": final["keys"],
                "rows": count,
                "rowPolicy": traits["policy"],
                "writeback": not blocks,
                "writebackBlocks": blocks,
                "columns": columns,
                "diagnostics": self.diagnostics,
            }
            add_metadata(target, manifest)
            return Execution(target, manifest)
        finally:
            self.db.close()

    def command(self, cmd: dict[str, object]) -> None:
        kind = needstr(cmd, "kind")
        cid = needstr(cmd, "id")
        try:
            handler = getattr(self, f"do_{kind}", None)
            if not handler:
                raise RecipeError("invalid_input", f"Unsupported recipe command: {kind}", cid)
            handler(cmd)
            self.track(cmd, kind)
        except RecipeError as error:
            if not error.command:
                error.command = cid
            raise
        except duckdb.Error as error:
            raise RecipeError("invalid_input", f"Recipe command {kind} is invalid", cid) from error

    def do_source(self, cmd: dict[str, object]) -> None:
        output = needstr(cmd, "output")
        source = self.inputs.get(output)
        if not source:
            raise RecipeError("invalid_input", f"Missing staged input: {output}")
        self.expanded += audit_parquet(source, self.maxrows)
        if self.expanded > MAX_EXPANDED:
            raise RecipeError("invalid_input", "Parquet inputs exceed 2 GiB expanded")
        view = self.name("source")
        self.db.read_parquet(str(source)).create_view(view)
        cols = self.columns(view)
        if INTERNAL in cols:
            raise RecipeError("invalid_input", f"Input contains reserved column: {INTERNAL}")
        rel = self.make(output, f"select *, row_number() over ()::bigint as {quote(INTERNAL)} from {view}")
        self.db.execute(f"drop view {view}")
        seeded = self.seed.get(output)
        if seeded:
            self.meta[output] = copy_meta(seeded)
        else:
            self.meta[output] = parquet_lineage(source, self.usercols(rel))
        for name in self.usercols(rel):
            self.meta[output].setdefault(name, base_lineage(name))
        for name, item in self.meta[output].items():
            if item.get("stale"):
                self.diagnostics.append({
                    "code": "formula_stale", "severity": "error", "column": name,
                    "count": item.get("staleCount", 1), "command": needstr(cmd, "id"),
                })

    def do_key(self, cmd: dict[str, object]) -> None:
        source = needstr(cmd, "input")
        output = needstr(cmd, "output")
        rel = self.relation(source)
        key = cmd.get("key")
        if not isinstance(key, dict):
            raise RecipeError("invalid_input", "Key strategy is required")
        strategy = needstr(key, "strategy")
        cols = self.columns(rel)
        user = [name for name in cols if name not in {INTERNAL, SYSTEM}]
        if strategy == "existing":
            keys = strings(key.get("columns"), "key columns")
            require_columns(user, keys)
            group = ", ".join(quote(name) for name in keys)
            checks = " or ".join(
                f"{quote(name)} is null or trim(cast({quote(name)} as varchar)) = ''"
                for name in keys
            )
            invalid = self.db.execute(
                f"select count(*) from {rel} where ({checks})"
            ).fetchone()[0]
            duplicates = self.db.execute(
                f"select coalesce(sum(n - 1), 0) from (select count(*) n from {rel} group by {group})"
            ).fetchone()[0]
            if invalid or duplicates:
                raise RecipeError("identity_invalid", "Existing business key must be unique and non-null")
            seed = "to_json(list_value(" + ", ".join(f"cast({quote(name)} as varchar)" for name in keys) + "))"
            uid = uuid_sql(lit(needstr(cmd, "id")) + " || ':' || " + seed)
            select = [quote(name) for name in cols if name != SYSTEM]
            select.insert(-1 if INTERNAL in cols else len(select), f"{uid} as {quote(SYSTEM)}")
            self.make(output, f"select {', '.join(select)} from {rel}")
            self.meta[output] = copy_meta(self.meta[source])
            return
        if strategy != "generated":
            raise RecipeError("invalid_input", "Unknown key strategy")
        visible = needstr(key, "name")
        if visible in {INTERNAL, SYSTEM}:
            raise RecipeError("identity_invalid", f"Reserved identity column: {visible}")
        generated = uuid_sql(f"{lit(needstr(cmd, 'id'))} || ':' || cast({quote(INTERNAL)} as varchar)")
        if visible in cols:
            bad = self.db.execute(
                f"select count(*) from {rel} where {quote(visible)} is not null "
                f"and trim(cast({quote(visible)} as varchar)) <> '' and try_cast({quote(visible)} as uuid) is null"
            ).fetchone()[0]
            if bad:
                raise RecipeError("identity_invalid", f"{visible} contains modified system IDs")
            uid = f"coalesce(try_cast({quote(visible)} as uuid), {generated})"
            select = [
                f"cast({uid} as varchar) as {quote(name)}" if name == visible else quote(name)
                for name in cols if name != SYSTEM
            ]
        else:
            uid = generated
            select = [quote(name) for name in cols if name not in {SYSTEM, INTERNAL}]
            select.extend([f"cast({uid} as varchar) as {quote(visible)}", quote(INTERNAL)])
        select.insert(-1, f"{uid} as {quote(SYSTEM)}")
        target = self.make(output, f"select {', '.join(select)} from {rel}")
        duplicate = self.db.execute(
            f"select count(*) - count(distinct {quote(SYSTEM)}) from {target}"
        ).fetchone()[0]
        if duplicate:
            raise RecipeError("identity_invalid", "Generated Veritly IDs are not unique")
        meta = copy_meta(self.meta[source])
        meta[visible] = {"owner": "workbook", "lineage": [visible], "system": True}
        self.meta[output] = meta

    def do_select(self, cmd: dict[str, object]) -> None:
        source, output, rel = self.flow(cmd)
        chosen = strings(cmd.get("columns"), "selected columns")
        require_columns(self.usercols(rel), chosen)
        system = [name for name in [SYSTEM, INTERNAL] if name in self.columns(rel)]
        self.make(output, f"select {', '.join(quote(name) for name in chosen + system)} from {rel}")
        self.meta[output] = {name: dict(self.meta[source][name]) for name in chosen if name in self.meta[source]}

    def do_drop(self, cmd: dict[str, object]) -> None:
        source, output, rel = self.flow(cmd)
        drop = strings(cmd.get("columns"), "dropped columns")
        require_columns(self.usercols(rel), drop)
        keep = [name for name in self.columns(rel) if name not in drop]
        self.make(output, f"select {', '.join(quote(name) for name in keep)} from {rel}")
        self.meta[output] = {name: dict(value) for name, value in self.meta[source].items() if name not in drop}

    def do_rename(self, cmd: dict[str, object]) -> None:
        source, output, rel = self.flow(cmd)
        mapping = cmd.get("columns")
        if not isinstance(mapping, dict) or not mapping:
            raise RecipeError("invalid_input", "Rename mapping is required")
        old = [str(name) for name in mapping]
        require_columns(self.usercols(rel), old)
        new = [needname(value, "renamed column") for value in mapping.values()]
        final = [mapping.get(name, name) for name in self.usercols(rel)]
        unique(final)
        select = [f"{quote(name)} as {quote(str(mapping.get(name, name)))}" for name in self.columns(rel)]
        self.make(output, f"select {', '.join(select)} from {rel}")
        meta = copy_meta(self.meta[source])
        for left, right in zip(old, new):
            value = meta.pop(left, base_lineage(left))
            value["lineage"] = list(value.get("lineage", [left]))
            meta[right] = value
        self.meta[output] = meta

    def do_reorder(self, cmd: dict[str, object]) -> None:
        source, output, rel = self.flow(cmd)
        ordered = strings(cmd.get("columns"), "column order")
        user = self.usercols(rel)
        if set(ordered) != set(user) or len(ordered) != len(user):
            raise RecipeError("invalid_input", "Reorder must name every data column exactly once")
        system = [name for name in [SYSTEM, INTERNAL] if name in self.columns(rel)]
        self.make(output, f"select {', '.join(quote(name) for name in ordered + system)} from {rel}")
        self.meta[output] = copy_meta(self.meta[source])

    def do_cast(self, cmd: dict[str, object]) -> None:
        source, output, rel = self.flow(cmd)
        specs = cmd.get("columns")
        if not isinstance(specs, list) or not specs:
            raise RecipeError("invalid_input", "Cast columns are required")
        mapping: dict[str, str] = {}
        for spec in specs:
            if not isinstance(spec, dict):
                raise RecipeError("invalid_input", "Invalid cast specification")
            column = needstr(spec, "column")
            require_columns(self.usercols(rel), [column])
            expression = cast_sql(quote(column), needstr(spec, "type"), spec.get("locale"), spec.get("timezone"))
            invalid = self.db.execute(
                f"select count(*) from {rel} where {quote(column)} is not null "
                f"and trim(cast({quote(column)} as varchar)) <> '' and ({expression}) is null"
            ).fetchone()[0]
            mode = needstr(spec, "invalid")
            if mode not in {"reject", "null"}:
                raise RecipeError("invalid_input", f"Invalid cast failure policy: {mode}")
            if invalid and mode == "reject":
                raise RecipeError("invalid_input", f"{invalid} values in {column} cannot be cast")
            if invalid:
                self.diagnostics.append({
                    "code": "type_failure", "severity": "warning", "column": column,
                    "count": invalid, "command": needstr(cmd, "id"),
                })
            mapping[column] = expression
        self.project(source, output, rel, mapping)

    def do_trim(self, cmd: dict[str, object]) -> None:
        self.cellwise(cmd, lambda name: f"trim(cast({quote(name)} as varchar))")

    def do_case(self, cmd: dict[str, object]) -> None:
        mode = needstr(cmd, "mode")
        if mode == "title":
            self.cellwise(
                cmd,
                lambda name: (
                    "array_to_string(list_transform(string_split(lower(cast("
                    f"{quote(name)} as varchar)), ' '), part -> upper(left(part, 1)) || substr(part, 2)), ' ')"
                ),
            )
            return
        function = {"lower": "lower", "upper": "upper"}.get(mode)
        if function is None:
            raise RecipeError("invalid_input", "Invalid case mode")
        self.cellwise(cmd, lambda name: f"{function}(cast({quote(name)} as varchar))")

    def do_replace(self, cmd: dict[str, object]) -> None:
        source, output, rel = self.flow(cmd)
        column = needstr(cmd, "column")
        require_columns(self.usercols(rel), [column])
        find = lit(str(cmd.get("find", "")))
        replacement = lit(str(cmd.get("replacement", "")))
        if cmd.get("exact") is True:
            expression = f"case when cast({quote(column)} as varchar) = {find} then {replacement} else {quote(column)} end"
        else:
            expression = f"replace(cast({quote(column)} as varchar), {find}, {replacement})"
        self.project(source, output, rel, {column: expression})

    def do_null(self, cmd: dict[str, object]) -> None:
        source, output, rel = self.flow(cmd)
        cols = strings(cmd.get("columns"), "null columns")
        require_columns(self.usercols(rel), cols)
        values = cmd.get("values")
        if not isinstance(values, list) or not values:
            raise RecipeError("invalid_input", "Null values are required")
        checks = lambda name: " or ".join(f"{quote(name)} is not distinct from {lit(value)}" for value in values)
        self.project(source, output, rel, {name: f"case when {checks(name)} then null else {quote(name)} end" for name in cols})

    def do_split(self, cmd: dict[str, object]) -> None:
        source, output, rel = self.flow(cmd)
        column = needstr(cmd, "column")
        targets = strings(cmd.get("columns"), "split columns")
        require_columns(self.usercols(rel), [column])
        unique(self.usercols(rel) + targets)
        separator = lit(needstr(cmd, "separator"))
        select = [quote(name) for name in self.columns(rel)]
        select[-1:-1] = [
            f"split_part(cast({quote(column)} as varchar), {separator}, {index + 1}) as {quote(name)}"
            for index, name in enumerate(targets)
        ]
        self.make(output, f"select {', '.join(select)} from {rel}")
        meta = copy_meta(self.meta[source])
        for name in targets:
            meta[name] = {"owner": "derived", "lineage": [column]}
        self.meta[output] = meta

    def do_merge(self, cmd: dict[str, object]) -> None:
        source, output, rel = self.flow(cmd)
        cols = strings(cmd.get("columns"), "merge columns")
        require_columns(self.usercols(rel), cols)
        target = needstr(cmd, "column")
        unique(self.usercols(rel) + [target])
        values = ", ".join(f"cast({quote(name)} as varchar)" for name in cols)
        expression = f"concat_ws({lit(str(cmd.get('separator', '')))}, {values})"
        select = [quote(name) for name in self.columns(rel)]
        select.insert(-1, f"{expression} as {quote(target)}")
        self.make(output, f"select {', '.join(select)} from {rel}")
        meta = copy_meta(self.meta[source])
        meta[target] = {"owner": "derived", "lineage": cols}
        self.meta[output] = meta

    def do_fill(self, cmd: dict[str, object]) -> None:
        source, output, rel = self.flow(cmd)
        cols = strings(cmd.get("columns"), "fill columns")
        require_columns(self.usercols(rel), cols)
        mode = needstr(cmd, "mode")
        mapping: dict[str, str] = {}
        for name in cols:
            if mode == "down":
                mapping[name] = f"last_value({quote(name)} ignore nulls) over (order by {quote(INTERNAL)} rows between unbounded preceding and current row)"
            elif mode == "up":
                mapping[name] = f"first_value({quote(name)} ignore nulls) over (order by {quote(INTERNAL)} rows between current row and unbounded following)"
            elif mode == "value" and "value" in cmd:
                mapping[name] = f"coalesce({quote(name)}, {lit(cmd['value'])})"
            else:
                raise RecipeError("invalid_input", "Fill value is required")
        self.project(source, output, rel, mapping)

    def do_filter(self, cmd: dict[str, object]) -> None:
        source, output, rel = self.flow(cmd)
        expression = safe_expression(needstr(cmd, "expression"))
        self.make(output, f"select * from {rel} where coalesce(({expression}), false)")
        self.meta[output] = copy_meta(self.meta[source])

    def do_dedupe(self, cmd: dict[str, object]) -> None:
        source, output, rel = self.flow(cmd)
        cols = strings(cmd.get("columns"), "dedupe columns")
        require_columns(self.usercols(rel), cols)
        keep = needstr(cmd, "keep")
        if keep not in {"first", "last"}:
            raise RecipeError("invalid_input", f"Invalid dedupe policy: {keep}")
        direction = "asc" if keep == "first" else "desc"
        partition = ", ".join(quote(name) for name in cols)
        self.make(
            output,
            f"select * exclude (__rank) from (select *, row_number() over (partition by {partition} "
            f"order by {quote(INTERNAL)} {direction}) __rank from {rel}) where __rank = 1",
        )
        self.meta[output] = copy_meta(self.meta[source])

    def do_validate(self, cmd: dict[str, object]) -> None:
        source, output, rel = self.flow(cmd)
        rules = cmd.get("rules")
        if not isinstance(rules, list) or not rules:
            raise RecipeError("invalid_input", "Validation rules are required")
        for index, rule in enumerate(rules):
            if not isinstance(rule, dict):
                raise RecipeError("invalid_input", "Invalid validation rule")
            kind = needstr(rule, "kind")
            where = self.rule(rel, rule)
            count = self.db.execute(f"select count(*) from {rel} where {where}").fetchone()[0]
            if count:
                self.diagnostics.append({
                    "code": "validation", "severity": "error", "rule": index,
                    "kind": kind, "count": count, "command": needstr(cmd, "id"),
                })
        self.make(output, f"select * from {rel}")
        self.meta[output] = copy_meta(self.meta[source])

    def do_derive(self, cmd: dict[str, object]) -> None:
        source, output, rel = self.flow(cmd)
        specs = cmd.get("columns")
        if not isinstance(specs, list) or not specs:
            raise RecipeError("invalid_input", "Derived columns are required")
        names = [needstr(spec, "name") for spec in specs if isinstance(spec, dict)]
        if len(names) != len(specs):
            raise RecipeError("invalid_input", "Invalid derived column")
        unique(self.usercols(rel) + names)
        added = []
        meta = copy_meta(self.meta[source])
        for spec, name in zip(specs, names):
            expression = safe_expression(needstr(spec, "expression"))
            value = cast_sql(f"({expression})", needstr(spec, "type"), None, None)
            added.append(f"{value} as {quote(name)}")
            meta[name] = {"owner": "derived", "lineage": expression_columns(expression, self.usercols(rel))}
        select = [quote(name) for name in self.columns(rel)]
        select[-1:-1] = added
        self.make(output, f"select {', '.join(select)} from {rel}")
        self.meta[output] = meta

    def do_join(self, cmd: dict[str, object]) -> None:
        leftid = needstr(cmd, "left")
        rightid = needstr(cmd, "right")
        left = self.relation(leftid)
        right = self.relation(rightid)
        pairs = cmd.get("on")
        if not isinstance(pairs, list) or not pairs:
            raise RecipeError("invalid_input", "Join keys are required")
        leftcols = self.usercols(left)
        rightcols = self.usercols(right)
        on = []
        for pair in pairs:
            if not isinstance(pair, dict):
                raise RecipeError("invalid_input", "Invalid join key")
            lcol = needstr(pair, "left")
            rcol = needstr(pair, "right")
            require_columns(leftcols, [lcol])
            require_columns(rightcols, [rcol])
            on.append(f"l.{quote(lcol)} is not distinct from r.{quote(rcol)}")
        mode = needstr(cmd, "mode")
        join = {"inner": "inner", "left": "left", "right": "right", "full": "full"}.get(mode)
        if not join:
            raise RecipeError("invalid_input", "Invalid join mode")
        used = set(leftcols)
        rightnames: dict[str, str] = {}
        for name in rightcols:
            target = name if name not in used else suffix(name, used)
            used.add(target)
            rightnames[name] = target
        select = [f"l.{quote(name)} as {quote(name)}" for name in leftcols]
        select.extend(f"r.{quote(name)} as {quote(rightnames[name])}" for name in rightcols)
        select.append(f"row_number() over ()::bigint as {quote(INTERNAL)}")
        output = needstr(cmd, "output")
        self.make(output, f"select {', '.join(select)} from {left} l {join} join {right} r on {' and '.join(on)}")
        meta = copy_meta(self.meta[leftid])
        for name, target in rightnames.items():
            value = dict(self.meta[rightid].get(name, base_lineage(name)))
            value["owner"] = "derived"
            meta[target] = value
        self.meta[output] = meta

    def do_union(self, cmd: dict[str, object]) -> None:
        inputs = strings(cmd.get("inputs"), "union inputs")
        rels = [self.relation(item) for item in inputs]
        columns = [self.usercols(rel) for rel in rels]
        allcols = list(dict.fromkeys(name for cols in columns for name in cols))
        if len(allcols) > MAX_COLUMNS:
            raise RecipeError("invalid_input", "Union output exceeds the column limit")
        selects = []
        for rel, cols in zip(rels, columns):
            values = [quote(name) if name in cols else f"null as {quote(name)}" for name in allcols]
            selects.append(f"select {', '.join(values)} from {rel}")
        operator = "union" if cmd.get("distinct") is True else "union all"
        body = f" {operator} ".join(selects)
        output = needstr(cmd, "output")
        self.make(output, f"select *, row_number() over ()::bigint as {quote(INTERNAL)} from ({body})")
        meta: dict[str, dict[str, object]] = {}
        for source in inputs:
            for name, value in self.meta[source].items():
                current = meta.setdefault(name, {"owner": "derived", "lineage": []})
                current["lineage"] = list(dict.fromkeys(list(current["lineage"]) + list(value.get("lineage", [name]))))
        self.meta[output] = meta

    def do_pivot(self, cmd: dict[str, object]) -> None:
        source, output, rel = self.flow(cmd)
        rows = strings(cmd.get("rows"), "pivot rows", empty=True)
        cols = strings(cmd.get("columns"), "pivot columns")
        values = cmd.get("values")
        require_columns(self.usercols(rel), rows + cols)
        if not isinstance(values, list) or not values:
            raise RecipeError("invalid_input", "Pivot values are required")
        count = self.db.execute(
            f"select count(*) from (select distinct {', '.join(quote(name) for name in cols)} from {rel})"
        ).fetchone()[0]
        if count * len(values) > MAX_COLUMNS:
            raise RecipeError("invalid_input", "Pivot output exceeds the column limit")
        aggregates = []
        for value in values:
            if not isinstance(value, dict):
                raise RecipeError("invalid_input", "Invalid pivot value")
            column = needstr(value, "column")
            require_columns(self.usercols(rel), [column])
            function = {"count": "count", "sum": "sum", "min": "min", "max": "max", "average": "avg"}.get(needstr(value, "aggregate"))
            if not function:
                raise RecipeError("invalid_input", "Invalid pivot aggregate")
            aggregates.append(f"{function}({quote(column)})")
        group = f" group by {', '.join(quote(name) for name in rows)}" if rows else ""
        pivot = f"pivot {rel} on {', '.join(quote(name) for name in cols)} using {', '.join(aggregates)}{group}"
        self.make(output, f"select *, row_number() over ()::bigint as {quote(INTERNAL)} from ({pivot})")
        self.meta[output] = {name: {"owner": "derived", "lineage": rows + cols} for name in self.usercols(self.rels[output])}

    def do_unpivot(self, cmd: dict[str, object]) -> None:
        source, output, rel = self.flow(cmd)
        keys = strings(cmd.get("keys"), "unpivot keys", empty=True)
        cols = strings(cmd.get("columns"), "unpivot columns")
        require_columns(self.usercols(rel), keys + cols)
        name = needstr(cmd, "name")
        value = needstr(cmd, "value")
        unique(keys + [name, value])
        chosen = ", ".join(quote(item) for item in keys + cols)
        statement = (
            f"from (select {chosen} from {rel}) unpivot "
            f"({quote(value)} for {quote(name)} in ({', '.join(quote(item) for item in cols)}))"
        )
        self.make(output, f"select *, row_number() over ()::bigint as {quote(INTERNAL)} from ({statement})")
        meta = {key: dict(self.meta[source].get(key, base_lineage(key))) for key in keys}
        meta[name] = {"owner": "derived", "lineage": cols}
        meta[value] = {"owner": "derived", "lineage": cols}
        self.meta[output] = meta

    def do_output(self, cmd: dict[str, object]) -> None:
        source = needstr(cmd, "input")
        rel = self.relation(source)
        output = needstr(cmd, "id")
        cls = needstr(cmd, "class")
        if cls not in {"entity", "derived", "native"}:
            raise RecipeError("invalid_input", f"Invalid output class: {cls}")
        keys = strings(cmd.get("keys"), "output keys", empty=True)
        require_columns(self.usercols(rel), keys)
        owners = cmd.get("owners")
        if not isinstance(owners, dict):
            raise RecipeError("invalid_input", "Output owners are required")
        unknown = [name for name in owners if name not in self.usercols(rel)]
        if unknown:
            raise RecipeError("invalid_input", f"Output owner references unknown column: {unknown[0]}")
        if cls in {"entity", "native"}:
            if SYSTEM not in self.columns(rel):
                raise RecipeError("identity_invalid", "Editable outputs require a key command")
            invalid = self.db.execute(
                f"select count(*) - count(distinct {quote(SYSTEM)}) + count(*) filter (where {quote(SYSTEM)} is null) from {rel}"
            ).fetchone()[0]
            if invalid:
                raise RecipeError("identity_invalid", "Output row identity is invalid")
        target = self.make(output, f"select * from {rel}")
        self.meta[output] = copy_meta(self.meta[source])
        self.outputs[output] = {
            "relation": target,
            "schema": needstr(cmd, "schema"),
            "table": needstr(cmd, "table"),
            "class": cls,
            "keys": keys,
            "owners": owners,
        }

    def do_code(self, cmd: dict[str, object]) -> None:
        raise RecipeError("mapping_not_invertible", "Signed code steps require the isolated gVisor runner")

    def flow(self, cmd: dict[str, object]) -> tuple[str, str, str]:
        source = needstr(cmd, "input")
        output = needstr(cmd, "output")
        return source, output, self.relation(source)

    def track(self, cmd: dict[str, object], kind: str) -> None:
        if kind == "source":
            target = needstr(cmd, "output")
            self.traits[target] = {"policy": "preserved", "blocks": []}
            return
        if kind == "join":
            inputs = [needstr(cmd, "left"), needstr(cmd, "right")]
            target = needstr(cmd, "output")
        elif kind == "union":
            inputs = strings(cmd.get("inputs"), "union inputs")
            target = needstr(cmd, "output")
        else:
            inputs = [needstr(cmd, "input")]
            target = needstr(cmd, "id") if kind == "output" else needstr(cmd, "output")
        ranks = {"preserved": 0, "filtered": 1, "combined": 2, "derived": 3}
        policies = [str(self.traits[source]["policy"]) for source in inputs]
        policy = max(policies, key=lambda value: ranks[value])
        if kind in {"filter", "dedupe"} and ranks[policy] < ranks["filtered"]:
            policy = "filtered"
        if kind in {"join", "union"} and ranks[policy] < ranks["combined"]:
            policy = "combined"
        if kind in {"pivot", "unpivot"}:
            policy = "derived"
        blocks = list(dict.fromkeys(item for source in inputs for item in self.traits[source]["blocks"]))
        if kind in NONINVERTIBLE:
            blocks.append(kind)
        if kind == "output" and cmd.get("class") == "derived":
            blocks.append("derived output")
        self.traits[target] = {"policy": policy, "blocks": list(dict.fromkeys(blocks))}

    def cellwise(self, cmd: dict[str, object], make) -> None:
        source, output, rel = self.flow(cmd)
        cols = strings(cmd.get("columns"), "columns")
        require_columns(self.usercols(rel), cols)
        self.project(source, output, rel, {name: make(name) for name in cols})

    def project(self, source: str, output: str, rel: str, mapping: dict[str, str]) -> None:
        select = [f"{mapping[name]} as {quote(name)}" if name in mapping else quote(name) for name in self.columns(rel)]
        self.make(output, f"select {', '.join(select)} from {rel}")
        self.meta[output] = copy_meta(self.meta[source])

    def rule(self, rel: str, rule: dict[str, object]) -> str:
        kind = needstr(rule, "kind")
        if kind == "required":
            column = needstr(rule, "column")
            require_columns(self.usercols(rel), [column])
            return f"{quote(column)} is null or trim(cast({quote(column)} as varchar)) = ''"
        if kind == "unique":
            cols = strings(rule.get("columns"), "unique columns")
            require_columns(self.usercols(rel), cols)
            group = ", ".join(quote(name) for name in cols)
            return f"({group}) in (select {group} from {rel} group by {group} having count(*) > 1)"
        if kind == "range":
            column = needstr(rule, "column")
            require_columns(self.usercols(rel), [column])
            checks = []
            if isinstance(rule.get("min"), (int, float)):
                checks.append(f"{quote(column)} < {lit(rule['min'])}")
            if isinstance(rule.get("max"), (int, float)):
                checks.append(f"{quote(column)} > {lit(rule['max'])}")
            if not checks:
                raise RecipeError("invalid_input", "Range validation needs min or max")
            return " or ".join(checks)
        if kind == "pattern":
            column = needstr(rule, "column")
            require_columns(self.usercols(rel), [column])
            return f"not regexp_matches(cast({quote(column)} as varchar), {lit(needstr(rule, 'pattern'))})"
        if kind == "expression":
            return f"not coalesce(({safe_expression(needstr(rule, 'expression'))}), false)"
        raise RecipeError("invalid_input", f"Unsupported validation rule: {kind}")

    def make(self, output: str, sql: str) -> str:
        if output in self.rels:
            raise RecipeError("invalid_input", f"Duplicate dataset output: {output}")
        rel = self.name("data")
        self.db.execute(f"create table {rel} as select * from ({sql}) limit {self.maxrows + 1}")
        rows = self.count(rel)
        if rows > self.maxrows:
            raise RecipeError("invalid_input", f"Recipe output exceeds {self.maxrows} rows")
        if len(self.columns(rel)) > MAX_COLUMNS + 2:
            raise RecipeError("invalid_input", f"Recipe output exceeds {MAX_COLUMNS} columns")
        self.rels[output] = rel
        return rel

    def relation(self, source: str) -> str:
        rel = self.rels.get(source)
        if not rel:
            raise RecipeError("invalid_input", f"Recipe input is unavailable: {source}")
        return rel

    def name(self, prefix: str) -> str:
        self.counter += 1
        return f"{prefix}_{self.counter}"

    def count(self, rel: str) -> int:
        return int(self.db.execute(f"select count(*) from {rel}").fetchone()[0])

    def columns(self, rel: str) -> list[str]:
        return [str(row[1]) for row in self.db.execute(f"pragma table_info('{rel}')").fetchall()]

    def usercols(self, rel: str) -> list[str]:
        return [name for name in self.columns(rel) if name not in {INTERNAL, SYSTEM}]

    def schema(self, rel: str) -> dict[str, str]:
        return {str(row[1]): str(row[2]) for row in self.db.execute(f"pragma table_info('{rel}')").fetchall()}

    def nulls(self, rel: str, columns: list[str]) -> dict[str, bool]:
        select = ", ".join(f"count(*) filter (where {quote(name)} is null) > 0" for name in columns)
        row = self.db.execute(f"select {select} from {rel}").fetchone()
        if not row:
            raise RecipeError("invalid_input", "Output nullability inspection failed")
        return dict(zip(columns, map(bool, row)))

    def column(
        self,
        rel: str,
        name: str,
        dtype: str,
        owners: dict[str, object],
        nullable: bool,
    ) -> dict[str, object]:
        meta = dict(self.meta.get(next((key for key, value in self.rels.items() if value == rel), ""), {}).get(name, base_lineage(name)))
        owner = owners.get(name, meta.get("owner", "shared"))
        if owner not in {"shared", "workbook", "database", "formula", "derived"}:
            raise RecipeError("invalid_input", f"Invalid owner for column: {name}")
        if meta.get("formula") and owner != "formula":
            owner = "formula"
        return {
            "id": physical(name),
            "name": name,
            "type": protocol_type(dtype),
            "owner": owner,
            "nullable": nullable,
            "lineage": meta.get("lineage", [name]),
            **({"formula": meta["formula"]} if meta.get("formula") else {}),
            **({"formulaStale": True} if meta.get("stale") else {}),
            **({"system": True} if meta.get("system") else {}),
        }


def execute(
    root: Path,
    inputs: dict[str, Path],
    commands: list[dict[str, object]],
    output: str,
    lineage: dict[str, object] | None = None,
    writeback: bool = False,
    rows: int = MAX_ROWS,
) -> Execution:
    return Executor(root, inputs, commands, lineage, rows).run(output, writeback)


def add_metadata(path: Path, manifest: dict[str, object]) -> None:
    rewrite_metadata(path, b"veritly.recipe", manifest)


def rewrite_metadata(path: Path, key: bytes, value: dict[str, object]) -> None:
    source = pq.ParquetFile(path)
    metadata = dict(source.schema_arrow.metadata or {})
    metadata[key] = json.dumps(value, separators=(",", ":")).encode()
    target = path.with_suffix(".metadata.parquet")
    writer = pq.ParquetWriter(target, source.schema_arrow.with_metadata(metadata), compression="zstd")
    try:
        for batch in source.iter_batches(batch_size=10_000):
            writer.write_batch(batch)
    finally:
        writer.close()
    target.replace(path)


def parquet_lineage(path: Path, columns: list[str]) -> dict[str, dict[str, object]]:
    raw = (pq.read_metadata(path).metadata or {}).get(b"veritly.lineage")
    if not raw:
        return {name: base_lineage(name) for name in columns}
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RecipeError("invalid_input", "Parquet lineage metadata is invalid") from error
    if not isinstance(value, dict):
        raise RecipeError("invalid_input", "Parquet lineage metadata is invalid")
    return normalize_lineage({"source": value}).get("source", {})


def order(commands: list[dict[str, object]]) -> list[dict[str, object]]:
    ids: dict[str, dict[str, object]] = {}
    for command in commands:
        if not isinstance(command, dict):
            raise RecipeError("invalid_input", "Recipe commands must be objects")
        cid = needstr(command, "id")
        if cid in ids:
            raise RecipeError("invalid_input", f"Duplicate command ID: {cid}")
        ids[cid] = command
    done: set[str] = set()
    result: list[dict[str, object]] = []
    while len(result) < len(commands):
        ready = [
            command for command in commands if needstr(command, "id") not in done
            and all(dep in done for dep in strings(command.get("after", []), "command dependencies", empty=True))
        ]
        if not ready:
            raise RecipeError("invalid_input", "Recipe command graph contains a cycle or missing dependency")
        for command in ready:
            cid = needstr(command, "id")
            unknown = [dep for dep in strings(command.get("after", []), "command dependencies", empty=True) if dep not in ids]
            if unknown:
                raise RecipeError("invalid_input", f"Unknown command dependency: {unknown[0]}")
            done.add(cid)
            result.append(command)
    return result


def closure(commands: list[dict[str, object]], output: str) -> set[str]:
    items = {needstr(command, "id"): command for command in commands}
    if output not in items or items[output].get("kind") != "output":
        raise RecipeError("invalid_input", "Requested recipe output command does not exist")
    needed = {output}
    pending = [output]
    while pending:
        current = pending.pop()
        for dependency in strings(items[current].get("after", []), "command dependencies", empty=True):
            if dependency not in items:
                raise RecipeError("invalid_input", f"Unknown command dependency: {dependency}")
            if dependency in needed:
                continue
            needed.add(dependency)
            pending.append(dependency)
    return needed


def command_inputs(command: dict[str, object]) -> list[str]:
    kind = needstr(command, "kind")
    if kind == "source":
        return []
    if kind == "join":
        return [needstr(command, "left"), needstr(command, "right")]
    if kind == "union":
        return strings(command.get("inputs"), "union inputs")
    if kind == "code":
        return strings(command.get("inputs"), "code inputs")
    return [needstr(command, "input")]


def audit_parquet(path: Path, rows: int) -> int:
    if not path.is_file() or path.stat().st_size > MAX_BYTES:
        raise RecipeError("invalid_input", "Parquet input exceeds the file limit")
    try:
        meta = pq.read_metadata(path)
    except Exception as error:
        raise RecipeError("invalid_input", "Malformed Parquet input") from error
    if meta.num_rows > rows:
        raise RecipeError("invalid_input", f"Parquet input exceeds {rows} rows")
    if meta.num_columns > MAX_COLUMNS:
        raise RecipeError("invalid_input", f"Parquet input exceeds {MAX_COLUMNS} columns")
    expanded = sum(meta.row_group(index).total_byte_size for index in range(meta.num_row_groups))
    if expanded > MAX_EXPANDED:
        raise RecipeError("invalid_input", "Parquet expanded content exceeds 2 GiB")
    return expanded


def cast_sql(value: str, dtype: str, locale: object, timezone: object) -> str:
    text = f"nullif(trim(cast({value} as varchar)), '')"
    if dtype == "text":
        return f"cast({value} as varchar)"
    if dtype in {"integer", "decimal"}:
        code = str(locale).lower() if isinstance(locale, str) else "en-us"
        comma = code.startswith(("de", "fr", "es", "it", "pt", "nl", "da", "no", "sv", "fi", "pl", "tr"))
        clean = f"replace(replace(replace({text}, ' ', ''), chr(160), ''), chr(8239), '')"
        clean = f"replace(replace({clean}, '.', ''), ',', '.')" if comma else f"replace({clean}, ',', '')"
        target = "bigint" if dtype == "integer" else "double"
        return f"try_cast({clean} as {target})"
    if dtype == "boolean":
        normalized = f"lower({text})"
        return f"case when {normalized} in ('true','yes','y','1') then true when {normalized} in ('false','no','n','0') then false else try_cast({text} as boolean) end"
    if dtype == "date":
        code = str(locale).lower() if isinstance(locale, str) else ""
        pattern = "%m/%d/%Y" if code.startswith("en-us") else "%d/%m/%Y"
        return f"coalesce(try_cast({text} as date), cast(try_strptime({text}, {lit(pattern)}) as date))"
    if dtype == "timestamp":
        if timezone is not None:
            if not isinstance(timezone, str):
                raise RecipeError("invalid_input", "Timezone must be text")
            try:
                ZoneInfo(timezone)
            except ZoneInfoNotFoundError as error:
                raise RecipeError("invalid_input", f"Unknown timezone: {timezone}") from error
            return f"coalesce(try_cast({text} as timestamptz), timezone({lit(timezone)}, try_cast({text} as timestamp)))"
        return f"try_cast({text} as timestamptz)"
    raise RecipeError("invalid_input", f"Unsupported column type: {dtype}")


def safe_expression(value: str) -> str:
    expression = value.strip()
    if not expression or len(expression) > MAX_EXPR or DENIED.search(expression):
        raise RecipeError("invalid_input", "Expression uses unsupported SQL syntax")
    for function in CALL.findall(expression):
        if function.lower() not in SAFE_FUNCTIONS:
            raise RecipeError("invalid_input", f"Expression function is not allowed: {function}")
    return expression


def expression_columns(expression: str, columns: list[str]) -> list[str]:
    lowered = expression.lower()
    return [name for name in columns if name.lower() in lowered]


def uuid_sql(seed: str) -> str:
    digest = f"md5({seed})"
    return (
        "cast(" + f"substr({digest},1,8) || '-' || substr({digest},9,4) || '-5' || "
        f"substr({digest},14,3) || '-9' || substr({digest},18,3) || '-' || substr({digest},21,12)" + " as uuid)"
    )


def quote(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def lit(value: object) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise RecipeError("invalid_input", "Non-finite recipe value")
        return repr(value)
    if isinstance(value, str):
        if "\x00" in value:
            raise RecipeError("invalid_input", "Recipe text contains a null byte")
        return "'" + value.replace("'", "''") + "'"
    raise RecipeError("invalid_input", "Unsupported recipe value")


def strings(value: object, label: str, empty: bool = False) -> list[str]:
    if not isinstance(value, list) or (not value and not empty):
        raise RecipeError("invalid_input", f"{label} must be an array")
    result = [needname(item, label) for item in value]
    unique(result)
    return result


def needstr(value: dict[str, object], key: str) -> str:
    item = value.get(key)
    if not isinstance(item, str) or not item.strip() or len(item) > 1024:
        raise RecipeError("invalid_input", f"{key} is required")
    return item.strip()


def needname(value: object, label: str) -> str:
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > 128:
        raise RecipeError("invalid_input", f"Invalid {label}")
    return value.strip()


def unique(values: list[str]) -> None:
    if len(values) != len(set(values)):
        raise RecipeError("invalid_input", "Column names must be unique")


def require_columns(columns: list[str], required: list[str]) -> None:
    missing = [name for name in required if name not in columns]
    if missing:
        raise RecipeError("invalid_input", f"Column not found: {missing[0]}")


def normalize_lineage(value: dict[str, object] | None) -> dict[str, dict[str, dict[str, object]]]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise RecipeError("invalid_input", "Lineage must be an object")
    result: dict[str, dict[str, dict[str, object]]] = {}
    for source, columns in value.items():
        if not isinstance(columns, dict):
            raise RecipeError("invalid_input", "Lineage columns must be an object")
        result[source] = {}
        for name, raw in columns.items():
            if not isinstance(raw, dict):
                raise RecipeError("invalid_input", "Column lineage must be an object")
            owner = raw.get("owner", "shared")
            if owner not in {"shared", "workbook", "database", "formula", "derived"}:
                raise RecipeError("invalid_input", f"Invalid lineage owner: {owner}")
            item: dict[str, object] = {"owner": owner, "lineage": [name]}
            if isinstance(raw.get("formula"), str):
                item["formula"] = raw["formula"]
                item["owner"] = "formula"
            if raw.get("stale") is True:
                item["stale"] = True
                if isinstance(raw.get("staleCount"), int):
                    item["staleCount"] = raw["staleCount"]
            result[source][name] = item
    return result


def copy_meta(value: dict[str, dict[str, object]]) -> dict[str, dict[str, object]]:
    return {name: {**item, "lineage": list(item.get("lineage", [name]))} for name, item in value.items()}


def base_lineage(name: str) -> dict[str, object]:
    return {"owner": "shared", "lineage": [name]}


def suffix(name: str, used: set[str]) -> str:
    index = 2
    candidate = f"{name}_right"
    while candidate in used:
        candidate = f"{name}_right_{index}"
        index += 1
    return candidate


def physical(name: str) -> str:
    value = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
    if not value or not value[0].isalpha():
        value = "column_" + value
    return value[:96]


def protocol_type(dtype: str) -> str:
    upper = dtype.upper()
    if "BOOL" in upper:
        return "boolean"
    if any(value in upper for value in ["BIGINT", "INTEGER", "SMALLINT", "TINYINT", "UBIGINT", "UINTEGER"]):
        return "integer"
    if any(value in upper for value in ["DECIMAL", "DOUBLE", "FLOAT", "REAL"]):
        return "decimal"
    if upper == "DATE":
        return "date"
    if "TIMESTAMP" in upper:
        return "timestamp"
    return "text"
