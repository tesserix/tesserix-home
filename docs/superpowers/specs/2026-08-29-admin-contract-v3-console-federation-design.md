# Contract v3, and the eight mark8ly surfaces the console cannot reach

**Date:** 2026-08-29
**Status:** design, approved for execution
**Amends:** `docs/superpowers/specs/2026-08-14-product-admin-integration-contract.md` (v2, amended 2026-08-22) — this document becomes its §9.
**Occasion:** mark8ly's `Platform integration v1` milestone closed 2026-08-28 with 27/27 issues and a green conformance run. That milestone made mark8ly *conformant*. It did not make mark8ly *visible*: eight of its mounted platform-admin surfaces have no route out of the product.

---

## 1. The gap, stated exactly

mark8ly mounts twenty routes under `/api/v1/platform/admin`. Twelve are federated by
platform-api today and render somewhere in the console. Eight are not reachable from the
console at all — no platform-api module, no console page.

**Reachable today** (platform-api module → console surface):
`kpis`, `inbox` + `inbox/{kind}/{id}/actions/{actionId}`, `audit-logs`,
`entities/tenants` + `entities/tenants/{id}` + `entities/users`,
`billing/subscriptions`, `billing/trials` + `billing/trials/{storeID}/extend`,
`tenants/{id}/suspend` + `unsuspend`, `lifecycle/reason-codes`, `tickets`.

**Not reachable:**

| # | mark8ly route | Response envelope | Read capability | Console route key |
|---|---|---|---|---|
| 1 | `GET /admin/outbox` | `data-pagination` | none (signature only) | `platform.outbox` — `pending` |
| 2 | `GET /admin/email-sends` | `data-pagination` | none | *no entry* |
| 3 | `GET /admin/notifications` | `data-pagination` | none | `platform.notificationLog` — `pending` |
| 4 | `GET /admin/break-glass` | `data-pagination` | **`rotate-credentials`, exact** | `platform.breakGlass` — `pending` |
| 5 | `GET /admin/conversions` | bare object, `?email=` | none | *no entry* |
| 6 | `GET /admin/onboarding/funnel` | `{ data: {…} }`, nesting `last_24h` and `window` | none | *no entry* |
| 7 | `GET /admin/onboarding/sessions` | `data-pagination` | none | *no entry* |
| 8 | `GET /admin/tenants/{id}/purge/preview` + `POST /admin/tenants/{id}/purge` | `{ data: {…} }` | write, `hard-delete` | `platform.gdprQueue` — `pending` |

Envelopes were read from the handlers, not inferred: `outbox.go:93`, `email_sends.go:90`,
`notifications.go:82`, `break_glass.go:93`, `conversions.go:85`, `onboarding.go:95,137`,
`tenant_purge.go:363,410`.

### 1.1 Two things that look like integrations and are not

- `apps/console/lib/notifications.ts` is **not** `/admin/notifications`. The console bell is
  *derived* — a ticket that arrived, a merchant who replied, read from the ticket rows
  themselves. Its own header says there is no notifications table and no writer. mark8ly's
  `/admin/notifications` is a different, product-owned log. Building #3 does not replace the
  bell and must not be wired into it.
- `apps/console/lib/crm-conversion.ts` calls `GET {product_admin_api}/internal/conversion-status?email=`,
  not `/admin/conversions`. Same question, two endpoints, different roads. §9.6 below rules on
  which one survives.

### 1.2 `/admin/health` needs no contract change

`health` is already a v2 endpoint id (§3.5), mark8ly already declares it, and the nightly run
already checks it. The gap is one layer up: platform-api's `health` module reads Deployment
readiness and CNPG Cluster status from the Kubernetes API — it is *estate* health, and it
federates nothing. A product's self-reported dependency health is a ninth surface with an
existing contract id and no consumer. It is in scope for this programme as a federation and
console task, and it is **out** of scope for the contract amendment.

---

## 2. The ruling: extend the vocabulary, do not multiply escape hatches

The contract's endpoint vocabulary is closed — `declaration.ts:258` throws on an unknown key
and fails the entire run. That is why mark8ly's `docs/admin-conformance.md` records seven
undeclarable reads as *one fact, not seven undocumented decisions*.

There were two ways out. We take the first:

**Chosen — extend to contract v3.** Add the ids to `ENDPOINTS` in
`@tesserix/admin-conformance`, amend the spec, redeclare in mark8ly. Every product gets the
same surfaces free, and the nightly run covers them from day one.

