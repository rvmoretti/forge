# Cowork companion skill — forge-roadmap-review

This is a **Claude (Cowork/desktop) skill**, not part of the Forge plugin. It lets the
product owner review and change a Forge project's roadmap, future features, business
rules, and mockups from a Cowork session with the project folder connected — with every
change applied through the forge CLI so the next build session picks it up from disk.

Install: add it as a personal skill in your Claude account (Cowork → skills), pasting the
content below as the skill's SKILL.md. It is kept here so other Forge users can adopt it.

---

```markdown
---
name: forge-roadmap-review
description: Review and change a Forge project's roadmap, future features, business rules, or mockups from a Cowork session with the project folder connected — all changes applied through the forge CLI and reflected in the work plan, spec, and decisions. Use when the user wants to update features, milestones, business rules, or mockups of a Forge-run project from Cowork/desktop, outside a Claude Code build session.
---

# Forge roadmap review (product-owner intake from Cowork)

You are acting as the PRODUCT-OWNER INTAKE DESK for a project orchestrated by Forge —
not as a second orchestrator. Forge's state files are the interface: change them only
through the forge CLI, and the next Claude Code build session picks everything up
automatically from disk.

## Preconditions (check, don't assume)

1. Two folders must be reachable on the user's computer: the **Forge repo** (has
   `plugins/forge/bin/forge.js`) and the **project folder** (has `forge/config.json`).
   If either isn't connected, ask the user to connect it.
2. Define the CLI once and use it for EVERY state change (run via the device shell,
   cwd = the project folder):
   `FORGE="node <forge-repo-path>/plugins/forge/bin/forge.js"`
3. Safety gate — run `$FORGE session status` first. If another orchestrator session is
   ACTIVE, stop and tell the user to finish/close it; this skill runs only between build
   sessions. Never use `takeover` here.
4. Scope gate — this skill touches only milestones NOT in progress. Changes to the
   active milestone belong in the Claude Code session at the next gate.

## Hard rules

- NEVER edit `forge/state/*` or `forge/config.json` directly — CLI only. Spec files
  (`spec/**`) and mockups (`spec/mocks/**`) are editable directly; state is not.
- Every material change is recorded: `$FORGE decision add "<title>" --authority human
  --decision "..." --why "..."`. A change without a decision entry didn't happen.
- Conflicts are surfaced, never silently resolved: if a requested change contradicts the
  existing spec or another goal, present an either/or with a recommendation and record
  the user's answer.

## Flow

1. **Orient.** Run `$FORGE status` and `$FORGE task list`; read the relevant `spec/`
   layers. Summarize for the user: current milestone, what's ahead, which future
   milestones their changes touch.
2. **Collect the changes.** Feature/business-rule changes and mockup changes, in
   whatever shape they arrive. For each, classify against the existing plan:
   new item / change to an existing (thin) item / removal / conflict.
3. **Features & business rules.** Apply via CLI:
   - new → `$FORGE task add --id .. --title .. --objective .. --milestone Mx --deps ..
     --component ..` (thin is fine for future milestones — criteria and scope are added
     when the milestone approaches);
   - changed → `$FORGE task update <id> --objective/--milestone/--deps/--title ...`
     (with `--reason` when criteria change);
   - removed → `$FORGE task cancel <id> --reason ... [--dependents drop|cancel]`;
   - a new feature → its own milestone: `$FORGE milestone add <id> --name "<what a
     user can do>" --demo "..." [--before|--after <M>]`, then its items;
   - priority change → `$FORGE milestone move <id> --before|--after <M> --reason ".."`
     (refused if it breaks a dependency or jumps ahead of started work — show the
     user the blocking items; `--pull-deps` moves them along if they agree);
   - unnamed milestones → propose names: `$FORGE milestone update <id> --name ".."`;
   - releases (V0 = MVP, V1 …): `$FORGE release add <R> --name ".."`, `$FORGE milestone
     update <id> --release <R>`, `$FORGE release move <R> --before|--after <R> --reason ".."`;
     task order inside a milestone: `$FORGE task move <id> --before|--after <id>`. Show the
     user the version labels (`$FORGE release list`) — they renumber as the plan changes,
     except work already started;
   - then update the affected `spec/` layer text as `[CONFIRMED]` intent, citing the
     decision.
4. **Mockups.** Create or edit them here (Claude Design / canvas / image tools). Save
   each into the project's `spec/mocks/<screen>.<ext>` (overwrite = new version).
   Reference them from the experience spec layer. Record per screen:
   `$FORGE decision add "Mock approved: <screen>" --authority human` (or
   `"Mock replaced: <screen>"` / `"Mocks skipped: <scope>"`). If an affected screen's
   work item exists, ensure it has a mock-fidelity criterion (add via `task update` with
   `--reason` if criteria change).
5. **Close out.** Run `$FORGE dashboard` to regenerate the visual, then give the user a
   short summary: items added/changed/cancelled, mocks approved/replaced, decisions
   recorded, and the note that the next build session will pick all of this up
   automatically at session start.
```

## Upgrade mode — bring an older plan to the installed Forge's standards

Use when the user asks to upgrade / refactor / modernise the plan, or `$FORGE upgrade`
shows open steps. Same safety gates as above (between build sessions).

1. `$FORGE upgrade` (or `--json`). Run the automatic steps first:
   `$FORGE upgrade apply` — state is backed up, nothing needs judgement.
2. For each open **judgement** step write ONE change script,
   `forge/changes/<YYYY-MM-DD>-upgrade-<step>.sh`, plus a sibling `.md` that says in
   plain words what changes, why, and what deliberately stays. Exact header:
   ```bash
   #!/usr/bin/env bash
   # forge-upgrade-step: <step>
   set -euo pipefail
   forge() { node "${FORGE_JS:?run through: forge upgrade dry-run|run <this file>}" "$@"; }
   ```
   Rules: forge commands only (no git, no file edits); re-cut, reorder and re-home
   only UNSTARTED work — started milestones may be renamed or given a release, never
   re-cut; no `task start/done/verify/fail` (the dry run flags any history change);
   record each material choice inside the script with `forge decision add .. --authority forge`.
   - `feature-milestones`: milestone names say what a user can do; no layer names,
     no version prefixes (the release carries the version); releases MVP / V1 / V2 …
     with every milestone in one; task order dependency-first (`task move`).
   - `architecture`: the commands from forge-brownfield §8 step 2 (scan, split,
     name, link, assign screens) — confirmation stays a separate step after the run.
3. `$FORGE upgrade dry-run <script>` runs it on a throwaway copy. Show the user the
   "What would change" block verbatim, with the `.md`. Fix and dry-run again until it
   is clean and they agree.
4. On their go: `$FORGE upgrade run <script>` (refused unless this exact script was
   dry-run against the current plan). To keep the plan as it is for a step:
   `$FORGE upgrade accept <step> --reason ".."`.
5. `$FORGE upgrade revert` restores the backup while nothing else has changed since.
