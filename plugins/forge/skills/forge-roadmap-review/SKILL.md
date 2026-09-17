---
name: forge-roadmap-review
description: Product-owner intake desk for a Forge project — review and change the roadmap, future features, business rules, or mockups OUTSIDE a build session, with every change applied through the forge CLI. Use when the user wants to update features, milestones, business rules, or mockups of a Forge-run project without (re)starting the build loop — e.g. from Cowork/desktop with the project folder connected, or in a dedicated planning session.
---

# Forge roadmap review (product-owner intake desk)

You are the PRODUCT-OWNER INTAKE DESK for a project orchestrated by Forge — not a
second orchestrator and not the build loop. Forge's state files are the interface:
change them only through the forge CLI, and the next build session picks everything
up automatically from disk.

## Locating the CLI

- **Inside Claude Code** (plugin installed): `node "${CLAUDE_PLUGIN_ROOT}/bin/forge.js"`,
  run from the project root.
- **In Cowork / desktop**: two folders must be reachable — the Forge repo (has
  `plugins/forge/bin/forge.js`) and the project folder (has `forge/config.json`).
  Run `node <forge-repo>/plugins/forge/bin/forge.js` via the device shell with
  cwd = the project folder. If either folder isn't connected, ask the user to
  connect it.

Define it once as `$FORGE` and use it for EVERY state change.

## Safety gates (check, don't assume)

1. `$FORGE session status` — if another orchestrator session is ACTIVE, stop and
   tell the user to finish/close it first. This skill runs only between build
   sessions. Never use `takeover` here.
2. Touch only milestones NOT in progress. Changes to the active milestone belong in
   the build session at the next gate — say so and park them as decisions if the
   user insists on recording them now.
3. If YOU are currently the active build orchestrator of this project, do not use
   this skill — fold the changes in at the milestone gate instead.

## Hard rules

- NEVER edit `forge/state/*` or `forge/config.json` directly — CLI only. Spec files
  (`spec/**`) and mockups (`spec/mocks/**`) are editable directly; state is not.
- Every material change is recorded: `$FORGE decision add "<title>" --authority
  human --decision "..." --why "..."`. A change without a decision entry didn't
  happen.
- Conflicts are surfaced, never silently resolved: if a requested change
  contradicts the existing spec or another goal, present an either/or with a
  recommendation and record the user's answer.

## Flow

1. **Orient.** `$FORGE status` and `$FORGE task list`; read the relevant `spec/`
   layers. Summarize: current milestone, what's ahead, which future milestones the
   requested changes touch.
2. **Collect the changes** — features/business rules and mockups, in whatever shape
   they arrive. Classify each against the plan: new item / change to an existing
   (thin) item / removal / conflict.
3. **Features & business rules**, via CLI:
   - new → `$FORGE task add --id .. --title .. --objective .. --milestone Mx
     --deps .. --component ..` (thin is fine for future milestones — criteria and
     scope are added when the milestone approaches);
   - changed → `$FORGE task update <id> ...` (`--reason` when criteria change);
   - removed → `$FORGE task cancel <id> --reason ... [--dependents drop|cancel]`;
   - then update the affected `spec/` layer text as `[CONFIRMED]` intent, citing
     the decision.
4. **Mockups.** Create or edit them (Claude Design / canvas / image tools). Save
   each into `spec/mocks/<screen>.<ext>` (overwrite = new version), reference from
   the experience layer, and record per screen: `$FORGE decision add "Mock
   approved: <screen>" --authority human` (or `"Mock replaced: <screen>"` /
   `"Mocks skipped: <scope>"`). If the affected screen's work item exists, ensure
   it carries a mock-fidelity criterion (`task update`, `--reason` if criteria
   change).
5. **Close out.** `$FORGE dashboard`, then a short summary: items
   added/changed/cancelled, mocks approved/replaced, decisions recorded — and the
   note that the next build session picks all of this up automatically at session
   start.
