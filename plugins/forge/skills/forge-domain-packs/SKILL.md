---
name: forge-domain-packs
description: Domain expertise packs for Forge briefs. Use when constructing a work brief for a specific domain — backend/API work, frontend/UI work, testing, or anything security-sensitive — to inject the matching checklist into the brief and lift the reliability floor of cheaper worker models.
---

# Forge domain packs

Curated engineering checklists, distilled from the agency-agents library
(msitarzewski/agency-agents, imported 2026-08; persona layers stripped, kept:
the discipline). Use them two ways:

1. **Brief enrichment** — when a work item touches a domain, copy the
   matching pack's checklist into the brief under "Domain rules". Items that
   are testable should also become acceptance criteria on the work item.
2. **Review lenses** — for L3+/risky items, tell `forge-reviewer` which
   pack(s) to review against.

Packs (in `references/`):

- `backend.md` — APIs, services, data, external calls (reliability + data discipline)
- `frontend.md` — UI implementation (accessibility, performance, states)
- `design-ux.md` — whether the UI is GOOD from a human's point of view: hierarchy,
  the five states, forms, feedback, mobile, language — plus the fresh-context
  UX review protocol (screenshot vs approved mock)
- `testing.md` — test authoring standards (determinism, isolation, pyramid)
- `security.md` — the AI-generated-code failure modes (secrets, authz, injection)

Match by the work item's touched surface, not its title. An "add export
button" item that adds an endpoint gets `backend.md` + `frontend.md`.
Anything touching auth, secrets, payments, or user data ALWAYS gets
`security.md`.
