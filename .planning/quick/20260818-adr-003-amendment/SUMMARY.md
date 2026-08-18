---
status: complete
date: 2026-08-18
pr: 279
---

# Summary

## Shipped

**PR #279** — `docs/adr-003-platform-api-amendment`

- **ADR-003 D7** — the console becomes a pure UI over the platform API; `apps/console/lib/db/*` retires alongside the admin endpoints. Sub-decisions D7a (CRM and audit migrate as one module, because `auditedOperation` shares a transaction) and D7b (M11 correctness stays on direct DB, M11 structural targets the API).
- **ADR-003 D8** — both principals authenticate through Zitadel. Records the declined `tx_session` JWE shortcut and the two Zitadel settings that are prerequisites.
- **ROADMAP** — sequencing rule gains its second clause; M11 section re-argued under D7b; #277/#278 added to the Now table.
- **#277** created — platform API scaffold, delivery path, module boundary enforcement landing empty.
- **#278** created — Zitadel auth for both principals.
- **#269** — auth decision recorded as a comment.

## Corrected mid-task

The plan initially said ADR-003 "blesses" the console's direct DB access. It does not — the ADR is silent, and the blessing is in the `lib/db/tesserix.ts` code comment. D7 was written as an extension of D1 rather than a contradiction of it, which is the accurate framing.

## Not done, deliberately

- **No Go written.** Phase 0 scaffold is #277.
- **#272 not updated**, though D7 widens what retires (the console's own `lib/db/*` now joins the inventory). Worth a follow-up comment.
- **#161 not updated**, though D8 answers its core question. The answer is recorded on #269 and #278.

## Next

#277 (scaffold) and #278's two Zitadel checks are the unblocked starting points. #261 remains the gate on the tickets module's authorisation.
