---
id: 260903-ce1
slug: contact-edit
date: 2026-09-03
issue: 247
kind: quick
---

# An edit surface for a contact (#247)

## Why this, now — from production, not from the issue

```
contacts 259    with instagram_handle 259    with phone 26    with email 3
opportunities 259, ALL stage=new    ever contacted 0    conversions 0
```

The leads came from an Instagram scrape, so the handle is the channel and the
email is the thing a lead gives you mid-conversation. Meanwhile #246 just made
conversion matching work — **keyed on email**, and `fetchRowSignal` skips a row
with no `primaryEmail` without even asking the product.

So 256 of 259 leads cannot ever be matched, because they have no email, and
today there is **no way to give them one**: `updateContact` does not exist. The
only paths are erasing the contact (which corrupts the DPDP trail and loses
`created_at`) or adding a second contact (which then competes for primary in
the ordering seven queries depend on).

That is the chain this fixes, and it wants to be in place before the replies
start rather than after.

## Decisions the issue asks for, settled

1. **An edit writes an activity row, with a per-field diff.** #227 settled this
   for organisations and the argument is stronger here — changing the email on
   a live deal is exactly what a timeline exists to record. Same shape as
   `writeEditActivity`: `kind='note'`, `metadata {field: {from, to}}`, inlined
   rather than via `logActivity`, because a correction is not contact and must
   not bump `last_contacted_at`.
2. **An edit that changes nothing writes nothing.** No UPDATE, no activity.
   Opening a form and pressing save did not happen to the business.
3. **Collisions reuse `DuplicateContactError`** (#237), by catching `23505` on
   the two contact-identity constraints at the UPDATE the way `insertContact`
   does at the INSERT — matched on `code`/`constraint`, never on message text.
4. **`normalizeInstagramHandle` on update as on insert** (#236), so the string
   stored is the string `isSuppressed` keys its check on.
5. **Primary is changeable**, as a separate action from the field edit —
   promoting one contact demotes the others in the same transaction, because
   two primaries would make `primaryContactOrder`'s tiebreak arbitrary across
   the seven queries that share it.
6. **A plain contact delete is OUT OF SCOPE.** The issue raises it as a
   question; it is a different decision with DPDP consequences (what does
   removing a contact mean next to erasing one, and which one does the audit
   trail want?), and bundling it would hold up the typo fix that is blocking
   attribution. Recorded on the issue instead.

## Tasks

### T1 — `updateContact` in crm-writes.ts
Row locked `FOR UPDATE` and diffed inside the transaction, so the diff is
against the state this UPDATE actually replaced. Fields: name, email, phone,
instagramHandle. Normalisation and collision handling per decisions 3 and 4.

**Done when:** a changed field updates and writes one activity row; an
unchanged submit writes neither; a colliding email raises
`DuplicateContactError('email')`; a handle is stored normalised.

### T2 — `setPrimaryContact`
Promote one contact, demote its siblings, in one transaction. Writes an
activity row naming both directions.

**Done when:** exactly one contact of an organisation is primary afterwards,
and promoting the already-primary contact is a no-op that writes nothing.

### T3 — the server action, through `withCrmWrite`
Like every other CRM write: capability gate, audit, `DuplicateContactError`
mapped to its own message rather than the generic failure.

### T4 — the form
Beside the existing add-contact affordance on the organisation detail view.