**Rejected — per-product named routes** (`koraaimetrics`'s shape). That module's own package
doc explains why it exists: with *one* caller there was no evidence about what a generic shape
should be. That argument does not transfer here. There are eight callers, seven of them
already answering contract envelopes, and mark8ly is not the only product that will grow an
outbox. Reaching for the escape hatch eight times would turn a deliberate exception into the
default, and none of the eight would be covered by conformance — which is precisely the
failure #415 was opened to fix.

### 2.1 Consequence: adding an id is not free

`contract.ts`'s own header states the rule — **add, never rename**. A renamed id silently turns
a product's declaration into "not implemented", which reports as a *pass*. Every id below is
final on merge.

An id also imposes work on every other product: kora's `admin-conformance.json` does not
declare these, which is correct and stays correct — an undeclared endpoint is "not
implemented", and the suite skips it. v3 adds no obligation to kora. This is stated because
"we extended the shared contract" reads like it does.

---

## 3. What v3 adds

Eight new ids across seven surfaces — onboarding is two endpoints — taking the closed vocabulary from nine to seventeen. Each entry gives the `ENDPOINTS` record verbatim in Plan 0.

| id | path | envelope | probe | note |
|---|---|---|---|---|
| `outbox` | `/admin/outbox` | `data-pagination` | yes | |
| `email-sends` | `/admin/email-sends` | `data-pagination` | yes | |
| `notifications` | `/admin/notifications` | `data-pagination` | yes | |
| `break-glass` | `/admin/break-glass` | `data-pagination` | yes | requires a capability **value** to probe |
| `conversions` | `/admin/conversions` | `free` | **no** | requires an `email` that identifies a real person |
| `onboarding/funnel` | `/admin/onboarding/funnel` | `free` | yes | nests `last_24h` and `window`, not a flat map of scalars |
| `onboarding/sessions` | `/admin/onboarding/sessions` | `data-pagination` | yes | |
| `tenant-purge` | `POST /admin/tenants/{id}/purge` | `free` | **no** | destructive |

### 3.1 Why `tenant-purge` is `probe: false`

Identical reasoning to `tenant-lifecycle`, and stronger. A conformance run that suspends a real
tenant to check an envelope is worse than no check; a run that *purges* one is unrecoverable.
There is no sandbox tenant to point the suite at. The id exists to be declarable — so the
console can discover that a product supports purge at all — and carries no wire check.

`GET .../purge/preview` is deliberately **not** a separate id. It is the read half of one
operation and is meaningless without the write; splitting them would let a product declare a
preview it cannot execute.

### 3.2 Why `conversions` is `probe: false`

`GET /admin/conversions` requires `?email=`. Any value the suite could send is either a real
person's address — which makes the nightly run a lookup against live PII on a schedule — or a
synthetic one, which exercises only the `state: "none"` branch and asserts nothing about the
endpoint's real behaviour. Neither is worth a check. Declared, not probed.

### 3.3 Why `break-glass` probes but needs configuration

It is the first **read** in the estate gated on an exact capability *value*
(`rotate-credentials`, `middleware.go:367-385`). A suite run without that capability gets a 403,
which is the endpoint working correctly and would report as a failure. The runner must send
`--operator` and `--capability rotate-credentials`.

**Correction (2026-08-29):** an earlier version of this section claimed the CronJob's signing
identity must "hold" `rotate-credentials`, and that the id should degrade to `probe: false` if
it could not be granted that capability. Neither is true. `middleware.go:367-385` gates the
read on exact string equality between the presented `Capability` field and the literal value
`"rotate-credentials"`, plus a non-empty `Operator` — there is no grant list, no identity
verification, and nothing to hold. Any signer that already reaches this surface (i.e. holds the
shared HMAC secret) can send any operator string and the literal capability value and pass.
`break-glass` is declared in Plan 0 alongside the other seven; nothing needs verifying first.

### 3.4 The two-copy declaration stays two copies

`admin-conformance.json` lives in mark8ly, and again as a ConfigMap in
`tesserix-k8s/charts/apps/mark8ly-marketplace-api-admin/templates/admin-conformance-configmap.yaml`
— the copy the CronJob actually reads. `conformance_declaration_test.go` fails on drift.
Removing the duplication is #290's follow-up and is **not** in this programme's scope; every
declaration change here lands in both copies, in the same PR.

---

## 4. Federation: one generic path, no new shape

Each new id gets a platform-api module following the established layout —
`internal/modules/<name>/<name>.go` as the entire public surface (`Register`, `Config`),
everything else under `internal/{handler,service}`.

Slug selection follows the existing distinction, which is load-bearing:

- `cfg.Federation.Slugs()` — the endpoint is universal, a product with none answers 501, and
  carrying that 501 to the console is the point (`kpis`'s comment).
- `cfg.Federation.SlugsServing(...)` / `SlugsImplementing(...)` — the endpoint is optional, and
  asking a product that does not serve it would 404 and surface to an operator as a failed
  source when the honest answer is "this product has none" (`tenants`'s comment).

**All seven new modules use `SlugsImplementing(<id>)`.** None of them is universal. A product
without an outbox has no outbox, and that is not a 501 worth rendering.

---

## 5. Console: eight surfaces, and the route registry is already right

`packages/console-core/src/routes.ts` already carries four of the eight as `pending: true` with
their capability set. `pending` is a promise the console has not kept; each vertical below
clears exactly one, and adds registry entries for the four with no key
(`email-sends`, `conversions`, `onboarding`, product health).

Capability strings are already in the registry's vocabulary — `platform`,
`rotate-credentials`, `hard-delete`. No new capability is invented here; §8.4 closed that
vocabulary and #275 puts it on the console's side of the line.

---

## 6. Ruling: `/admin/conversions` versus `/internal/conversion-status`

Two endpoints answer "did this lead become a live tenant". `crm-conversion.ts` calls the
`/internal/` one under RULING 27 — the console never calls a product's admin API directly and
holds no product → base-URL registry.

**Ruling:** they are not duplicates and neither is retired by this programme.
`/internal/conversion-status` answers *one lead's* state for the CRM's own conversion column,
by email, through `apps/web`. `/admin/conversions` is the same product's operator view of that
data and will be federated the same way every other admin read is. Vertical 5 must not rewire
`crm-conversion.ts` onto the new module; if the two disagree in production, that is a finding
worth its own issue, not a refactor to fold into this work.

---

## 7. Sequence

Plan 0 is a hard gate — nothing federates until the vocabulary exists.

- **Plan 0 — contract v3.** Spec §9, the eight `ENDPOINTS` entries, declaration option keys, checks for
  the probed ids, mark8ly redeclaration in both copies. Deliverable: a green conformance run
  naming the new endpoints.
- **V1 `outbox`** — the simplest `data-pagination` read end to end. Proves the whole path;
  every later vertical is a variation on it.
- **V2 `email-sends`** — second read, confirms V1's pattern generalises.
- **V3 `notifications`** — read, plus the explicit non-wiring to the bell (§1.1).
- **V4 `break-glass`** — first capability-gated read; the console must assert
  `rotate-credentials` and the three credential fields stay excluded.
- **V5 `conversions`** — non-envelope read, plus §6's ruling held.
- **V6 `onboarding/funnel` + `/sessions`** — one console surface, two endpoints, two envelopes.
- **V7 product `health`** — no contract change; federation and a console surface distinct from
  the cluster-derived header indicator.
- **V8 `tenant-purge`** — last, alone, destructive, `hard-delete`-gated, preview-before-execute.

V8 is last because it is the only destructive write in the set and it is the one whose console
surface needs a confirmation design rather than a table.

---

## 8. Out of scope

- Removing the two-copy declaration (#290's follow-up).
- Retiring `/internal/conversion-status` (§6).
- Turning on `CapabilityValueChecked` for writes (#364).
- Anything in mark8ly's Go handlers — they are conformant and shipped. If a vertical finds a
  handler bug, it files an issue in mark8ly rather than fixing it in flight, exactly as #415
  found and fixed `/admin/inbox`'s envelope *before* declaring it.

## 9. Risk worth naming up front

The nightly CronJob does not run a pinned image of the suite — it `npx`-installs
`@tesserix/admin-conformance@">=0.5.0 <1.0.0"` at run time, so a minor publish is picked up
automatically at the next 06:20 UTC run. That removes an image roll from the sequence and
replaces it with a narrower, sharper window:

**A declaration that names a v3 id while the published suite is still 0.7.0 throws on the
unknown key and fails the entire run** — not that endpoint, the run. So the order inside
Plan 0 is fixed and non-negotiable: publish `@tesserix/admin-conformance` **first**, confirm it
is on the registry, then land the two declaration copies. Reversing those two steps turns a
green estate red overnight for a reason that has nothing to do with mark8ly.

The `>=0.5.0 <1.0.0` range is what makes this work without a chart change. Do not narrow it,
and do not pin an exact version to "be safe" — `values.yaml:246` already records why the caret
form was wrong for a 0.x package, and pinning would strand the job on a contract older than the
one the estate is being held to.

### 9.1 `break-glass` needs a CronJob change, and it is the only one that does

The suite sends a single capability for the whole run, via `--capability` (`cli.ts:60`), and
needs `--operator` for the same run. The mark8ly CronJob passed `--base`, `--slug` and
`--declaration` and nothing else before this landed. The CLI defaults `--operator` to
`admin-conformance` and `--capability` to `platform` (`cli.ts:150-151`), so the operator was
never actually missing; the resulting `break-glass` probe got a 403 `capability_insufficient` —
the default capability `platform` failing exact-string-equality against `rotate-credentials` —
the endpoint working correctly, reported as a failure.

**Correction (2026-08-29):** this section previously said the flag addition needed to wait for
V4 pending verification against the "signing identity," and that the id would degrade to
`probe: false` if that identity could not "hold" `rotate-credentials`. That premise does not
exist in the code. `middleware.go:367-385` checks exact string equality against the capability
value and a non-empty operator only — no grant, no identity check. `--operator` and
`--capability rotate-credentials` were added to the CronJob's `npx` args in Plan 0 itself, and
`break-glass` is declared in both copies alongside the other seven ids.
