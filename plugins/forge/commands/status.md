---
description: Show the Forge project status (work graph, blockers, preflight, discoveries)
---

Run the Forge status command from the project root and present the result to the user in a clear, readable form:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/forge.js" status
```

If anything needs the user's attention (blocked items, pending ASK_USER preflight decisions, failed attempts near escalation), call it out explicitly at the top of your summary.
