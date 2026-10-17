import { QuestionnaireBrand } from "@/components/questionnaires/brand";
import { HospitalGuidance } from "@/components/questionnaires/hospital-guidance";
import Link from "next/link";
import { FORM_IDS, forms } from "@tesserix/questionnaires";
export const metadata = {
  title: "Tesserix research questionnaires",
  robots: { index: false, follow: false },
  alternates: { canonical: "https://questionnaire.tesserix.app/" },
};
export default function Page() {
  return (
    <main
      id="main-content"
      className="min-h-screen bg-stone-50 px-4 py-10 sm:px-6 sm:py-20 text-stone-900"
    >
      <div className="mx-auto max-w-3xl space-y-8">
        <QuestionnaireBrand />
        <h1 className="text-3xl font-semibold sm:text-5xl">
          Help shape what comes next.
        </h1>
        <p className="text-lg text-stone-600">
          We are exploring convenient vending for gyms, shopping centres and
          other everyday spaces. Share your preferences or tell us about your
          venue.
        </p>
        <div className="grid gap-5 sm:grid-cols-2">
          {FORM_IDS.map((id) => (
            <Link
              key={id}
              href={`/${id}`}
              className="space-y-3 rounded-2xl border bg-white p-7"
            >
              <p className="text-xs text-emerald-800">{forms[id].audience}</p>
              <h2 className="text-xl font-semibold">{forms[id].title}</h2>
              <p className="text-sm text-stone-600">{forms[id].subtitle}</p>
              <p className="pt-3 font-medium">Start survey →</p>
            </Link>
          ))}
        </div>
        <section className="space-y-3 rounded-2xl border bg-white p-5">
          <h2 className="text-xl font-semibold">Bhubaneswar / Odisha pilot</h2>
          <p className="text-sm text-stone-600">
            Start with India, Odisha, Bhubaneswar and INR filled in. Every
            answer stays editable. Regional ideas are options to test, not
            promises of availability.
          </p>
          <div className="flex flex-wrap gap-3">
            {FORM_IDS.map((id) => (
              <Link
                key={id}
                href={`/${id}?market=bhubaneswar`}
                className="inline-flex min-h-12 items-center rounded-xl border px-4 py-3 text-sm font-medium"
              >
                {id === "vending-customers"
                  ? "Customer survey"
                  : "Business survey"}{" "}
                →
              </Link>
            ))}
          </div>
        </section>
        <HospitalGuidance />
        <Link
          href="/questionnaire/privacy"
          className="inline-block text-sm underline"
        >
          Privacy & collection notice
        </Link>
      </div>
    </main>
  );
}
