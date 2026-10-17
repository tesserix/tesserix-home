import { Survey } from "@/components/questionnaires/survey";
export const metadata = {
  title: "Vending customer survey",
  description:
    "Help choose products for convenient vending at gyms and shopping centres.",
  alternates: {
    canonical: "https://questionnaire.tesserix.app/vending-customers",
  },
  robots: { index: false, follow: false },
};
import { loadCountries } from "@/lib/questionnaires/location";
export default async function Page() {
  return <Survey form="vending-customers" countries={await loadCountries()} />;
}
