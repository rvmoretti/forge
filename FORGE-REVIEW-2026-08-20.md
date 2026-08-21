# Forge v0.1.0 — external review & improvement recommendations

**Reviewed:** 2026-08-20, against commit `f325739` (Forge v0.1.0)
**Reviewer:** Claude (Cowork session), reading the repo cold
**Trigger:** comparison against OpenBMB/ChatDev 2.0

**How to use this:** every item is scoped, evidence-backed, and states its blast
radius. Section 0 lists the decisions I treated as settled and did **not**
re-open — check that list first to confirm nothing here overlaps work already
decided. Section 5 is the only place I touch settled ground, and every item
there is explicitly flagged with the decision it revisits and the condition that
would justify re-opening it.

Everything is anchored to symbols (`commands.task › 'start'`), not line numbers,
so it survives edits.

---

## 0. Settled decisions — NOT re-opened

Taken from `docs/TRACEABILITY.md` §"Deliberate design departures" and the
DEFERRED rows. Nothing in sections 1–4 contradicts any of these:

| Decision | Status treated as |
|---|---|
| Knowledge engine replaced by re-derivation (Graphify/Explorer at need) | Settled |
| 333-section spec not loaded at runtime; OPERATING.md is the distillation | Settled |
| Token/usage telemetry deferred (never-fabricate rule) | Settled |
| HTML Control Center deferred; `forge status` covers v0 observability | Settled |
| Deep audit deferred to v0.5 | Settled |
| Formal eval suite deferred to v0.5 | Settled |
| Sequential execution by default; state writes serialized through one CLI | Settled |
| Per-operation approval policy deferred; Claude Code permissions are the gate | Settled |
| `docs-steward` folded into the orchestrator for v0 | Settled |
| Domain packs imported from agency-agents, persona stripped | Settled |
| METHOD.md run verbatim, not "improved" | Settled |

Section 5 revisits exactly two of these, under stated conditions.

---

## 1. P0 — Enforcement gaps (the thesis is at stake)

Forge's entire differentiation is *"the rules that matter are enforced by code,
not prompts."* Four of the six README bullets are currently softer than they
read. These are not feature requests; they are the difference between the claim
being true and being aspirational.

### 1.1 The retry ladder is bypassable

**Claim:** "A third identical retry is rejected — after 2 failed attempts the
CLI forces an explicit escalation."

**Reality:** `commands.task › 'start'` accepts `IN_PROGRESS` as a valid
from-state, and `failedAttempts()` only counts attempts where the orchestrator
*voluntarily* called `forge task fail`. An orchestrator that re-dispatches a
worker without recording the failure never increments the counter and never
trips the gate. The rule is on the honor system — exactly what the design says
it refuses to rely on.

**Fix:**
- Remove `IN_PROGRESS` from the allowed from-states in `start`. Re-starting an
  in-flight item must first resolve it (`fail`, `block`, or `done`).
- Add a dispatch record: `forge task dispatch <id> --agent <name>` (or fold it
  into `start`) so a second dispatch on the same attempt is detectable.
- Treat "started, then started again without an intervening outcome" as a
  failed attempt automatically, with `note: "(no diagnosis recorded — auto-counted)"`.

**Blast radius:** `bin/forge.js` only, plus one line in `OPERATING.md` step 5.

---

### 1.2 Verification can self-certify

**Claim:** "DONE requires a passing verification record."

**Reality:** true, but the record proves less than it appears to. `task verify`
runs the project verify commands plus each criterion's `check` string. The
implementer agent writes the tests those criteria reference. A weak or vacuous
test passes the gate and produces a permanent, genuine-looking verification
record. Nothing in the CLI requires that the check *discriminates* — only that
it exits 0.

`forge-tester` exists as the adversarial counterweight, but its use is a
judgment call in `OPERATING.md`, not a gate.

**Fix (cheap, deterministic, no new agents):** a red-first gate.
- At `task start`, run each criterion check and record the result as
  `preState`. A criterion that already passes before any work is done is
  flagged: either the item is already satisfied, or the check is vacuous.
- `task done` refuses when a criterion passed at `start` *and* at `verify`
  without the item having produced any file change — that check proved nothing.
- Add `forge task verify --independent --by <agent>` provenance so the record
  says who produced the evidence, and let `OPERATING.md` require independence
  for items the orchestrator flags L3+.

