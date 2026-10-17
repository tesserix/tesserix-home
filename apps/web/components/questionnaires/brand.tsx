import Image from "next/image";
import Link from "next/link";
export function QuestionnaireBrand() {
  return (
    <Link
      href="/questionnaire"
      aria-label="Tesserix research home"
      className="inline-flex flex-wrap items-center gap-3"
    >
      <Image
        src="/logo.png"
        alt="Tesserix"
        width={166}
        height={40}
        priority
        unoptimized
        style={{ height: "40px", width: "auto" }}
      />
      <span className="border-l border-stone-300 pl-3 text-xs font-semibold uppercase tracking-widest text-emerald-800">
        Research
      </span>
    </Link>
  );
}
