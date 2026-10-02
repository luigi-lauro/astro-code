---
description: Challenge an idea that isn't a phase yet — numbered rounds, every round saved
argument-hint: "<idea>" | <backlog id>
allowed-tools: Bash, Read, Grep, Glob, Agent, AskUserQuestion
---

Turn a loose idea into settled decisions before it ever claims a phase number.

## Steps

1. **Where the record lives.** Run `ac status`. If it says there is no `.astrocode/`
   here, tell the user in one line that this conversation is the only record (nothing
   is written to disk), then run the method with no writes at all — never `ac init`,
   never create `.astrocode/`, never `ac decision add`, no backlog offer at the end.

2. **Pick the item.** Try `ac backlog show "$ARGUMENTS"`.
   - If it resolves and `$ARGUMENTS` is exactly that item's id, challenge that item —
     go to step 3 with this id.
   - If it resolves only by a fuzzy match (an id fragment or a title word), say in one
     line which item matched, then ask one `AskUserQuestion`: challenge this existing
     item, or file `$ARGUMENTS` as a new idea? Only proceed past this if the answer is
     clear — an existing id never spawns a second item.
   - Otherwise, run `ac backlog add "<idea trimmed to one line>"` and read the id it
     prints.

3. **Run the method.** Load and apply `` `$(ac path templates)/challenge.md` `` in
   full. Destination for every round: `ac backlog note <id> "<round record>" --append`
   — the record opening with a plain `Round N` heading, then `Settled:` and `Open:`
   lists. Never `--replace`, and never a bare `ac backlog note <id> "…"` write (no
   `--append`) while a session is in progress — each round adds to the note, it never
   overwrites the ones before it. Hard-to-reverse choices still follow the method's
   `ac decision add` rule.

4. **Report and hand off.** In one line: the backlog item's id, how many rounds ran,
   how many questions are still open, and that `/astro-backlog-promote <id>` later
   seeds this note into a phase's CONTEXT.md — which still needs a real
   `/astro-discuss <n>` (optionally `--challenge`) before it can be planned. No phase
   number is spent by this command.

Everything about the round format, the checkpoint, the nudge and how unknowns are
handled lives in the shared method — this command states only where things are saved
and how the item is picked, never the mechanics themselves.
