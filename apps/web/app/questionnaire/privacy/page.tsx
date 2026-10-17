import { QuestionnaireBrand } from "@/components/questionnaires/brand";
export const metadata = {
  title: "Questionnaire collection notice",
  robots: { index: false, follow: false },
};
export default function Page() {
  return (
    <main id="main-content" className="mx-auto max-w-2xl space-y-6 px-6 py-16">
      <div>
        <QuestionnaireBrand />
      </div>
      <a href="/questionnaire" className="underline">
        ← Research surveys
      </a>
      <h1 className="text-3xl font-semibold">
        How we use your survey response
      </h1>
      <p>
        Tesserix collects these responses to assess vending locations,
        understand product demand, and plan a possible pilot. Participation is
        voluntary and a response does not create an order, rental agreement or
        installation commitment.
      </p>
      <h2 className="text-xl font-semibold">Customer survey</h2>
      <p>
        We do not request your name, email, date of birth or account. We ask
        about location, shopping habits, products, prices and service
        preferences. Please do not enter medical information, personal contact
        details or other sensitive information in free text.
      </p>
      <h2 className="text-xl font-semibold">Business survey</h2>
      <p>
        We collect the business and venue information you provide, and your
        business contact name and email so we can discuss your site. You may
        leave optional questions blank. Do not submit passwords, alarm codes,
        access credentials, payment card details or private security plans.
      </p>
      <h2 className="text-xl font-semibold">Access, storage and follow-up</h2>
      <p>
        Responses are stored in our database hosted in India and are accessible
        to authorised Tesserix console operators. They are used for research and
        venue follow-up, not automatic marketing enrolment. Infrastructure
        providers process data to host and protect the service. Responses are
        retained while needed for feasibility assessment and related pilot
        planning, with contact data reviewed for removal when no longer needed.
      </p>
      <p>
        We use short-lived, hashed network and random browser identifiers for
        abuse prevention. Hosting and security systems may retain standard
        access logs under their own retention policies. A customer response
        cannot be assumed to identify one unique person, so survey totals are
        not verified unique-person counts.
      </p>
      <h2 className="text-xl font-semibold">Optional address search</h2>
      <p>
        When you use venue address search, the text you type and selected
        country are sent through our existing Mark8ly location proxy to its
        address provider (Photon / OpenStreetMap). Provider processing may occur
        outside your country. We do not request your device location. Use a
        public venue address, not a home address. You can skip search and enter
        or correct the details manually. Search text is sent in a request body
        to our questionnaire endpoint; the location proxy and provider may
        retain their own request logs.
      </p>
      <h2 className="text-xl font-semibold">Your choices</h2>
      <p>
        For access, correction, deletion requests or privacy questions, contact{" "}
        <a className="underline" href="mailto:privacy@tesserix.app">
          privacy@tesserix.app
        </a>{" "}
        and include the response reference if you have it. Anonymous responses
        can be difficult to locate without that reference. See also our{" "}
        <a className="underline" href="https://tesserix.app/privacy">
          privacy policy
        </a>
        .
      </p>
    </main>
  );
}
