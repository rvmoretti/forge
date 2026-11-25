# Testing domain pack

Include in briefs for test-authoring work (and give to forge-tester by default).

## Determinism (non-negotiable)
- No hard sleeps — wait on conditions (element state, network response, URL), never wall-clock time.
- Tests own their data: create what you need via API/fixtures, tolerate parallel siblings, no seed-user dependence.
- A test that needs a retry to pass is not done; diagnose the flake at root cause. Pass-on-retry is a flake signal, not a success.

## Structure
- Right pyramid level: unit/API test if it can prove the behavior; browser E2E only where the integration itself is the risk (the money paths).
- Setup through the API, assert through the UI — don't re-test login in 200 tests.
- Selectors: user-facing roles/labels first, data-testid as escape hatch, brittle CSS chains never.

## Harness cost (e2e) — paid once per run, not once per spec
- Run e2e against the built app, not the dev server: build once, serve it, point every spec at it (measured on one project: ~3× faster per spec).
- Sign in once per role in a setup project and save the session (Playwright `storageState`); specs reuse it. Only the sign-in spec signs in through the UI (measured on one project: ~460 UI sign-ins in one full run).
- Resolve the stack's environment (URLs, keys, ports) once in global setup and hand it to specs through env — never per spec file.
- Specs own their data through the API so they run in parallel workers.

## Coverage judgment
- Test the acceptance criteria literally, then the boundaries: edge cases, negative paths, malformed input, authorization (can A see B's data?), failure recovery.
- Proposed extra checks that imply product decisions go back as questions — tests never redefine expected behavior.

## Debuggability
- Every failure must be understandable from its output/artifacts alone. A failure that requires a rerun to understand is a tooling bug.
