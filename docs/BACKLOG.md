# Forge backlog — queued for the next release

Not yet implemented. Everything here is deliberately held until the current
measurement window closes: v0.16.0 is being measured on a live project against a
recorded `forge usage --baseline`, and shipping a new plugin version mid-milestone
contaminates the only clean before/after comparison available. Docs-only changes
are safe; anything that changes CLI behaviour waits for the gate.

---

## 0. Standing rule: this repository is public and carries no real project data

Forge is MIT and public. Nothing in it may name, describe, or show data from any
project it has been used on — not in code comments, not in docs, not in the
changelog, not in screenshots, not in test fixtures.

- **Field evidence stays, attribution goes.** "a 21-item project", "an 87-item
  project", "a field case" — the measurement is what justifies each rule and is
  worth keeping; the project's identity adds nothing and is not ours to publish.
- **Every example and screenshot uses a fictional project.** The canonical one is
  **ACME** (see §1) — invented product, invented items, invented numbers that are
  plausible rather than copied.
- **Check before every release**: `git grep -I -i -e "<project names>"` across the
  repo, including changelog entries and image files. Images leak more than prose —
  a screenshot carries paths, component names, item titles and commit messages.
- The author's own name and repository URL (LICENSE, `marketplace.json`,
  `plugin.json`, the install line) are intentional and stay.

This rule exists because real project names did reach code comments, the
changelog and the traceability matrix across several releases before being
scrubbed. Assume it will happen again unless checked.

---

## 1. The ACME demo project — one fixture, used everywhere

Build a single throwaway project that generates a realistic dashboard, and use it
for every screenshot, every doc example, and any future demo. It is invented from
end to end.

**Suggested shape** — plausible enough to be legible, small enough to maintain:

- Project: **ACME Field Service** — scheduling and dispatch for maintenance crews.
- Components: `WorkOrders` (backend), `Scheduler` (backend), `CrewApp`
  (frontend), `CustomerPortal` (frontend), `Billing` (integration),
  `NightlySync` (job), `Warehouse` (db).
- Milestones: `M0 Foundation` (approved), `M1 Work orders` (complete, awaiting
  approval — this is what makes the needs-you banner and the gate pill visible),
  `M2 Scheduling`, `M3 Crew app`, `M4 Billing`, `M5 Launch`.
- ~40 items so the graph looks real: a spread of DONE, one IN_PROGRESS with a
  live elapsed timer, one BLOCKED on a product decision, a few READY, and thin
  items in later milestones. One item with a saved brief, one screen item with a
  mock plus a build capture so the design strip renders.
- Invented decisions and discoveries so the journal timeline shows both a human
  and a Forge authority marker.
- A synthetic `usage.json` / `usage-baseline.json` with plausible telemetry so
  the efficiency strip and the since-baseline delta both render.

**Where it lives.** `examples/acme/` with a `build.sh` that creates the project
from scratch with `forge` commands only — so the fixture is reproducible, stays
valid as the CLI changes, and is itself a worked example of setting a project up.
Generated artefacts are gitignored; only the script and the rendered screenshots
are committed.

---

## 2. Show the dashboard in the README

**Why.** The README explains what Forge refuses and why, but never shows what
running a project under it actually looks like. The dashboard is the artefact
that makes the method legible to someone who has never used it — the whole
project on one page: every milestone, every item, who was dispatched, what was
verified, what it cost. A reader deciding whether to install should see that
before reading a claims list.

**What to add**, near the top of `README.md`, after the one-line description and
before "What makes it different":

- A full-page screenshot of the ACME dashboard. Full page, not a crop: the point
  is the whole project on one surface.
- A second, tighter shot of one ACME work item with its drawer open — criteria
  with pass marks, dispatches, scope, evidence, the design strip. That is the
  "evidence, not claims" argument in one picture.
