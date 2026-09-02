# Design & UX pack

Judgment rules for anything a product's user sees. This pack rides along
with `frontend.md` (which covers implementation mechanics — a11y attributes,
performance, states as code); this one covers whether the result is GOOD
from a human's point of view. Use it in briefs for screen work and as the
review lens for the fresh-context UX review.

## Layout & hierarchy

- One primary action per screen, visually dominant; secondary actions
  visibly subordinate. If two things compete for "primary", the design is
  undecided — flag it, don't average it.
- Reading order = importance order. The user's first fixation should land on
  the thing the screen exists for.
- Spacing communicates grouping: related controls closer than unrelated
  ones. Never rely on borders alone.
- Alignment to a grid; mixed alignments on one screen need a reason.

## States are the design (the happy path is the easy 20%)

Every screen ships all five, designed rather than defaulted:

- **Empty** — teaches what belongs here and offers the first action; never a
  blank region.
- **Loading** — skeletons or spinners sized to the content they replace; no
  layout jump when content lands.
- **Error** — says what failed, in the user's language, with the next step.
  Never a raw code or a dead end.
- **Partial** — long lists paginate/virtualize; slow sections load
  independently rather than blocking the screen.
- **Success** — a state change the user caused is visibly confirmed where
  they caused it.

## Forms & input

- Label every field (placeholder text is not a label); mark what's optional
  rather than what's required when most fields are required.
- Validate at the field on blur, at the form on submit; error messages name
  the fix, not the rule.
- Preserve user input across errors — losing typed data is a severity-1 UX
  bug.
- Sensible input types and autocomplete attributes (mobile keyboards follow
  from these).

## Feedback & motion

- Every tap/click acknowledges within 100ms (state change, ripple, spinner).
- Destructive actions confirm — proportionally: inline undo beats a modal
  for reversible things; a modal with the consequence spelled out for
  irreversible ones.
- Motion explains causality (where a thing came from / went); decorative
  motion is a cost, not a feature.

## Mobile

- Design at 360px width first or verify at it before calling a screen done;
  no horizontal page scroll, ever.
- Touch targets ≥ 44px with breathing room; thumb-reachable primary actions
  on tall screens.

## Language

- Buttons say what they do ("Save changes", not "OK"); titles say what the
  screen is, not the app's internal name for it.
- The product speaks the user's domain language, consistently — the same
  concept never has two names in the UI.

## Review protocol (fresh-context UX review of a screen)

Given the screenshot and the approved mock:

1. Does the implemented screen serve the mock's intent — hierarchy, grouping,
   primary action — not just its pixels? Wireframe-fidelity mocks bind
   intent; high-fidelity mocks bind layout too.
2. Walk the five states. Any state that is defaulted (blank empty state, raw
   error) is a finding.
3. Walk the checklist above; report findings ranked: blocks-usage >
   misleads-user > polish. Style nits are capped at three.
