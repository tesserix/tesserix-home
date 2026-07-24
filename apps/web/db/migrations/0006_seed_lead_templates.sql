-- 0006 — Seed starter lead-marketing templates so the
-- /admin/notifications/lead-templates surface ships with content rather
-- than an empty list.
--
-- Voice follows mark8ly's editorial brand context: calm, premium,
-- refined — confident without urgency or hustle. Operators can edit
-- any of these via the admin editor; ON CONFLICT DO NOTHING means
-- re-running this migration doesn't clobber operator edits.
--
-- Variables intentionally minimal — the operator picks a lead, the
-- modal merges {{.FirstName}} from lead.first_name and {{.SenderName}}
-- from the operator's session. Add more variables later if/when the
-- send modal supports richer data.

INSERT INTO platform_lead_templates
  (key, label, subject, html_body, text_body, variables, status, product, version, updated_at, updated_by)
VALUES

-- ─── 1. lead_welcome — first-touch acknowledgment ────────────────────
(
  'lead_welcome',
  'Lead — welcome / first touch',
  'Welcome to Mark8ly, {{.FirstName}}',
  $html$<!doctype html>
<html lang="en">
  <body style="margin:0;background:#F7F6F2;color:#0E0E0C;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F7F6F2;padding:48px 24px;">
      <tr>
        <td align="center">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;padding:48px 40px;border:1px solid #ECECE6;">
            <tr>
              <td>
                <h1 style="margin:0 0 24px 0;font-family:'Source Serif 4',Georgia,serif;font-weight:400;font-size:28px;line-height:1.25;color:#0E0E0C;">
                  Glad you&rsquo;re here, {{.FirstName}}.
                </h1>
                <p style="margin:0 0 16px 0;font-size:16px;line-height:1.6;">
                  Mark8ly is a marketplace platform for independent merchants &mdash; a calmer way to run a store, with the polish of a flagship and the simplicity of a side project.
                </p>
                <p style="margin:0 0 16px 0;font-size:16px;line-height:1.6;">
                  We saw your interest come through and wanted to reach out personally. If there&rsquo;s anything specific you&rsquo;re trying to solve &mdash; migrating off Shopify, opening a second storefront, anything &mdash; just reply to this note.
                </p>
                <p style="margin:0 0 24px 0;font-size:16px;line-height:1.6;">
                  Otherwise, we&rsquo;ll be in touch with a few notes from the team over the coming weeks.
                </p>
                <p style="margin:32px 0 0 0;font-size:16px;line-height:1.6;color:#0E0E0C;">
                  &mdash; {{.SenderName}}<br/>
                  <span style="color:#6B6B66;font-size:14px;">Mark8ly</span>
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>$html$,
  $txt$Glad you're here, {{.FirstName}}.

Mark8ly is a marketplace platform for independent merchants — a calmer way to run a store, with the polish of a flagship and the simplicity of a side project.

We saw your interest come through and wanted to reach out personally. If there's anything specific you're trying to solve — migrating off Shopify, opening a second storefront, anything — just reply to this note.

Otherwise, we'll be in touch with a few notes from the team over the coming weeks.

— {{.SenderName}}
  Mark8ly$txt$,
  $vars$[
    {"name":"FirstName","type":"string","required":true},
    {"name":"SenderName","type":"string","required":true}
  ]$vars$::jsonb,
  'published',
  'mark8ly',
  1,
  now(),
  'seed'
),

