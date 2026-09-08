<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="plugins/forge/icons/logo_white_nobg.png">
    <img src="plugins/forge/icons/logo_black_nobg.png" alt="FORGE" width="420">
  </picture>
</p>

# Forge — spec-first engineering orchestration for Claude Code

Forge is a Claude Code plugin that turns one session into an engineering
organization. The main agent (on the strongest available model) operates as
CTO: it interviews you until your idea is a precise spec, converts the plan
into a work graph, briefs cheaper worker agents, **machine-verifies every
result** (it runs the tests and keeps the output — a worker saying "done"
counts for nothing), and stops at each milestone so you can try the running
slice and steer. You own WHAT and WHY; Forge owns HOW. You are interrupted
for exactly three things: a product decision, a high-risk approval, and a
milestone review.

## Why it exists

Agentic coding fails in predictable ways: work marked complete on the
model's say-so, the same failed fix retried until the budget dies,
"helpful" edits outside the task's scope, documentation drifting from the
code within a week, and two sessions silently overwriting each other. The
usual answer is better prompting. Forge's answer is that **prompts are
advice and advice gets ignored under pressure — so every rule that matters
is enforced in code**: a zero-dependency state CLI that refuses illegal
transitions, and hooks that fence the session. The model supplies judgment;
the gates supply discipline. Everything recoverable lives in plain
git-versioned files, so the conversation is never the memory and any fresh
session resumes exactly where things stood.

## What makes it different

Every claim below is a refusal in code, not an instruction in a prompt —
and every one is covered by a test in `tests/cli.test.js` (`npm test`,
36 tests):

- **DONE requires a passing verification record for the current tree** — no record, a failed record, or evidence older than the latest edit all refuse.
- **Checks must prove something** — `start` records each criterion check's pre-work result; if everything was green before work and nothing changed, `done` refuses (vacuous or already-satisfied criteria get flagged, not laundered).
- **No work item starts without acceptance criteria**, with unmet dependencies, or while already in progress — an in-flight item must be resolved (done / failed-with-diagnosis / blocked) before any re-dispatch, so retries can't dodge the counter.
- **A third identical retry is rejected** — after 2 recorded failures the CLI forces an explicit escalation (stronger model / decompose / revise criteria / do-it-yourself).
- **Milestones end in human review** — with `options.gates` at its `per-milestone` default, items of the next milestone refuse to start until you've tested the finished slice and recorded approval (`forge milestone approve`). Choose `end-only` to run straight through.
- **Security is part of the gate** — `approve` refuses until a security review of the slice is recorded (`forge milestone security <M> --note`), skipped only explicitly (`--skip-security --reason`, logged) or disabled per project (`options.security off`). Deterministic scanning runs continuously: set `verify.security` and it executes inside every `task verify` like any other check.
- **Brownfield changes are baseline-guarded in the verification itself** — once a baseline exists, `task verify` runs the comparison automatically; a regression fails the record (deliberate skips need `--skip-baseline --reason`).
- **State files can only change through the CLI** — direct edits are blocked by a hook; work-item edits go through audited `forge task update`; cancelling an item with live dependents forces an explicit decision about them.
- **Sessions can't end with silently dangling work** — the stop gate catches in-progress items and failed items parked in TODO.
- **One orchestrator per project** — a session lock (heartbeat on every write) makes hooks refuse writes from a second session while the first is active; a clean finish releases it, a stale one ages out, and `forge session takeover --force` clears a dead session's lock.
- **Log entries can't lose their identity** — `decision add` / `discovery add` refuse when no title is given (a bare positional argument counts as the title), instead of silently recording "(untitled)".
- **Scope is enforced, not advisory** — while an item is IN_PROGRESS, edits to its `scope.forbidden` paths are blocked by the hook, and paths frozen in config (`options.protect`) are blocked always. (Applies to file-tool edits; shell-level writes remain a review concern.)

Development discipline: **every field failure becomes a permanent test** —
the session lock, the untitled-log refusal, and the dispatch-tie fallbacks
all began as observed failures and stay in the suite as regressions.

