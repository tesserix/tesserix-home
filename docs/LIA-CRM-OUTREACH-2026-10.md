# Legitimate Interests Assessment — Mark8ly seller outreach

**Status: DRAFT. Not a decision. Needs sign-off before any EU/UK contact.**

| | |
|---|---|
| Controller | Tesserix Pty Ltd (ACN 694 070 865), 5 Tagu Place, Kings Park NSW 2148, Australia |
| Processing | Cold B2B outreach to Instagram sellers about Mark8ly |
| Basis assessed | GDPR / UK GDPR Art 6(1)(f) — legitimate interests |
| Data subjects in scope | **175** (EU 148, UK 27) of 373 total leads — **98 approved**, 27 held, 50 excluded |
| Prepared | 1 October 2026 |
| Decision owner | *unassigned* |
| Legal review | *not obtained* |

Three decisions are marked **[DECIDE]** below. Two of them change what we may
lawfully send, so they cannot be deferred past the first DM.

---

## 1. Purpose test — is the interest legitimate?

**The interest.** We sell Mark8ly, a storefront for sellers who currently take
orders in Instagram DMs. We want to ask people who appear to sell that way
whether that is a problem worth solving for them.

This is a commercial interest, which Recital 47 accepts can be legitimate. It
is ordinary B2B prospecting: no special category data, no profiling, no
automated decision-making, no onward sale of the data.

**Who benefits.** Us, through a possible sale. Them, if the product is
relevant — the pain we are naming is one their own profile advertises. Third
parties: none.

**If we could not do it.** We would fall back to inbound marketing, which for
this audience means paid social against a segment Instagram does not let us
target precisely (small handmade sellers without a webshop). The @mark8ly
account has 6 followers after 14 posts, so organic reach is currently not a
route to these people.

**Assessment: the interest is legitimate.** Low confidence is not the issue
here; this limb is comfortably met.

---

## 2. Necessity test — is the processing necessary for it?

**Could we achieve this with less personal data?** The record is already close
to minimal: handle, display name, public bio text, follower/post counts,
public link, inferred country and category. We hold no email addresses beyond
any the profile published, no private messages, no payment data, and nothing
from private accounts.

The one field worth challenging is the **verbatim bio text**. It is personal
data and we could store a boolean instead. We keep the text because it is the
evidence for this assessment — specifically for the balancing test below,
where "their own profile says 'DM to order'" is the fact doing the work. A
boolean asserts that conclusion without supporting it, and a data subject
exercising access rights is entitled to see what we actually relied on.
Retaining it is therefore necessary *for the lawfulness of the processing*,
not merely convenient.

**Could we reach the same people another way?** Not at comparable cost or
precision — see §1. Instagram's own discovery surfaces do not expose this
segment; that is the finding recorded in `.claude/lead-sweep-state.md`.

**Assessment: necessary, and the data set is minimised.** One caveat: the 16
records with no bio text at all carry no evidence to justify retaining — see §3.

---

## 3. Balancing test — do their interests override ours?

This is the limb that decides it, and the honest answer varies sharply by
segment. The relevant question is Recital 47's: would these people
**reasonably expect** this processing?

### What favours us

- **They published the data themselves**, on a business or creator account, in
  a business capacity. Not a personal account; not a private one.
- **56 of the 175 explicitly invite contact** — their bios say "DM to order",
  "Commandes en DM", "contattami in direct", "Bestellung über DM". For these,
  a DM asking about their ordering process is close to the expected use of the
  channel they advertised.
- **The message is relevant to their stated trade.** We are not cross-selling
  something unrelated.
- **Low intrusion.** One message, to a business account, on the platform they
  chose for business. No tracking, no profiling, no enrichment from other
  sources.
- **Easy, absolute opt-out** offered in the first message (Art 21(2)), backed
  by a suppression list that survives re-import — `crm-suppressions-repo.ts`,
  checked at both preview and commit of every import.

### What favours them

- **They did not give us the data and do not know we hold it.** This is the
  core asymmetry, and the Art 14 notice exists to close it rather than excuse
  it.
- **Scraping is contested in the EU** in a way "it was public" does not
  resolve. Public availability is not a lawful basis; the Clearview AI
  decisions make that explicit.
- **Most are sole traders, not companies.** Their business contact details are
  also their personal data, so the B2B framing does not thin out the
  protection as much as it would for a corporate contact.
- **119 of 175 have no invitation to contact** in their bio. For them we are
  relying on "public business account" alone, which is the weakest version of
  the argument.
- **16 have no bio text at all**, and 31 more have only vague or aesthetic
  text. We have no evidence these 47 trade at all, let alone in a business
  capacity. For them the balancing test fails: we cannot show the
  business-capacity fact the whole assessment rests on.

### Conclusion, by tier

Tiering was computed over the 175, not estimated — see
`.claude/_eu_tiers.json` for the per-handle assignment.

