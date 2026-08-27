# Forge — spec-first engineering orchestration for Claude Code

Forge turns a Claude Code session into an engineering organization: the main
agent (on the strongest available model) acts as CTO — it runs your spec
methodology, converts the plan into a work graph, briefs cheaper worker
agents, machine-verifies every result, and loops until acceptance criteria
pass. You own WHAT and WHY; Forge owns HOW.

The rules that matter are enforced by code, not prompts — and every claim
below is covered by a test in `tests/cli.test.js` (`npm test`, 26 tests):

- **DONE requires a passing verification record for the current tree** — no record, a failed record, or evidence older than the latest edit all refuse.
- **Checks must prove something** — `start` records each criterion check's pre-work result; if everything was green before work and nothing changed, `done` refuses (vacuous or already-satisfied criteria get flagged, not laundered).
- **No work item starts without acceptance criteria**, with unmet dependencies, or while already in progress — an in-flight item must be resolved (done / failed-with-diagnosis / blocked) before any re-dispatch, so retries can't dodge the counter.
- **A third identical retry is rejected** — after 2 recorded failures the CLI forces an explicit escalation (stronger model / decompose / revise criteria / do-it-yourself).
- **Milestones end in human review** — with `options.gates` at its `per-milestone` default, items of the next milestone refuse to start until you've tested the finished slice and recorded approval (`forge milestone approve`). Choose `end-only` to run straight through.
- **Brownfield changes are baseline-guarded in the verification itself** — once a baseline exists, `task verify` runs the comparison automatically; a regression fails the record (deliberate skips need `--skip-baseline --reason`).
- **State files can only change through the CLI** — direct edits are blocked by a hook; work-item edits go through audited `forge task update`; cancelling an item with live dependents forces an explicit decision about them.
- **Sessions can't end with silently dangling work** — the stop gate catches in-progress items and failed items parked in TODO.
- **One orchestrator per project** — a session lock (heartbeat on every write) makes hooks refuse writes from a second session while the first is active; a clean finish releases it, a stale one ages out, and `forge session takeover --force` clears a dead session's lock.
- **Log entries can't lose their identity** — `decision add` / `discovery add` refuse when no title is given (a bare positional argument counts as the title), instead of silently recording "(untitled)".

## Install

```
/plugin marketplace add <this-repo-url-or-path>
/plugin install forge@forge-marketplace
```

Requires Node ≥ 18 (which Claude Code already requires) and git.
Optional enhancers, detected by preflight: [Graphify](https://github.com/Graphify-Labs/graphify) (deterministic code
graph — recommended), Playwright (machine-verified E2E for web projects).

## Use

**Greenfield:** open Claude Code in an empty repo, describe your product.
The `forge-method` skill runs the layered spec interview (vision → domain →
experience → API → logic → foundation). When the spec gates, say "build it".

**Brownfield:** open your repo, ask for the change. The `forge-brownfield`
skill orients (Graphify-first), captures a baseline, asks you only the
product questions the code can't answer, then runs the same loop.

**Commands:** `/forge:status` · `/forge:preflight` · `/forge:build` · `/forge:dashboard` · `/forge:usage`

**Dashboard:** `forge/dashboard.html` — a generated projection of everything on
disk (progress, work graph by milestone, attempts/verifications, decisions,
discoveries, preflight, baseline, spec files). It regenerates automatically on
every state change, zero tokens; open it in a browser and just reload. State
wins — never edit it, never treat it as the source of truth.

You get interrupted for exactly three things: a product decision the spec
doesn't answer, a high-risk approval, and milestone reviews.

## What's inside

```
plugins/forge/
├── core/OPERATING.md      the CTO operating contract (injected every session)
├── bin/forge.js           state CLI — work graph, verification, retry ladder,
│                          baseline, preflight, decisions/discoveries logs
├── hooks/hooks.json       session-start context, state write-guard, stop gate
├── agents/                forge-explorer (haiku) · forge-implementer (sonnet)
│                          forge-tester (sonnet) · forge-reviewer (opus)
│                          forge-architect (opus)
├── skills/
│   ├── forge-method/      the spec-first METHOD (verbatim) + work-graph handoff
│   ├── forge-brownfield/  orientation, baseline, mini-spec protocol
│   └── forge-domain-packs/ backend · frontend · testing · security checklists
│                          (curated from msitarzewski/agency-agents)
├── commands/              /forge:status /forge:preflight /forge:build
│                          /forge:dashboard /forge:usage
└── docs/
    ├── manual.html        the user manual — setup + greenfield/brownfield
    │                      walkthroughs; open in any browser, give to newcomers
    ├── architecture.html  functional diagrams — who talks to whom, where the
    │                      truth lives, the work-item state machine with its
    │                      refusal edges
    └── TRACEABILITY.md    FORGE spec §1–§333 → where each rule lives
```

