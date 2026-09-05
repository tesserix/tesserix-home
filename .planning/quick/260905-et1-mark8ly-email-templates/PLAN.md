---
id: 260905-et1
slug: mark8ly-email-templates
date: 2026-09-05
issue: "#588 — part of the #586 epic"
kind: quick
---

# The mark8ly transactional email editor, in the console

`apps/web` authors mark8ly's transactional templates today. The console has no
email surface at all. This moves the editor.

## Correction: the console integrates by API, not by cross-DB

An earlier draft of this plan ported `apps/web`'s cross-DB write path into the
console. **That was wrong**, and the tell was sitting in the cluster: the
`console` Deployment has no `MARK8LY_*` env vars while `company` (the old admin,
same namespace) has all six. That is not a gap to fill — it is the console's
design. The console has no direct connection to any other product's database and
should not acquire one.

The confusion was mine: #151 records that **the rows stay in the product's DB**,
and I read that as endorsing the cross-DB *transport*. It does not. Ownership of
the data and the mechanism for reaching it are separate questions. The rows stay
in mark8ly's DB either way; what changes is that the console reaches them the way
it reaches everything else — through platform-api, which fans out over the
federation contract.

So the shape is:

```
console page/actions
  -> apps/console/lib/platform-api.ts
    -> platform-api module (Go)
      -> federation.FanOut, HMAC-signed
        -> mark8ly /api/v1/platform/admin/email-templates
          -> mark8ly's own email_templates table
```

This is three repos, not one. It is no longer a quick port, and the plan below
reflects that.

## The split registry, and what this branch does about it

`FEDERATION_MARK8LY_BASE_URL` points at **marketplace-api-admin only**:

```
FEDERATION_PRODUCTS = kora,mark8ly
FEDERATION_MARK8LY_BASE_URL = http://mark8ly-marketplace-api-admin.mark8ly.svc.cluster.local:8080/api/v1/platform
FEDERATION_MARK8LY_ENDPOINTS = outbox,onboarding,billing,inbox,conversions
```

mark8ly's **platform-api service is not federated**, and the template registry is
split across the two services with mirrored tables:

