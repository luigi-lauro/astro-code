---
description: Author or refresh a kit's data source — introspect the database through a running Astro instance and write src/sources/<id>/schema.json + SOURCE.md
argument-hint: [source id] [instance URL]
allowed-tools: Bash, Read, AskUserQuestion
---

You are authoring **this kit's** data source — `<source id>` — by introspecting the
real database **through a running Astro instance**, never a local driver. The
instance reads the catalog inside its read-only envelope and returns it as JSON;
this command writes that into `src/sources/<id>/schema.json` and `src/sources/<id>/
SOURCE.md`. First run creates both from scratch; every later run **merges** —
author edits are never lost, and drift from the database is flagged, not deleted.

The tool is `$(ac path templates)/kit/tools/kit_source.py` — stdlib-only (no deps),
invoked from the installed astro-code templates so it works even for kits scaffolded
before this command existed. New kits also ship their own copy at
`tools/kit_source.py`. **Prefer the kit's local copy if present, else the templates
one.**

1. **Preflight.** Confirm the cwd is a kit repo (`src/CLAUDE.md` exists and at least
   one of `registry-entry.json` / `kit.json` is present). Confirm the source id given
   in `$ARGUMENTS` is declared in `kit.json`'s `sources[]` — if it is not, tell the
   user which ids are declared and stop; nothing is written for an undeclared id.

2. **Collect credentials via env — there is no password flag.** The tool accepts no
   password on the command line at all; it reads:
   - `ASTRO_BASE_URL` (or `--base <instance URL>`), `ASTRO_ADMIN_EMAIL`,
     `ASTRO_ADMIN_PASSWORD` — the admin account used to call the instance's
     introspect endpoint.
   - For a one-off connection (no binding yet, or the kit isn't uploaded):
     `ASTRO_SOURCE_<ID>_HOST`, `_PORT` (default 1433), `_DATABASE`, `_USERNAME`,
     `_PASSWORD`, `_TRUST_SERVER_CERTIFICATE` (`1`/`true`), where `<ID>` is the
     source id upper-cased with every non-alphanumeric character turned into `_`.
     If the source is already bound (saved + last test ok), the bound connection is
     used instead and none of these are needed.

   If any required variable is missing, ask the user for it and run the tool with a
   one-line `VAR='…' python3 …` prefix so the password never lands in argv or the
   transcript — never as a flag, and never echoed back in any report.

3. **Run the tool.**
   ```
   ASTRO_ADMIN_PASSWORD='<password>' python3 "$(ac path templates)/kit/tools/kit_source.py" \
     <source id> --base <instance URL> [--include <glob>]... [--exclude <glob>]... [--sample-values]
   ```
   `--include` / `--exclude` take `schema.table` globs to narrow table scope (default:
   every user table and view, excluding system schemas). `--sample-values` opts into
   sampling distinct values for low-cardinality columns — off by default, and never
   for a column already marked `sensitive: true` or whose name matches a sensitive
   pattern (password, secret, token, ssn, iban, email, phone, …), nor for binary or
   large types.

4. **Relay the summary exactly.** The tool prints what changed on stdout:
   - **First run** — `src/sources/<id>/schema.json` and `src/sources/<id>/SOURCE.md`
     are created. SOURCE.md is a skeleton (database name, a table overview, and TODO
     prompts for purpose, rules, units and time zones) and is **never rewritten**
     again once it exists.
   - **Re-run** — tables/columns new in the database are added; SQL types are
     refreshed; every author-written field (purpose, meaning, rules, unit, tz,
     values, hand-added joins, sensitive) is kept verbatim; tables/columns gone from
     the database are **flagged**, never deleted, so nothing an author wrote is lost
     silently.
   - If `--sample-values` was used, the summary lists which columns were sampled —
     **review the sampled values before publishing the kit**: they ship inside it.

5. **Suggest the next check.** Offer `/astro-kit-test` (offline, static) and then
   `/astro-kit-test --live` (opt-in; calls the instance to catch drift between
   schema.json and the real database, and mismatched named-query `@returns`) before
   `/astro-kit-publish`.

Report exactly what the tool reported — added/flagged/type-changed counts and
whether SOURCE.md was created or left untouched — and never invent success: if the
tool exits non-zero, surface its message and stop.
