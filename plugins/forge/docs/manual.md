# Forge Companion (manual.md — AI-readable mirror of manual.html)

Forge turns one Claude Code session into an engineering organization. The user is the
**product owner** (owns WHAT & WHY). The main session is the **CTO/orchestrator** (owns HOW:
spec, briefs, review, integration) on the strongest model. **Workers** are cheaper-model agents
(forge-explorer haiku · forge-implementer/forge-tester sonnet · forge-reviewer/forge-architect
opus), each given one bounded task in a fresh context; workers never delegate. **Gates** are
enforced by the forge CLI + hooks — refusals in code that the model cannot skip. All memory
lives on disk under `forge/` (git-versioned); the conversation is never the memory.

The user is interrupted for exactly three things: (1) a product decision / spec hole, presented
as an either/or with a recommendation, recorded in decisions.md; (2) a high-risk approval;
(3) a milestone review — try the running slice, give a verdict, approve the gate.

## You are always guided (v0.13)

- **Every session opens with your next step.** The session-start hook computes it from state
  (continue in-flight work / test a finished milestone / say "continue" for the next item /
  resume the spec interview / start something new) and the orchestrator says it in plain words
  first thing. `/forge:start` is the explicit entry command — any time you feel lost, run it.
- **The feature dump has a named moment**: at project start (and entering brownfield
  destination mode), Forge explicitly invites your feature lists, notes, sketches, mockups,
  documents. That input shapes everything asked afterwards.
- **The mockup stop is mandatory**: when the spec reaches screens, Forge stops and asks per
  screen — Forge drafts a mock / you create+upload one (you get the spec excerpts to design
  from) / consciously skip. Every choice, including skip, is recorded as a decision. Applies
  to greenfield Step 7 AND brownfield goals that touch UI.
- **Changing course is part of the process**: small change → decision + task add/update in the
  current milestone; bigger change → the milestone gate, where Forge explicitly asks "anything
  to change, add, or reprioritize?"; new destination → the roadmap intake re-runs for the
  delta. You are never off-process for changing your mind.
- **The dashboard is surfaced, not hidden**: forge/dashboard.html reminders appear at init,
  milestone completion, and approval.

## Install (once per machine)

Prereqs: Claude Code + git. In a Claude Code session inside each project that should use Forge:

```
/plugin marketplace add <forge-repo-url>
/plugin install forge@forge-marketplace --scope project
```

Always `--scope project`: it pins the Forge version per project so upgrading one project never
changes another mid-flight. Verify with `/forge:status` and (zero tokens, any terminal):
`node ~/.claude/plugins/cache/forge-marketplace/forge/<version>/bin/forge.js doctor`.
Optional enhancers, detected by preflight: Graphify (code map), Playwright (web E2E/screenshots).

Updating: only at project boundaries (or a milestone gate), never mid-milestone. Route:
`/plugin marketplace update forge-marketplace` then update — or uninstall, `rm -rf
~/.claude/plugins/cache/forge-marketplace`, reinstall `--scope project`. `forge doctor` flags
stale/multiple cached versions.

## Greenfield flow (new project)

1. `mkdir app && cd app && git init && claude`; describe the product. The forge-method skill runs.
2. Layered interview: Vision → Domain → Experience → API → Logic → Foundation. Either/or
   questions; user approves each layer gate; decisions land in `forge/decisions.md`.
3. Milestone cut proposed and confirmed (each milestone = user-testable vertical slice; walking
   skeleton first; demo criterion each). Gating mode: `per-milestone` (default) or `end-only`.
   Products with UI: the drawn-frontend offer — one mock per key screen (Claude Design/Figma/
   photographed sketch) approved into `spec/mocks/<screen>`, referenced from 02-experience,
   approval recorded as a human decision. A mock binds intent (hierarchy, grouping, primary
   action), not pixels unless the user says so. Unmocked screens still get the design-ux pack.
