# Frontend domain pack

Include in briefs for UI implementation work.

## States (from the experience spec — all of them, always)
- Every screen/component implements: happy, empty, loading, error, unauthorized. A missing state is a missing feature, not a polish item.
- Error states show what the spec says users should see — if the spec doesn't say, that's a hole to report, not a string to invent.

## Accessibility (WCAG 2.2 AA floor)
- Semantic HTML before ARIA — the best ARIA is the ARIA you don't need.
- Every interactive element: keyboard reachable, visible focus, accessible name. Every flow must work keyboard-only; "works with a mouse" is not tested.
- Custom widgets (modals, tabs, dropdowns, date pickers) are guilty until proven innocent: correct roles/states, focus management on open/close, announced updates for dynamic content.
- Contrast meets AA; nothing conveyed by color alone. A green Lighthouse score does not mean accessible.

## Performance
- Code-split and lazy-load what isn't needed at first paint; optimize images; no unbounded lists without virtualization.
- State changes render predictably — no layout thrash on the hot interaction path.

## Integration
- API calls match the frozen contract (openapi.yaml) exactly — types, error envelope, pagination. Mock data shape = contract shape.
- Handle the API's declared error responses explicitly; no swallowed rejections.