Beyond the gates, Forge carries the full lifecycle: a layered spec method
(vision → domain → experience → API → logic → foundation) with mocks-as-spec
for UI work, a brownfield mode that baselines before touching anything and
grows a provenance-tagged spec as work happens, security folded into both
verification and the milestone gate, observed token/dispatch telemetry and
process metrics (never estimated), a zero-token generated dashboard with a
visual project map, and a flight recorder + `doctor` self-check for when
anything looks off. Start with `docs/manual.html` — the interactive
companion — and `docs/architecture.html` for the diagrams.

## Disclaimer

I built Forge for myself, to run my own projects, encoding my own
methodology and opinions about how AI-driven engineering should be
disciplined. I'm sharing it because it works well for me, not because it's a
product: expect opinionated defaults, a solo-developer perspective, versions
that move fast, and no support guarantees. It has been exercised on real
projects but is young — read the changelog, run `forge doctor`, and judge
for yourself. Issues and ideas are welcome; my own projects come first.

## Install

```
/plugin marketplace add https://github.com/rvmoretti/forge
/plugin install forge@forge-marketplace --scope project
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

**Commands:** `/forge:status` · `/forge:preflight` · `/forge:build` · `/forge:dashboard` · `/forge:usage` · `/forge:stats`

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
│   ├── forge-method/      the spec-first METHOD (verbatim) + mocks + work-graph handoff
│   ├── forge-brownfield/  orientation, baseline, mini-spec protocol
│   └── forge-domain-packs/ backend · frontend · design-ux · testing · security
│                          checklists (curated from msitarzewski/agency-agents)
├── commands/              /forge:status /forge:preflight /forge:build
│                          /forge:dashboard /forge:usage /forge:stats
└── docs/
    ├── manual.html        the interactive companion — install → daily use →
    │                      every refusal decoded; open in any browser
    ├── manual.md          the same manual as plain markdown, for AI consumption
    ├── architecture.html  functional diagrams — who talks to whom, where the
    │                      truth lives, the work-item state machine with its
    │                      refusal edges
    └── TRACEABILITY.md    FORGE spec §1–§333 → where each rule lives
```

## Per-project state (created by `forge init`)

```
forge/
├── config.json        phase, verify commands, options    (CLI-managed)
├── state/             work.json · preflight · baseline · session.json (lock)
│                      components.json (map) · trace.jsonl (flight recorder)
│                      (CLI-managed, hook-protected)
├── decisions.md       append-only, titled, human/forge authority tagged
├── discoveries.md     append-only, titled, consequence-tracked
└── dashboard.html     generated projection incl. the project map — never edited
```

Everything is plain JSON/markdown, git-versioned, human-inspectable. A fresh
session recovers the full picture from disk — the conversation is never the
memory.

## Changelog

### v0.10.0 — the project map
The dashboard gains a visual component map: one box per component (route,
kind, progress bar, in-progress/blocked/failed rollups, spec doc link, and
the mock or latest screenshot evidence as a thumbnail). Components live in a
CLI-managed registry (`forge component add|update|list` →
`state/components.json`, hook-protected like all state); work items tag
themselves with `--component` on add/update, and an unknown component
auto-registers so the map never lies by omission. Untagged items are counted
visibly. Still a zero-token generated projection — state wins, never edit it.

1 new test (36 total).

### v0.9.0 — UX layer and the drawn frontend
- **`design-ux` domain pack** — hierarchy, the five states
  (empty/loading/error/partial/success), forms, feedback, mobile, language,
  plus a fresh-context UX review protocol. Every screen brief carries it;
  a screen whose checks pass but whose UX review fails is a failed item.
- **Mocks as spec (the drawn frontend, back from the original METHOD).** The
  spec phase offers a mock per key screen (Claude Design / Figma export /
  photographed sketch, wireframe fidelity by default) stored at
  `spec/mocks/<screen>`, referenced from 02-experience, approval recorded as
  a human decision. Screen items get a mock-fidelity criterion; "actually
  followed" is the same machinery as everything else — red-first,
  screenshot at verify, fresh-context reviewer verdict.
- **`task verify --artifact <path>`** — attach evidence files (screenshots,
  reports) to the verification record; missing paths warn and are not
  recorded.

1 new test (35 total).