-- ─── 2. lead_demo_invite — invite to a walkthrough ───────────────────
(
  'lead_demo_invite',
  'Lead — demo / walkthrough invite',
  'A walkthrough, whenever it suits',
  $html$<!doctype html>
<html lang="en">
  <body style="margin:0;background:#F7F6F2;color:#0E0E0C;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F7F6F2;padding:48px 24px;">
      <tr>
        <td align="center">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;padding:48px 40px;border:1px solid #ECECE6;">
            <tr>
              <td>
                <h1 style="margin:0 0 24px 0;font-family:'Source Serif 4',Georgia,serif;font-weight:400;font-size:28px;line-height:1.25;color:#0E0E0C;">
                  Hi {{.FirstName}} &mdash;
                </h1>
                <p style="margin:0 0 16px 0;font-size:16px;line-height:1.6;">
                  Happy to walk you through Mark8ly whenever it suits. About thirty minutes, no slides &mdash; we open the admin together and look at the things that matter for {{if .CompanyName}}{{.CompanyName}}{{else}}your store{{end}}.
                </p>
                <p style="margin:0 0 24px 0;font-size:16px;line-height:1.6;">
                  Pick a time that works:
                </p>
                <p style="margin:0 0 32px 0;font-size:16px;line-height:1.6;">
                  <a href="{{.MeetingURL}}" style="display:inline-block;background:#2D4A2B;color:#FFFFFF;padding:12px 24px;text-decoration:none;font-weight:500;">
                    Choose a time
                  </a>
                </p>
                <p style="margin:0 0 16px 0;font-size:14px;line-height:1.6;color:#6B6B66;">
                  Or reply with a few windows that work and I&rsquo;ll send a calendar hold.
                </p>
                <p style="margin:32px 0 0 0;font-size:16px;line-height:1.6;color:#0E0E0C;">
                  &mdash; {{.SenderName}}<br/>
                  <span style="color:#6B6B66;font-size:14px;">Mark8ly</span>
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>$html$,
  $txt$Hi {{.FirstName}} —

Happy to walk you through Mark8ly whenever it suits. About thirty minutes, no slides — we open the admin together and look at the things that matter for {{if .CompanyName}}{{.CompanyName}}{{else}}your store{{end}}.

Pick a time that works:
{{.MeetingURL}}

Or reply with a few windows that work and I'll send a calendar hold.

— {{.SenderName}}
  Mark8ly$txt$,
  $vars$[
    {"name":"FirstName","type":"string","required":true},
    {"name":"CompanyName","type":"string","required":false},
    {"name":"MeetingURL","type":"string","required":true},
    {"name":"SenderName","type":"string","required":true}
  ]$vars$::jsonb,
  'published',
  'mark8ly',
  1,
  now(),
  'seed'
),

-- ─── 3. lead_followup_no_response — gentle nudge ─────────────────────
(
  'lead_followup_no_response',
  'Lead — follow-up after no response',
  'Still curious, {{.FirstName}}?',
  $html$<!doctype html>
<html lang="en">
  <body style="margin:0;background:#F7F6F2;color:#0E0E0C;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F7F6F2;padding:48px 24px;">
      <tr>
        <td align="center">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;padding:48px 40px;border:1px solid #ECECE6;">
            <tr>
              <td>
                <h1 style="margin:0 0 24px 0;font-family:'Source Serif 4',Georgia,serif;font-weight:400;font-size:28px;line-height:1.25;color:#0E0E0C;">
                  No rush, {{.FirstName}}.
                </h1>
                <p style="margin:0 0 16px 0;font-size:16px;line-height:1.6;">
                  Just a quiet check-in. We never want to be the kind of company that pesters &mdash; if Mark8ly isn&rsquo;t the right fit right now, that&rsquo;s perfectly fine.
                </p>
                <p style="margin:0 0 16px 0;font-size:16px;line-height:1.6;">
                  But if anything has changed, or you&rsquo;d like to take another look at the platform, the door is open. Reply here and we&rsquo;ll pick up where we left off.
                </p>
                <p style="margin:32px 0 0 0;font-size:16px;line-height:1.6;color:#0E0E0C;">
                  &mdash; {{.SenderName}}<br/>
                  <span style="color:#6B6B66;font-size:14px;">Mark8ly</span>
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>$html$,
  $txt$No rush, {{.FirstName}}.

Just a quiet check-in. We never want to be the kind of company that pesters — if Mark8ly isn't the right fit right now, that's perfectly fine.

But if anything has changed, or you'd like to take another look at the platform, the door is open. Reply here and we'll pick up where we left off.

— {{.SenderName}}
  Mark8ly$txt$,
  $vars$[
    {"name":"FirstName","type":"string","required":true},
    {"name":"SenderName","type":"string","required":true}
  ]$vars$::jsonb,
  'published',
  'mark8ly',
  1,
  now(),
  'seed'
)

ON CONFLICT (key) DO NOTHING;
