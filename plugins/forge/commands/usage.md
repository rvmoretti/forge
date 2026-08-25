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

Do not editorialize beyond that. If the user wants the raw report, they can
run the same command in any terminal — it costs zero tokens.
