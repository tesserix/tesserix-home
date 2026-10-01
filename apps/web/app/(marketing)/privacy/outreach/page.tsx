import type { Metadata } from "next";
import Link from "next/link";
import {
  OUTREACH_NOTICE_LAST_UPDATED,
  LegalPage,
  LegalSection,
} from "../../legal/legal-page";

export const metadata: Metadata = {
  title: "How we found you",
  description:
    "What business contact details Tesserix holds about you, where we got them, and how to tell us to stop.",
  alternates: {
    canonical: "/privacy/outreach",
  },
};

/**
 * The GDPR Article 14 notice for people we contacted without them having
 * given us their details — currently the Mark8ly seller outreach list.
 *
 * This is a SEPARATE PAGE from /privacy on purpose. Article 14 has to be met
 * by the first communication, which for us is a cold Instagram DM, and
 * Article 12(1) requires that notice be "concise, transparent, intelligible
 * and easily accessible". Pointing a two-line DM at the eleven-section
 * general policy meets neither: the recipient has to work out which of those
 * sections is about them, and none of them is — /privacy describes data
 * people hand us when they sign up.
 *
 * The one disclosure that makes this page necessary rather than merely
 * convenient is Article 14(2)(f), "from which source the personal data
 * originate". That is the obligation with no analogue when data comes from
 * the person directly, and it is why section 02 names Apify and Instagram
 * outright instead of saying "third-party sources".
 */
export default function OutreachPrivacyNoticePage() {
  return (
    <LegalPage
      eyebrow="Privacy"
      title="How we found you"
      description="If we messaged you out of the blue about Mark8ly, this page explains what we hold, where we got it, and how to make us stop."
      lastUpdated={OUTREACH_NOTICE_LAST_UPDATED}
    >
      <LegalSection number="01" title="What we hold about you">
        <p>
          Only what your Instagram profile showed publicly at the time we
          looked:
        </p>
        <ul className="list-disc space-y-2 pl-5">
          <li>Your account handle and display name.</li>
          <li>Your profile description, as written, and any link in it.</li>
          <li>Your follower and post counts.</li>
          <li>
            The country we inferred from your profile, and the product
            category we guessed at — jewellery, candles, crochet and so on.
          </li>
        </ul>
        <p>
          We hold no private messages, no email address unless your profile
          published one, no payment details, and nothing from a private
          account.
        </p>
      </LegalSection>

      <LegalSection number="02" title="Where we got it">
        <p>
          We did not get it from you. We found your profile by searching
          public Instagram accounts for makers and small sellers, using a
          third-party web-scraping service,{" "}
          <a
            href="https://apify.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-foreground underline-offset-4 hover:underline"
          >
            Apify
          </a>
          . Everything in section 01 came from the public version of your
          profile as Apify recorded it. We have not bought your details from
          a list broker and we have not combined them with data from anywhere
          else.
        </p>
      </LegalSection>

      <LegalSection number="03" title="Why we contacted you">
        <p>
          We build Mark8ly, a storefront for people who currently sell by
          taking orders in their direct messages. We approached you because
          your public profile suggested you sell that way. The only purpose is
          to ask whether that is a problem worth solving for you. We are not
          profiling you, scoring you, or making any automated decision about
          you.
        </p>
      </LegalSection>

      <LegalSection number="04" title="Our legal basis">
        <p>
          In the UK and the EU we rely on our legitimate interests under
          Article 6(1)(f) of the GDPR — approaching a business about a product
          relevant to how that business operates. We assessed that interest
          against your interests and rights before contacting you, and we will
          share that assessment with you on request.
        </p>
        <p>
          In India, information you have yourself made publicly available
          falls outside the Digital Personal Data Protection Act 2023 under
          section 3(c)(ii). We rely on that, and we still honour the requests
          below.
        </p>
        <p>
          In Australia, Canada and New Zealand we rely on the equivalent
          provisions for business contact information published openly, in a
          business capacity, where our message relates to that business.
        </p>
      </LegalSection>

      <LegalSection number="05" title="Telling us to stop">
        <p>
          Reply <strong>STOP</strong> to our message, or email{" "}
          <a
            href="mailto:privacy@tesserix.app?subject=Outreach%20objection"
            className="text-foreground underline-offset-4 hover:underline"
          >
            privacy@tesserix.app
          </a>
          . Either one is enough, and you do not have to give a reason.
        </p>
        <p>
          Where the GDPR applies you have an absolute right to object to
          direct marketing under Article 21(2): once you object we must stop,
          with no balancing exercise. We add you to a suppression list so the
          same profile cannot be re-imported and contacted again by mistake.
          If you would rather we deleted the record outright than suppressed
          it, say so and we will.
        </p>
      </LegalSection>

      <LegalSection number="06" title="How long we keep it">
        <p>
          If you do not reply, we delete the record{" "}
          <strong>twelve months</strong> after we collected it. If you ask us
          to stop, we keep only the minimum needed to honour that — a one-way
          fingerprint of your handle on the suppression list — so that we do
          not contact you again. If you reply and want to talk, it becomes an
          ordinary business contact record and our{" "}
          <Link
            href="/privacy"
            className="text-foreground underline-offset-4 hover:underline"
          >
            general privacy policy
          </Link>{" "}
          applies.
        </p>
      </LegalSection>

      <LegalSection number="07" title="Your other rights">
        <p>
          You can ask us for a copy of what we hold, ask us to correct it, or
          ask us to erase it. Email{" "}
          <a
            href="mailto:privacy@tesserix.app"
            className="text-foreground underline-offset-4 hover:underline"
          >
            privacy@tesserix.app
          </a>{" "}
          and we will respond within one month.
        </p>
        <p>
          If you are unhappy with how we handled it you can complain to your
          data protection authority — the Information Commissioner&apos;s
          Office in the UK, or your national authority in the EU. You do not
          need to come to us first.
        </p>
      </LegalSection>

      <LegalSection number="08" title="Who we are">
        <p>
          Tesserix Pty Ltd (ACN 694 070 865), 5 Tagu Place, Kings Park NSW
          2148, Australia, is the controller for this outreach. Reach us at{" "}
          <a
            href="mailto:privacy@tesserix.app"
            className="text-foreground underline-offset-4 hover:underline"
          >
            privacy@tesserix.app
          </a>
          .
        </p>
      </LegalSection>
    </LegalPage>
  );
}
