# Runbook: someone asks us to stop contacting them

Precondition 2 of `LIA-CRM-OUTREACH-2026-10.md`. **This is a procedure, not a
feature.** The console already refuses outreach to a suppressed contact and
already checks suppression at both ends of an import; what it cannot do is
notice that somebody objected. Nothing connects an Instagram reply to the
database, and nothing will — see #254.

So the whole opt-out guarantee rests on a person checking an inbox and typing
a handle into a form. That is workable for a two-person team and it is worth
being honest that it is the weakest link in the assessment.

## Where an objection can arrive

| Channel | Who sees it | Watch it how often |
|---|---|---|
| Reply to the DM — "stop", "unsubscribe", "remove me", "not interested" | @mark8ly Instagram inbox | **Every working day during an outreach run** |
| `privacy@tesserix.app` | Forwards to the monitored mailbox | Daily |
| A public comment on a post | @mark8ly notifications | Opportunistically |

**Check the Instagram message-requests tab, not just the main inbox.** A reply
from someone who does not follow @mark8ly lands in requests, and that is
exactly the population being messaged. An objection sitting unread in a tab
nobody opens is an objection we failed to action.

## What counts as an objection

Anything that reads as "stop", in any language. It does not have to use the
word, be polite, or cite a right. Under GDPR Art 21(2) objection to direct
marketing is **absolute** — there is no balancing test and nothing to weigh it
against. If you are unsure whether a reply was an objection, treat it as one.

"Not right now" and "maybe later" are objections for this purpose. We are not
running a nurture sequence.

## What to do

Within **one working day** of seeing it:

1. **Stop.** Do not reply with a pitch, a clarifying question, or an offer to
   check back later. A short acknowledgement is fine and not required.
2. **Add a suppression** — console → Platform → CRM → Suppressions → add, keyed
   on their Instagram handle. `@` and case do not matter; the handle is
   normalised on both the write and the read path.
3. **Set the reason** to something a stranger could read later: `objected to
   outreach, IG DM, 2026-10-14`. This column is what you will be reading back
   if the person ever asks what happened.
4. If they asked to be **deleted** rather than just left alone, see below —
   suppression alone is the wrong answer.

Within **one month** (Art 12(3)), if they asked a question rather than just
saying stop, answer it from `privacy@tesserix.app`.

## Suppress, do not just delete

Deleting the contact is **worse than doing nothing**, because the CSV that
produced them still exists. The next import re-adds them and they get messaged
again — by a system that no longer has any record that they objected.

The suppression list is the thing that survives a re-import. `previewImport`
and `commitImport` both check it, in that order, so a suppressed handle is
skipped at preview and skipped again at commit.

**If they asked to be forgotten**, that is an erasure, not a suppression, and
it is a stronger claim: a suppression can be lifted by an operator, an erasure
cannot. Use the erasure path, which pseudonymises the row and stamps
`erased_at`. Both import paths check erasure *before* suppression precisely so
the operator is shown the right remedy — "remove the suppression" is the wrong
instruction for someone who asked to be forgotten.

## Do not lift a suppression to "check in"

Removing a suppression re-exposes someone who asked not to be contacted. It is
audited (`crm.suppression.remove`) and there is no good reason to do it on this
list. The only legitimate case is fixing a suppression added against the wrong
handle.

## What good looks like

- Objection seen within one working day of arriving.
- Suppression entry exists with a legible reason.
- No further outreach activity against that contact — the console enforces this
  once suppressed, so the risk window is only between the reply and the entry.

## Known weaknesses, stated rather than hidden

- **Nobody is assigned to the Instagram inbox.** Assign someone before the
  first send, or the first objection is discovered late by definition.
- **No integration means no audit of what arrived**, only of what we recorded.
  If a reply is missed, nothing in the system knows it existed.
- **Replies from `privacy@tesserix.app` leave as the forwarding mailbox's own
  address**, because Cloudflare Email Routing is inbound-only.
