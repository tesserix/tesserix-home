# Tesserix CRM — design

Issue #153. Boundary decision in #154.

The console gains a CRM: a follow-up queue for outbound prospecting, the record
of every interaction with a prospect, and the link from a prospect to whatever
they became in one of Tesserix's products.

## Decisions this rests on

| Decision | Where |
|---|---|
| The in-house CRM **is** the CRM. No external Zoho/HubSpot-class system, no sync contract, no per-field system of record. | #154 |
| Fresh build in `apps/console`, not a port of the 1,437-LOC admin page. Existing data migrates into the new shape. | #153 |
| Sourcing is out of scope. Leads arrive by CSV import or manual entry. | this design |
| The primary surface is a **follow-up queue**, not a pipeline board. | this design |
| A lead is due when it has an explicit next-step date, with a staleness backstop for leads nobody scheduled. | this design |
| Outreach is **logged, not sent**. No SendGrid path, no template authoring — #151 owns the template editor. | this design |

The data is already platform-owned: `leads` and its companions live in
`tesserix-postgres`, which `apps/console` already has a pool for. **No mark8ly
access, no cross-DB grant, no product integration.** That is why this work is
proceeding while #160 is deferred.

## Why not reshape the existing tables

The current `leads` row is simultaneously the person, the business, the deal and
the pipeline stage. That is survivable at 259 rows and one product, and it fails
three ways as the estate grows:

1. **Six products, one status.** A café prospected for Mark8ly today may want
   Kora next year. One row and one `status` means overwriting the first history
   or duplicating the business.
2. **`converted` is a dead end.** It records *that* a lead converted, never
   *into what*. The point of this CRM is producing tenants, and there is nowhere
   to put the identifier — so at the moment of success the CRM stops knowing
   anything, and nothing in the estate can answer "which prospecting produced
   this tenant".
3. **Lost is not final.** A business lost in March that returns in November is a
   new opportunity against the same organisation, not a resurrection of the old
   row.

Adding these tables to an empty schema is a migration. Adding them to a CRM with
two years of history means reconstructing which activities belonged to which
deal, from data that never recorded it.

## Data model

Six tables, prefixed `crm_` so they coexist with `leads` during migration.

```
crm_organisations
  id uuid pk, name text NOT NULL, website_url text, location text,
  category text[], tags text[],
  -- deliberately no `notes` column: the activity log is the record. A standing
  -- note and an event log describing the same business would drift apart, and
  -- the migration puts `leads.notes` into an activity for exactly that reason.
  converted_product     text NULL,        -- which product they became something in
  converted_ref         text NULL,        -- opaque, product-scoped id
  converted_label       text NULL,        -- human name for display
  converted_at          timestamptz NULL,
  converted_link_method text NULL,        -- 'matched' | 'manual'
  import_id uuid NULL fk crm_imports,
  created_at, updated_at

crm_contacts
  id uuid pk, organisation_id uuid NOT NULL fk,
  name text, email text, phone text,
  instagram_handle text, followers_count int, posts_count int, biography text,
  is_primary boolean NOT NULL DEFAULT false,
  source text,                            -- where this contact came from
  sourced_at timestamptz,                 -- when
  lawful_basis text,                      -- DPDP basis under which we hold this
  created_at, updated_at
  -- unique index on lower(email) where email is not null

crm_opportunities
  id uuid pk, organisation_id uuid NOT NULL fk,
  product text NULL,                      -- null until qualified; see below
  stage crm_stage NOT NULL DEFAULT 'new', -- new|contacted|qualified|won|lost
  owner text, source text,
  next_action_at timestamptz NULL,        -- the queue's engine
  next_action_note text,
  last_contacted_at timestamptz,
  is_starred boolean NOT NULL DEFAULT false,
  closed_at timestamptz, lost_reason text,
  created_at, updated_at

crm_activities
  id uuid pk,
  organisation_id uuid NOT NULL fk,       -- always
  opportunity_id  uuid NULL fk,           -- when deal-scoped
  contact_id      uuid NULL fk,           -- when person-scoped
  kind crm_activity_kind NOT NULL,
  actor text NOT NULL, body text, metadata jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now()

crm_suppressions
  id uuid pk, email text, instagram_handle text,
  reason text NOT NULL, created_by text NOT NULL, created_at timestamptz
  -- at least one of email / instagram_handle NOT NULL

crm_imports
  id uuid pk, filename text, row_count int, skipped_count int,
  created_by text NOT NULL, created_at timestamptz
```

