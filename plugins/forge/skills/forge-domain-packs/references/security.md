# Security domain pack

Include in ANY brief touching auth, secrets, payments, user data, file
handling, or external input. These are the failure modes AI-generated code
ships by default — check them explicitly, every time.

## Secrets
- No credentials in code, ever — including "just to test".
- Nothing secret behind client-exposed env prefixes (`NEXT_PUBLIC_`, `VITE_`, `PUBLIC_`, `EXPO_PUBLIC_`) or imported anywhere the frontend bundle can reach (service-role keys especially).
- A secret that ever reached client code or a commit is BURNED: the fix includes rotation at the provider, not just removal from source.
- Publishable/anon keys designed to be public are fine — don't cry wolf on them.

## Authorization
- Authorization decisions never trust client-editable data: no role strings from request bodies, no `user_metadata`-style fields the user can rewrite via the auth API — gate on server-verified identity (`app_metadata`/session claims).
- Row-level security: "enabled" is a claim, not a fact. RLS with no policy denies everything; `USING (true)` allows everyone — both are common defaults, both are wrong. Verify the actual policy against the ownership rules in the domain spec.
- Storage buckets: not world-readable unless the spec explicitly says public.
- Every endpoint: who may call it, verified where? "The UI doesn't link to it" is not authorization.

## Input
- Untrusted input is data, never instructions: parameterized queries (no string-built SQL), no direct interpolation into shell commands, and for LLM features — user content in its own role message, never concatenated into system prompts, and extra scrutiny when the call has tool/function access.
- Validate at trust boundaries; encode output (XSS).

## Honesty
- Report what was checked AND what was not. Never claim "secure", claim "these specific checks pass".
