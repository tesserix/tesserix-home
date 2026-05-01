# Phase 5: Platform Comms — Tickets + Announcements

**Status:** Ready to execute 2026-05-01
**Surfaces:**
- `/admin/platform-tickets` (list) + `/admin/platform-tickets/[id]` (detail) — super-admin
- `/admin/platform-announcements` (list + composer) — super-admin
- Public-but-tenant-scoped read endpoints for products to consume both
**Backlog refs:** Phase 5 (Platform Tickets) + I1 (In-app Announcement Broadcast)

## Phase boundary

Two features bundled because both follow the same pattern:
**platform-owned schema in tesserix-postgres → product-side reads/writes via internal endpoints → super-admin manages in tesserix-home.**

Bundling motivation: Phase 5.5 (mark8ly admin app changes) becomes one cohesive "Platform" submenu in mark8ly admin instead of two separate PRs.

**In scope (Phase 5 — this phase):**
- Schema in `tesserix-postgres` under `tesserix_admin`:
  - `platform_tickets`, `platform_ticket_replies`
  - `platform_announcements`
- Internal API for products:
  - `POST /api/internal/platform-tickets` — merchant files a ticket (GIP id_token forwarded)
  - `POST /api/internal/platform-tickets/[id]/replies` — merchant replies
  - `GET /api/internal/platform-announcements?product=mark8ly&tenant_id=…` — fetch active announcements
- Admin API in tesserix-home:
  - Tickets: GET list, GET detail, POST reply (with optional status change)
  - Announcements: GET list, POST create, PATCH update, soft-delete via `is_published=false`
- Super-admin UI:
  - Platform Tickets list + detail with reply thread
  - Platform Announcements list + composer
- Sidebar entries on **Platform rail**

**Out of scope (deferred to Phase 5.5 — mark8ly admin app PR):**
- mark8ly admin "Platform" submenu (Contact platform support form + Active announcements panel)
- HomeChef / future products' filing UI
- Email notifications when platform replies (depends on Phase 1 Wave 1.5)
- SLA breach detection
- Public unauthenticated ticket portal

## Locked decisions

| # | Decision | Locked value |
|---|---|---|
| 1 | Internal-API auth | Forward merchant's GIP id_token; tesserix-home verifies via existing GIP JWKS |
| 2 | Network path | Assume yes; add NetworkPolicy edit to Wave 0 if blocked |
| 3 | Reply notification model | In-app only on merchant side; email gated on Phase 1 Wave 1.5 |
| 4 | RBAC | Any merchant admin role can file/reply; only super-admin can reply or manage announcements |
| 5 | Cross-product list | Platform rail with product chip + product filter |
| 6 | Announcement audience filter | JSON shape: products list + tenant statuses (active/trial/past_due). Extensible later |
| 7 | Announcement scheduling | `starts_at` (default now) + nullable `ends_at` |

## Schema

```sql
-- in tesserix-postgres, schema tesserix_admin
CREATE TABLE platform_tickets (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id         text NOT NULL,
  tenant_id          uuid NOT NULL,
  ticket_number      varchar(20) NOT NULL,
  subject            varchar(300) NOT NULL,
  description        text NOT NULL,
  status             varchar(20) NOT NULL DEFAULT 'open',
  priority           varchar(10) NOT NULL DEFAULT 'medium',
  submitted_by_name  varchar(200) NOT NULL,
  submitted_by_email varchar(300) NOT NULL,
  submitted_by_user_id uuid,
  resolved_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pt_status_chk   CHECK (status   IN ('open','in_progress','resolved','closed')),
  CONSTRAINT pt_priority_chk CHECK (priority IN ('low','medium','high','urgent')),
  UNIQUE (product_id, ticket_number)
);

CREATE TABLE platform_ticket_replies (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id      uuid NOT NULL REFERENCES platform_tickets(id) ON DELETE CASCADE,
  author_type    varchar(20) NOT NULL,
  author_name    varchar(200) NOT NULL,
  author_email   varchar(300),
  author_user_id uuid,
  content        text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ptr_author_chk CHECK (author_type IN ('merchant','platform_admin'))
);

CREATE TABLE platform_announcements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title           varchar(200) NOT NULL,
  body            text NOT NULL,
  severity        varchar(20) NOT NULL DEFAULT 'info',
  audience_filter jsonb NOT NULL DEFAULT '{}'::jsonb,
  starts_at       timestamptz NOT NULL DEFAULT now(),
  ends_at         timestamptz,
  is_published    boolean NOT NULL DEFAULT false,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pa_severity_chk CHECK (severity IN ('info','warning','maintenance','incident'))
);
```

## Acceptance

- [ ] Migration `0002_platform_comms.sql` applied to tesserix-postgres
- [ ] Internal POST endpoints accept GIP-token-authenticated merchant filing
- [ ] Admin GET/POST/PATCH endpoints work for super-admin
- [ ] `/admin/platform-tickets` and `/admin/platform-announcements` pages live
- [ ] Sidebar Platform rail entries with open-ticket badge
- [ ] No mark8ly code changed in this phase (5.5 ships separately)
- [ ] Type/lint clean; CI green; rollout complete