`crm_stage`: `new | contacted | qualified | won | lost`.
`crm_activity_kind`: `note | dm_sent | dm_received | email_sent | email_received | call | stage_change | assigned`.

### Load-bearing decisions inside the model

**Stage lives on the opportunity, never on the organisation or contact.** This is
the single change that buys everything above: the same café can be `lost` for
Mark8ly and `qualified` for Kora simultaneously, and neither overwrites the other.

**`won` is a stage; conversion is a fact about the organisation.** They are
separate because agreeing and actually becoming a tenant are separate events,
often weeks apart, and the gap between them is where deals die silently.

**`product` is nullable until `qualified`.** An early prospect has not been
matched to a product yet, and forcing a guess at import would fabricate
attribution the funnel later reports as fact. Required from `qualified` onward,
enforced at the boundary.

**Activities attach to the organisation always, optionally to an
opportunity/contact.** So "everything we have ever said to this business"
survives across deals, while "what happened in this deal" stays scoped. A note
taken before any opportunity exists still has a home.

**Every stage transition writes a `stage_change` activity, without exception.**
This is not logging — it is the only record of *when* a stage was entered, and
therefore the only thing that makes funnel measurement possible later. It cannot
be reconstructed afterwards.

**`converted_ref` is opaque and product-scoped**, always stored beside
`converted_product`. Mark8ly produces tenants, Kora has users, HMS has
facilities. A bare `converted_tenant_id` would bake one product's vocabulary
into a cross-product table — the same defect `/api/admin/apps/[product]/audit-logs`
had before #139, where mark8ly's rows appeared under every product's URL.

## Scope

**In v1:** capture (CSV import, manual add), qualify (detail view), work (the
queue, ownership, next action), record (activity log), progress (stage
transitions with loss reasons), suppress (do-not-contact), govern (capability
gates, audit, erasure path), and convert (record the link).

**Deferred to v2:** measurement surfaces (funnel, conversion rate, source
performance), dedupe and merge, bulk edit, export, a pipeline board view.

**Deliberately never**, unless the business changes shape: sequences and cadence
automation, lead scoring, custom field definitions, forecasting and quotas,
territory management, quotes and line items (M8 Commercial owns pricing).

### Two v1 items that are easy to miss

**The suppression list must exist before the first import.** If someone asks not
to be contacted, that has to survive the next CSV. A suppression list added later
cannot retroactively protect anyone it should have — a re-import of an
overlapping file silently resurrects them and someone contacts a person who
explicitly said no.

**Lawful basis is a schema field, not a policy document.** Per #154, CRM contact
data is personal data under DPDP on a marketing-consent / legitimate-interest
basis. We hold scraped social profiles — biography, follower counts, location —
about people who never filled in a form. `source`, `sourced_at` and
`lawful_basis` on `crm_contacts` record what we hold and why; erasure feeds
#140's estate erasure queue rather than growing a second one.

## Surfaces

Four routes, with their ids in `packages/console-core`.

**A new rail group, `Growth`.** The rail currently has Operate, Health and
Governance; none fits. The CRM is neither platform operation nor estate health
nor accountability — it is the only surface in the console about acquiring
customers rather than running what exists, and burying it in Operate would put a
sales queue next to service health. `nav.test.ts` covers `platformNav` and
asserts group membership and adjacency, so the group is added there deliberately
rather than incidentally.

### `/platform/crm` — the queue

Two tabs.

**Work** — the daily loop, in two groups:
- **Due**: `next_action_at <= now()`, most overdue first. Somebody committed to
  these.
- **Drifting**: no `next_action_at`, and `last_contacted_at` older than the
  staleness window. Rendered below, quieter.

They are separated rather than merged because a rule-surfaced lead must not look
identical to one an operator deliberately scheduled.

**Handoff** — everything at stage `won` with no conversion recorded, ordered by
how long it has been stuck, with the product's reported idle time beside it when
available. This gap is invisible today and is where agreed deals die.

