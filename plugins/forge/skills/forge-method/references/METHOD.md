# METHOD — Spec-First Product Definition

This file is the complete, project-agnostic procedure for defining a software
product before any code is written. It is self-contained: a conversation that has
never seen this project should be able to read **only this file** and know exactly
how to proceed.

The goal: define a product so completely that a coding agent can build it without
inferring, guessing, or inventing a single fact. Every question the agent might ask
is answered in the spec before it asks.

---

## Core principle

Spaghetti comes from **holes** — facts left undefined that the agent fills by
guessing, then guesses differently the next time. The cure is not a better build
order; it is a closed, checkable definition of "everything," filled top to bottom
with no holes.

**The completeness bar (applies to every layer):**
> A layer is done when the coding agent, reading only the spec, would never have to
> *invent* a fact to proceed. If you can name one question the agent could ask that
> the docs don't answer, the layer has a hole.

---

## The artifacts

A finished spec is this set of files (in a `*-spec/` folder). Each is either a
**[DELIVERABLE]** (authoritative spec a coding agent builds from) or **[SCAFFOLDING]**
(a working aid that helps us navigate; agents do not build from it):

| File | Kind | What it holds |
|------|------|---------------|
| `METHOD.md` | scaffolding | This file. The reusable procedure. |
| `README.md` | scaffolding | Project state, file map, **state marker** (incl. progress). |
| `FEATURES.md` | scaffolding | Top-down feature wishlist + coverage checklist. |
| `decisions.md` | scaffolding | Every either/or resolved, with reasoning. |
| `00-vision.md` | deliverable | Product, actors, non-goals, hard constraints. |
| `01-domain.md` | deliverable | Entities: fields, types, relationships, states, ownership. |
| `02-experience.md` | deliverable | Screens (reads/writes/states/nav) + cross-screen flows. |
| `03-api.md` + `openapi.yaml` | deliverable | Endpoint contract, human + machine readable. |
| `04-logic.md` | deliverable | Business rules (each w/ acceptance criterion), validations, triggers, jobs, providers. |
| `05-foundation.md` | deliverable | Storage, providers + limits, auth, deployment. |
| `CLAUDE.md` | deliverable | **Generated at end.** Coding-agent operating rules. |
| `PLAN.md` | deliverable | **Generated at end.** Build order + task breakdown. |

> **Progress is tracked ONLY in the state marker — never as a separate file.** A standalone
> progress/tracking file is a third surface that drifts out of sync; do not create one. A
> progress *view* can be regenerated on demand from the state marker, but is not persisted.

`METHOD.md` and `README.md` are deliberately separate: the method is reusable across
all projects; the README/state is disposable per project.

> **Single source of truth (Option A).** This file is self-contained: the per-file
> structure lives in the "File templates" section below, so blank skeletons are
> **generated from METHOD.md on demand, never stored separately.** To start a new project:
> copy METHOD.md alone, then generate the skeleton from it. Nothing else to carry.

---

## The procedure (run in order)

### Step 0 — Orient
Read `README.md` → find the **state marker** → resume at the first unfinished layer.
If starting fresh, **generate the skeleton from the "File templates" section below** —
create every file with its section headers and completeness-bar line, and a README with
the state marker set to "Layer 0, not started". The templates section is authoritative;
nothing is stored separately, so there is nothing to drift.

### Step 1 — Layer 0: Vision
Fill `00-vision.md` in this internal order:
1. Core vision: what it is, who it's for, the **success criterion**, hard constraints.
2. **Feature dump → `FEATURES.md`** (do this AFTER the success criterion exists, BEFORE
   gating). The user brain-dumps every desired feature — data features AND AI
   capabilities — unfiltered. Structure and de-duplicate it; tag each feature with the
   layer(s) it touches and the entities it implies.
   - This is the **top-down motion**. It does three jobs: stress-tests the success
     criterion (does the vision support everything wanted?), populates **non-goals**
     (anything listed then deferred becomes an explicit non-goal), and produces the
     **coverage checklist**.
   - Placement matters: a feature dump BEFORE the vision is an unanchored pile with no
     criterion to judge against; AFTER the success criterion it is an evaluable coverage
     check. Insurance that matters MORE the less familiar the user is with the product.
3. Gate. (Gate = passes completeness bar + user approval.)

