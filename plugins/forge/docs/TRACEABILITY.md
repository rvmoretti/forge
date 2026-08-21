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
