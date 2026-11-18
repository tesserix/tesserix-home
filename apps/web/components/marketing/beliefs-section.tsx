import { Reveal } from "@/components/marketing/reveal";

import type { Belief } from "@/lib/cms/types";

export function BeliefsSection({ beliefs }: { beliefs: Belief[] }) {
  return (
    <section className="relative border-t py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <Reveal className="max-w-2xl">
          <p className="inline-flex items-center gap-[0.7rem] font-mono text-[0.7rem] uppercase tracking-[0.14em] text-cobalt">
            <span className="h-px w-[2.2rem] bg-cobalt" aria-hidden="true" />
            Non-negotiables
          </p>
          <h2 className="mt-4 text-[clamp(2rem,4.6vw,3.4rem)] font-semibold leading-[1.04] tracking-[-0.04em] text-foreground">
            Three things we won&apos;t compromise on.
          </h2>
        </Reveal>

        <div className="mt-16 grid grid-cols-3 border-t max-[860px]:grid-cols-1">
          {beliefs.map((belief, index) => (
            <Reveal
              key={belief.title}
              delay={index * 0.1}
              className={`border-r pb-0 pr-[1.8rem] pt-[1.8rem] last:border-r-0 max-[860px]:border-b max-[860px]:border-r-0 max-[860px]:pb-[1.6rem] max-[860px]:pr-0 max-[860px]:last:border-b-0 ${
                index > 0 ? "pl-[1.8rem] max-[860px]:pl-0" : ""
              }`}
            >
              <p className="font-mono text-[0.68rem] uppercase tracking-[0.12em] text-cobalt">
                {belief.label}
              </p>
              <h3 className="mt-[0.9rem] text-[1.12rem] font-[650] tracking-[-0.015em] text-foreground">
                {belief.title}
              </h3>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                {belief.body}
              </p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