> **Two motions, reconciled.** The method runs both top-down (vision → features → what
> must exist) and bottom-up (conversation surfaces entities → they accrete). The
> **coverage check** reconciles them: a feature with no entity = a hole; an entity no
> feature needs = dead weight. Agreement across both motions is the strongest
> completeness guarantee the method offers — stronger than either alone. Run the
> coverage check when entering Layer 1 and again before gating it.

### Step 2 — Layer 1: Domain
Fill `01-domain.md`. **Run the coverage check against `FEATURES.md`** (every feature's
implied entities exist; no orphan entities). Run traceability. Gate.

> **Filling a large layer (applies to ANY layer, not just Domain).** When a layer is too
> big for one pass, fill it in **named clusters** (e.g. Domain: "spine", "people",
> "budget"). Work clusters in **dependency order** (define what others depend on first).
> Track which clusters are done **in the state marker** — never in a separate file. The
> layer is complete when all clusters are filled AND the coverage check passes (no orphan
> features, no orphan entities). Confirm each cluster with the user before moving on.

### Step 3 — Layer 2: Experience
Fill `02-experience.md`. Run traceability. Gate.

### Step 4 — Layer 3: API
Fill `03-api.md` **and generate `openapi.yaml`** from it. Run traceability. Gate.
> `openapi.yaml` is generated here, not earlier, because it is the machine-readable
> form of the contract both the frontend (Claude design) and backend (Claude Code)
> compile against. It must be frozen before either branch starts building.

### Step 5 — Layer 4: Logic
Fill `04-logic.md`. Run traceability. Gate.

### Step 6 — Layer 5: Foundation
Fill `05-foundation.md`. Run traceability. Gate.

### Step 7 — Generate handoff artifacts
Now that Foundation is decided:
- Generate `CLAUDE.md` — coding-agent operating rules (conventions, file layout,
  test command, definition of done), derived from Layer 5.
- Generate `PLAN.md` — the build order and task breakdown, derived from the
  dependency graph the spec now defines (see "Build order falls out of the spec").

### Step 8 — Handoff
- Claude design consumes: `01-domain.md`, `02-experience.md`, the relevant
  `03-api.md` / `openapi.yaml` slices. Produces frontend scaffolding against
  correctly-shaped mock data.
- Claude Code consumes: `01`, `03`+`openapi.yaml`, `04`, `05`, `CLAUDE.md`, `PLAN.md`.
  Builds backend, then rewires the imported frontend's mock data to the live API.

---

## Traceability (the hole-detector, run at each gate)

Holes live in the links between layers, not inside them. After each layer, check:
- Every **screen field** (L2) traces down to an **entity field** (L1).
- Every **endpoint** (L3) traces up to a **screen** (L2) that needs it.
- Every **entity** (L1) is reachable by some screen, or it is dead weight.
- Every **provider call** (L4) has a defined integration + failure mode (L5).

Report orphans explicitly before advancing. An orphan is a hole — resolve it, don't
note it and move on.

---

## Rules of engagement (behavioral, not optional)

1. **One layer at a time.** Do not advance until the current layer is gated.
2. **Either/or, not prose.** Surface open decisions as explicit either/or choices,
   put to the user one at a time. Do not ask the user to write paragraphs.
3. **Propose defaults, mark them as proposals.** Accelerate transcription, never the
   decision. Auto-fill the obvious (e.g. a full CRUD surface) but flag the cases
   where the obvious default is probably wrong and force a decision there.
4. **Do not agree by default.** Where the objective answer differs from what the user
   wants to hear, say so. Validation that isn't earned is a hole in disguise.
5. **Log every resolved either/or** to `decisions.md` with its reasoning — especially
   the constraint that forced it.
6. **Write to disk continuously.** The spec is the memory, not the chat. Update the
   state marker after every work session.
7. **Propose, confirm, THEN write.** Never write proposed content to a deliverable file
   before the user has decided. Proposals live in chat; only confirmed decisions go to
   disk. Writing guesses to disk is how the spec rots.
8. **Carry forward, don't chase down.** When a thought belongs to a lower layer (a screen
   detail surfaced during domain work, a rule surfaced during API work), do NOT design it
   now — record it in a "Carried forward" note in the current file, tagged with its target
   layer. This is how layer discipline is *enforced* rather than violated: the thought
   isn't lost, it's parked where it belongs. Resurface it when that layer is reached.
