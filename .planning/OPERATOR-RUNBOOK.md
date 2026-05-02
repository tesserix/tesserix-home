# Operator runbook — email-templates registry activation

End-to-end activation in the order it should be done. Most YAML changes
are committed already (this session); the remaining work is:

1. Apply database migrations
2. Wait for ArgoCD to sync the new chart values + AuthorizationPolicies
3. Configure SendGrid Event Webhook
4. Create the GSM secret for the webhook public key
5. Run the round-trip smoke

You should be authenticated as a GCP operator (`gcloud auth login`) and
have `kubectl` pointed at the prod GKE cluster
(`gke_tesseracthub-480811_asia-south1_tesseract-prod-in-gke`) before
starting.

```bash
# Sanity check — confirm cluster context
kubectl config current-context
kubectl get ns tesserix mark8ly
```

## Step 1 — apply migrations

All four migrations are additive and idempotent (`IF NOT EXISTS` on
columns, `ON CONFLICT DO NOTHING` on seeds), so re-running is safe.

### 1.1 — tesserix-postgres (super-admin DB)

```bash
TESSERIX_PASS=$(kubectl get secret -n tesserix tesserix-postgres-tesserix-admin \
  -o jsonpath='{.data.password}' | base64 -d)

# 0005 — email_events + platform_lead_templates + platform_outbound_emails
kubectl exec -i -n tesserix pod/tesserix-postgres-1 -c postgres -- \
  env PGPASSWORD="$TESSERIX_PASS" psql -h localhost -U tesserix_admin -d tesserix_admin \
  < ../tesserix-home/db/migrations/0005_email_events_and_lead_templates.sql

# 0006 — seed 3 starter lead-marketing templates
kubectl exec -i -n tesserix pod/tesserix-postgres-1 -c postgres -- \
  env PGPASSWORD="$TESSERIX_PASS" psql -h localhost -U tesserix_admin -d tesserix_admin \
  < ../tesserix-home/db/migrations/0006_seed_lead_templates.sql

# Verify
kubectl exec -n tesserix pod/tesserix-postgres-1 -c postgres -- \
  env PGPASSWORD="$TESSERIX_PASS" psql -h localhost -U tesserix_admin -d tesserix_admin \
  -c "SELECT key, label, status FROM platform_lead_templates ORDER BY key;"
# Expect 3 rows: lead_demo_invite, lead_followup_no_response, lead_welcome
```

### 1.2 — mark8ly platform-api (`0013` — email_templates)

```bash
MARK8LY_PASS=$(kubectl get secret -n mark8ly mark8ly-postgres-mark8ly-platform-admin \
  -o jsonpath='{.data.password}' | base64 -d)

# Run platform-api's migration runner — it auto-applies any unapplied
# migrations on startup, but to do it eagerly:
kubectl exec -i -n mark8ly pod/mark8ly-postgres-1 -c postgres -- \
  env PGPASSWORD="$MARK8LY_PASS" psql -h localhost -U mark8ly_platform_admin \
  -d mark8ly_platform_api \
  < ../mark8ly/services/platform-api/migrations/0013_create_email_templates.up.sql

# Verify
kubectl exec -n mark8ly pod/mark8ly-postgres-1 -c postgres -- \
  env PGPASSWORD="$MARK8LY_PASS" psql -h localhost -U mark8ly_platform_admin \
  -d mark8ly_platform_api -c "\d email_templates"
```

### 1.3 — mark8ly marketplace-api (`000085` + `000086`)

```bash
# 000085 — create email_templates table (B1f orderdoc + giftcard)
kubectl exec -i -n mark8ly pod/mark8ly-postgres-1 -c postgres -- \
  env PGPASSWORD="$MARK8LY_PASS" psql -h localhost -U mark8ly_platform_admin \
  -d mark8ly_marketplace_api \
  < ../mark8ly/services/marketplace-api/migrations/000085_create_email_templates.up.sql

# 000086 — shipments.dispatched_email_sent_at column for dedup
kubectl exec -i -n mark8ly pod/mark8ly-postgres-1 -c postgres -- \
  env PGPASSWORD="$MARK8LY_PASS" psql -h localhost -U mark8ly_platform_admin \
  -d mark8ly_marketplace_api \
  < ../mark8ly/services/marketplace-api/migrations/000086_shipments_dispatched_email_sent_at.up.sql

# Verify
kubectl exec -n mark8ly pod/mark8ly-postgres-1 -c postgres -- \
  env PGPASSWORD="$MARK8LY_PASS" psql -h localhost -U mark8ly_platform_admin \
  -d mark8ly_marketplace_api -c "\d shipments" | grep dispatched_email_sent_at
```

## Step 2 — wait for ArgoCD to sync chart changes

The CI bot already pushed the image bumps. ArgoCD-driven pieces (env
vars, AuthorizationPolicy updates, ExternalSecret addition) are in the
tesserix-k8s commit you just merged from this session. Trigger a sync:

```bash
# Sync the company app + the two mark8ly apps that got AuthorizationPolicy edits.
argocd app sync company mark8ly-platform-api mark8ly-marketplace-api-admin --prune

# Confirm the new env vars landed
kubectl exec -n tesserix deploy/company -c company -- printenv \
  | grep -E "MARK8LY_(PLATFORM|MARKETPLACE)_API_URL"

# Confirm AuthorizationPolicy includes tesserix/sa/company
kubectl get authorizationpolicy -n mark8ly allow-platform-api-callers -o yaml \
  | grep -A1 "principals:" | grep tesserix
```

