---
description: Report observed token usage, delegation split, and dispatch accounting from the local session logs
---

Run the Forge usage report from the project root:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/forge.js" usage
```

Relay the report to the user faithfully — it is observed data from the local
Claude Code session logs, never an estimate. Highlight, in order:

1. **Delegation split** — orchestrator vs worker tokens by model. If it says
   UNAVAILABLE, say so and explain why (this Claude Code version stores worker
   transcripts where the report can't find them), don't substitute a guess.
2. **Dispatch accounting** — how many dispatches went through the forge roster
   vs bypassed it, and which briefs tie to which work items.
3. **Drift** — output tokens spent since the last forge state change. If this
   is large, flag it plainly: tokens are burning while the work graph is
   frozen, which usually means work is happening outside the loop.
4. **Per task, grouped** (v0.22) — calls and context per done task by Forge
   version, orchestrator model and milestone, with first-pass beside each. A
   group flagged with two orchestrator models cannot be compared; say so.
5. **Per milestone** (v0.22.2) — the dashboard's Usage page has a scope
   selector (whole project or one milestone) for the token table and the
   per-item strip. Point the user there rather than reading figures aloud; the
   calls made between tasks are shown beside the selector and belong to no
   milestone.

Do not editorialize beyond that. If the user wants the raw report, they can
run the same command in any terminal — it costs zero tokens.