9. **Gating with declared gaps.** A layer may gate with **known, explicitly-declared,
   non-blocking gaps** (e.g. a non-goals list that will keep accreting). The completeness
   bar ("never invent a fact") applies to what the layer *commits to* — a declared gap is
   not an invented fact, it is an acknowledged TODO. A gate requires: (a) all load-bearing
   content present, (b) any remaining gaps explicitly listed as non-blocking, (c) user
   approval. Silent gaps are holes; declared gaps are honest.

---

## Build order falls out of the spec (do not design it up front)

Do not define a development process before the spec exists — you cannot sequence work
whose dependencies you don't yet know. Once the spec is done, the build order is
nearly mechanical, bottom-up in dependency order:
`foundation → entities → API → logic → wire frontend`.
`PLAN.md` captures this at Step 7.

---

## File templates (authoritative — generate the skeleton from these)

Conventions applied to ALL deliverable files: write only confirmed decisions (rule 7);
mark anything pending as `_TBD_`; each layer file opens with its completeness-bar line.

**Silent entity defaults (Domain):** every entity has `id` (uuid) + `createdAt`/`updatedAt`.
Not repeated per entity. **Delete behavior is always an explicit per-entity decision**, never
a default.

### `00-vision.md`
```
# Layer 0 — Vision & Constraints
> Completeness bar: every later "should we support X?" is answerable by pointing here.
## What it is            # one paragraph
## Who it's for          # primary users + situation
## Actors                # each: name + one line (humans; + how the AI is modeled)
## What success looks like   # the result that, if absent, the product failed
## Feature wishlist          # pointer → FEATURES.md (filled after success criterion)
## Non-goals             # living list; accretes as scope is bounded
## Hard constraints      # tenancy, compliance, storage, auth, clients, scale, stack locks
```

### `FEATURES.md` (scaffolding)
```
# <Project> — Feature Wishlist (top-down coverage checklist)
# Status tags: [covered] [partial] [gap] [conflict] [defer?]
## <grouping>            # each feature → layer(s) touched + implied entities + status
## Coverage check        # every feature has entities; every entity serves a feature
```

### `01-domain.md`  — per entity:
```
### EntityName
- Purpose: one line.
- Fields: `name: type (required?)` — one per line.
- Relationships: belongs-to / owns / references (+ cardinality).
- Lifecycle states: named states + what triggers transitions.
- Ownership / permissions: who can read/create/update/delete, under what conditions.
- Delete behavior: explicit (soft/hard/archive); note cascade/side-effects.
## Open decisions        # pending either/ors → log to decisions.md when resolved
## Carried forward       # lower-layer thoughts parked with target layer (rule 8)
```

### `02-experience.md`  — per screen, then flows:
```
### ScreenName
- Purpose / Reads (→L1) / Writes (→L1)
- States: happy, empty, loading, error, unauthorized
- Navigation: each interactive element → target
## Flows                 # ordered screen sequences; state carried; decision points
## Carried forward
```

### `03-api.md`  (+ generate `openapi.yaml`)  — conventions, then per endpoint:
```
## Conventions           # auth model, base URL, error envelope, pagination/filter/sort
### METHOD /path
- Serves screen(s) (→L2) / Auth / Request schema (→L1) / Response schema (→L1) / Errors
```

### `04-logic.md`  — per rule (acceptance criterion is MANDATORY):
```
### RuleName
- Trigger: when X happens.
- Behavior: exact result.
- Acceptance criterion: observable test that proves it works (phrased as a test case).
## Validations / ## Triggers & side effects (+provider) / ## Background jobs
```

### `05-foundation.md`
```
## Storage   # engine + why; migrations
## Providers # each: purpose, known limits/quotas, failure mode + fallback
## Auth      # mechanism, token/session model
## Deployment# where backend+frontend run; build/release
```

### `decisions.md` (scaffolding) — per entry:
```
### [DATE] — [short title]
- Layer / Question / Decision / Why (esp. the constraint that forced it)
```

### `CLAUDE.md` + `PLAN.md` — generated at Step 7 (see procedure).

---

## State marker format (lives in README.md)

```
## STATE MARKER
- Current layer: <layer name>
- Status: <not started | in progress | gated>
- Last updated: <date>
- Notes: <what's done, what's next>
```