## Step 3 — configure SendGrid Event Webhook

In the SendGrid console:

1. Settings → Mail Settings → Event Webhook
2. **HTTP Post URL:** `https://tesserix.app/webhooks/sendgrid`
3. Enable: Processed, Delivered, Opened, Clicked, Bounced, Dropped, Spam Reports, Unsubscribes, Group Unsubscribes
4. Toggle on **Signed Event Webhook Requests**
5. SendGrid generates and displays an ECDSA public key (PEM). Copy it.

## Step 4 — store ECDSA public key in GSM

```bash
# Paste the PEM contents into a temp file, e.g. /tmp/sendgrid-pubkey.pem
gcloud secrets create prod-tesserix-sendgrid-webhook-secret \
  --replication-policy=automatic \
  --data-file=/tmp/sendgrid-pubkey.pem \
  --project=tesseracthub-480811

# Grant access to the company workload-identity SA
gcloud secrets add-iam-policy-binding prod-tesserix-sendgrid-webhook-secret \
  --member="serviceAccount:app-secrets-ext-secrets-prod@tesseracthub-480811.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor" \
  --project=tesseracthub-480811

# Force ExternalSecret to re-sync (or wait up to refreshInterval=1h)
kubectl annotate externalsecret -n tesserix company-secrets \
  force-sync=$(date +%s) --overwrite

# Verify the key landed in the K8s Secret
kubectl get secret -n tesserix company-secrets \
  -o jsonpath='{.data.SENDGRID_WEBHOOK_PUBLIC_KEY}' | base64 -d | head -3
# Expect "-----BEGIN PUBLIC KEY-----" header

# Restart the company pod so the new env var binds
kubectl rollout restart deployment/company -n tesserix
kubectl rollout status deployment/company -n tesserix --timeout=2m

# Don't forget /tmp cleanup
rm -f /tmp/sendgrid-pubkey.pem
```

## Step 5 — round-trip smoke

```bash
# Grab your tesserix.app session cookie from devtools (Application →
# Cookies → tesserix.app → tx_session) — paste it as SESSION_COOKIE.

SESSION_COOKIE='tx_session=<paste>' \
  ../tesserix-home/scripts/smoke-templates.sh \
  --base https://tesserix.app \
  --key welcome \
  --db platform_api \
  --to your.email@gmail.com

# If that passes, repeat for marketplace-api side
SESSION_COOKIE='tx_session=<paste>' \
  ../tesserix-home/scripts/smoke-templates.sh \
  --base https://tesserix.app \
  --key orderdoc_invoice_email \
  --db marketplace_api \
  --to your.email@gmail.com

# Then trigger a real send to validate engagement event ingestion:
# - Browser → /admin/notifications/templates/welcome (platform_api tab)
# - Send test → check inbox
# - Open the email
# - Browser → /admin/notifications/log → expect rows for processed/delivered/open
#   within 30s
```

## Things that should NOT be necessary (already done in code)

- ☑ Image rolls — tesserix-home CI does `kubectl set image` on every push to main; mark8ly CI auto-bumps tesserix-k8s/charts/apps/mark8ly-*/values.yaml. No manual image bump.
- ☑ Migration files — already committed in tesserix-home and mark8ly repos.
- ☑ env.MARK8LY_PLATFORM_API_URL + env.MARK8LY_MARKETPLACE_API_URL — added to argocd/prod/apps/global/company.yaml this session.
- ☑ ExternalSecret entry for SENDGRID_WEBHOOK_PUBLIC_KEY — added to charts/apps/company/templates/externalsecret.yaml this session.
- ☑ AuthorizationPolicy on mark8ly-platform-api + mark8ly-marketplace-api-admin — added `cluster.local/ns/tesserix/sa/company` this session.
- ☑ marketplace-api `mode.Admin` registers `/internal/templates/*` — added in mark8ly main.go this session.

## Diagnostic — if something goes wrong

| Symptom | Likely cause | Fix |
|---|---|---|
| `Could not load templates from platform-api` on `/admin/apps/mark8ly/notifications/templates` | mark8ly platform-api hasn't rolled, or migration `0013` not applied | Re-run §1.2 + check ArgoCD sync status |
| Save succeeds, log shows `templates/refresh non-2xx` 403 | AuthorizationPolicy not synced | `argocd app sync mark8ly-platform-api` |
| Save shows `templates/refresh non-2xx` 404 on marketplace-api | marketplace-api admin pod missing the new templateHandler.Register | Verify mark8ly main.go change rolled in latest image; restart marketplace-api-admin Knative service |
| Notification log empty after sending real email | SendGrid webhook unconfigured OR SENDGRID_WEBHOOK_PUBLIC_KEY missing | Re-do §3 + §4; tail tesserix-home logs for `/webhooks/sendgrid` 401 responses |
| `signature_invalid` 401s in webhook receiver | Public key in GSM doesn't match SendGrid's | Copy the key fresh from SendGrid console; re-run `gcloud secrets versions add prod-tesserix-sendgrid-webhook-secret --data-file=...` |

## Companion docs

- `.planning/SMOKE-TEMPLATES.md` — UI-driven validation steps + diagnostic table
- `.planning/HANDOFF.md` — full session shipped/pending state
- `scripts/smoke-templates.sh` — round-trip smoke script (used in §5)
