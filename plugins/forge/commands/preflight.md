---
description: Run Forge preflight (git, verification commands, Graphify, Playwright)
---

Run Forge preflight from the project root:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/forge.js" preflight
```

Use `--full` if the user asked for a thorough check (this actually executes the project's verify commands, which can take minutes).

Then:
- If any check reports `ASK_USER`, ask the user the recorded question (e.g. install Graphify or proceed without) using a clear either/or, and record their answer with `forge config set options.graphify use|skip`.
- If a mandatory check failed, explain precisely what is missing and how to fix it. Build work stays blocked until it passes.
- If everything passed, say so in one line and continue with whatever the user wanted.
