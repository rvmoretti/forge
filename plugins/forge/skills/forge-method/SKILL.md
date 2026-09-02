---
name: forge-method
description: Spec-first product definition (the METHOD). Use at the start of any new (greenfield) project, when the user describes a product idea to build, when resuming an unfinished spec, or whenever product scope must be defined or changed before implementation. Produces the layered spec (vision → domain → experience → API → logic → foundation), CLAUDE.md, PLAN.md — and, at the end, the Forge work graph.
---

# Forge spec phase — run the METHOD

Read `references/METHOD.md` in this skill and follow it exactly. It is the
complete, self-contained procedure: artifacts, layer order, gates,
traceability checks, rules of engagement, and file templates. It is the
product owner's proven methodology — do not "improve" it, run it.

Key behavioral rules it enforces (do not soften these):

- One layer at a time; a layer gates only on completeness bar + user approval.
- Decisions surface as either/or choices, one at a time — never ask the user
  to write paragraphs. Propose defaults, mark them as proposals; do not agree
  by default.
- Propose → user confirms → THEN write to disk. Only confirmed decisions
  enter deliverable files.
- Log every resolved either/or to `decisions.md` — additionally mirror
  material ones via `forge decision add --authority human` so they enter
  Forge state.
- Carried-forward thoughts get parked with their target layer, not designed
  early.
- Declared non-blocking gaps are honest; silent gaps are holes.

## Forge integration (what this skill adds to the METHOD)

At **Step 0**: if `forge/config.json` does not exist, run `forge init` so the
project has state from the start (phase stays `spec`).

At **Step 7** (generate handoff artifacts), in addition to `CLAUDE.md` and
`PLAN.md`:

1. Set the Forge config from Layer 5 decisions:
   - `forge config set verify.test "<test command>"`
   - `forge config set verify.lint "<lint command>"` (if the stack has one)
   - `forge config set verify.typecheck "<typecheck command>"` (if typed)
   - `forge config set options.web true|false`
   - `forge config set specDir "<spec folder>"`
   - `forge config set phase build`
2. **Propose the milestone cut and confirm it with the user.** Milestones
   are phases that end in something the user can personally test — a
   runnable vertical slice ("auth + create a family + see it persisted"),
   never a horizontal layer ("database schema"). Put the walking skeleton
   (thinnest end-to-end path) in M1 so integration risk surfaces first.
   For each milestone, define a demo criterion: the command that runs it and
   a short "what to try" script for the user. Present the cut as a proposal;
   the user confirms or adjusts it — this is a product-owner decision.
   Then ask one more either/or: stop for their testing after each milestone
   (`per-milestone`, recommended default) or run straight through
   (`end-only`)? Record it: `forge config set options.gates <choice>`.
   **Mocks (products with a UI).** Offer the user the drawn-frontend path:
   for each key screen in `02-experience.md`, a mock — Claude Design, a
   Figma export, or a photographed sketch; wireframe fidelity is enough
   unless a screen really matters. Approved mocks land in
   `spec/mocks/<screen>.<ext>`, referenced from `02-experience.md`, with the
   approval recorded (`forge decision add "Mock approved: <screen>"
   --authority human`). A mock binds intent (hierarchy, grouping, primary
   action) — pixel fidelity only if the user says so. Screens the user
   declines to mock still get the `design-ux` pack at build time. This is an
   offer, not a gate — record a decision either way so build-phase sessions
   know which screens have binding mocks.
3. Convert `PLAN.md` into the work graph: one `forge task add` per task, in
   dependency order, with `--deps`, `--milestone` (from the confirmed cut),
   and **acceptance criteria taken from the spec** (`04-logic.md` criteria
   are mandatory sources). Give every criterion a machine check
   (`--criterion "desc::command"`) wherever one can exist — a criterion
   nobody can run is a weak gate, and the CLI's red-first check will flag
   vacuous ones. Screen items whose mock exists get a mock-fidelity
   criterion ("rendered <route> serves the approved mock
   spec/mocks/<screen>") — verified at build time by screenshot
   (`task verify --artifact`) plus the fresh-context UX review from the
   `design-ux` pack.
4. Run `forge preflight` and resolve anything it raises (including the
   Graphify install-or-skip question if unset).

Then tell the user the spec phase is complete and the project is ready for
`/forge:build`.
