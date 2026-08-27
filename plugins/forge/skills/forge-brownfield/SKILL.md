---
name: forge-brownfield
description: Brownfield orientation for Forge. Use when the user asks for changes to an EXISTING codebase (feature, fix, refactor) and Forge has no established understanding of the affected area yet. Produces scoped understanding, a recorded baseline, and a mini-spec with acceptance criteria — then hands off to the normal build loop.
---

# Forge brownfield orientation

Goal: reach "we can explain enough of the relevant system to modify it
safely" — for THIS task. Never reconstruct the whole system for a bounded
change; never modify anything before the baseline exists.

## 1. Scope the question

From the user's request, name the subsystem(s) plausibly affected. That is
your orientation boundary. Widen it only on evidence.

## 2. Map (cheap first)

- Graphify available → query it: entry points, dependency closure of the
  affected modules, what depends on what you plan to change. Minutes, ~free.
- Otherwise → dispatch `forge-explorer` (haiku) with the scoped question.
- Read existing docs for the area; where docs contradict code, the code is
  the reality — record the contradiction as a discovery, do not silently
  trust either.

Stop mapping the moment you can name: entry points, relevant flow,
components, dependencies, data touched, likely side effects, and how the
change will be verified. If you cannot name one of these, map that gap
specifically.

## 3. Baseline (before ANY change — non-negotiable)

- Ensure `forge/config.json` has the project's real verify commands (ask the
  user or read package.json/CI config to find them; set via
  `forge config set verify.*`). If the project has NO runnable checks, say so
  plainly: the first work items must create a minimal harness around the code
  being changed — that is a precondition, not overhead.
- `forge baseline capture`. RED items are recorded as pre-existing: new work
  must not worsen them and is not obliged to fix them (offer follow-up items
  instead).

## 4. Mini-spec

For the requested change, establish with the user only what the code cannot
answer — product questions as either/or choices. Write acceptance criteria
(machine-checkable wherever possible). Create the work item(s) via
`forge task add` with scope derived from the dependency closure (allowed
files = the closure; forbidden = shared contracts/areas outside it).

If the project has no spec folder yet, create one now in the METHOD layer
format (skeleton only — empty layer files with their completeness-bar lines)
and record it: `forge config set specDir "<folder>"`. Propose the location
(`spec/` or `<project>-spec/`); the user confirms.

## 5. Hand off to the build loop

Normal loop. The baseline guard is automatic: once a baseline exists,
`forge task verify` includes the comparison and a regression fails the item
even if its own criteria pass (deliberate exceptions need
`--skip-baseline --reason`). `baseline capture` also advances the project to
build phase, so preflight's verification gate is armed without the spec
phase having run.

## 6. Spec accretion (after each completed change)

Spec sync at item close is universal — greenfield projects do it too (see the
operating contract's build loop, step 5). This section adds what is specific
to brownfield: provenance tags, because here reality and intent can differ.

The spec grows along the paths where work happens — never by whole-system
reverse-engineering. When an item completes, merge what this change
established into the spec folder, in METHOD's layer format:

- entities touched → `01-domain.md` (fields, relationships, delete behavior
  as actually decided);
- user-visible behavior decided → `02-experience.md`;
- endpoints defined/changed → `03-api.md`;
- rules with their acceptance criteria → `04-logic.md`;
- infrastructure/provider facts → `05-foundation.md`.

Tag every statement with its provenance:

- **[CONFIRMED]** — the user decided this (it exists in the decisions log).
  This is intent.
- **[OBSERVED]** — derived from code. This describes reality; it is NOT
  blessed intent — never silently promote it. If a later change needs it to
  be intent, ask the user then.
- **_TBD_** — known gap, deliberately left open (METHOD's convention).

Rules: only touch the sections this change actually established — no
opportunistic rewriting of neighboring content. Where an OBSERVED statement
contradicts a CONFIRMED one, that is a discovery
(`forge discovery add`) — record it, don't pick a winner silently. Dead
corners of the codebase staying undocumented is honest, not a failure;
coherence across projects comes from the format, not from completeness.

Full upfront spec reconstruction is a separate, explicit opt-in — run it as
its own Forge project (milestones per subsystem, human gates adjudicating
intended-vs-accidental per slice) when a rewrite, migration, audit, or
documentation deliverable genuinely requires whole-system intent.
