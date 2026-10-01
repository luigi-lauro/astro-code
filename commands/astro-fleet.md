---
description: Report this machine's Claude Code sessions to an Astro Fleet — connect, status, pause/resume, colour, disconnect
argument-hint: "[status | connect <url> --token <t> [--color '#rrggbb'] [--name <label>] [--hide-names] | pause | resume | color <#rrggbb> | disconnect]"
allowed-tools: Bash, AskUserQuestion
---

Drive `ac fleet`, the connector that reports every Claude Code session on this machine —
any repo, not only astro-code projects — to an Astro Fleet's Forge. The CLI owns
everything: the config (`~/.astro/fleet.json`), the user-level hooks and the queue. This
command only picks the verb and relays the result. Never edit those files yourself.

## Steps

Keyed on the first word of `$ARGUMENTS`:

| `$ARGUMENTS` | Run |
|---|---|
| empty, or `status` | `ac fleet status` |
| `connect …` | `ac fleet connect …` (see step 2) |
| `pause` / `resume` | `ac fleet pause` / `ac fleet resume` |
| `color <hex>` (or `colour`) | `ac fleet color '<hex>'` |
| `disconnect` | `ac fleet disconnect` (see step 3) |
| anything else | print the argument hint in one line and stop |

1. **Status.** Run `ac fleet status`. Relay it **in at most four lines**: the fleet URL,
   whether reporting is on, paused or stopped, and the queue depth. Add the last error
   only when there is one. If the CLI says it is not connected, say so in one line, with
   the connect form, and stop. Never print the token beyond the redacted form the CLI
   gives.

2. **Connect.** Without a URL and a `--token`, don't ask for the token in the chat. Say
   in one line that the token comes from the fleet admin's Sources panel. Then give the
   exact `ac fleet connect <url> --token <t>` line to run in a terminal, and stop.
   Otherwise run the command as given. Quote the colour (`--color '#4fb3ff'`), because a
   bare `#` starts a shell comment.
   - **Report** in one line: `connected ✓` with the URL and colour, or the CLI's error
     verbatim. A 401 means the token is invalid or revoked.
   - **Then add one line:** the token is now in this session's transcript. Running the
     command in a terminal keeps it out, and if that matters the user can revoke the
     token in the admin and reconnect.
   - Sessions already running start reporting once restarted. Say this only on success.

3. **Disconnect.** Removing the hooks is reversible by reconnecting, but the token is
   deleted with the config. Confirm once with `AskUserQuestion` unless `$ARGUMENTS`
   already says `disconnect` and nothing else was asked of you in this turn. Then run it
   and report in one line which settings files lost the fleet hooks.

4. **Pause, resume, colour.** Run the command and relay its single `✓` line. Say nothing
   more.

## Notes

- The hook reports activity only: session start and end, prompt, tool, waiting, stop
  and sub-agents. It never sends prompt text, tool payloads or transcripts. If asked what
  is sent, say that, and mention `--hide-names`, which hashes project names and drops the
  repo URL and cwd.
- `ac fleet status --json` is the machine-readable form, if you need a field the human
  view omits.