- `marketplace-api` — `orderdoc_*`, `giftcard_delivery`, plus the twelve billing
  keys that have no rows (tesserix/mark8ly#717)
- `platform-api` — `welcome`, `email_verification`, `invitation`,
  `password_reset`, `login_otp`, `new_device_login`

The old UI's `platform_api` / `marketplace_api` toggle exists for exactly this
reason.

**Decided:** federate mark8ly's platform-api as a second product — but as its own
piece of work, after this one. It is not an endpoint away. That service has **no
platform admin contract surface at all**: the only `platformadmin` references in
it are comments pointing at marketplace-api's package. There is no HMAC
middleware, no nonce store, no signature verification, no conformance
declaration. And it cannot borrow them — `services/{auth-bff,marketplace-api,
otto,platform-api}` are four separate Go modules with no shared Go package, so
the signature code has to be extracted into a shared module first (decided:
extract, not copy — two implementations of signature verification will drift, and
a fix will land in one of them).

**So this branch ships the marketplace half.** The console gets `orderdoc_*`,
`giftcard_delivery`, and with #717 the twelve billing keys. Auth templates stay in
`apps/web` until platform-api is federated. Two editors coexist for a while,
which is a cost worth naming — but the alternative is a console surface that
cannot be built until a second service grows a contract, and proving the console
half first de-risks that contract work rather than betting on it.

The page must therefore say what it does **not** cover, and where those templates
still live. A list that silently omits `password_reset` is worse than no list.

## T1 — mark8ly serves its templates on the platform admin contract

`services/marketplace-api/internal/handlers/platformadmin/email_templates.go`.

The package is the right home and the precedent is close by: `notifications.go`
serves the in-app bell and `email_sends.go` serves the send log, both as narrow
interfaces mounted nil-safely in `Register` (`routes.go:246+`).

Endpoints, following §3 of the contract:

- `GET  /admin/email-templates` — list
- `GET  /admin/email-templates/:key` — one
- `PUT  /admin/email-templates/:key` — upsert
- `POST /admin/email-templates/:key/test-send`

Constraints the package already imposes, which are not optional here:

- **Mount nil-safely.** A missing dependency leaves the routes unmounted rather
  than half-working.
- **Writes require `Emitter`.** `routes.go` refuses to mount `TenantLifecycle`
  at all when `Emitter` is nil, because "a write endpoint that cannot be
  attributed to an operator should not exist, not run silently unaudited". A
  template edit changes what every merchant receives; it is exactly that kind of
  write.
- **Never mount under `/api/v1/admin`.** `routes.go:225-245` explains at length:
  an Istio AuthorizationPolicy denies un-JWT'd requests to that prefix and this
  surface authenticates by HMAC, so the mesh answers 403 before the app sees the
  request — invisible in local dev and CI, since Istio is in neither.
- Validation stays server-side: unmatched `{{` / `}}` rejected, `subject`
  validated as a template too.
- The existing `/internal/templates/*` endpoints stay for now. Retiring them is
  a separate change once nothing calls them.

Done when: the four routes are mounted behind HMAC, writes emit audit rows, and
the conformance declaration lists the new endpoint.

## T2 — platform-api `emailtemplates` module

`platform-api/internal/modules/emailtemplates/`, following the `announcements`
module: `Register(mux, cfg)`, handler/service/repository/domain split, colocated
tests, wired in `cmd/server/main.go` via `httpx.RegisterModule`.

Per `docs/PLATFORM-API-CONVENTIONS.md`: §1 response envelope, §1c an unconfigured
upstream is **501, not 503**, §5 idempotency on the write, §6 audit in the same
transaction, §7 Zitadel capability gate, §8 no module imports another — if it
needs the federation registry it declares an interface and `cmd/server` satisfies
it, as `announcement_audience.go` does.

Scoped to marketplace-api for now; the module should not hardcode one upstream,
since a second mark8ly source is coming.

## T3 — the console surface

`page.tsx` (server, `dynamic`, explicit load-failure state) /
`email-templates-view.tsx` (`"use client"`) / `actions.ts` (`"use server"`),
reading through `apps/console/lib/platform-api.ts`. **No `lib/db/mark8ly.ts`.**

Behaviour that must survive the port, each because it is load-bearing:

- **A read failure renders as a failure.** A failed federated read looks exactly
  like an empty registry unless the page says otherwise. `apps/web`'s list page
  says it out loud (`page.tsx:77-91`).
- **Cache eviction on save.** Whatever replaces the `/internal/templates/refresh`
  ping, a failed eviction must be visible — swallowed, the operator sees "saved"
  and their change does not send for five minutes.
- **Draft means invisible to the send path.** The loader filters
  `status='published'` (`marketplace-api/internal/emailtemplates/loader.go:141`),
  so saving a draft silently reverts sending to the embedded template. Nothing
  about the word "draft" implies that; say it in the UI.
- **Test-send is a real send.** Map each upstream failure to its own sentence.

Actions follow `platform/announcements/actions.ts`: a discriminated
`{ ok: true } | { ok: false; message: string }`, never a throw to the UI;
`getCurrentSession()` + `checkOperatorCapabilityLive(...)`; `CapabilityError` to
the fixed permission message and everything else to a per-verb sentence;
`revalidatePath` on success. Copy its actions, not its view — announcements
hand-rolls its list and `ConsoleDataTable` exists. Import `PlatformApiError` from
`lib/platform-api-error.ts`, never from `lib/platform-api.ts` in a client
component: that mistake dragged `pg` into the browser bundle once already.

## Done, and out of scope

Route id and rail entry are T0 and already landing: `mark8ly.emailTemplates`,
product-scoped beside `mark8ly.overview` / `.tenants` / `.users`. Not
`platform.emailTemplates` — the rows are mark8ly's, and `routes.ts:798-817`
already warns twice about two confusably-named template routes.

Out of scope:

- **Creating a key.** Keys are owned by code — a key exists because a Go call
  site renders it, so a console-created key with no call site sends nothing.
  Registered-but-unseeded keys are tesserix/mark8ly#717, on the read side.
- **Interpolated preview** — #587, which wants its own render endpoint.
- Delete, per-tenant override, locale, version history. None exist in the schema
  (`version` is a counter, not a stored revision).
- `otto_api`, which is not on the registry at all.
- Retiring `apps/web`'s routes, and retiring `/internal/templates/*`.
