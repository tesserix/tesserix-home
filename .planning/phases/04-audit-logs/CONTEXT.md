# Phase 4: Audit Logs Explorer — Context

**Status:** In flight 2026-05-01
**Backlog refs:** A2
**Surface:** `/admin/apps/mark8ly/audit-logs` (NEW)

## Phase boundary

Federated read (FR) on mark8ly's `audit_logs` table. Read-only.

**Locked:**
- Same FR pattern as Phase 1/2. SELECT grant on `audit_logs` already exists for `mark8ly_platform_admin`.
- Schema: `actor_user_id/email/type` (user/system/api), `action`, `resource_type/id`, `status` (success/failure), `severity` (info/warning/critical), `ip_address`, `metadata` jsonb.
- New Mark8ly rail entry: "Audit logs".
- Critical-severity tile on Mark8ly Overview (audit events in last 24h).
- All access via tesserix-home API routes (browser never queries mark8ly DB directly).

**Out of scope (deferred to a separate phase):**
- Platform Tickets (merchant → platform support) — needs cross-repo design (mark8ly admin UI + tesserix-home schema + endpoint). Tracked as a follow-up "Phase 5: Platform Tickets".
- Audit log alerting / Slack hooks.
- Audit log export (CSV / JSON download).

## Acceptance

- [ ] `/admin/apps/mark8ly/audit-logs` lists events newest-first, filterable by severity / status / action / resource type / actor email / time window
- [ ] Expandable row showing the full `metadata` JSON
- [ ] Mark8ly Overview gets a "Critical events (24h)" tile that links to the explorer pre-filtered to `severity=critical`
- [ ] Sidebar Mark8ly rail entry
- [ ] Type/lint clean; CI green; rollout complete