4. Spec gates → CLAUDE.md, PLAN.md, verify commands set, phase build, work graph created
   (`forge task add` per item, red-first machine-checkable criteria, `--milestone`, `--deps`,
   `--component`, `--allowed` file scope — start refuses without one). Preflight runs.
5. User says "build it" (`/forge:build`) → build loop, milestone by milestone.
6. At each gate: security pass first, then demo, verdict, feedback→decisions+items, approve.

## Brownfield flow (existing codebase)

Two entry modes — the forge-brownfield skill ASKS which (§0 entry fork) unless obvious:
(A) a bounded change → steps below. (B) a DESTINATION — the user has a vision: a feature/change
set (each item honestly statused works/half-done/missing) and possibly mockups (improve-existing
vs new). Mode B = roadmap intake (skill §7), the brownfield equivalent of the greenfield spec
interview: goals collected (or elicited via a light goals interview — bullet-level intent, never
user-written specs) → scoped orientation per goal → baseline → GAP ANALYSIS per goal (already
satisfied / half-done: items against the gap / missing: items as greenfield / conflict:
discovery + either/or, never silently resolved) → spec seeded from confirmed goals ([CONFIRMED])
and observed reality ([OBSERVED]), mocks into spec/mocks/ with recorded approvals →
forge-method Step 7 machinery for the milestone cut (walking skeleton among MISSING features
first; half-done features early) + verify.security + options.protect set unprompted. The fork
changes how intent is gathered, never which gates apply. No special commands.

1. Open repo, ask for the change. forge-brownfield skill orients — scoped to the affected
   subsystem only (Graphify or forge-explorer); never whole-system reverse-engineering.
2. Baseline before ANY change: real verify commands into config, `forge baseline capture`
   (also advances phase to build). Pre-existing failures recorded, not blamed on new work; from
   then on every `task verify` includes the baseline comparison — a regression fails the item
   (`--skip-baseline --reason` for audited exceptions). No runnable checks at all → first items
   build a minimal harness.
3. Mini-spec: only the product questions code can't answer; criteria; items with scope from the
   dependency closure.
4. Same build loop. After each completed change, spec accretion into the spec folder with
   provenance tags: [CONFIRMED] = user-decided intent; [OBSERVED] = derived from code, never
   silently promoted to intent; _TBD_ = known gap. OBSERVED-vs-CONFIRMED contradictions become
   discoveries.

## The build loop (per item)

1. **Scope & start** — derive the allowed-files scope from the dependency closure and RECORD it
   (`forge task update <id> --allowed "..."`) — start refuses an unscoped item (deliberate
   whole-tree work: `start --whole-tree --reason`). Then `forge task start <id>` (records
   pre-work check results + tree). One item in flight by default: start refuses a second
   IN_PROGRESS item (`options.concurrency`, default 1), and at higher caps refuses scope overlap.
2. **Brief & dispatch** — `forge brief` skeleton + spec excerpts, decisions, domain pack(s).
   Screen work: brief carries the design-ux pack + the approved mock. Record the handoff in
   state — `forge task dispatch <id> --agent <worker>` — immediately before launching; a
   mid-flight message to a running worker is recorded too (`--kind message --note`). Dispatch
   prompts still start with `# Work brief — <id>: <title>` (ties old logs in usage telemetry).
   **Worker executes** — one bounded task, fresh context; stops and reports on spec holes or
   scope conflicts. Routing: exploration → forge-explorer; test authoring → forge-tester;
   don't absorb worker-work on orchestrator tokens (measure = cost per DONE item).
3. **Verify** — `forge task verify <id>`: all `verify.*` commands (incl. `verify.security`) +
   criterion checks + baseline guard; output stored as evidence bound to the git tree.
   `--artifact <file>` attaches screenshots/reports.
