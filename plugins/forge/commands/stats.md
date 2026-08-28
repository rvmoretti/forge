---
description: Report process metrics derived from the work graph — first-pass rate, retries, escalations, elapsed times, milestone health
---

Run the Forge stats report from the project root:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/forge.js" stats
```

Relay it faithfully — it is derived arithmetic from `forge/state/work.json`,
never an estimate. Highlight what is actionable:

1. **First-pass rate** falling over time means briefs or criteria are
   degrading — look at the most-retried items for the pattern.
2. **Escalations** clustered in one area usually mean the work is decomposed
   wrong or the cheaper tier isn't reliable for that kind of task.
3. **Milestone health** shows where a gate is waiting on the human.

Elapsed times are wall-clock spans between state transitions — they include
review, gates, and idle time, so present them as elapsed, never as effort.
Token/dispatch telemetry is `/forge:usage`, not this report.
