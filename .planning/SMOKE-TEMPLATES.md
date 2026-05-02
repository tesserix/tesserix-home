# Smoke — Email templates round-trip

How to confirm the email-templates registry is fully live in production.
Two surfaces to validate: **mark8ly product transactional templates** (auth /
verification / orderdoc / giftcard) and **tesserix lead-marketing templates**
(operator-authored, sent from tesserix-home directly).

## Phase 1 — operator activation (run-once)

Reproducing here from `HANDOFF.md` for one-stop reference. All blocking infra
work is on the operator side; the engineering work shipped already.

1. ☐ Bump image pins in `tesserix-k8s/argocd/prod/apps/global/company.yaml`:
   - `tesserix-home` → latest main (this commit or later)
   - `mark8ly platform-api` → `main-14c6e33` or later
   - `mark8ly marketplace-api` → `main-435319c` or later
2. ☐ Apply migrations to the relevant Postgres clusters:
   - `tesserix-home/db/migrations/0005_email_events_and_lead_templates.sql`
   - `tesserix-home/db/migrations/0006_seed_lead_templates.sql` ← new this session
   - `mark8ly/services/platform-api/migrations/0013_create_email_templates.up.sql`
   - `mark8ly/services/marketplace-api/migrations/000085_create_email_templates.up.sql`
   ```bash
   # Example — apply 0006 to tesserix-postgres
   PASS=$(kubectl get secret -n tesserix tesserix-postgres-tesserix-admin -o jsonpath='{.data.password}' | base64 -d)
   kubectl exec -n tesserix pod/tesserix-postgres-1 -c postgres -- env PGPASSWORD="$PASS" \
     psql -h localhost -U tesserix_admin -d tesserix_admin \
     < db/migrations/0006_seed_lead_templates.sql
   ```
3. ☐ Add env vars to the company chart (`tesserix-k8s/charts/apps/company/values.yaml`):
   - `MARK8LY_PLATFORM_API_URL=http://platform-api.mark8ly.svc.cluster.local`
   - `MARK8LY_MARKETPLACE_API_URL=http://marketplace-api.mark8ly.svc.cluster.local`
4. ☐ Verify NetworkPolicy / AuthorizationPolicy allows tesserix → mark8ly
   platform-api + marketplace-api egress on `/internal/templates/*`. The
   PUT path in tesserix-home does a fire-and-forget cache-evict ping; a
   blocked policy means saves still work but propagation waits 5min.
5. ☐ Configure SendGrid Event Webhook in console pointing at
   `https://tesserix.app/webhooks/sendgrid`. SendGrid will provide an
   ECDSA public key.
6. ☐ Store the ECDSA key in GSM as `tesserix-sendgrid-webhook-secret`,
   wire `SENDGRID_WEBHOOK_PUBLIC_KEY` env var into the company chart's
   ExternalSecret, ArgoCD-sync.

## Phase 2 — round-trip smoke (after operator activation)

### A. Product transactional template (mark8ly, edit + verify path)

1. Browser → `https://tesserix.app/admin/apps/mark8ly/notifications/templates`
2. Pick `welcome` (platform-api seed).
3. Append `[smoke YYYY-MM-DD HH:MM]` to the subject. Save.
4. Use the **Send test** field on the right rail; leave recipient blank to
   send to the operator's own email. Click. Confirm a new email arrives in
   < 30s with the tweaked subject.
5. **Restore the original subject** (delete the smoke marker). Save.

CLI alternative if you have a session cookie pasted from devtools:
```bash
SESSION_COOKIE='<cookie>' ./scripts/smoke-templates.sh \
  --base https://tesserix.app \
  --key welcome \
  --db platform_api \
  --to me@example.com
```

The script does GET → PUT → GET → test-send → restore in five steps and
asserts each one. Exits non-zero on any failure.

### B. Marketplace-api template (orderdoc / giftcard / shipment)

Same flow as A, but switch the `marketplace-api` tab on the templates list
page. Pick `orderdoc_invoice_email` or `shipment_dispatched`. The save path
hits marketplace-api's `/internal/templates/refresh` (not platform-api), so
this also validates the `MARK8LY_MARKETPLACE_API_URL` env you set in step 3.

### C. Engagement event ingestion (Wave 1.5 webhook)

1. Right after sending a test in step A or B, browser → `https://tesserix.app/admin/notifications/log`.
2. Within ~30s of send, you should see `processed` then `delivered` rows
   appear (auto-refreshes every 30s). If you opened the test email, an
   `open` row follows.
3. KPIs at the top should non-zero (sent / delivered / opens).

If the log stays empty after a real send arrives in your inbox: the
SendGrid Event Webhook isn't pointed at the right URL, or
`SENDGRID_WEBHOOK_PUBLIC_KEY` is unset and the receiver is rejecting every
event with `signature_invalid`. Tail tesserix-home pod logs for
`/webhooks/sendgrid` 401s.

### D. Lead-marketing template

1. Browser → `https://tesserix.app/admin/apps/mark8ly/leads`. Pick a real lead
   (or seed one).
2. Click **Send email**. Pick `lead_welcome` (seeded in 0006). Send.
3. Confirm: lead's `last_contacted_at` updates on the leads list, the email
   arrives in the lead's inbox, and a row lands in `platform_outbound_emails`
   (idempotency key in audit log).
4. Open the test email. Within 30s, an `open` event with `kind=lead_email`
   and the lead's `lead_id` should appear in `/admin/notifications/log`.

## Diagnostic — what to check when things fail

| Symptom | Likely cause | Where to look |
|---|---|---|
| Templates list shows "Could not load templates" | `email_templates` table not migrated in mark8ly DB | Apply migration `0013` (platform-api) or `000085` (marketplace-api) |
| Save succeeds but cache-refresh ping warns in logs | NetworkPolicy / AuthZ policy blocks tesserix → mark8ly `/internal/*` | Check istio AuthorizationPolicy on mark8ly side |
| Test-send returns 502 | Same as above, OR mark8ly's SendGrid client unconfigured | Tail mark8ly platform-api / marketplace-api pod logs |
| Notification log stays empty after a send | SendGrid webhook unconfigured, key missing, or signature failing | Check `/webhooks/sendgrid` returns 200 in tesserix-home logs |
| Lead-templates page shows empty after running 0006 | Migration ran on wrong DB/cluster, or `ON CONFLICT DO NOTHING` skipped because rows already exist | `SELECT key FROM platform_lead_templates` to confirm |
