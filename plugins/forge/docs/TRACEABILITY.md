# Traceability — FORGE v0 spec → implementation home

Every cluster of the original specification (FORGE_V0_SPEC §1–§333) mapped to
where it lives in this plugin. Homes:

- **CLI** — enforced by code in `bin/forge.js` (cannot be skipped)
- **HOOK** — enforced by `hooks/hooks.json` + CLI hook handlers (cannot be skipped)
- **CORE** — orchestrator behavior in `core/OPERATING.md` (injected every session)
- **SKILL** — situational protocol, loaded on demand
- **AGENT** — worker agent definitions in `agents/`
- **REF** — design rationale; kept in the original spec document, not at runtime
- **DEFERRED** — consciously out of v0 (listed at the end)

| Spec cluster | Sections | Home | Notes |
|---|---|---|---|
| Executive definition, what Forge is/is not | 1–2 | REF | Design rationale |
| Human owns intent / Forge owns engineering | 3.1–3.2, 123–126, 305–307 | CORE | "Authority boundary" — the first rule in OPERATING.md |
| Investigate before escalating | 3.3 | CORE + AGENT | Explorer agent; escalation format in CORE |
| Process proportionality / adaptive depth | 3.5–3.6, 85–92, 261 | CORE | "Proportionality" section; L0–L4 taxonomy collapsed into judgment + cheap mandatory gates |
| Consequential learning / discoveries | 3.7, 41–42, 109, 120 | CLI + CORE | `forge discovery add` + consequence rule in CORE and in the CLI's output message |
| Persistent memory under ./forge/ | 3.8, 55, 69, 213, 269–270, 293, 303, 317 | CLI | All state in `forge/`; session-start digest restores context; conversation never authoritative |
| Documentation as part of engineering | 3.9, 40, 110, 318–319 | CORE | Docs sync in loop step 5; three-layer distinction kept implicitly (spec / forge state / project docs) |
| Simplest reliable mechanism | 3.10, 187, 265–268 | — | Applied to this implementation itself |
| Filesystem boundary, CLAUDE.md, .claude/ | 4, 190–196, 293–296, 312–313 | CLI + HOOK | State under `forge/`; plugin owns nothing in project root; state writes blocked by hook |
| Preflight + dependency checklist + remediation | 5, 127, 171–173, 250, 285–289 | CLI | `forge preflight`: mandatory vs optional vs ASK_USER; idempotent; choices recorded |
| Graphify integration (evidence, not memory) | 7–8, 68, 251–253, 256 | SKILL + AGENT + CLI | Preflight checks it; Explorer/brownfield skills query it first; never authoritative |
| Knowledge model, Intent/Reality, status taxonomy | 9–14, 61–64, 103–106, 227–229 | SKILL + AGENT + REF | Spec folder IS the intent model; reality re-derived (Graphify/Explorer); OBSERVED/INFERRED/UNKNOWN kept in Explorer's report contract; the knowledge-item engine is deliberately replaced (see design decision below) |
| Requirements hierarchy, constraint challenge | 15–16, 168–169, 236, 276–277 | SKILL (method) + CORE | METHOD owns classification; CORE forbids silent constraint violation |
| Work Graph, item schema, states, readiness | 17–20, 221–224 | CLI | `work.json`; transitions enforced; no-criteria and unmet-deps starts refused; explicit cancel reasons |
| Greenfield lifecycle | 21, 130–133, 159 | SKILL (forge-method) | METHOD verbatim + Step 7 work-graph generation |
| Brownfield lifecycle, baseline, mapping stages | 22–23, 129, 157–158, 225–226, 254–255 | SKILL (forge-brownfield) + CLI | `forge baseline capture/check` enforces the pre-existing/introduced distinction |
| Task lifecycle protocol (16 phases) | 24, 78–84 | CORE | Collapsed to the 5-step loop; phases that were bookkeeping became CLI side-effects |
| Delegation contract, Agent Brief | 25–26, 57–58, 97–99, 279 | CLI + CORE + AGENT | `forge brief` generates skeleton; agents carry scope/no-invention rules in their own prompts |
| Specialist roles | 27–33 | AGENT | 5 agents: explorer, implementer, tester, reviewer, architect (docs-steward folded into orchestrator for v0) |
| Agency Agents import, provenance, curation | 34, 67, 209–212, 282 | SKILL (domain-packs) + AGENT | Imported 2026-08, persona stripped, checklists kept, provenance noted |
| Model routing, economics, containment | 35, 66, 139–141, 195–196, 280–281, 299–302 | AGENT + CORE | Static tiers in agent frontmatter; escalation ladder in CLI (forced after 2 failures); requested-vs-actual model honesty → DEFERRED (telemetry limits) |
| Token/usage accounting | 36, 246–247 | DEFERRED | Runtime telemetry insufficient for honest per-agent attribution; spec's never-fabricate rule respected by not building it |
| Parallel execution limits | 37, 205–206, 220 | CORE + CLI | Sequential by default; state writes serialized through single CLI |
| Verification protocol, security testing | 38–39, 136–137, 163–165 | CLI + AGENT | `task verify` machine gate; security pack + reviewer lens |
| Replanning, foundations | 42–43, 160 | CORE + CLI | Discovery → work-graph update; missing foundation → prerequisite items |
| Human escalation format | 44, 119 | CORE | "A or B, I recommend A because X" rule |
| Autonomy modes, approval policy | 45–46, 201–202, 248–249 | CORE + Claude Code permissions | v0 uses Claude Code's native permission system as the approval gate; per-operation policy config → DEFERRED |
| Failure recovery, Git, retries | 47, 54, 137–138, 230, 256–258 | CLI | Retry ladder with forced escalation; git assumed as recovery substrate |
| Control Center | 48–50, 112, 142–144, 243–245 | CLI (v0.2) | `forge dashboard` generates `forge/dashboard.html` deterministically from state; auto-regens on every CLI state mutation; stamped as generated projection (§50 state-wins rule enforced by regeneration) |
| Audit protocol | 51–52, 148, 262–263 | DEFERRED (deep audit) | Lightweight consistency lives in status + baseline; deep audit v0.5 |
| State consistency, transactions, idempotency | 53, 216–219, 152–154 | CLI | Atomic writes (tmp+rename), stable ids, idempotent init/preflight; corruption → refuse + instruct recovery from git |
| Session restart, interruption, emergency stop | 270–273 | HOOK | SessionStart digest; Stop gate refuses silent dangling work (with loop protection) |
| Scope creep | 274–275 | AGENT + CORE | Workers must stop-and-report; orchestrator expands graph explicitly |
| Conversational protocol, verbosity | 241–242 | CORE | "Interaction with the user" section |
| Spec-First methodology integration | 233–240, 321–327 | SKILL (forge-method) | METHOD.md verbatim; proposal→confirmation→decision protocol kept |
| Commands surface | 145–149 | commands/ | /forge:status, /forge:preflight, /forge:build |
| Acceptance scenarios | 74 | CLI tests (v0.3) | `tests/cli.test.js` — 20 refusal/gate tests, one per advertised enforcement (`npm test`); formal agent-behavior eval suite remains DEFERRED to v0.5 |
| Milestone/human review gates | 45–46, 241 ("milestone review"), 236 | CLI (v0.3) | `forge milestone approve/reopen`; `task start` refuses later-milestone items until earlier gates approved; config `options.gates per-milestone\|end-only`; approvals recorded as human-authority decisions |
| Verification integrity (review 1.1–1.3, 3.1) | 38, 59, 121–122 | CLI (v0.3) | retry-ladder bypass closed (no start from IN_PROGRESS); baseline folded into `task verify`; red-first criterion gate; verification records bound to git tree state |

