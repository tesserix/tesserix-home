# Notification bell — design

**Issue:** tesserix-home#180. **Milestone:** M3 Growth (buildable now — reads platform-owned data).

The console has queues now (#133) and will grow more under M7. None of them announce themselves. This is the in-console bell: unread count, a panel of recent items, each linking to the thing that needs a human. Slack comes later, deliberately — designing the payload around a channel before the notion of a notification is settled would shape it around delivery rather than around the work.

## What a notification is here

Derived, never stored. Two sources, both already existing rows in `tesserix-postgres`:

| Source | Row | Reads as |
|---|---|---|
| A ticket arrives | `platform_tickets.created_at` | "New ticket · M8-1042 · Payout missing" |
| A merchant replies | `platform_ticket_replies` where `author_type = 'merchant'` | "Asha Pillai replied · M8-1042" |

There is no events table and no writer. A notification exists because a row exists; it cannot drift from the thing it describes, and it cannot outlive it. Every item links to `/platform/tickets/{uuid}` — the surface #133 built.

**Deferred:** the M7 threshold notifications the issue names (SEA review nearing its five-day SLA, erasure request nearing 30 days). Those queues have no console surface yet, so a notification about them would link nowhere. They arrive with their queues.

**Excluded permanently:** anything that fires on a schedule regardless of whether something changed. A bell that always has something in it is a bell nobody reads.

## Decisions

### D1 — Per-operator last-seen timestamp, not per-item receipts

The issue's option 1, which both Mahesh and the previous session leaned toward. One row per operator; unread is derived as "events newer than your last visit". No per-item state, no growth with items × operators, and it survives across devices. It cannot express "mark this one unread" — a feature nobody has asked for.

### D2 — The console gets direct access to `tesserix-postgres`

It has none today: `apps/console` has no database dependency and reads everything through `apps/web`'s admin API. That has to change here, for two independent reasons — last-seen must persist server-side, and the feed needs a cross-ticket query over `platform_ticket_replies` that the admin API does not expose in list form (only `getPlatformTicketReplies(ticketId)`, which would be N+1 across the queue).

Mirrors `charts/apps/company` exactly: `TESSERIX_DB_{HOST,PORT,NAME,USER,PASSWORD}`, credentials from the **existing** `tesserix-postgres-tesserix-admin` Secret already synced into the `tesserix` namespace. No new GCP Secret Manager entry. `tesserix-postgres` runs in the `tesserix` namespace, which the console's egress NetworkPolicy already permits in full — **no policy change** (verified against `charts/apps/console/templates/network-policy.yaml`).

Against the coupling test: `tesserix-postgres` is platform-owned, not a product database. If the platform is unavailable, no product stops working. This is the console reading its own store.

**Rejected — a new `apps/web` endpoint.** `apps/web` is being retired to a marketing site; adding surface to it is exactly the drift the route ratchet exists to stop.

**Rejected — cookie-held last-seen.** Device-local, and cross-device survival is the reason option 1 was chosen over receipts.

### D3 — Unread starts at zero, and reads never write

Unread = events with `created_at > last_seen_at`. A missing row means the operator has never opened the panel, and it renders as **0**, not "every ticket ever". A bell that opens with 500 in it on the day it ships is the bell the issue warns about. The feed still lists recent items — they are simply not shouted about.

The row is written when the operator opens the panel. No implicit writes on a GET.

### D4 — Bounded feed

Newest 20 events within the last 14 days. Cheap to query, scannable in a panel, and it bounds the blast radius of a busy week.

### D5 — The verb, and its capability

The bell's verb is **mark read**. It asserts `read` — the entry capability every internal operator holds.

This is deliberate and worth stating, because the standing rule is that every verb asserts a capability and the honest answer here is the lowest one. Last-seen is the operator's own state about their own attention; gating it behind `respond` would be theatre, and worse, it would mean an operator who can see the queue cannot dismiss its badge.

### D6 — Polling, not push

SWR on a 60-second interval against the console's first API route. The console is a low-traffic internal tool; realtime waits for a reason. One wrinkle: the middleware matcher covers `/api/*`, so an expired session answers a poll with a redirect to Zitadel rather than JSON. The client treats a non-JSON or redirected response as unavailable and stops rather than hammering.

### D7 — The bell lives in the sidebar, not a new header

The issue says "a bell in the console header". **The console has no header** — `app/(console)/layout.tsx` is a sidebar plus a main region, and the sidebar itself is rail switcher plus nav with no footer.

Building a header strip to hold one control would add chrome to every surface and change the vertical rhythm of every page, shipped alongside a first notification feature. Instead the sidebar grows a footer region — which is where "you and your stuff" belongs in a rail-based console, and where operator identity and sign-out will want to live later.

### D8 — Degrades quiet, and config lands first

Until the k8s change deploys, `TESSERIX_DB_*` is unset in the console pod. The bell must not break the header of every page for that window: the route answers instrumentation-unavailable and the bell renders quiet and disabled. Same shape as the Zitadel cutover — config lands, is verified in place, and the feature turns on without a code rollback.

### D9 — One database, one migration ledger

The new table's migration goes in `apps/web/db/migrations/` with the others, applied by the existing `scripts/db-migrate.mjs`. Not because it belongs to `apps/web`, but because `schema_migrations` is a single integer-versioned ledger and two runners against one ledger is how versions collide. Moving the migration system to the console is its own piece of work.

**Debt, recorded:** the migration runner for a platform-owned database lives in the app being retired.

## Schema

```sql
CREATE TABLE console_notification_reads (
  user_id      text PRIMARY KEY,
  last_seen_at timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
```

`user_id` is the session `sub` — the Zitadel subject, an opaque string, not a UUID. `text` for the same reason migration 0003 made `author_user_id` text.

## Surfaces this does not build

- Slack or email delivery (the follow-on, once a notification is settled here).
- Alerting. Alertmanager exists and is linked from the tools directory; a bell that competes with paging is a bell that gets muted.
- A feed of everything. Only things a human would act on.
