---
description: Regenerate the Forge dashboard (forge/dashboard.html) from current state
---

Regenerate the Forge dashboard from the project root:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/forge.js" dashboard
```

Then tell the user where it is (`forge/dashboard.html`) and that they can open it in a browser — it also auto-regenerates after every state change, so reloading the browser tab is always current. It is a generated projection: never edit it, never treat it as the source of truth.