Built on the kit's `QueueList` (product badge, status slot, `waitingSince`,
`dueAt`) with `FilterBar` for product, stage and owner. All five surface states
via `resolveState` from `@/components/kit/surface-state` — **not** from
`states.tsx`, which carries a load-bearing `"use client"`.

### `/platform/crm/[organisation]` — detail

`DetailLayout` with a summary rail (name, location, category, conversion if any)
and tabs: **Activity** (full log, newest first), **Contacts**, **Opportunities**
(every deal against this business, closed ones included).

Actions: log activity, set next action, advance stage, mark won/lost with a
reason. Marking won prompts for what it produced.

### `/platform/crm/import`

Upload, then a **dry-run preview before anything is written**: how many rows are
new, how many match an existing organisation, how many are suppressed and will be
skipped, how many are malformed. Only then commit, as one `crm_imports` batch so
a bad import is identifiable and reversible. Dedupe on `lower(email)` and
`instagram_handle`.

### `/platform/crm/suppressions`

View, add with a reason, remove. Checked at import and when logging outreach.
Removals are audited — removing someone from a do-not-contact list is the
consequential direction.

### Capability gating

Delete gates on `hard-delete` and writes an audit row through `auditedOperation`
(#204), which wraps the operation so a caller cannot obtain the result without
the audit write having happened.

**Known gap, stated rather than papered over:** #153 asks for bulk import to be
capability-gated, but `CAPABILITIES` is a closed set of seven — `read`,
`respond`, `rotate-credentials`, `adjust-balance`, `execute-refund`,
`mass-send`, `hard-delete` — and none fits importing prospects. Adding one is a
Zitadel role change, outside this work. v1 gates import on console entry (`read`)
plus a full audit row. That is weaker than #153 asks, and picking a near-fit
capability would imply the wrong thing.

## Lead → conversion

There is **no platform-admin tenant-create path**. Tenants are created
exclusively by onboarding completion (#111). The console cannot mint one, and
should not — that path exists so every tenant has a real, consented onboarding
behind it.

```
opportunity won   →   awaiting conversion   →   in flight   →   converted
(stage = won)         (nothing observed)        (product      (ref recorded)
                                                 reports it)
```

**Onboarding differs per product**, and most products have no observable
onboarding at all. So the CRM never reads a product's tables. It asks.

### The conversion-status contract

A deliverable of this design, implemented by each product on its existing admin
API — the road already exists, with HMAC signing Kora and Fe3dr already use.

```
GET {product_admin_api}/internal/conversion-status?email=<email>

200 { state: "none" | "in_flight" | "complete",
      ref?:        string,   // product-scoped id — tenant, facility, account
      label?:      string,   // human name for display
      idle_hours?: number,   // how long stalled, when in_flight
      observed_at: string }

anything other than a valid 200 (404, 501, unreachable, timeout) → unknown
```

**RULING 27 (binding, #153).** The product implements this endpoint on its own
admin API. **The console never calls it directly, and holds no
product → base-URL registry.** Every other cross-product read the console
makes already goes through `apps/web` — tickets, support analytics, the
aggregate audit log — because `apps/web` holds the HMAC keys Kora and Fe3dr
require to sign requests to their own admin APIs. Moving those keys into the
console would be a secret-distribution change, not a refactor, and the same
constraint applies here: the console asks `apps/web` at
`/api/admin/apps/{product}/conversion-status?email=…`, and `apps/web` is what
actually reaches the product's `/internal/conversion-status` above, signing
the request with the key it already holds. A product with no adapter wired up
yet, and a product the console has simply never heard of, both surface to the
console as the same thing — `apps/web` answering something other than a valid
200 — which Ruling 28 below already resolves to `unknown`. There is no second
list of product base URLs to keep in sync with anything.

**RULING 28.** 404 originally carried "product has no conversion concept" as a
definite answer. It cannot: 404 is also what this exact route returns when it
does not exist at all, which is indistinguishable on the wire from the product
having answered — and true of every product before its endpoint ships. A
meaning chosen for "the product spoke" cannot also be the framework's own
answer for "there is no route here". "No conversion concept" and "not
implemented" are the same fact from the CRM's side anyway — nothing can be
learned either way — so both collapse into `unknown`, alongside 501, an
unreachable product, a timeout, and a malformed body. Only an explicit 200
produces a definite state; a product asserting "not converted" does so
honestly, by answering `200 { state: "none" }`.

Three rules, each because the alternative fails quietly:

1. **Only an explicit 200 produces a definite state.** 404, 501, an
   unreachable product, a timeout, or a malformed body all mean `unknown`,
   never `none`. A falsely negative conversion under-reports the funnel and
   leaves a live merchant sitting in the handoff queue as though they had
   stalled.
2. **The product's answer only ever adds a conversion, never removes one.** The
   CRM's own `stage = won` is authoritative about the agreement.
3. **`ref` is opaque and stored with `converted_product`. Email is the lookup
   key, but the match itself is only a suggestion an operator confirms.** A
   tenant id and a facility id are only meaningful together with whose
   namespace they are in; the person who onboards may not be the person
   prospected, and a wrongly auto-linked conversion corrupts exactly the
   attribution this exists to produce. `converted_link_method` records which
   way it happened.

**Coupling test** — if the platform is unavailable, must the product still
function? Yes. The product never calls us; we call it, and it holds no platform
state. This passes cleanly where reading `onboarding_sessions` over the mark8ly
grant does not (#160).

**Ship order:** manual linking works for every product from day one. Mark8ly
implements the contract first as the reference — it already has the data in
`onboarding_sessions` (`email`, `status`, `last_activity_at`, `tenant_id`), so
its implementation is a query it can already answer. Every other product is
manual until it implements the endpoint, and the surface says which is which
rather than implying it knows.

## Migration

Each of the ~259 `leads` rows becomes one organisation + one contact + one
opportunity.

| From | To |
|---|---|
| `company`, falling back to `name`, then `instagram_handle` | `crm_organisations.name` |
| `website_url`, `location`, `category`, `tags`, `has_website` | organisation |
| `email`, `name`, `phone`, `instagram_handle`, `followers_count`, `posts_count`, `biography` | contact |
| `source` | contact `source`; `created_at` → `sourced_at` |
| `status` (`converted` → `won`) | opportunity `stage` |
| `owner`, `last_contacted_at`, `is_starred` | opportunity |
| `notes` | an initial `crm_activities` row of kind `note` |
| `lead_activities` (`status_change` → `stage_change`) | `crm_activities`, attached to the produced opportunity |

`product` is left null — migrated leads were never matched to one, and inventing
a value would fabricate attribution the funnel later reports as fact.

**No attempt to infer shared organisations.** Two leads at the same company
become two organisations. Merging two later is easy; un-merging is not.

The migration is a dry-run-first script reporting counts before writing, and it
is idempotent — re-running produces no duplicates.

`leads` and `lead_activities` are **not dropped** by this work. They are left
in place until the console surfaces are proven, then retired with
`/admin/apps/mark8ly/leads` under the ratchet.

## Testing

- Queue boundaries: due, not-yet-due, drifting, and a lead with a future
  `next_action_at` that must *not* appear.
- **A stage transition always writes a `stage_change` activity** — asserted
  directly, since funnel measurement depends on it and the failure is silent.
- Suppression is checked at import, with a guards-the-guard case: a test that
  passes when the suppression check is removed entirely is not a test.
- Import dry-run counts match what commit actually writes.
- Migration is idempotent, and its row counts reconcile against `leads`.
- Conversion contract: a 501 renders `unknown`, **not** `none` — the assertion
  that matters most.
- Delete writes an audit row, and a failed audit write fails the delete.

## Ship order

1. **Schema and migration** — tables, dry-run migration, reconciliation counts.
2. **Queue and detail** — the daily loop; usable before anything else exists.
3. **Import and suppression** — suppression lands *with or before* import.
4. **Handoff and the conversion contract** — manual linking, then mark8ly's
   adapter as the reference implementation.

## Open items

- The import capability gap above needs a decision about whether `CAPABILITIES`
  gains a member (a Zitadel role change) or import stays audited-only.
- The staleness window for **Drifting** needs a number. Proposed: 14 days,
  configurable in one constant, revisited once there is real usage.
- Erasure is a v1 *path*, but its integration with #140's estate queue is that
  issue's work, not this one's.