### v0.8.0 — security in the loop, delegation routing
- **Security enters through the existing machinery, not a new ceremony.**
  Deterministic layer: set `verify.security` (gitleaks/semgrep/npm-audit/…)
  and it runs inside every `task verify` — a finding fails the item;
  preflight now recommends one in build phase. Judgment layer:
  `milestone approve` refuses until a fresh-context security review of the
  slice's cumulative diff is recorded via `forge milestone security <M>
  --note` (forge-reviewer + security domain pack); deliberate skips are
  `--skip-security --reason` and land in the decisions log;
  `options.security off` opts a project out.
- **Delegation routing.** Field telemetry (79/79 dispatches =
  forge-implementer; explorer/tester never used) showed the orchestrator
  absorbing exploration and test-authoring on the most expensive tokens. The
  contract now routes: codebase questions → forge-explorer before
  self-reading at scale; test-focused work → forge-tester. Measured by cost
  per completed item, not delegation percentage.

2 new tests (34 total).

### v0.7.0 — observability: trace, doctor, verbose debug
Instrumentation ships BEFORE the next wave of compounding changes, so
failures are attributable to a version, not to a pile:

- **Always-on trace** — every CLI invocation and every hook decision appends
  one JSON line to `forge/state/trace.jsonl` (timestamp, plugin version,
  command, outcome or refusal, block reason, duration). Auto-rotates at 2MB.
  Tracing never breaks the CLI and never creates `forge/` in an
  uninitialized directory.
- **`forge trace [--refusals|--hooks|--last N]`** — the reader.
  `FORGE_DEBUG=1` records verbose payloads (hook stdin, matched patterns).
- **`forge doctor`** — install/state self-check targeting the failure classes
  observed in the field: multiple cached plugin versions, installed cache
  behind the repo, the manifest-hooks duplicate-load regression, corrupt
  config/work state, stale locks, and orphaned IN_PROGRESS items with no
  active orchestrator (the edit-war precursor).
- Operating contract: when Forge misbehaves, run `doctor` + `trace
  --refusals` and report — never work around a guard without that evidence.

3 new tests (32 total).

### v0.6.0 — enforced scope, process metrics, unbiased review
Informed by Anthropic's AI-native SDLC playbook, filtered against what Forge
already enforces:

- **Scope enforcement.** `scope.forbidden` was advisory prose in the brief;
  now the PreToolUse hook refuses Write/Edit to any IN_PROGRESS item's
  forbidden paths (exact path, directory `dir/`, or `*` glob), and
  `options.protect` in config freezes paths unconditionally (generated code,
  migrations, vendored packages). A blocked worker must stop and report —
  scope changes go through audited `task update`, never around the guard.
- **`forge stats` (+ `/forge:stats`).** Process-health counterpart to
  `forge usage`, derived from work.json at zero tokens: first-pass rate,
  failed attempts absorbed, most-retried items, escalations, first-start →
  done elapsed times (wall-clock, honestly labeled), per-milestone health
  with gate status.
- **Fresh-context review rule.** The operating contract now requires
  high-risk diffs to be reviewed by `forge-reviewer` in a fresh context: the
  orchestrator briefed the work, so its own read is colored by the
  assumptions that produced it. Machine verification was already unbiased;
  this closes the judgment side.
- Development discipline written down: every field failure becomes a
  permanent test. 3 new tests (29 total).

Deliberately deferred from the playbook (triggers recorded here): the
maintain loop (monitoring bands → auto-intent → pipeline) until a Forge
project has production traffic to calibrate against; continuous evals of
agent configuration until the suite would test something a real incident has
shown to matter; PR-review and enterprise managed-settings layers (org-scale,
out of Forge's solo-first scope).

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

Deferred by design (see docs/TRACEABILITY.md for rationale and the addendum
mapping every post-spec mechanism to its origin): the production maintain
loop (monitoring bands → auto-intent), continuous evals of the agent
configuration, parallel worktree orchestration. The original 333-section
behavioral spec remains the design contract; the traceability map is the
proof of coverage.

## License

MIT — see [LICENSE](LICENSE). The spec methodology embedded in the
`forge-method` skill is released under the same terms.
