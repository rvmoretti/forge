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
2. Convert `PLAN.md` into the work graph: one `forge task add` per task, in
   dependency order, with `--deps`, `--milestone`, and **acceptance criteria
   taken from the spec** (`04-logic.md` criteria are mandatory sources).
   Give every criterion a machine check (`--criterion "desc::command"`)
   wherever one can exist — a criterion nobody can run is a weak gate.
3. Run `forge preflight` and resolve anything it raises (including the
   Graphify install-or-skip question if unset).

Then tell the user the spec phase is complete and the project is ready for
`/forge:build`.