4. **Review** — diff + report; high-risk diffs go to forge-reviewer in a FRESH context (the
   author-orchestrator's read is biased); screens get the UX review vs mock per the design-ux
   pack protocol. A screen whose checks pass but UX review fails is a failed item.
5. **Done** — `forge task done` (refused without passing record for the current tree; refused
   when checks were green pre-work and tree unchanged). Same close: spec sync — any established/
   changed product behavior updates the affected spec layer, citing the decision/discovery.
6. **Failure** — `forge task fail --note "<diagnosis>"`; retry = fresh worker + revised brief;
   third identical attempt refused: `start --escalate stronger-model|decompose|self|
   revisit-criteria`. **Milestone complete** → security review (`forge milestone security <M>
   --note`), demo, `forge milestone approve <M> --note` (refuses without security unless
   `--skip-security --reason` or `options.security off`).

Session habits: resume with "continue" (session-start hook restores everything); fresh session
at every gate or ~⅓ context; stopping triggers the stop gate (every open item settled: done /
blocked-with-reason / failed-with-diagnosis).

## Progress views (all zero/low token)

- `/forge:start` — the guided entry: Forge reads state and walks the user to the next step.
- `/forge:status` — phase, counts, blockers, what needs the human.
- `forge/dashboard.html` — generated projection: progress, work graph, decisions/discoveries,
  preflight, baseline, spec files, the **project map** (one box per component: kind, route,
  progress, in-progress/blocked/fails, mock or latest screenshot), and **telemetry** —
  development time live from state (per-agent trimmed medians: prep = start→dispatch,
  execution = dispatch→verify; wall-clock brackets, not agent runtime; >2h windows excluded
  as session breaks) plus tokens from the last `forge usage --write` snapshot, stamped with
  its timestamp (never parsed live; absent data is absent). v0.13: every section is
  collapsible — the active milestone opens, closed milestones fold away; time metrics add
  median verification runtime (recorded per verify) and per-milestone human gate wait.
  Auto-regenerates; never edit.
- `/forge:stats` — first-pass rate, failed attempts, most-retried items, escalations,
  start→done elapsed (wall-clock), per-milestone health.
- `/forge:usage` — observed tokens by model, orchestrator vs workers, dispatches tied to items,
  output tokens since last state change (drift detector). Read from Claude Code session logs;
  never estimated.

## Safety nets (all enforced; every one has a regression test)

evidence-or-nothing DONE (current tree) · red-first criteria (vacuous checks refused) · retry
ladder (diagnosis required; 3rd identical attempt refused) · milestone gates (human approval +
security review) · baseline guard · one-orchestrator session lock (heartbeat on writes; second
session's writes blocked; `forge session takeover --force` clears a dead lock; 15-min TTL) ·
scope guard, both directions (item `scope.forbidden` + `options.protect` blacklist, AND — when
every in-progress item declares `scope.allowed` — a whitelist blocking edits outside the union;
`forge/`, spec dir, `docs/`, `*.md` exempt via `options.scopeExempt`; covers file-tool edits,
not shell writes — review covers those) · scope-required start (empty `scope.allowed` refused;
`--whole-tree --reason` for deliberate exceptions) · concurrency gate (`options.concurrency`,
default 1 = serial; higher caps require disjoint scopes — overlap refused) · state-write lock
(concurrent forge processes serialised by `forge/state/work.lock`; live contention refused,
dead-process locks broken + traced) · dispatch records (`task dispatch` — agent mix and
mid-flight messages in state, not transcript inference) · stop gate · state write-guard
(forge/state and config.json only via CLI) · titled logs (untitled decision/discovery
refused) · living spec.

## Refusals — meaning → action (abbreviated)

- "no acceptance criteria" → write criteria first.
- "unfinished dependencies" → pick a ready item.
- "already IN_PROGRESS" → resolve (done/fail/block) before re-start.
- "requires --escalate" → 2 failures recorded; change approach explicitly.
- "no passing verification record" → run verify; DONE is evidence, not claim.
- "tree changed since the passing verification" → re-verify (stale evidence).
- "prove nothing" → item already satisfied (cancel w/ reason) or checks vacuous (fix criteria).
- "baseline regression" → fix it, or `--skip-baseline --reason` (recorded).
- "awaits HUMAN approval" → the user must test and approve the previous milestone.
- "no recorded security review" → `forge milestone security <M> --note` first (or skip/off).
- "state files are managed exclusively by the forge CLI" → use forge commands, never hand-edits.
- "EDIT-WAR GUARD" → close one session, or `forge session takeover --force` if the other is dead.
- "SCOPE GUARD" / "PROTECTED PATH" → stop and report; revise scope/protect deliberately if wrong.
- "Open work items are still IN_PROGRESS" (stop) → settle each item.
- "needs a title — nothing was recorded" → re-run decision/discovery add with a title.
- "dependents" on cancel → `--dependents drop|cancel` explicitly.
- "no allowed file scope" → set it (`task update --allowed`) or declare whole-tree deliberately.
- "concurrency cap reached" → resolve the in-flight item, or the user raises `options.concurrency`.
- "overlaps the scope of in-progress item" → serialize the two items, or narrow one scope.
- "OUTSIDE the allowed scope" (hook) → stop and report; widen scope deliberately if the path belongs.
- "write-locked by another forge process" → another forge command is mid-write; wait and retry
  (dead locks break automatically and are traced).
- "not IN_PROGRESS — dispatch records a handoff" → start the item before recording its dispatch.

Debugging rule (for the user AND the orchestrator): before working around anything, run
`forge doctor` (install/state self-check: versions, cache, hooks, lock, orphaned IN_PROGRESS)
and `forge trace --refusals` (flight recorder: every CLI call + hook decision, version-stamped;
`--hooks`, `--last N`; `FORGE_DEBUG=1` records verbose payloads). Report what they say.

## CLI reference (run as `node <plugin>/bin/forge.js <cmd>` from project root)

`init` · `config get|set` · `preflight [--full]` ·
`task add|list|show|start|dispatch|verify|done|fail|block|cancel|update` (start: `--agent`,
`--escalate`, `--whole-tree --reason`; dispatch: `--agent`, `--kind launch|message`, `--note`;
verify: `--artifact`, `--skip-baseline --reason`; add/update: `--criterion "desc::cmd"`,
`--deps`, `--milestone`, `--component`, `--allowed`, `--forbidden`; update requires `--reason`
when criteria change after failures; cancel: `--reason`, `--dependents drop|cancel`) ·
`brief <id>` · `milestone list|security|approve|reopen` · `decision add "title" [--authority
human|forge --decision --why]` · `discovery add "title" [--evidence --impact --affects]` ·
`baseline capture|check` · `component add|update <id> [--name --kind --route --mock --doc] |
list` · `status` · `dashboard` · `stats` · `usage [--write]` · `session status|takeover
[--force]` · `trace [--refusals|--hooks|--last N]` · `doctor` · `hook session-start|pretooluse|
stop` (plugin internal).

Config: `verify.test|lint|typecheck|security|…` (all run in every verify) · `options.gates
per-milestone|end-only` · `options.security off` · `options.protect "p1/,p2/"` ·
`options.concurrency N` (max items in flight; default 1 = serial; raise only with disjoint
scopes and the parallel-dispatch rules) · `options.scopeExempt "a/,b/"` (whitelist-exempt dirs;
default forge/,spec/,docs/; *.md always exempt) · `options.graphify` · `options.web` ·
`specDir` · `phase spec|build`.

Project files: `forge/config.json` · `forge/state/` (work.json, preflight, baseline,
session.json lock, work.lock write-lock, components.json, trace.jsonl — hook-protected,
CLI-only) · `forge/
decisions.md` + `discoveries.md` (append-only, titled) · `forge/dashboard.html` (generated) ·
`spec/` + `spec/mocks/`.

Companions: `docs/manual.html` (this manual, interactive) · `docs/architecture.html`
(functional map + work-item state machine diagrams) · `docs/TRACEABILITY.md` (spec §→enforcement
+ post-v0 addendum with each mechanism's origin).