- A caption of two or three sentences, not a feature list: this page is generated
  from `forge/state/` on every state change, nobody edits it, and it is what the
  product owner reads instead of asking for a status update. Say plainly that the
  project shown is fictional.

**Mechanics.** Store under `docs/img/`. Render with Playwright at 1440px wide,
deviceScaleFactor 2, `fullPage: true`. Keep each image under ~600KB so the clone
stays small. Reference with relative paths so they render on GitHub. Before
committing any image, open it and read it — a screenshot is the easiest way to
leak a path, a branch name or an item title.

**Also worth linking** from the same place: `plugins/forge/docs/architecture.html`
and the dashboard guide below.

---

## 3. A practical dashboard manual — how to actually use it

**Why.** The dashboard is documented as a *description* ("this section shows X")
across `manual.md` and `manual.html`. A user staring at it still does not know
what to DO with it. It should read as a working instrument: a question the user
actually has, the exact place on the page that answers it, and the command that
acts on the answer.

Field evidence that this is missing: a project sat frozen with zero READY items
because a milestone gate was unapproved. Everything needed to see that was
already on the dashboard — the awaiting-approval pill, the needs-you banner, the
zero in the READY tile — and it still took a CLI round trip to diagnose.

**Shape.** A new task-oriented guide, `plugins/forge/docs/dashboard-guide.md`,
mirrored into `manual.html` as its own section, and linked from the dashboard
itself (a "how to use this page" link in the sidebar footer). Written for a
non-technical product owner — the same audience the guided experience targets.
Every screenshot in it is ACME.

**Contents — one entry per real question, in this order:**

1. **"What needs me right now?"** — the needs-you banner is the answer, always;
   it is computed, not written. The `Needs me` quick filter lists the items
   behind it. Nothing in the banner means nothing is waiting on you.
2. **"Is anything actually running?"** — IN PROGRESS tile, and the item rows with
   a live elapsed timer. The timer ticks in the browser, so an open tab stays
   truthful.
3. **"Why is nothing moving?"** — the diagnosis tree, and the most valuable entry
   in the guide: zero READY means either a gate is awaiting your approval (look
   for AWAITING HUMAN APPROVAL on a milestone), or the remaining items are thin
   (no criteria/scope yet — the card says "thin item"), or they are blocked (red
   stripe, reason on the row). Each branch gets the command that unblocks it.
4. **"What was this worker actually told?"** — the 📄 brief chip opens the brief
   as it was handed over. Use it when an item came back wrong: the answer is
   usually in the brief, not the code.
5. **"Does what got built match what I approved?"** — the design strip, mock
   beside latest capture. What "mock approved" binds (hierarchy, grouping,
   primary action) and what it does not (pixels).
6. **"When will this be done?"** — the pace strip, and an honest statement of what
   the projection is: p25–p75 of YOUR observed item times, recomputed on every
   change, never a promise; the gates-left figure is the part that depends on how
   fast you review.
7. **"Is this costing too much?"** — the efficiency strip. Context re-read per
   item is the number that tracks a subscription quota; calls per worker dispatch
   is the number that tracks whether briefs are good. A dispatch far past the
   median was exploring, not building.
8. **"What has been decided, and what did we learn?"** — the journal, and why the
   you/forge marker matters: a decision you made binds the product, one Forge
   made is an engineering choice you can overturn.
9. **"What is the shape of the whole project?"** — the milestone rail and the
   project map, and the rule that nothing planned lives outside the graph.
10. **"Something looks stale or wrong"** — the system section, the age stamps,
    what refreshes itself and what does not, and `forge doctor`.

**Plus two walkthroughs:**

- *First five minutes* — open the file, read the banner, follow it to the one
  thing that needs you, act, reload.
- *The daily loop* — what to check when you sit down, what to check at a gate,
  and the three moments Forge will interrupt you (a product decision, a high-risk
  approval, a milestone review) so the user knows silence is normal.

**Constraint.** Every entry names the exact on-page element and the exact command,
and stays honest about what a number cannot tell you. No feature tours.

