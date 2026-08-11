import type { Metadata } from "next";
import { LAST_UPDATED, LegalPage, LegalSection } from "../legal/legal-page";

export const metadata: Metadata = {
  title: "Terms of Service",
  description:
    "The terms that govern your use of Tesserix's products, including Mark8ly and Fe3dr.",
};

export default function TermsPage() {
  return (
    <LegalPage
      eyebrow="Legal"
      title="Terms of Service"
      description="The terms that govern your use of Tesserix's products."
      lastUpdated={LAST_UPDATED}
    >
      <LegalSection number="01" title="Parties and entity">
        <p>
          These terms are between you and Tesserix Pty Ltd (ACN 694 070 865,
          ABN 59 694 070 865), a company registered in New South Wales,
          Australia, with its registered address at 5 Tagu Place, Kings Park
          NSW 2148, Australia. Where the product you use is Fe3dr, it is
          operated in India by Zivana Innovations LLP, part of Tesserix Pty
          Ltd.
        </p>
      </LegalSection>

      <LegalSection number="02" title="Acceptance of terms">
        <p>
          By creating an account or otherwise using a Tesserix product, you
          agree to be bound by these terms. If you&apos;re accepting on
          behalf of a business, you confirm you have authority to do so.
        </p>
      </LegalSection>

      <LegalSection number="03" title="Description of service">
        <p>
          Tesserix builds and operates specialized SaaS products, including
          Mark8ly (commerce infrastructure for online stores) and Fe3dr (a
          home-cooked food marketplace). Each product may have additional
          product-specific terms, which take precedence for that product
          where they conflict with these general terms.
        </p>
      </LegalSection>

      <LegalSection number="04" title="Accounts and eligibility">
        <p>
          You must provide accurate information when creating an account and
          keep your login credentials secure. You&apos;re responsible for
          activity that occurs under your account.
        </p>
      </LegalSection>

      <LegalSection number="05" title="Acceptable use">
        <p>
          You agree not to misuse our products — including attempting to
          disrupt our infrastructure, reverse-engineer our software, or use
          the service for unlawful purposes.
        </p>
      </LegalSection>

      <LegalSection number="06" title="Fees, billing, refunds and taxes">
        <p>
          Paid plans are billed as described at checkout for the relevant
          product. Prices for Australian customers are shown in AUD and are
          subject to an additional 10% GST. Refunds are considered on a
          case-by-case basis in line with the applicable consumer law.
        </p>
      </LegalSection>

      <LegalSection number="07" title="Intellectual property">
        <p>
          Tesserix and its licensors own all rights in the software,
          branding and content that make up our products. These terms
          don&apos;t transfer any of that ownership to you — you receive a
          licence to use the service as intended.
        </p>
      </LegalSection>

      <LegalSection number="08" title="Your data">
        <p>
          You own the data you put into our products — your store catalog,
          orders, customer records and similar business data. You can export
          it at any time, and we&apos;ll help you get it out if you decide to
          leave.
        </p>
      </LegalSection>

      <LegalSection number="09" title="Third-party services">
        <p>
          Our products rely on third-party infrastructure and processors —
          including Google Cloud Platform, Cloudflare, Stripe, Cashfree
          Payments and SendGrid — to operate. Your use of the service is also
          subject to those providers&apos; own terms where relevant.
        </p>
      </LegalSection>

      <LegalSection number="10" title="Warranty disclaimer">
        <p>
          Our products are provided &quot;as is&quot;, without warranties of
          any kind beyond those that cannot be excluded by law, including
          under the Australian Consumer Law.
        </p>
      </LegalSection>

      <LegalSection number="11" title="Limitation of liability">
        <p>
          To the extent permitted by law, Tesserix&apos;s liability to you
          for any claim arising from these terms or your use of the service
          is limited to the amount you paid us in the twelve months before
          the claim arose.
        </p>
      </LegalSection>

      <LegalSection number="12" title="Indemnity">
        <p>
          You agree to indemnify Tesserix against claims, losses or expenses
          arising from your misuse of the service or breach of these terms.
        </p>
      </LegalSection>

      <LegalSection number="13" title="Suspension and termination">
        <p>
          We may suspend or terminate your access if you breach these terms
          or if required to protect the security or integrity of our
          products. You may cancel your account at any time.
        </p>
      </LegalSection>

      <LegalSection number="14" title="Changes to these terms">
        <p>
          We may update these terms from time to time; the &quot;last
          updated&quot; date at the top of this page reflects the most recent
          revision. Continued use of the service after a change means you
          accept the updated terms.
        </p>
      </LegalSection>

      <LegalSection number="15" title="Governing law">
        <p>
          These terms are governed by the laws of New South Wales, Australia,
          and you submit to the exclusive jurisdiction of its courts.
        </p>
      </LegalSection>

      <LegalSection number="16" title="Contact">
        <p>
          Questions about these terms can be sent to{" "}
          <a
            href="mailto:sales@tesserix.app"
            className="text-foreground underline-offset-4 hover:underline"
          >
            sales@tesserix.app
          </a>
          .
        </p>
      </LegalSection>
    </LegalPage>
  );
}
