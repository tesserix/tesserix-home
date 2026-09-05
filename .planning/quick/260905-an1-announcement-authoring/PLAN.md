---
id: 260905-an1
slug: announcement-authoring
date: 2026-09-05
issue: "#150 (M9 Outbound)"
kind: quick
---

# Announcements are authored in the console, where the capability is enforced

Announcements are today authored at `apps/web/app/admin/platform-announcements`
(138 lines) against `apps/web/app/api/admin/platform-announcements/route.ts`
(47 lines). That API has **no capability check** — not in the handler, and not
in `apps/web/middleware.ts`, whose matcher covers the route but enforces only a
session. `POST` with `isPublished: true` broadcasts to every merchant of every
product.

`packages/console-core/src/routes.ts:410` already says what it should require:

```ts
"platform.announcements": { web: "/admin/platform-announcements",
  mobile: "/platform/announcements", pending: true, capability: "mass-send" }
```

The decision is recorded and unbuilt. `pending: true` means the console route
id exists and still points at apps/web.

## This is not exploitable today, and that is the reason to do it now

Every operator currently holds all 12 human capabilities — `docs/RBAC-CAPABILITIES.md`
says so and the Zitadel Role Assignments screen confirms it. So nobody is
presently doing something the gate would stop.

The gap is **latent**: the first time anyone is granted a narrow role, they
keep the ability to broadcast to every merchant, and nothing says so. That is
the failure this closes, and it is worth stating plainly because "no operator
is over-privileged today" is a true sentence that makes the work look
optional.

## The audience preview is the hard part, and federation constrains it

#150 asks for "a preview of the resulting audience" and for sending to be "a
confirmed action naming the audience size". Four verified facts decide what
that can honestly be.

**There is no local tenant table.** `grep` for `FROM tenants` / `platform_tenants`
across `apps/web/db/migrations` and `platform-api` returns nothing. Tenants are
FEDERATED: `platform-api/internal/modules/tenants/tenants.go:29` holds a
`Fed *federation.Client` and a `Slugs []string` of products serving the
`tenants` entity. So an audience count is a fan-out, not a query.

**Only mark8ly serves tenants.** From the live deployment:

```
FEDERATION_PRODUCTS=kora,mark8ly
FEDERATION_KORA_ENTITIES=users,foods
FEDERATION_MARK8LY_ENTITIES=tenants
```

Kora federates users and foods. **An announcement targeting Kora has an
audience this platform cannot count.** Rendering `0` there would read as
"reaches nobody" when it means "cannot be counted" — the opposite of what an
operator needs before an irrevocable send.

**The federated response carries no total.** Nothing in the tenants service or
the federation client returns a count. Counting means paging mark8ly's tenants
and counting client-side, or adding a count to the §3.4 entity contract — a
cross-product change, which is the expensive kind and out of scope here.

**Statuses are a per-product vocabulary.** `domain.Tenant.Status` is documented
as "the product's own vocabulary, passed through rather than normalised", with
an explicit argument against a console-side translation table. So the authoring
UI must offer the statuses a product actually reports, discovered, rather than
a hardcoded `active | trialing | suspended` list that would silently mis-target.

### What the preview will therefore be

Honest about what it knows, per product:

- for a product that federates `tenants` (mark8ly today) — a real count
- for one that does not (kora today) — **"not countable from here"**, never `0`
- the confirm step names the countable audience and says explicitly that the
  uncountable products are included but unmeasured

That is weaker than #150's wording implies and stronger than a number that is
sometimes a lie. If a real count for every product is wanted, that is a
federation contract change and its own issue.

## Tasks

Each is one commit. Order matters: nothing in the console can be built before
the API it calls exists.

**T1 — operator endpoints in platform-api.** `GET /v1/announcements/admin`
(list including unpublished), `POST /v1/announcements`, `PATCH
/v1/announcements/{id}` (publish, expire, edit). Gated `platform` AND
`mass-send`, stacked the way the tickets module stacks surface and verb. The
machine route from #573 is untouched and keeps its own capability.
DONE: an operator token with `mass-send` can author; one without is refused;
the machine route still answers exactly as it does now.

**T2 — the audience preview endpoint.** `GET /v1/announcements/audience?products=&statuses=`
returning a per-product count or an explicit "uncountable", never a zero
standing in for one. DONE: a mark8ly-targeted filter returns a real count; a
kora-targeted one returns uncountable; a product that is down returns
uncountable rather than a wrong number.

**T3 — the console surface.** `/platform/announcements`, composing T1 and T2.
The route id already exists; flip `pending`. DONE: an operator without
`mass-send` cannot reach it, and the send confirmation names what T2 returned.

**T4 — retire the apps/web page and its ungated API.** Only after T3 is
deployed and used once. DONE: both files deleted, and `routes.ts` points at the
console.

## Not in this plan

The `audience_filter` JSONB stays as it is. It is matched with `@>` containment
by both the machine read (#573) and the query this moves, and the schema
comment says it is "intentionally permissive so we can grow filters without a
migration". Adding tags or segments is a later issue, not this one.
