---
name: forge-brownfield
description: Brownfield orientation for Forge. Use when the user asks for changes to an EXISTING codebase — one bounded change (feature, fix, refactor) OR a whole set of desired features/changes/mockups ("here's where I want this project to go") — and Forge has no established understanding of the affected areas yet. Produces scoped understanding, a recorded baseline, and either a mini-spec (one change) or a gap analysis + milestone plan (roadmap) — then hands off to the normal build loop.
---

# Forge brownfield orientation

Goal: reach "we can explain enough of the relevant system to modify it
safely" — for the task at hand. Never reconstruct the whole system for a
bounded change; never modify anything before the baseline exists.

## 0. Entry fork — ask which door, don't assume

A brownfield project has two legitimate starting points. Unless the user's
opening message already makes it obvious, ask them ONE either/or before
orienting:

> **(A) A bounded change** — "I want to work on this codebase; here's the
> first thing." We orient around that change and go.
> **(B) A destination** — "I have a vision of where this project should be:
> features (some working, some half-done, some missing) and possibly
> mockups." We map your goals against the code's reality and plan milestones
> across all of it — the brownfield equivalent of the greenfield spec
> interview.

Mode A → run §1–§6 as written for the requested change.
Mode B → run the roadmap intake (§7), which wraps §1–§6.

If the user picked A but keeps adding "and later I also want…" items,
offer B explicitly — a drip-fed roadmap forfeits cross-feature planning.

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

## 7. Roadmap intake (Mode B — a destination, not just a change)

This mode exists to compensate for the intent a greenfield project gets from
the METHOD interview. Here, intent arrives as the user's goals; reality
arrives from the code; the plan is the gap between them.

1. **Collect the goals, in whatever shape they exist.** A feature/change dump
   (file or message) and optionally mockups. If the user has nothing written,
   elicit it — a light goals interview, NOT the full METHOD: "list the
   features/changes you want; for each, its honest current state (works /
   half-done / missing) and what 'good' looks like in a sentence." Accept
   bullet-level intent; do not make the user write specs — that is your job.
   For each mockup, establish: which screen/route it belongs to, and whether
   it improves an existing screen (capture WHAT should change) or defines a
   new one.

2. **Orient per goal, still scoped (§2).** The orientation boundary is the
   union of areas the goals touch — feature by feature, never whole-system.
   Use Graphify / forge-explorer per area.

3. **Baseline (§3), exactly as always, before any change.**

4. **Gap analysis — the heart of this mode.** For each goal, compare desired
   vs observed and classify:
   - **already satisfied** → no work item; record as [OBSERVED] in the spec,
     confirm with the user it matches their intent ([CONFIRMED] if so);
   - **half-done** → work item(s) written against the GAP, red-first; the
     existing partial behavior is [OBSERVED] reality;
   - **missing** → work item(s) as in greenfield;
   - **conflict** (code does something that contradicts the goal, or two
     goals contradict) → a discovery + an either/or to the user before any
     item is written. Never pick a winner silently.

5. **Seed the spec from the goals.** Create the spec skeleton (§4 rules) and
   write the user's confirmed goals into the layers as [CONFIRMED] intent;
   what orientation established about current behavior enters as [OBSERVED].
   Approved mocks land in `spec/mocks/` referenced from 02-experience, each
   approval recorded (`forge decision add "Mock approved: <screen>"
   --authority human`).

6. **Milestone cut + work graph — apply the forge-method Step 7 machinery**
   (milestone proposal confirmed by the user, demo criterion each,
   red-first machine-checkable criteria, `--deps`/`--milestone`/
   `--component`, gates choice, preflight). Two defaults to propose:
   the walking skeleton among the MISSING features first (integration risk
   surfaces early), and half-done features in early milestones (the messiest
   code exercises the baseline machinery first). In the same pass, set
   `verify.security` for the stack and `options.protect` for generated/
   migration paths — do not wait to be asked.

7. **Hand off to the build loop (§5).** Accretion (§6) proceeds as normal —
   in this mode the spec starts richer, and every completed item still syncs
   what it established.

The fork is about intake, not rigor: Mode B changes how intent is gathered,
never which gates apply.