## Per-project state (created by `forge init`)

```
forge/
├── config.json        phase, verify commands, options   (CLI-managed)
├── state/             work.json, preflight, baseline    (CLI-managed, hook-protected)
├── decisions.md       append-only, human/forge authority tagged
└── discoveries.md     append-only, consequence-tracked
```

Everything is plain JSON/markdown, git-versioned, human-inspectable. A fresh
session recovers the full picture from disk — the conversation is never the
memory.

## Changelog

### v0.5.0 — one orchestrator, one living spec
Three changes, each closing a failure observed in the field:

- **Orchestrator session lock** (the duplicate-orchestrator fix). Root cause
  of the T27 edit-war incident: a resumed/headless session and the visible
  session both believed they owned the project. Now every write beats a
  heartbeat into `forge/state/session.json`; the PreToolUse hook refuses
  Write/Edit from any OTHER session while the lock is fresh (15-min TTL),
  session start warns an arriving second orchestrator to stay read-only, a
  clean stop releases the lock, and `forge session status | takeover
  [--force]` gives the human the referee's whistle. Sessions without a
  session_id in hook input (older Claude Code) are unaffected.
- **Universal spec sync** (greenfield spec drift fix). Spec accretion was
  brownfield-only; greenfield relied on one soft "sync any affected docs"
  line, so gate feedback and mid-build decisions piled up in decisions.md
  while spec/ went stale. The close step in OPERATING.md now requires, on
  every project, updating the affected spec layer when a completed item
  established/changed/contradicted product behavior — citing the driving
  decision/discovery — and `task done` prints the reminder. The spec is the
  documentation-generation source; it must always describe the product as
  built and intended.
- **Titled log entries.** `decision add` / `discovery add` silently recorded
  "(untitled)" with empty fields when called without flags — quiet data loss
  dressed as compliance. Both now accept a bare positional argument as the
  title and refuse outright when no title arrives either way.

6 new tests (26 total).

### v0.4.5 — dispatch-to-item tie hardening
`forge usage` tied dispatches to work items only via the inline brief header
(`# Work brief — <id>:`); orchestrators that pass briefs by file path made
every new dispatch untraceable (observed in the field: 17/73 untied and
climbing). The matcher now falls back to (2) a brief file path in the prompt
(`briefs/<id>.md`) and (3) the first known work-item id appearing in the
prompt (longest id wins, so `T20f` never mis-ties to `T20`). OPERATING.md now
also requires the brief header as the dispatch prompt's first line regardless
of how the brief body is delivered. Covered by a new fixture test (21 total).

### v0.4.4 — /forge:usage slash command
The usage report existed only as a CLI subcommand (`forge usage`) since
v0.4.0; there was no slash form. Added `commands/usage.md` so `/forge:usage`
works inside a session. The zero-token path is unchanged: run
`node <plugin>/bin/forge.js usage` from any plain terminal.

### v0.4.3 — real worker telemetry
`forge usage` now reads worker transcripts from
`<session>/subagents/agent-*.jsonl` (where Claude Code ≥ 2.1 stores them),
so the delegation split reports observed orchestrator-vs-worker tokens by
model instead of UNAVAILABLE.

### v0.4.2 — usage report accuracy
Roster detection now matches plugin-prefixed agent types (`forge:forge-implementer`),
fixing a false "work is bypassing the forge agents" warning. When dispatches
exist but no subagent-thread usage appears in the logs (some Claude Code
versions store worker transcripts elsewhere), the delegation split now reports
UNAVAILABLE instead of a misleading 0%.

