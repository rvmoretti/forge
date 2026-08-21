# Forge — spec-first engineering orchestration for Claude Code

Forge turns a Claude Code session into an engineering organization: the main
agent (on the strongest available model) acts as CTO — it runs your spec
methodology, converts the plan into a work graph, briefs cheaper worker
agents, machine-verifies every result, and loops until acceptance criteria
pass. You own WHAT and WHY; Forge owns HOW.

The rules that matter are enforced by code, not prompts:

- **DONE requires a passing verification record** — the CLI refuses otherwise.
- **No work item starts without acceptance criteria** or with unmet dependencies.
- **A third identical retry is rejected** — after 2 failed attempts the CLI forces an explicit escalation (stronger model / decompose / do-it-yourself).
- **State files can only change through the CLI** — direct edits are blocked by a hook.
- **Sessions can't end with silently dangling work** — a stop gate requires done / blocked-with-reason / failed-with-diagnosis.
- **Brownfield changes are baseline-guarded** — pre-existing failures are recorded; regressions fail verification.

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

**Commands:** `/forge:status` · `/forge:preflight` · `/forge:build` · `/forge:dashboard`

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
└── docs/
    ├── manual.html        the user manual — setup + greenfield/brownfield
    │                      walkthroughs; open in any browser, give to newcomers
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

## v0 scope notes

Deferred by design (see docs/TRACEABILITY.md for rationale): HTML Control
Center (`forge status` covers observability), per-agent token telemetry,
deep audit, formal eval suite. The original 333-section behavioral spec
remains the design contract; the traceability map is the proof of coverage.
