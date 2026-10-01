<!-- astro-fast: spec -->
# Phase 33 — Kit authoring guidance for data sources

**Goal:** a kit author using /astro-kit-new or /astro-kit-convert is guided to declare,
author and use data sources without rediscovering the spec, and the kit's runtime
instructions tell its agent how this kit uses its sources.

Runtime facts (from the astro repo, phase 105 — do NOT duplicate, point at them):
- UseKit's post-load summary lists a kit's sources + named queries + six generic working
  rules (read SOURCE.md/DescribeSource before SQL; prefer named queries; probe TOP 20 then
  aggregate in SQL; never SELECT * on large tables; outputPath for anything a script reads;
  cite queryIds).
- Agent tools: `DescribeSource` (SOURCE.md, schema.json, live drift) and `QuerySource`
  (`source`, `query` | `sql`, `params`, `maxRows`, `outputPath` .csv/.jsonl, `kit`).
- Kit scripts: `astro-query` CLI or stdlib `astro_sources.py` — `astro_sources.query(source,
  name, out=None, kit=None, max_rows=None, **params)` and `astro_sources.sql(source, text, …)`;
  both return the CLI's JSON dict; errors raise `AstroQueryError(code, message)`. Exists only
  inside the Astro worker.

## Changes

### t1 — Add a "Writing a good source" guide to KIT-CONTRACT.md
- **id:** t1
- **file:** templates/kit/KIT-CONTRACT.md
- **depends_on:** [ ]
- **what:** Short subsection inside "Data sources" (after Check IDs or after Named queries): what a useful SOURCE.md contains (purpose + when to use it, which tables answer which questions, grain, business rules/filters that must always apply e.g. soft-deletes/status codes, units/currency, time zones, known traps); schema.json `purpose`/`meaning`/`rules`/`values`/`sensitive` written for an agent reader; named queries — one per recurring question the recipe asks, deterministic, `@returns` matches exactly, `@max_rows` set, params typed, aggregate in SQL; when to set `adhoc: false` (production DBs, sensitive data, kits whose questions are fully known) vs leave ad-hoc on; how runtime consumes it (agent → DescribeSource/QuerySource; scripts → astro_sources.py / astro-query, outputPath files) with a pointer that UseKit already states the generic rules. Concise — ~40-60 lines.
- **source:** "(4) A short guide on writing a good SOURCE.md and named queries (@returns, @max_rows, adhoc:false), placed in KIT-CONTRACT.md or a sibling guide"

### t2 — Sharper prompts in kit_source.py's SOURCE.md skeleton
- **id:** t2
- **file:** templates/kit/tools/kit_source.py
- **depends_on:** [t1]
- **what:** Replace the four generic TODOs in `build_source_md` with specific prompts (purpose + when an agent should/shouldn't query it; which tables answer which questions; grain; mandatory filters/business rules; units/currency; time zone of each date column family; known traps), and point at KIT-CONTRACT.md "Writing a good source". Keep the existing `## Purpose` heading (tests/kit_source.test.mjs asserts it) and the table overview. Run `node --test tests/kit_source.test.mjs tests/kit_source_fix_106.test.mjs`.
- **source:** "better TODO prompts in kit_source.py's SOURCE.md skeleton"

### t3 — Data sources section in the kit runtime instructions + recipe
- **id:** t3
- **file:** templates/kit/src/CLAUDE.md.tmpl, templates/kit/src/recipes/recipe.yaml.tmpl
- **depends_on:** [t1]
- **what:** CLAUDE.md.tmpl: add a `## Data sources` section with a guidance comment saying fill it only if kit.json declares sources (delete otherwise): per source, what it's for; a table mapping recipe phase → source → named query (or ad-hoc) → params → who runs it (agent via QuerySource vs script via astro_sources/astro-query) → output file under _report/; one line saying the generic rules come from UseKit's summary + DescribeSource and are not repeated here. recipe.yaml.tmpl: a commented example of a source-using phase step/constraints (e.g. "Run named query `<q>` on source `<id>` with outputPath _report/data/<q>.csv; cite the queryId") — commented so a source-less kit is unaffected.
- **source:** "(3) templates/kit/src/CLAUDE.md.tmpl + recipe.yaml.tmpl — a Data sources section (only filled when sources declared)…"

### t4 — Source-backed example in EXAMPLES.md.tmpl
- **id:** t4
- **file:** templates/kit/src/EXAMPLES.md.tmpl
- **depends_on:** [t3]
- **what:** Add a guidance-commented, optional "source-backed" pattern (in Common Patterns, delete if no sources): a short script snippet `import astro_sources` → `astro_sources.query("erp", "open_orders", out="_report/data/open_orders.csv", CustomerId=42)` handling `AstroQueryError`, plus a matching named-query header example; note it runs only inside an Astro worker (test with /astro-kit-test --live / a running instance). Must keep EXAMPLES required sections intact so kit_test still parses the template-derived file.
- **source:** "(5) EXAMPLES.md.tmpl — an example source-backed use case with a script calling astro_sources.query(..., output_path)"

### t5 — /astro-kit-new asks about data sources
- **id:** t5
- **file:** commands/astro-kit-new.md
- **depends_on:** [t1]
- **what:** Interview bullet: does the kit read a database? If yes, per source collect id (stable, `^[a-z][a-z0-9_-]{0,31}$`), description, required, adhoc (recommend adhoc:false when the questions are known). Scaffold: fill `sources[]` and set `contract_version` to `^1.1.0`; fill CLAUDE.md's Data sources section, else delete it. Step 3 tools list: make explicit and complete (add kit_source.py, _astro_client.py, parity_check.py — match templates/kit/tools contents). Conventions seed: include the sources rules. Phase proposal: when sources declared, add a phase "Data sources — /astro-kit-source <id> per source, write SOURCE.md + named queries, /astro-kit-test --live". Note scaffold sanity: SRC-04/05 fail until /astro-kit-source runs — that's expected to-do.
- **source:** "(1) commands/astro-kit-new.md — interview asks whether the kit reads a database…"

### t6 — /astro-kit-convert detects database access
- **id:** t6
- **file:** commands/astro-kit-convert.md
- **depends_on:** [t5]
- **what:** In "Map the source": detect DB access — DB drivers (pyodbc, pymssql, sqlalchemy, sqlcmd), connection strings / DSNs, `.sql` files, and CSV/Excel inputs that are exports of a database. Offer (AskUserQuestion) a live source instead of the frozen export; SQL Server only (engine enum), otherwise keep the file input. When accepted: declare sources[], contract_version ^1.1.0, turn the tool's SQL into named queries with @returns, credentials never copied (bindings live in astroport). Parity: fixtures capture the query results the source consumed (the export or a captured result set) so parity compares logic, not live data. Keep existing tests in tests/kit_convert.test.mjs passing.
- **source:** "(2) commands/astro-kit-convert.md — detect DB access in the source … offer a live source instead of the frozen export; parity fixtures use captured query results."

## To clarify / unclassified
- "no local-run stub for astro_sources (out of scope, test against a running instance)" — out of scope by request; a source-backed kit script can't run under kit_run_local.py / --tier2. Candidate for backlog.
- Engine is `sqlserver` only — a source tool on Postgres/MySQL can't become a live source yet; convert keeps the file input in that case.

## Scope guard
verdict: PROCEED — docs/templates plus one string change in a tool; no schema, API, dependency or decision change (ADR-024 respected: both commands keep the shared templates/kit tree).