### v0.4.1 — fix duplicate-hooks load error
Claude Code auto-loads `hooks/hooks.json` by convention; the manifest's
explicit `hooks` field made it load twice and error on newer versions.
Removed the manifest field — hooks now load once, via the convention path.

### v0.4.0 — observed usage & dispatch visibility
`forge usage` answers "is orchestration actually happening?" from the one
honest source: the local Claude Code session logs (`~/.claude/projects/`),
which record every model call and every subagent dispatch. Reported, never
estimated: tokens by model split orchestrator-vs-subagent threads, delegation
percentage, dispatch counts by agent type (with an explicit flag when work
bypasses the forge roster or when there are zero dispatches), dispatches tied
to work items via their brief ids, per-day activity, and **output tokens
spent since the last forge state change** — the drift detector for "tokens
burning while the work graph is frozen". `task start` gains `--agent` so the
work graph records who executed each attempt. Unavailable data is declared
unavailable (per-agent-type token splits inside subagent threads; milestone
token attribution).

### v0.3.1 — brownfield spec accretion
Brownfield projects converge on the same METHOD-format spec as greenfield
ones — incrementally, never by whole-system reverse-engineering. After each
completed change, what it established is merged into the spec folder with
explicit provenance: **[CONFIRMED]** (user-decided — intent),
**[OBSERVED]** (derived from code — reality, never silently promoted to
intent), **_TBD_** (known gap). OBSERVED-vs-CONFIRMED contradictions are
recorded as discoveries. Full upfront reconstruction remains an explicit
opt-in, run as its own Forge project. (Skill + operating contract change;
no CLI change.)

### v0.3.0 — enforcement hardening + milestone gates
Implements every finding from `FORGE-REVIEW-2026-08-20.md` (external review vs
ChatDev 2.0) plus the incremental-delivery design:

- **Review 1.1** — retry-ladder bypass closed: `start` refuses from IN_PROGRESS; unrecorded re-dispatch is impossible through the CLI.
- **Review 1.2** — red-first criterion gate: pre-work check results recorded at `start`; `done` refuses evidence that proved nothing.
- **Review 1.3** — baseline folded into `task verify` (was prose in a skill); regression fails verification; `--skip-baseline --reason` for audited exceptions.
- **Review 1.4** — `tests/cli.test.js`: 20 refusal/gate tests (`npm test`, zero dependencies); TRACEABILITY corrected to reference real tests.
- **Review 2.1/2.2** — `forge task update` (audited, `--reason` required when criteria change after failures); `cancel` resolves dependents explicitly (`--dependents drop|cancel`) instead of bricking them.
- **Review 2.3** — `opt()` no longer swallows the next flag as a value.
- **Review 2.4** — session-start states the real CLI invocation imperatively.
- **Review 3.1** — verification records bound to git tree state; `done` refuses stale evidence.
- **Review 3.2** — stop gate also surfaces failed items parked in TODO.
- **Review 3.4** — baseline comparison detects changed verify commands and demands recapture instead of comparing apples to oranges.
- **Review P3** — `baseline capture` advances phase spec→build (brownfield gate armed without the spec phase); preflight checks Node ≥ 18; hooks never crash on corrupt state; `.gitignore` covers state temp files.
- **New: milestone gates (F9)** — milestones are defined in the spec phase as user-testable vertical slices (walking skeleton first, demo criterion each, cut confirmed by the user); with `options.gates per-milestone` (default) the CLI refuses to start later-milestone items until the human has tested the slice and recorded `forge milestone approve <M>`; approvals land in the decisions log with human authority; `end-only` available for straight-through runs.
- Deliberately NOT adopted from the review's ChatDev comparison (triggers recorded in the review): parallel dispatch (§5.1), cross-project experience corpus (§5.2), `work.json` size management (§3.3 — revisit when felt).

### v0.2.0 — generated dashboard
`forge dashboard` + auto-regeneration on every state change.

### v0.1.0 — initial release
CTO operating contract, state CLI with enforced gates, tiered agents, METHOD
+ brownfield + domain-pack skills.

## v0 scope notes

Deferred by design (see docs/TRACEABILITY.md for rationale): HTML Control
Center (`forge status` covers observability), per-agent token telemetry,
deep audit, formal eval suite. The original 333-section behavioral spec
remains the design contract; the traceability map is the proof of coverage.
