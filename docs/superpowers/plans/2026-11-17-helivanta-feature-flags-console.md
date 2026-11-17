# Delivery checklist

- [x] Review provider v2 contracts and canonical release manifest.
- [x] Implement tested catalogue validation, dependency closure and provider adapter.
- [x] Add durable attributed command journal and uncertain-outcome reconciliation.
- [x] Add operator-only API gates and dedicated manage-feature-flags capability.
- [x] Add console navigation, product page, grouped controls and confirmation UI.
- [x] Test stale, unauthorized, duplicate, dependency, outage and uncertain paths.
- [x] Add GitOps management credential delivery and scoped network access.
- [x] Preserve console flag values across provider provisioning/upgrades.
- [ ] Prepare API-only provider mode, conditional on console acceptance.
- [ ] Build, lint, typecheck and run unit/CI integration tests; remove build outputs.
- [ ] Commit/push reviewable increments and prepare migration/rollout approval.
- [ ] Merge/deploy approved changes and verify console, SDK and Helivanta behavior.

Local evidence (2026-11-17): console 296 files / 5,557 tests passed; console
TypeScript, ESLint and Next.js production build passed; scoped Go race tests,
platform-auth race tests, Go vet and production server build passed. CI integration
tests compile locally but were not executed against a local database/provider.
The infrastructure suite passed 14 Node tests and 17 Python tests, with Helm lint
for both affected charts. Production migration, operator grant, rollout and browser
acceptance remain pending.
