# Changelog

Release notes in full live on the [GitHub releases page](https://github.com/uublive/astro-code/releases).

## v0.38.0

- Astro Fleet now receives outcomes as well as activity. It is told when a phase is verified, rejected or accepted, when a fix is accepted, and about every `git commit`, with who signed it and whether an accept was a first try. A fleet can then rank sessions by what they deliver

## v0.37.0

- Challenge mode: a thorough, opt-in interview for `/astro-new-project`, `/astro-adopt`, `/astro-discuss --challenge`, `/astro-autonomous --challenge` and the new `/astro-challenge`
- On Codex, `/astro-config` no longer offers Claude models, and never writes a model into the shared config

## v0.36.1

- `ac fleet connect` no longer leaves an 'unknown' bay in the Forge
