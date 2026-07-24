# packages/

Shared workspace packages for the Tesserix monorepo.

- **tsconfig** — `@tesserix/tsconfig`: shared TypeScript compiler baseline (`base.json`).
- **eslint-config** — `@tesserix/eslint-config`: shared ESLint custom-rule block.

Both are **config-only** — no runtime/business logic lives here yet.

## Deferred de-duplication (next effort)

The web app (`apps/web/lib`) and mobile app (`apps/mobile/lib`) currently keep
parallel copies of the same concepts. These are the intended targets for a future
`packages/shared` (pure TypeScript — no UI, since React and React Native primitives differ):

- `contracts.ts` — shared API/domain types (zod schemas + inferred types)
- `api.ts` — API client / request logic
- `auth` — auth token + session helpers
- `format.ts` — formatting utilities

Not moved in the monorepo-restructure effort (2026-07-24) to keep it behavior-neutral.