---

## 4. Mocks must be images — three defects that let HTML mocks in silently

Found in the field: a project ended up with HTML mockups in `spec/mocks/`, which
the dashboard then rendered as broken images. The user followed the skill
correctly; Forge accepted the wrong thing at three separate points.

- **The skills specify an open extension.** `forge-method` §7, `forge-brownfield`
  §7.5 and `forge-roadmap-review` §4 all say `spec/mocks/<screen>.<ext>`. Design
  tools (Claude Design, canvas) naturally emit HTML, so HTML mocks are the
  *expected* outcome of following the instruction as written. Change every one to
  `spec/mocks/<screen>.png`, and say plainly: the approved mock is an image,
  because it is compared side by side with a screenshot of the built screen. If
  the design was authored in HTML, render it to PNG and keep the source in
  `spec/mocks/src/` if it is worth keeping.
- **`task add --mock` / `task update --mock` validate nothing.** The value is
  stored verbatim (`mock: opt('mock') || null`). Refuse a non-image extension,
  and warn when the path does not exist yet, with the render command in the
  refusal text.
- **The dashboard renders any existing file as `<img>`.** `mockOk` is a bare
  `fs.existsSync`, while the capture side already filters on
  `/\.(png|jpe?g|webp|gif|svg)$/i`. The asymmetry is an oversight. Apply the same
  filter to the mock, and for legacy non-image records show an honest "the
  recorded mock is not an image — <path>" state with the fix, never a broken
  image.

Also worth a line in the mock-fidelity criterion guidance: the reviewer compares
a screenshot against an image. Handing them an HTML file to render themselves is
extra work and makes two reviewers compare differently.

---

## 5. The mock flow must respect a generated `spec/mocks/`

`forge-roadmap-review` §4 says to save each mockup "into `spec/mocks/<screen>.<ext>`
(overwrite = new version)". On a project where `spec/mocks/` is **generated** from
a design source, that instruction is actively harmful: a hand-written file there
is silently overwritten by the next render, so a recorded "Mock approved" points
at a file the pipeline will replace, and the approval reverts without anyone
noticing.

Observed in the field: a project whose `spec/mocks/*.png` are rendered from
committed HTML artboards by a two-step build, with a project rule that an
artboard edit, both builders and the render all land in the same commit.
Following the skill literally would have broken that rule on the first edit.

Fix:

- Before writing any mock, the skill checks whether `spec/mocks/` is generated —
  a build script referencing it, a `README` in the mock source directory, a
  recorded decision saying so, or the directory being gitignored. If it is, the
  skill edits the **source** and runs the project's documented render, never the
  output directory.
- When it cannot tell, it asks rather than writing. One question is cheaper than
  an approval that quietly reverts.
- The same check belongs in `forge-method` §7 and `forge-brownfield` §7.5.
- Worth surfacing in the dashboard too: if an item's `--mock` path sits under a
  directory the project generates, say so on the design strip, so an approval
  against a generated file is visible rather than assumed.

---

## 6. Fix the drift flag (found in the field)

`forge usage` reports "output tokens spent since the last state change" and flags
it as significant spend with no state movement. Two defects, both observed:

- **It counts the measuring session's own tokens.** Four consecutive read-only
  runs grew the figure by ~5,900 tokens purely by reporting on themselves.
  Exclude the current session's transcript from the drift window.
- **It cannot tell a frozen queue from off-loop work.** When READY is 0 and
  IN_PROGRESS is 0, the honest message is "the queue is empty — a gate is waiting
  for you / the remaining items are thin", not an accusation that work is
  happening outside the loop. Read the work graph before choosing the wording.

---

# Performance programme (v0.17 candidates)

Source: an external measured analysis of one 28-item project (session transcripts,
`work.json`, `usage.json`, v0.16.0 source), reviewed against the repository and
the project's own state on 19 Sep. Ten candidates were proposed; this section
records which are accepted, which are re-scoped, and which are rejected, with the
evidence that decided each.

