import { QuestionnaireBrand } from "@/components/questionnaires/brand";
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
      className="min-h-screen bg-stone-50 px-6 py-20 text-stone-900"
    >
      <div className="mx-auto max-w-3xl space-y-8">
        <QuestionnaireBrand />
        <h1 className="text-5xl font-semibold">Help shape what comes next.</h1>
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
