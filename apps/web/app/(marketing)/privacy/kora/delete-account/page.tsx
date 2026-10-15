import type { Metadata } from "next";
import Link from "next/link";
import {
  KORA_PRIVACY_LAST_UPDATED,
  LegalPage,
  LegalSection,
} from "../../../legal/legal-page";

export const metadata: Metadata = {
  title: "Delete your Kora account",
  description:
    "How to delete your Kora account and data, in the app or by email, and what is removed.",
  alternates: {
    canonical: "/privacy/kora/delete-account",
  },
};

const linkClass = "text-foreground underline-offset-4 hover:underline";

/**
 * The account-deletion page Google Play requires apps to link from their
 * Data safety form: a web address that explains how to ask for deletion
 * without reinstalling the app. Kora deletes from inside the app, so this
 * page points there first and gives email as the route for anyone who no
 * longer has the app.
 */
export default function KoraDeleteAccountPage() {
  return (
    <LegalPage
      eyebrow="Privacy · Kora"
      title="Delete your Kora account"
      description="Kora by Tesserix Pty Ltd. How to delete your account and everything in it."
      lastUpdated={KORA_PRIVACY_LAST_UPDATED}
    >
      <LegalSection number="01" title="In the app">
        <ol className="list-decimal space-y-2 pl-5">
          <li>Open Kora and sign in.</li>
          <li>Go to More → Profile.</li>
          <li>
            Optional: tap Export my data first if you want a copy.
          </li>
          <li>Tap Delete account, type &quot;delete&quot; and confirm.</li>
        </ol>
        <p>Deletion starts straight away and cannot be undone.</p>
      </LegalSection>

      <LegalSection number="02" title="Without the app">
        <p>
          Email{" "}
          <a
            href="mailto:kora-support@tesserix.app?subject=Delete%20my%20Kora%20account"
            className={linkClass}
          >
            kora-support@tesserix.app
          </a>{" "}
          from the address you signed up with, with the subject &quot;Delete
          my Kora account&quot;. We will confirm it is you, delete the
          account within 30 days, and reply when it is done.
        </p>
      </LegalSection>

      <LegalSection number="03" title="What is deleted">
        <ul className="list-disc space-y-2 pl-5">
          <li>Your profile, sign-in identity and settings.</li>
          <li>Food logs, meal photos and label photos.</li>
          <li>Saved meals, pinned foods and recipes.</li>
          <li>Weight, water, fasting and health data synced from Apple Health or Health Connect.</li>
          <li>Friends, groups and challenges.</li>
          <li>Coach conversations.</li>
        </ul>
      </LegalSection>

      <LegalSection number="04" title="What is kept">
        <p>
          Nothing with your content in it. We keep an anonymous count of AI
          usage for billing, and AI performance records (model, timing,
          success) labelled with a one-way code instead of your account. See
          the{" "}
          <Link href="/privacy/kora" className={linkClass}>
            Kora privacy policy
          </Link>{" "}
          for details.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
