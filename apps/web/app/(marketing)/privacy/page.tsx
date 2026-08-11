import type { Metadata } from "next";
import { LAST_UPDATED, LegalPage, LegalSection } from "../legal/legal-page";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "How Tesserix Pty Ltd collects, uses, stores and protects your personal data.",
  alternates: {
    canonical: "/privacy",
  },
};

export default function PrivacyPage() {
  return (
    <LegalPage
      eyebrow="Privacy"
      title="Privacy Policy"
      description="How we collect, use, store and protect your personal data across Tesserix's products."
      lastUpdated={LAST_UPDATED}
    >
      <LegalSection number="01" title="Who we are">
        <p>
          Tesserix Pty Ltd (ACN 694 070 865, ABN 59 694 070 865) is a company
          registered in New South Wales, Australia, with its registered
          address at 5 Tagu Place, Kings Park NSW 2148, Australia.
        </p>
        <p>
          Our Fe3dr product is operated in India by Zivana Innovations LLP,
          part of Tesserix Pty Ltd, at Flat No-103, Block-C, Northern Heights
          Apartment, Kalarahanga Road, Kalarahanga, Bhubaneswar, Odisha
          751024, India. References to &quot;Tesserix&quot;, &quot;we&quot;,
          &quot;us&quot; or &quot;our&quot; in this policy cover both
          entities as applicable to the product you use.
        </p>
      </LegalSection>

      <LegalSection number="02" title="What we collect">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            Account details — name, email address, phone number, and business
            or store information you provide when you sign up.
          </li>
          <li>
            Usage and analytics data — how you interact with our products, to
            help us understand what&apos;s working and what isn&apos;t.
          </li>
          <li>
            Support correspondence — messages you send us through the contact
            form, email or in-product support.
          </li>
          <li>
            Billing details — invoicing and subscription information. We do
            not store your payment card details; these are handled directly
            by our payment processors.
          </li>
        </ul>
      </LegalSection>

      <LegalSection number="03" title="Why we collect it">
        <p>
          We use your data to provide and operate the service, process
          billing, respond to support requests, keep our products secure, and
          improve what we build. We do not sell your personal data.
        </p>
      </LegalSection>

      <LegalSection number="04" title="Who we share it with">
        <p>
          We share data only with the service providers that help us run
          Tesserix, and only to the extent necessary:
        </p>
        <ul className="list-disc space-y-2 pl-5">
          <li>Google Cloud Platform — hosting, Cloud SQL, Cloud Storage and Secret Manager.</li>
          <li>Cloudflare — DNS, content delivery and DDoS protection.</li>
          <li>Stripe and Cashfree Payments — payment processing.</li>
          <li>SendGrid — transactional email delivery.</li>
          <li>Our product analytics providers — usage analytics.</li>
        </ul>
        <p>
          Each of these providers processes data under its own agreement with
          us and only for the purpose we engage them for.
        </p>
      </LegalSection>

      <LegalSection number="05" title="Where it is stored">
        <p>
          Our infrastructure runs on Google Cloud Platform in the{" "}
          <code>asia-south1</code> region. Depending on the product and
          service provider involved, your data may be transferred to and
          processed in other countries, including Australia and the United
          States; where that happens, we require appropriate safeguards from
          the provider.
        </p>
      </LegalSection>

      <LegalSection number="06" title="How long we keep it">
        <p>
          We retain personal data for as long as your account is active and
          as needed to provide the service, meet legal and accounting
          obligations, and resolve disputes. If you ask us to delete your
          data, we will do so, subject to any legal retention requirements.
        </p>
      </LegalSection>

      <LegalSection number="07" title="Your rights">
        <p>
          Depending on where you&apos;re located, you may have rights to
          access, correct, delete or export your personal data, and to lodge
          a complaint with a data protection authority. This includes rights
          under the Australian Privacy Principles, India&apos;s Digital
          Personal Data Protection Act, and the GDPR where applicable. To
          exercise any of these rights, contact us using the details below.
        </p>
      </LegalSection>

      <LegalSection number="08" title="Security">
        <p>
          We encrypt data in transit and at rest, and apply the principle of
          least-privilege access across our systems, so only the people and
          services that need access to your data have it.
        </p>
      </LegalSection>

      <LegalSection number="09" title="Children">
        <p>
          Our products are not directed at, and are not intended for use by,
          anyone under 18 years of age.
        </p>
      </LegalSection>

      <LegalSection number="10" title="Grievance Officer">
        <p>
          In accordance with India&apos;s Digital Personal Data Protection
          Act, you can raise privacy grievances relating to Fe3dr with our
          Grievance Officer at{" "}
          <a
            href="mailto:sales@tesserix.app"
            className="text-foreground underline-offset-4 hover:underline"
          >
            sales@tesserix.app
          </a>
          .
        </p>
      </LegalSection>

      <LegalSection number="11" title="Changes and contact">
        <p>
          We may update this policy from time to time; the &quot;last
          updated&quot; date at the top of this page reflects the most recent
          revision. For any questions about this policy or your data, email
          us at{" "}
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
