import type { Metadata } from "next";
import { LAST_UPDATED, LegalPage, LegalSection } from "../legal/legal-page";

export const metadata: Metadata = {
  title: "Cookie Policy",
  description: "How Tesserix uses cookies and similar technologies.",
};

export default function CookiesPage() {
  return (
    <LegalPage
      eyebrow="Legal"
      title="Cookie Policy"
      description="How we use cookies and similar technologies across our products."
      lastUpdated={LAST_UPDATED}
    >
      <LegalSection number="01" title="What cookies are">
        <p>
          Cookies are small text files stored on your device by your browser.
          We use them, and similar technologies like local storage, to make
          our products work and to understand how they&apos;re used.
        </p>
      </LegalSection>

      <LegalSection number="02" title="The cookies we use">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            Strictly necessary / session cookies — required for core
            functionality, including keeping you signed in. Our
            authentication uses encrypted session cookies for this purpose.
          </li>
          <li>
            Preference cookies — remember choices you&apos;ve made, such as
            display settings.
          </li>
          <li>
            Analytics cookies — help us understand how our products are used
            so we can improve them.
          </li>
        </ul>
        <p>
          We don&apos;t use advertising cookies or sell data collected
          through cookies.
        </p>
      </LegalSection>

      <LegalSection number="03" title="Controlling cookies">
        <p>
          Most browsers let you view, delete and block cookies through their
          settings. Blocking strictly necessary cookies will likely prevent
          you from signing in or using core features of our products.
        </p>
      </LegalSection>

      <LegalSection number="04" title="Changes and contact">
        <p>
          We may update this policy from time to time; the &quot;last
          updated&quot; date at the top of this page reflects the most recent
          revision. Questions about our use of cookies can be sent to{" "}
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
