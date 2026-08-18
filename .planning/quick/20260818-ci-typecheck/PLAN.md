# CI runs no typecheck (#231)

## Step 1 is already done — the scope was unknown, and it is empty

The issue's first instruction is "run `pnpm typecheck` unfiltered on `main`
first and see what falls out — that is the real scope of this issue, and it is
unknown today."

Run on `main` at `5bc336b`: **10 tasks, 10 successful, clean.** No pre-existing
type errors anywhere in the workspace. So the issue's branch 3 ("fix or
explicitly exclude the failing packages") does not apply, and this is branch 2:
add the step.

## How CI actually invokes things

`ci.yml` does **not** use `turbo run`. It calls `pnpm --filter <x> <script>`
per target, which is why the lint and test steps are enumerated one per filter
and each carries a comment saying so (#202, #206 are the two previous times
this exact gap was closed for a different script).

So `turbo.json` declaring a `typecheck` task enforces nothing here. The fix is
three steps mirroring the three lint steps:

- `pnpm --filter './packages/*' typecheck`
- `pnpm --filter web typecheck`
- `pnpm --filter console typecheck`

Place each beside its existing lint sibling, so the file keeps reading
"lint then test" per target rather than growing a detached block.

`apps/mobile` is **not** added: it has its own `mobile-typecheck.yml`, and
`ci.yml`'s `paths:` filter does not include `apps/mobile/**`.

## The exempt packages, verified rather than assumed

`pnpm --filter` silently skips a package with no such script — verified:
`Scope: 6 of 10 workspace projects`, four actually ran. Two packages have no
`typecheck` script, and both are legitimately exempt:

- `packages/tsconfig` — contains `base.json` and `package.json`. No TypeScript
  source to check.
- `packages/eslint-config` — `.mjs` only. It carries a `lint` script and no
  TypeScript.

Per the issue: an exclusion must be deliberate rather than inherited, so the
CI step carries a comment naming both and why.

## The recurrence guard — this is the part that matters

The silent skip is the same failure the issue is filed about: *a check that
reports success while enforcing nothing*. Adding the step fixes today's gap but
leaves the mechanism intact — the next package to ship without a `typecheck`
script is skipped in silence, exactly as `@tesserix/crm-country` was.

The issue asks for this to be treated "as a category rather than one-off
fixes". So add a guard test asserting that **every workspace package containing
TypeScript source has a `typecheck` script**, with the two exempt packages
named in an allowlist that has to be edited deliberately.

Precedent for a repo-structural guard living in the console's test suite:
`apps/console/app/globals.test.ts`, which parses `globals.css` and fails CI on
token drift. Match its shape and its comment style — state what drift is being
prevented and why the test is the enforcement mechanism.

The guard must fail for the right reason: mutation-test it by adding a fixture
package (or by removing `typecheck` from a real one) and confirming it goes
red, then restore.

## Gates

`pnpm --filter console test:unit`, `typecheck`, `lint`, and the unfiltered root
`pnpm typecheck` and `pnpm lint`.

**Verify the workflow YAML parses** before pushing — a malformed `ci.yml` is
not caught by any local gate.

No new dependencies.