## P0. What the measurement actually established

**v0.16 works, and by less than was predicted.** Seven items completed since the
recorded baseline: **calls per item −26%, context per item −38%, output per item
−18%.** The prediction at the time was −40/−50%. Direction confirmed, magnitude
overstated — say so in the changelog rather than quoting the prediction.

**Cost is superlinear in call count.** Window grows monotonically inside a
session (measured 92k → 875k across 783 calls in one 42-hour session), and every
call re-reads everything before it, so a removed call is paid back once directly
and again on every later call. A linear model predicts −26% context from −26%
calls; the measurement was −38%. **Removing orchestrator calls is the ranking
criterion for everything below.**

**Three claims in the source analysis did not survive checking. They are recorded
here because they change what is worth building:**

1. *"Half the orchestrator's shell work is running its own state machine"* —
   inflated. Project-wide `trace.jsonl` shows the command mix is dominated by
   one-time graph construction (`task add` ×171, `component add` ×127,
   `decision` ×198), not per-item loop overhead. The per-item loop is roughly
   **9 CLI calls per item** (`start`, `dispatch`, `verify`, `done`, plus
   `show`/`list`/`status` reads). A composed `forge next` can remove perhaps 3–4
   of those 9. Real, but a fraction of the headline.
2. *"Half of dispatches aren't reaching state"* — right number, wrong cause. Logs
   show 63 dispatches, state records 33; the missing ~30 are **explorer,
   reviewer and architect** dispatches. `task dispatch` refuses anything that is
   not an IN_PROGRESS item, so a dispatch that answers a question or reviews a
   milestone diff *has no item to attach to and cannot be recorded*. This is a
   design gap, not a discipline gap, and the fix is a record that does not
   require an item.
3. *"Worktrees unblock parallel verify"* — blocked, and worse than the analysis
   feared. The project's `verify` config runs `db: npm run test:db` and
   `e2e: npm run test:e2e` **on every item's verification**. Worktrees isolate the
   filesystem; every verify still hits one shared database. The relevant figure is
   not "18% of items touch migrations" but "100% of verifies touch the database".

## P1. Build first — all three verified buildable against v0.16 source

### P1.1 Make the session boundary enforced, not advisory

v0.16 added the gate-as-session-boundary as instruction text. Context is
append-only and no operation removes a tool result from a transcript, so ending
the session is the **only** mechanism Forge has to reset the window — too
important to leave as advice.

Verified: `forge/state/session.json` already carries `sessionId`, written by the
PreToolUse hook from `input.session_id` on every file write, so a plain CLI call
can read the current session. `task start` already refuses later-milestone items
via `milestoneGateBlock` — this is an added condition at an existing refusal
point, not new machinery.

- `milestone approve` records the approving session id in the gate record.
- `task start` refuses an item from a later milestone when the live session id
  equals the one that approved the previous gate. Message says why, and names the
  override (`--same-session --reason "..."`, recorded).
- Verify with: sessions per milestone, and peak per-call context.

### P1.2 Dispatch the step-4 review by default

