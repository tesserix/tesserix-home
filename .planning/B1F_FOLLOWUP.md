# B1f Follow-up — Inline-string mailers

The following templates were intentionally out of scope for the initial
B1f shipment (which covered orderdoc + giftcard). Each needs a small
refactor to extract its inline-string template body into a file before
it can join the registry. None blocks production today — they continue
to send fine via the existing inline approach.

## Scope per service

### otto — OTP email

**Where:** `mark8ly/services/otto/internal/mailer/sendgrid.go`

Current shape: subject, html body, text body all built inline as Go
string literals inside `SendOTP()`. No `embed.FS`, no template files.

What's needed:
1. **Shared loader access** — otto is a separate Go service with its
   own `go.mod`, so it cannot import `marketplace-api/internal/emailtemplates`
   directly. Two options:
   - **Vendor the loader** into otto: copy `loader.go` + `handler.go` +
     `sendgrid_test_sender.go` into `otto/internal/emailtemplates/`.
     Cheapest, ~250 LOC duplicated.
   - **Move loader to `go-shared`**: extract to `go-shared/emailtemplates/`
     so otto, marketplace-api, and platform-api all consume from one
     place. Cleaner long-term but requires a `go-shared` release +
     downstream version bumps in three repos.
2. **Otto migration** — `otto/migrations/000XX_create_email_templates.up.sql`
   with the same shape as marketplace-api 000085 / platform-api 0013.
3. **Extract OTP template** — pull subject + html + text out of
   `sendgrid.go` into `templates/otp.html`, `templates/otp.txt`. Use
   `embed.FS` like the other services. Subject template will be
   something like `"Your verification code: {{.Code}}"`.
4. **Refactor `SendOTP`** — replace inline body construction with a
   loader.Render call. Add `WithLoader` to the SendGridSender constructor.
5. **Wire main.go** — instantiate loader, register fallback, seed.
6. **Mount internal handler** — `POST /internal/templates/refresh` +
   `/:key/test`. Otto already has an /internal route group.
7. **Tests** — unit + handler + DB-backed byte-identity (mirror
   `marketplace-api/internal/emailtemplates/loader_test.go`).
8. **tesserix-home admin UI** — extend the database picker to include
   `otto_api` (or whichever name otto uses for its Postgres DB).
   Currently the picker hardcodes `platform_api` + `marketplace_api`.

**Effort:** ~3 hours assuming option 1 (vendor); ~1.5 days for option 2
(move to go-shared).

**Key decision before starting:** vendor vs `go-shared` move. If/when
homechef or fanzone start needing the registry, the `go-shared` move
becomes a forced function — better to do it once when there are three
consumers than to vendor twice.

### marketplace-api — shipping label envelope ❌ SKIP BY DESIGN

**Where:** `mark8ly/services/marketplace-api/internal/shipping/labelmailer.go`

Investigation during the session confirmed this email is NOT customer-facing.
The recipient comes from a free-form `req.Recipient` field the merchant
types into the admin UI (see `handlers/admin/shipments.go:1230`) — they
email the label to themselves, warehouse staff, a 3PL partner, or whoever
fulfills the package. The customer never sees this.

Operator-editable copy is low value here — internal/operational email,
recipient barely reads it (they want the PDF), subject + body are
functional, not branded.

**Decision:** leave inline `fmt.Sprintf` as-is. Don't lift to registry.

**The actual customer-facing gap** that we discovered — the missing "your
order has shipped" email between invoice and receipt — was filled in the
same session as `shipment_dispatched` (see HANDOFF.md "Recently shipped").
That covers the customer touchpoint properly with carrier + tracking.

### marketplace-api — dunning + payment_action_reminder

**Where:** `mark8ly/services/marketplace-api/internal/email/templates.go`

Current shape: package is **empty** — only the constant `TemplateID`
declarations exist. No actual templates have been written yet. The
referenced templates (`dunning_day_5`, `dunning_day_7`,
`payment_action_reminder`) are sent today via the campaign or order
paths, not via dedicated template files.

What's needed:
1. Decide what each template should *say* — this is design work, not
   refactor work. Likely needs collaboration with the billing team
   since dunning copy has compliance / tone considerations.
2. Once content exists, follow the same pattern as orderdoc: create
   files, register fallback, refactor sender to use the loader.

**Effort:** unknown (blocked on content). Defer until billing flow is
exercised in production and the actual copy is settled.

## Carrier-webhook hook for shipment_dispatched (related follow-up)

Separate from B1f but in the same neighborhood: `shipment_dispatched`
currently only fires from the admin status-update path. The carrier
webhook (`delhivery_webhook.go:300`) also stamps `shipped_at` when the
carrier reports pickup. To wire the email here too:

1. Call `dispatchShipmentDispatchedEmail` from the webhook handler
   when the status transition is the in_transit one.
2. **Add dedup** so the customer doesn't get two emails — one from
   admin marking shipped + one from the webhook arriving moments later.
   Cleanest: add `shipments.dispatched_email_sent_at` (new nullable
   column) and check it inside the same UPDATE that stamps shipped_at.
   `UPDATE...WHERE dispatched_email_sent_at IS NULL` pattern returns
   1 row only on the first transition.

**Effort:** ~1.5 hours including the migration + dedup test.

## Recommendation

Order of pickup:
1. **otto OTP** first. Decide vendor-vs-go-shared up front; vendor is
   the pragmatic choice if homechef/fanzone adoption is >3 months out.
2. **shipment_dispatched webhook hook + dedup** — high value (covers
   the case where merchant doesn't manually transition status; carrier
   reports pickup first).
3. **dunning** last, only when there's content to author.

When `go-shared` move happens, also migrate platform-api +
marketplace-api off their own emailtemplates packages so all three
services share a single implementation.