## Deliberate design departures from the spec (decided in review, 2026-08)

1. **The knowledge engine (§9–13, §103, §113–118) is replaced by re-derivation.**
   Reality is answered by code + Graphify + Explorer agents at need; only
   non-recomputable knowledge persists (decisions, discoveries). Rationale:
   LLM-maintained knowledge caches rot; deterministic re-derivation is cheap.
   Reversible: if re-orientation costs dominate on large projects, add a
   cached reality layer in v1 — the discovery/decision logs already give it a seed.
2. **The 333-section prose contract is not loaded at runtime.** OPERATING.md
   (~130 lines) is the enforced distillation; this table is the audit trail
   proving nothing was dropped silently.
3. **Usage telemetry and the HTML Control Center are deferred**, per the
   spec's own never-fabricate and simplest-mechanism rules.

---

## Addendum — post-v0 mechanisms (no §-number: added after the original spec)

These were not in FORGE_V0_SPEC; each entered through an observed failure or
an explicitly recorded external source, and each is covered by tests:

| Mechanism | Version | Origin | Enforcement home |
|---|---|---|---|
| Milestone gates (human review per slice) | v0.3.0 | incremental-delivery design session | CLI `milestoneGateBlock` + `milestone approve` |
| Brownfield spec accretion w/ provenance | v0.3.1 | greenfield/brownfield convergence decision | forge-brownfield §6 + contract |
| Observed usage/dispatch telemetry | v0.4.x | "is it actually dispatching?" (field) | CLI `usage` (session logs, never estimated) |
| Orchestrator session lock (edit-war guard) | v0.5.0 | duplicate-orchestrator incident (T27) | PreToolUse/SessionStart/Stop hooks + `session` |
| Universal spec sync at item close | v0.5.0 | observed greenfield spec drift | contract step 5 + `task done` reminder |
| Titled decisions/discoveries (refuse untitled) | v0.5.0 | "(untitled)" data-loss incident | CLI `decision/discovery add` |
| Enforced scope + `options.protect` | v0.6.0 | AI-native SDLC playbook (hooks-as-guardrails) | PreToolUse scope guard |
| Process metrics (`stats`) | v0.6.0 | playbook measurement framework | CLI `stats` (derived, zero tokens) |
| Fresh-context review rule | v0.6.0 | playbook verifier-subagent distinction | contract step 4 |
| Trace / doctor / FORGE_DEBUG | v0.7.0 | compounding-changes debug need | CLI trace plumbing + `trace`/`doctor` |
| Security in verify + gated security review | v0.8.0 | playbook + missing security layer | `verify.security` + `milestone security/approve` |
| Delegation routing (explorer/tester) | v0.8.0 | usage telemetry: 79/79 = implementer | contract model-economics |
| design-ux pack + mocks-as-spec + `--artifact` | v0.9.0 | original METHOD's drawn frontend, restored | pack + method Step 7 + `verify --artifact` |
| Component registry + dashboard project map | v0.10.0 | user's visual-map requirement | CLI `component` + generated dashboard |
| Brownfield entry fork (bounded change / destination) | v0.11.0 | user's two-starting-points requirement | forge-brownfield §0 + §7 |
| State-write lock (work.lock, PID-liveness stale-break) | v0.12.0 | external parallelism review of project-b: `saveWork` read-modify-write race | CLI `acquireWorkLock` around every mutating command |
| Required + whitelist-enforced `scope.allowed` | v0.12.0 | same review: 0/87 items carried a scope; whitelist was inert | `task start` refusal + PreToolUse whitelist (union, exempt dirs) |
| Concurrency gate (`options.concurrency`, disjoint scopes) | v0.12.0 | same review: 4-way unguarded worker bursts observed | `task start` cap + overlap refusal; contract parallel-dispatch section |
| Dispatch records (`task dispatch`, incl. mid-flight messages) | v0.12.0 | same review: dispatch↔item tie by inference is fragile; 30 unaudited SendMessages | CLI `task dispatch` + contract step 3; `usage` reads state first |
| Dashboard telemetry panel (time live from state; tokens from `usage --write` snapshot) | v0.12.1 | user request — follow time/tokens per agent as a project progresses; log parsing stays out of the regen path | generated dashboard (projection only; trimmed medians, honest empty states) |
| Guided experience (session next-step, `/forge:start`, named feature-dump moment, mandatory mock stop, gate change-invitation, dashboard reminders) | v0.13.0 | field feedback: non-technical users felt lost between install and build | session-start hook (deterministic next-step) + contract "guided experience" section + method/brownfield skills |
| Whole-project work graph (thin later-milestone items; parked backlog docs = drift bug) | v0.13.0 | field: items living only in docs/handoff were invisible to every gate and view | contract spec-phase rule + method Step 7 + brownfield §7; `add` allows thin, `start` still gates |
| Component seeding + untagged warnings | v0.13.0 | field: 0-tag projects rendered an empty/partial project map | skills (registry as Step 7/orientation deliverable) + `task add` warning + preflight check |
| Collapsible dashboard sections; scope warning scoped to the active milestone | v0.13.0 | usability: long graphs unreadable; thin backlog items spammed warnings | generated dashboard |
| Verification timing in evidence + human gate-wait metric | v0.13.0 | vNext review: measure the time taxonomy before optimizing anything | `run()` ms per check → verification `durationMs`; telemetry panel |
| Saved briefs (`brief --save` → forge/briefs/) + dashboard item cards, milestone component chips, next-touched, live filter | v0.13.1 | user: briefs were ephemeral/unreadable; "what gets touched when" invisible | CLI `brief --save` + contract step 2 + generated dashboard |
| Dashboard redesign (branded shell, needs-you banner, KPI + pace/forecast projection, milestone rail, design strip) + `--mock` item field | v0.14.0 | user: dashboard unusable/unattractive; mocks invisible; no elapsed/remaining view | generated dashboard (projection; forecast labeled and computed only from observed pace) + `task --mock` |
| API workers, providers phase A (`worker run`: scope-sandboxed read/write/verify loop over OpenAI-compatible providers; `api` dispatch records with token counts) | v0.15.0 | user: workers locked to one vendor/subscription; measured improvement zero because levers never fired | CLI `worker run` + contract "API workers" section; sandbox enforced in code |
| Provider-failure taxonomy (`fail --kind provider` exempt from escalation + brief history) | v0.15.0 | vNext review seed; field: platform errors would burn the retry ladder | CLI `task fail --kind` + `failedAttempts()` filter |
| Item-shape guard (warn: >8 globs, >6 criteria, decision-shaped criteria) + stall rule (diagnose-and-narrow before decompose) | v0.15.0 | field (project-b T55): mega-item stalled 55min; narrowed retry finished in 24min; a smuggled decision criterion had to be removed mid-flight | CLI warnings at add/update/start + contract build-loop stall rule |
| Brief carries the resolved file list + no-exploration working rules | v0.16.0 | field: one implementer dispatch averaged 218 model calls; context is re-sent per call, so turns are the bill | `resolveScopeFiles()` in `briefLines()` + contract step 2 |
| `milestone security --agent` required (self allowed, recorded as absorbed) | v0.16.0 | field: security pass absorbed in-session 22× for 21 items (~694k tokens) despite the contract saying dispatch | CLI refusal + gate record carries the agent |
| Milestone gate declared a session boundary | v0.16.0 | field: 601M cached tokens re-read by one orchestrator across one long session | `milestone approve` instruction + contract step 6 |
| Lean verify stdout by default (`options.verifyVerbose` restores) | v0.16.0 | field: tool results were 29–47% of the orchestrator window; a passing test's output is never read | `task verify` output path only; `work.json` evidence unchanged |
| Efficiency metrics: context re-read, context:output ratio, calls/context/output per DONE item, calls per worker dispatch, `usage --baseline` deltas, clean-run rate | v0.16.0 | field: 1.33B context re-read vs 3.94M generated (339:1) — token share by model does not track cost | `usageMetrics()` / `usageSince()` in `usage`, `stats`, dashboard strip |
| In-dashboard document reader (embedded briefs + spec markdown, rendered, with open/download/folder actions; size- and budget-capped) | v0.15.3 | user: briefs and spec files should open in a panel respecting markdown, with quick access to the originals | generated dashboard (`docdata` store + reader panel) |
| Quick filters corrected: gate-aware "Needs me", active-milestone-aware "Active", live counts, per-group match counts, empty state | v0.15.3 | user: "Needs me" and "Active" showed nothing while a milestone awaited approval; "Done" showed a group that was not done | generated dashboard filter predicate (one predicate drives both counts and filtering) |
| Milestone rail in a card | v0.15.3 | user: rail should match the approved mockup | generated dashboard |
| Self-refreshing token snapshot (incremental transcript scan with per-file byte offsets, time budget + resume, `options.usageAuto`) | v0.15.2 | user: had to run `forge usage --write` by hand for telemetry to update | `collectUsage`/`usageAutoRefresh` called from `regenDashboard` |
| Client-side duration ticker (in-progress elapsed, calendar elapsed, snapshot ages) | v0.15.2 | user: asked what else goes stale — every duration was stamped at the last CLI call | generated dashboard `[data-since]` + 30s tick |
| `task dispatch --agent` required on launch; messages inherit the launch agent | v0.15.2 | user: phantom `(agent not named)` row with 0 dispatches and no timings | CLI refusal + render-time attribution for legacy records |
| Dashboard finish pass (item rows + drawers, milestone group cards, custom carets, quick filters, charted telemetry, map grid, journal timeline, system status rows) | v0.15.1 | user: generated dashboard visibly less polished than the approved mockup — "small details that make a lot of difference" | generated dashboard (structure locked by a regression test) |
| Milestone headers lose component chip rows | v0.15.0 | user: pills at real-project density are noise; components already on cards/map/rail | generated dashboard |

Still deferred, with triggers: the maintain loop (monitoring bands →
auto-intent) until a Forge project has production traffic; continuous evals
of agent configuration until an incident class demands one; parallel
worktree orchestration + integration items (build only after the §8
validation protocol on Changes 1–4 shows the concurrency gain is real —
worktrees are the expensive change); the 9-second-review investigation
(review-before-verify vs review-absent — determination to be recorded as a
decision against project-b's transcripts, then a contract amendment or an
observable review record).