The contract already prescribes a fresh-context reviewer for high-risk diffs and
gives the reason ("you briefed this work, so your own read is colored by the
assumptions that produced it"). Logs show 13 reviewer dispatches against 32
implementer dispatches — most reviews are still absorbed.

Token arithmetic alone is roughly a wash. The superlinear effect is what decides
it: the reviewer's tokens are spent in a window that is thrown away, the
orchestrator's in the window every later call re-reads.

- `options.delegateReview` defaults **true**; the orchestrator reads the diff
  itself only when the reviewer's verdict is ambiguous or evidence conflicts.
- Contract step 4 inverts to match, with the absorb case named as the exception.

### P1.3 Record dispatches that have no work item

Until this lands, the agent mix in state is unreliable and every later comparison
rests on log scans that can only be re-derived, never audited.

- `forge dispatch --agent <worker> --purpose <explore|review|security|advise>
  [--item <id>] [--note]` writes to a project-level dispatch log in state.
- `task dispatch` stays as the item-bound form and keeps its refusal.
- `usage` and the dashboard read both, so "agent mix" stops understating by ~half.

## P2. Measure first, then build

### P2.1 Compose the per-item loop (`forge next`)

Re-scoped from the source analysis. Worth doing, but sized against 9 CLI calls
per item, not 52% of all shell work.

- Before designing: classify the inline `python3 <<EOF` heredocs in a live
  transcript. Each is a query someone needed and could not express as a command —
  **they are the specification for what the CLI is missing.** This could not be
  checked from the repository; it needs a session transcript.
- `forge next` returns one packet: current state, the next READY item with
  dependencies resolved, its recorded scope, the brief path, and the exact next
  commands. It must replace three or more calls to be worth its larger size.
- Once the missing queries exist as subcommands, a hook can refuse inline
  interpreters in the orchestrator, the way `dispatch --agent` is enforced today.

### P2.2 Gate packet assembled on the last item, not on the human's arrival

Measured gap on one gate: last item DONE to security pass **≈23 hours**, against
a median item time of 24 minutes. Gate latency is plausibly the largest term in
calendar duration — but the timestamps cannot separate "waiting for the human"
from "assembly not started".

- **Instrument before building**: record `gatePacketReadyAt` when the last item of
  a milestone closes, alongside the existing approval timestamp. One release of
  data settles whether the 23 hours is preparation or availability.
- If it is preparation: on the last item going DONE, emit the cumulative diff
  range, the security dispatch prompt, the demo criterion, and a spec-delta
  summary, so the human arrives at a finished packet.

### P2.3 Computed concurrency, with a lower ceiling than the graph suggests

Dependency width per milestone runs 2–15 against a fixed cap of 3, so the cap is
a constant where the data supports a computed value. Two limits, both real:

- Shared-surface classification is judgment today ("when in doubt, it is shared
  surface"). `auto` must derive what it can from scope globs (migrations,
  manifests, lockfiles, generated code, spec) and stay conservative otherwise.
- **Verify is serial and stays serial** — every verification runs the db and e2e
  suites against one database. Auto-concurrency widens the *build* phase only;
  the ceiling is well below dependency width. Expect roughly 2×, not 5×.

## P3. Rejected for now, with the condition that would change it

- **Worktrees per lane.** Blocked by the shared database, not by the filesystem.
  Revisit only alongside a per-lane database; until then it buys little and costs
  a lot. Condition to revisit: a project whose verify has no shared external state.
- **Multiple orchestrators.** Depends on worktrees, and triples the expensive
  thing — three windows each on their own growth curve. Also a merge problem on
  the spec, which build-loop step 5 has every item updating. Do it when a lane is
  cheap, not before.
- **Smaller work items.** Correct instinct, wrong order. Orchestrator cost per
  item is roughly fixed, so halving item size doubles the fixed cost while worker
  cost stays flat — net worse until P2.1 lands. Note also that decomposition
  *shape* matters more than size: one observed milestone split into 27 items ten
  levels deep, which removed parallelism while adding overhead.
- **API workers / a faster worker model.** Config, not code — the lane shipped in
  v0.15 and has never been switched on. Worth a deliberate trial on a throwaway
  item before real work, and only with a provider that offers prompt caching (the
  workload re-reads ~172k per worker call). Not a v0.17 build item.

## P4. Definitions to fix before the next comparison

- **One rate, named once.** "First-pass" means 93% under one definition and 57%
  under the stricter one now called clean-run. Fix which one headlines a
  comparison before running it, not after.
- **Noise floor.** At 28 items, ±1 item is ±3.5 points. Do not read small
  movements as signal, in either direction.
