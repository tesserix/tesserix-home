import { Survey } from "@/components/questionnaires/survey";
export const metadata = {
  title: "Vending business survey",
  description: "Tell us about your venue and explore a vending pilot.",
  alternates: {
    canonical: "https://questionnaire.tesserix.app/vending-business",
  },
  robots: { index: false, follow: false },
};
export default function Page() {
  return <Survey form="vending-business" />;
}
