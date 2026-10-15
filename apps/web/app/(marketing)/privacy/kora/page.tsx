import type { Metadata } from "next";
import Link from "next/link";
import {
  KORA_PRIVACY_LAST_UPDATED,
  LegalPage,
  LegalSection,
} from "../../legal/legal-page";

export const metadata: Metadata = {
  title: "Kora Privacy Policy",
  description:
    "What the Kora nutrition app collects, which AI services read your meals, and how to delete everything.",
  alternates: {
    canonical: "/privacy/kora",
  },
};

const linkClass = "text-foreground underline-offset-4 hover:underline";

/**
 * Kora's own policy, linked from the App Store and Google Play listings.
 *
 * It exists separately from /privacy because Kora handles data the general
 * policy never mentions: health and fitness records, meal photos, voice notes,
 * and AI services that read them. Store reviewers check that the linked
 * policy names the data the app's declarations list, so the general policy is
 * not enough on its own.
 */
export default function KoraPrivacyPage() {
  return (
    <LegalPage
      eyebrow="Privacy · Kora"
      title="Kora Privacy Policy"
      description="What the Kora app collects, why, who processes it, and how to delete it."
      lastUpdated={KORA_PRIVACY_LAST_UPDATED}
    >
      <LegalSection number="01" title="Who we are">
        <p>
          Kora is made by Tesserix Pty Ltd (ACN 694 070 865, ABN 59 694 070
          865), a company registered in New South Wales, Australia. This
          policy covers the Kora apps for iOS and Android. For anything not
          covered here, our{" "}
          <Link href="/privacy" className={linkClass}>
            general privacy policy
          </Link>{" "}
          applies.
        </p>
      </LegalSection>

      <LegalSection number="02" title="What we collect">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            Account details: your name, email address and password. Passwords
            are held by our sign-in service in hashed form; we never see them.
          </li>
          <li>
            Profile details you choose to give: sex, birth year, height,
            current weight and goal weight, used to work out your nutrition
            targets.
          </li>
          <li>
            What you log: meals, foods, water, weight and fasting, and the
            text you type to describe them.
          </li>
          <li>
            Meal photos and nutrition-label photos you take or pick. These
            are stored privately so we can show you what was logged and
            check the accuracy of our estimates.
          </li>
          <li>
            Voice notes you record to describe a meal. The audio is sent for
            transcription and is not stored on our servers; the transcript
            becomes part of your log.
          </li>
          <li>
            Health and fitness data, only if you connect Apple Health or
            Health Connect: steps, sleep, weight and exercise. Kora only
            reads this data; it never writes to either.
          </li>
          <li>
            Social activity, if you use it: friends, groups, challenges and
            what you choose to share with them.
          </li>
          <li>
            Coach conversations: the messages you exchange with Otto, Kora&apos;s
            nutrition coach.
          </li>
          <li>
            Diagnostics: crash reports and performance data, so we can fix
            problems. These do not include your meals or photos.
          </li>
        </ul>
        <p>
          Kora does not use advertising identifiers, does not show ads, and
          does not track you across other apps or websites.
        </p>
      </LegalSection>

      <LegalSection number="03" title="How AI is used">
        <p>
          Kora uses AI services to turn photos, voice notes and text into
          nutrition estimates, to read nutrition labels, and to answer you as
          your coach. When you log a meal this way, the photo, audio or text
          is sent to one or more of these providers for that request only:
        </p>
        <ul className="list-disc space-y-2 pl-5">
          <li>Google (Gemini): meal photos, voice transcription, text, and search embeddings.</li>
          <li>Anthropic (Claude): a second check of photo and label results, and coach replies.</li>
          <li>Microsoft Azure (Document Intelligence): reading text on nutrition labels.</li>
          <li>OpenAI: understanding meals described in text.</li>
        </ul>
        <p>
          We use these providers under terms that do not allow them to train
          their models on your data. We do not use your health data to train
          AI models. AI estimates can be wrong; Kora is not medical advice.
        </p>
      </LegalSection>

      <LegalSection number="04" title="Why we collect it">
        <p>
          We use your data only to run Kora for you: to log and estimate your
          nutrition, show your progress, send the reminders you set, run the
          social features you join, keep your account secure, and improve the
          accuracy of our estimates. We do not sell your data, and we do not
          use health data for advertising or share it with data brokers.
        </p>
      </LegalSection>

      <LegalSection number="05" title="Who else processes it">
        <ul className="list-disc space-y-2 pl-5">
          <li>Google Cloud Platform: hosting, database and private photo storage.</li>
          <li>Cloudflare: DNS and network protection.</li>
          <li>The AI providers listed in section 03.</li>
          <li>Resend: sending sign-in codes by email.</li>
          <li>Sentry: crash reporting.</li>
          <li>Apple and Google: push notifications, if you turn them on.</li>
        </ul>
        <p>
          Each provider processes data under its own agreement with us and
          only for the purpose we use it for.
        </p>
      </LegalSection>

      <LegalSection number="06" title="Where it is stored">
        <p>
          Kora runs on Google Cloud Platform in the <code>asia-south1</code>{" "}
          (Mumbai) region. The providers in section 03 and 05 may process
          data in other countries, including the United States and
          Australia. Data is encrypted in transit and at rest.
        </p>
      </LegalSection>

      <LegalSection number="07" title="How long we keep it">
        <p>
          We keep your data while your account is open. When you delete your
          account, your profile, logs, photos, health data, social activity
          and coach conversations are deleted, and your sign-in identity is
          removed. We keep two things that contain none of your content: an
          anonymous count of AI usage for billing and capacity records, and
          AI performance records (which model ran, how long it took, whether
          it succeeded) labelled with a one-way code instead of your
          account.
        </p>
      </LegalSection>

      <LegalSection number="08" title="Your choices and rights">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            Export: More → Profile → Export my data gives you a copy of
            everything in your account.
          </li>
          <li>
            Delete:{" "}
            <Link href="/privacy/kora/delete-account" className={linkClass}>
              how to delete your Kora account
            </Link>
            , in the app or by email.
          </li>
          <li>
            Health access: you can disconnect Apple Health or Health Connect
            at any time in your phone&apos;s settings.
          </li>
          <li>
            Camera, microphone and photos are only used when you choose to
            log with them, and you can turn each off in your phone&apos;s
            settings.
          </li>
        </ul>
        <p>
          Depending on where you live, you may also have rights to access,
          correct or object to how we use your data, under the Australian
          Privacy Principles, the GDPR, India&apos;s Digital Personal Data
          Protection Act or similar laws, and to complain to a data
          protection authority.
        </p>
      </LegalSection>

      <LegalSection number="09" title="Children">
        <p>
          Kora is for adults. It is not directed at, or intended for, anyone
          under 18.
        </p>
      </LegalSection>

      <LegalSection number="10" title="Changes and contact">
        <p>
          We will update the date at the top of this page whenever this
          policy changes, and tell you in the app if a change affects how we
          use your data. For questions or requests, email{" "}
          <a href="mailto:kora-support@tesserix.app" className={linkClass}>
            kora-support@tesserix.app
          </a>
          .
        </p>
      </LegalSection>
    </LegalPage>
  );
}
