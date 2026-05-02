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

### marketplace-api — shipping label envelope

**Where:** `mark8ly/services/marketplace-api/internal/shipping/labelmailer.go`

Current shape: short HTML + text body built inline via `fmt.Sprintf` in
`SendLabel()`. Subject also computed inline.

What's needed:
1. Create `internal/shipping/templates/label_email.html` and
   `label_email.txt`. Pull current Sprintf strings into them with
   `{{.Field}}` interpolation.
2. Add `embed.FS` for the templates directory.
3. Define a `RegisterFallbacks(loader)` function and call it from
   `cmd/marketplace-api/main.go` next to the existing orderdoc + giftcard
   registrations.
4. Refactor `SendLabel` to call `loader.Render(ctx, "shipping_label", data)`.
5. Add `WithLoader` to `SendGridLabelMailer`.
6. Tests mirroring orderdoc/giftcard pattern.

**Effort:** ~2 hours. Already in the same repo + DB as orderdoc, so no
loader-sharing question.

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

## Recommendation

Order of pickup:
1. **shipping_label** first (smallest, all in marketplace-api, no
   loader-sharing question). ~2 hours.
2. **otto OTP** second. Decide vendor-vs-go-shared up front; vendor is
   the pragmatic choice if homechef/fanzone adoption is >3 months out.
3. **dunning** last, only when there's content to author.

When `go-shared` move happens, also migrate platform-api +
marketplace-api off their own emailtemplates packages so all three
services share a single implementation.