| Tier | Count | Evidence | Assessment |
|---|---|---|---|
| A | **56** | Bio explicitly invites DM/orders — "DM to order", "Commandes en DM", "contattami in direct", "Bestellung über DM" | **Passes.** Reasonable expectation is strongest here. |
| B | **69** | Business capacity evident without an invitation: a trade identity (*créatrice*, *ceramista*, glassblower, Goldschmiedemeisterin), a legal status (*auto-entrepreneur*, *P.IVA*, SIRET, "a small business selling…"), or trading activity (shipping, prices, stockists, markets, commissions) | **Passes, narrowly**, conditional on the Art 14 notice landing in the first message and a working opt-out. |
| C | **47** | 31 with only vague or aesthetic bios ("L'arte italiana", "Enjoy Life Enjoy your Home"); 16 with no bio at all | **Fails as a class.** The 31 need individual review — see below. |
| X | **3** | Bio unrecoverable (`loopscrochetuk`, `mommakesartuk`, `handmade_mud_uk`) | **Fails by default.** Cannot assess what we cannot see. |

**[DECIDE 1] Approve tiers A and B — 125 contacts. Exclude C and X — 50
contacts.**

Two caveats on the C tier, both arguing for human review rather than a bulk
decision:

- An earlier draft of this document put tier B at ~100 and tier C at 19, from
  a keyword test that was too strict. It classified `mf.creation.crochet`
  ("Auto-entrepreneur") and `crochet_uk.couk` ("a small business selling
  handmade yarn cakes") as having no trading evidence. Both are strong
  business-capacity facts. The numbers above come from a corrected test.
- The corrected test still has false negatives — `jessdavidsglass`
  ("Manchester, UK based Glassblower crafting colourful homeware") sits in C
  only because "glassblower" was not in the pattern. **31 records is a
  reviewable number; review them by eye before excluding.** Expect several to
  move to B.

---

## 4. Germany

**[DECIDE 2] Germany (40 leads) is a materially different risk and is excluded
from this assessment.**

UWG §7 requires prior express consent for unsolicited electronic marketing,
including B2B, and German courts treat breach as unfair competition —
actionable by **competitors**, not only regulators. That is a private right of
action no LIA can cure, because the exposure is not about our lawful basis
under Art 6 but about the legality of the channel under national law.

Of Germany's 40, **27 fall in tiers A or B** — i.e. the German exclusion is
not removing weak records, it is removing defensible ones for a reason
unrelated to Art 6. That is 11% of the list and the second-largest EU market,
so it is worth advice rather than a silent drop. Until then: hold.

**Net effect of this assessment: 98 of 175 EU/UK contacts are approved for
outreach** (tiers A+B, less Germany), 27 held pending German advice, 50
excluded.

---

## 5. What must be true before the first DM

These are preconditions, not follow-ups.

1. **`/privacy/outreach` is live** and the URL is in the first message.
   Art 14(3)(a) gives one month from collection; the earliest leads were
   collected 29 September 2026, so the clock is already running.
2. **The opt-out works end to end** — a reply of "STOP" reaches a human and
   results in a suppression entry. Untested as of this draft.
3. **`privacy@tesserix.app` exists and is monitored.** The notice publishes it;
   the existing policy uses `sales@tesserix.app`. One of the two has to change.
4. **Retention is implemented, not just stated.** The notice says twelve months
   from collection. Nothing currently enforces that.

**[DECIDE 3] Confirm twelve months.** It is a proposal, not a derived number.
Shorter is easier to defend; longer needs a reason. The notice already states
it publicly, so changing it later means republishing the notice.

---

## 6. India — a separate point, not covered by this LIA

The 259 existing India contacts carry `lawful_basis = legitimate_interests`
(and before the #248 backfill, `not_recorded_pre_migration`). **DPDP has no
legitimate-interests basis.** Section 4 offers consent or the closed list of
"certain legitimate uses" in section 7, which does not include business
development, and there is no balancing test to fall back on. The label is a
category error — a GDPR concept applied to a statute that does not have it.

The defensible position is DPDP **s.3(c)(ii)**: the Act does not apply to
personal data the data principal made publicly available themselves. A public
Instagram business bio plausibly qualifies.

**Implemented, not yet run.** `dpdp_public_data_exempt` has been added to
`LawfulBasis` and to the selectable set (`apps/console/lib/crm-provenance.ts`),
and `backfillLawfulBasis` now takes `from` and `source` so the correction can
be applied through the audited writer. No migration was needed: the column is
plain `text` with no CHECK, deliberately so per that file's own comment.

Production state confirmed read-only on 1 October 2026:

| source | lawful_basis | contacts | erased |
|---|---|---|---|
| `instagram_outreach` | `legitimate_interests` | **259** | 0 |

That is the entire table — no other source exists yet.

**Run the relabel BEFORE importing the 373 new leads.** Today
`--source instagram_outreach` is belt-and-braces, because every row in the
table is the India cohort. The moment the new leads land, `legitimate_interests`
becomes the correct label for ~198 non-EU contacts and the right one for the
approved EU set, and a relabel keyed on the old basis alone would overwrite all
of them. Doing it now means the narrowing filter never has to be the only thing
protecting them.

Not blocking EU outreach. Should not ship with a known-wrong label either.

---

## 7. Review

Reassess if any of these change: the data we collect, the markets in scope,
the channel (DM → email changes the analysis materially), the message content,
or the volume. Otherwise review in twelve months.

**Reviewer:** *unassigned* · **Date:** —
