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

## 5. Hand off to the build loop

Normal loop. The baseline guard is automatic: once a baseline exists,
`forge task verify` includes the comparison and a regression fails the item
even if its own criteria pass (deliberate exceptions need
`--skip-baseline --reason`). `baseline capture` also advances the project to
build phase, so preflight's verification gate is armed without the spec
phase having run.
