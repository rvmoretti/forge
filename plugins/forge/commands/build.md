---
description: Start or resume the Forge build loop (work through READY items)
---

Enter the Forge build loop as defined in your operating contract:

1. Run `node "${CLAUDE_PLUGIN_ROOT}/bin/forge.js" status` and `... task list` to see the current work graph.
2. If preflight was never run or is stale, run it first.
3. If this is a brownfield project and no baseline exists, capture it (`forge baseline capture`) before any change.
4. Work through READY items one at a time: start → brief → dispatch to the appropriate worker agent → verify → review → done or fail-with-diagnosis. Follow the retry/escalation ladder.
5. Interrupt the user only for: a product decision (spec hole), a high-risk approval, or a milestone review.

$ARGUMENTS may name a specific work item or milestone to focus on; otherwise pick by dependency order.