**Why this shape:** it uses only exit codes and git state — no model judgment,
no telemetry. It respects the never-fabricate rule.

**Blast radius:** `bin/forge.js` (`start`, `verify`, `done`), work item schema
gains `preState` per criterion, one paragraph in `OPERATING.md`.

---

### 1.3 The baseline guard is prose, not code

**Claim:** "Brownfield changes are baseline-guarded — pre-existing failures are
recorded; regressions fail verification."

**Reality:** `task verify` never calls the baseline. The requirement lives only
in `skills/forge-brownfield/SKILL.md` §5 ("verification for brownfield items
includes `forge baseline check`") — i.e. in a prompt. An orchestrator that
forgets, or a fresh session that never loaded the brownfield skill, gets a
passing verification with an unchecked baseline.

**Fix:** in `task verify`, if `forge/state/baseline.json` exists, run the
baseline comparison as part of the verification and fold the result into the
record as `kind: "baseline"`. A regression makes the verification FAIL, no
prose required. Add `--skip-baseline` with a mandatory `--reason` for the rare
deliberate case (the reason lands in the record).

**Blast radius:** `bin/forge.js` (`verify`, factor `baseline check` into a
reusable function). One line in the brownfield skill can then be deleted rather
than trusted.

---

### 1.4 `docs/TRACEABILITY.md` claims tests that do not exist

**Claim:** row "Acceptance scenarios | 74 | Partially DEFERRED | Gates A–L
covered by CLI/hook tests (**see repo tests**)".

**Reality:** the repository contains no test directory and no test files.
`find` across the whole repo returns only `agents/forge-tester.md` and
`skills/forge-domain-packs/references/testing.md`.

This is the most serious item in the document, and not because of the missing
tests. TRACEABILITY.md exists specifically to be *the audit trail proving
nothing was dropped silently* — a false claim inside the artifact whose entire
job is truthfulness undermines the document's usefulness as evidence.

**Fix, in this order:**
1. Correct the row today: `DEFERRED` with no test reference.
2. Write the CLI refusal tests. These are **not** the deferred formal eval suite
   (that concerns agent behavior); they are unit tests of deterministic Node
   code and cost an hour. Minimum set — one per advertised refusal:
   - `start` refuses with no criteria
   - `start` refuses with unmet deps
   - `start` refuses on the 3rd attempt without `--escalate`
   - `verify` refuses when nothing executable exists
   - `done` refuses without a passing verification record
   - `done` refuses when the last verification failed
   - `cancel` refuses a DONE item; refuses without `--reason`
   - `pretooluse` hook exits 2 for `forge/state/*` and `forge/config.json`
   - `stop` hook exits 2 with an IN_PROGRESS item, exits 0 when `stop_hook_active`
3. Only then restore a test reference to TRACEABILITY.md.

**Blast radius:** new `tests/` dir, `node --test` (built in, no dependency), one
doc row.

---

## 2. P1 — Functional dead-ends

### 2.1 `--escalate revisit-criteria` is unimplementable

`task start --escalate <stronger-model|decompose|self|revisit-criteria>` offers
`revisit-criteria` as an escalation strategy. There is no CLI path to revise
criteria: `task add` explicitly refuses to act as an update ("add is not an
update"), there is no `task update`, and the PreToolUse hook blocks editing
`work.json` directly. The orchestrator is offered a strategy the tooling forbids
it from executing.

**Fix:** add `forge task update <id>` supporting `--title`, `--objective`,
`--deps`, `--allowed`, `--forbidden`, `--criterion-add`, `--criterion-remove
<index>`, each mutation appended to the item's history with a `--reason`.
Criteria changes on an item with prior attempts should require `--reason` so the
audit trail shows the goalposts moved and why.

---

### 2.2 A cancelled dependency permanently bricks its dependents

`depsSatisfied()` treats a dep as satisfied only when its status is `DONE`.
Cancel a work item and every downstream item is unstartable forever — and with
no `task update` (2.1) there is no way to drop the stale dep. The only escape is
cancelling and re-adding the whole downstream subgraph under new ids, losing its
history.

**Fix:** on `task cancel`, list dependents and require the orchestrator to
resolve each (`--reason` recorded): drop the dep, re-point it, or cancel too.
Alternatively treat `CANCELLED` as satisfied-with-warning — but explicit
resolution is more in keeping with the rest of the design.

---

### 2.3 `opt()` swallows the next flag when a value is omitted

`opt('escalate')` returns `argv[i+1]` unconditionally. `forge task start T1
--escalate --note "why"` records the escalation strategy as the literal string
`--note`. Silent corruption of an audit record that exists to prove a real
escalation happened.

**Fix:** `opt()` returns `null` when the next token starts with `--`; commands
that require a value die with usage. Two lines.

---

### 2.4 The `forge` command doesn't exist

`OPERATING.md`, all three skills, and every command file instruct the agent to
run `forge task add …`, `forge status`, `forge baseline capture`. Nothing
installs a `forge` binary. Only the session-start hook mentions the real
invocation, once, as a `FORGE_CLI:` line the agent must remember to translate on
every call. Predictable failure mode: `command not found`, then improvisation.

**Fix (pick one):**
- Ship `bin/forge` as an executable shim and document adding it to PATH; or
- make the session-start line explicit and imperative: *"Wherever this contract
  says `forge X`, the actual command is `node "<abs path>" X`, run from the
  project root"*; or
- rewrite the docs to use the full invocation.

The middle option is cheapest and needs no install step.

---

## 3. P2 — Integrity hardening

### 3.1 A verification record is not bound to the code it verified

`task done` checks only `lastVerification().passed`. Nothing ties that record to
a tree state. Verify green → make further edits → `task done` succeeds on stale
evidence. Not malice; ordinary drift over a long item.

**Fix:** record `git rev-parse HEAD` plus a hash of `git status --porcelain` at
verify time. `done` refuses when the current tree state differs, with:
*"the tree changed since the passing verification — re-verify."* Deterministic,
uses git which preflight already makes mandatory.

### 3.2 The Stop gate has a blind spot

The stop hook only catches `IN_PROGRESS`. An item that was `fail`ed (status
reverts to `TODO`) with attempts near the escalation threshold ends the session
looking like ordinary pending work. The README promises "sessions can't end with
silently dangling work"; a twice-failed item is the definition of dangling.

**Fix:** the stop gate also reports TODO items with ≥1 failed attempt, requiring
the agent to state their disposition in the closing summary (report only, not a
hard refusal — the item genuinely may be legitimately queued).

### 3.3 `work.json` grows without bound

Every verification stores a 40-line `tail` per command per run. A 60-item
project with retries produces a large single JSON file that is read and rewritten
on every CLI call, and it is the file the session-start digest is derived from.

**Fix:** keep the last N (3) verification records inline with full tails; older
ones collapse to `{ts, passed, kinds}`. Or move tails to
`forge/state/evidence/<id>-<ts>.log` and store paths.

### 3.4 Baseline comparison can silently change meaning

`baseline check` runs `cfg.verify[b.kind] || b.cmd` — if a verify command was
edited after the baseline was captured, it compares new-command results against
old-command results and calls it a regression check.

**Fix:** store the command string in the baseline (already done) and warn loudly
when it no longer matches config, offering `baseline recapture --reason`.

---

## 4. P3 — Papercuts

- **`readJson` on a corrupt `work.json` calls `die()` from inside a hook.** The
  session-start hook then emits a hard error at session open. Confirm the
  failure mode is a legible instruction rather than a stack trace.
- **`init` never advances `phase`.** Only the METHOD skill sets `phase build`
  (as a prompt instruction). A brownfield project that skips the spec phase can
  sit in `phase: spec` forever, where preflight declares verify commands "not
  required yet" — quietly disabling the very gate brownfield work depends on.
  The brownfield skill should set `phase build` as a required step, or
  `baseline capture` should set it.
- **README/plugin README are byte-identical duplicates.** Fine today; they will
  drift. Symlink, or make the plugin README the short one.
- **`preflight` never checks Node ≥ 18** though the README requires it.
- **`.gitignore` is 42 bytes** — confirm it covers `forge/state/*.tmp` for
  projects that install the plugin and commit their forge state.

---

## 5. Revisits that DO touch settled decisions

Flagged explicitly. Neither is a v0 recommendation — both are triggers to watch
for, so the decision gets re-opened on evidence rather than drift.

### 5.1 Sequential execution (settled: "Sequential by default")

**What ChatDev has:** MacNet — agents arranged as a DAG, scaling past 1000
agents without a context ceiling; and *Evolving Orchestration* (NeurIPS 2025), a
learnable orchestrator that optimizes topology rather than hand-drawing it.

**The observation:** `work.json` already stores a real dependency graph, and
`task list` already computes READY. The information needed for parallel dispatch
exists; only the loop is sequential. The original rationale — serializing state
writes through one CLI — is about *write safety*, which is not the same
constraint as *dispatch concurrency*. Two independent READY items could be
dispatched in parallel with their `task start` / `task verify` calls still
strictly serialized through the CLI.

**Trigger to re-open:** a project where wall-clock is dominated by independent
leaf items. Until then, sequential is right: it keeps the orchestrator's review
step meaningful, and review is where Forge's quality actually comes from.

**If re-opened, the real risk isn't races** — it's that parallel workers touching
overlapping dependency closures produce merge conflicts the orchestrator has to
untangle. Scope-derived `allowed` globs are already the mechanism that would
prevent it; they'd need to become disjointness-checked rather than advisory.

### 5.2 Cross-project experience (adjacent to: "knowledge caches rot")

**What ChatDev has:** Experiential Co-Learning and Iterative Experience
Refinement — experience accumulating *across runs*, not just within one.

**The gap:** Forge's `discoveries.md` and `decisions.md` are per-project and die
with the repo. Nothing learned on project A reaches project B except METHOD.md
itself. Every new project starts Forge at zero.

**Why this doesn't simply contradict departure #1:** that decision concerns
caching *reality* (what the code does) — correctly rejected, because code
changes and caches rot. Cross-project learning would cache *method* (which
briefs failed, which criterion shapes turn out vacuous, which escalation
strategies actually resolved failures). Method doesn't rot the same way, and it
is not re-derivable from any codebase.

**Minimum honest form, if pursued:** an append-only, human-curated corpus that
is explicitly *never authoritative* — advisory input to brief construction only,
with the same OBSERVED/INFERRED discipline the Explorer already uses. Anything
auto-summarized by a model re-creates exactly the rot the original decision
rejected.

**Trigger to re-open:** the same class of failure diagnosed for the third time
across different projects.

---

## Appendix — as forge work items

Dogfooding. Ids are suggestions; criteria are starting points, not final.

```
forge task add --id F1 --title "CLI refusal test suite" \
  --objective "node --test coverage for every advertised CLI refusal and both blocking hooks" \
  --criterion "all refusal tests pass::node --test tests/" \
  --allowed "tests/**,package.json"

forge task add --id F2 --title "Correct the TRACEABILITY test claim" --deps F1 \
  --objective "Row 'Acceptance scenarios' must not reference tests until F1 lands" \
  --criterion "no stale test reference::! grep -q 'see repo tests' plugins/forge/docs/TRACEABILITY.md"

forge task add --id F3 --title "Close the retry-ladder bypass" --deps F1 \
  --objective "start refuses from IN_PROGRESS; re-dispatch without an outcome auto-counts as a failed attempt" \
  --criterion "start from IN_PROGRESS is refused::node --test tests/retry.test.js"

forge task add --id F4 --title "Fold baseline check into task verify" --deps F1 \
  --objective "verify runs the baseline comparison when a baseline exists; regression fails the record" \
  --criterion "regression fails verify::node --test tests/baseline.test.js"

forge task add --id F5 --title "Red-first criterion gate" --deps F1 \
  --objective "record criterion preState at start; refuse done when a check proved nothing" \
  --criterion "vacuous criterion is refused at done::node --test tests/redfirst.test.js"

forge task add --id F6 --title "forge task update" --deps F1 \
  --objective "make --escalate revisit-criteria executable; unbrick cancelled-dependency subgraphs" \
  --criterion "criteria can be revised with a recorded reason::node --test tests/update.test.js"

forge task add --id F7 --title "Bind verification records to tree state" --deps F1 \
  --objective "verify records git HEAD + dirty hash; done refuses on stale evidence" \
  --criterion "done refuses after post-verify edits::node --test tests/freshness.test.js"

forge task add --id F8 --title "opt() value validation + forge invocation clarity" --deps F1 \
  --objective "opt returns null before a --flag; session-start states the real command form imperatively" \
  --criterion "omitted flag value does not swallow the next flag::node --test tests/argv.test.js"
```

**Suggested order:** F1 → F2 → (F3, F4 in parallel if 5.1 is ever revisited;
sequential otherwise) → F5 → F6 → F7 → F8.

F1 first is not ceremony: sections 1.1–1.3 all change refusal logic, and there
is currently nothing that would catch a regression in it. Forge should not be
the only project Forge doesn't apply to.
