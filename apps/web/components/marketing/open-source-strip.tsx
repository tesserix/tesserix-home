import { ArrowUpRight } from "lucide-react";
import { Reveal } from "@/components/marketing/reveal";

import type { OpenSourceRepo } from "@/lib/cms/types";

export function OpenSourceStrip({ repos }: { repos: OpenSourceRepo[] }) {
  return (
    <section className="relative border-t border-line-strong py-[4rem]">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <Reveal>
          <p className="inline-flex items-center gap-[0.7rem] font-mono text-[0.7rem] uppercase tracking-[0.14em] text-cobalt">
            <span className="h-px w-[2.2rem] bg-cobalt" aria-hidden="true" />
            Open source
          </p>
          <p className="mt-4 max-w-xl text-muted-foreground">
            Tools we build for ourselves, shared. The same infrastructure
            that runs Tesserix products.
          </p>

          <div className="mt-10 grid grid-cols-1 gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-4">
            {repos.map((repo) => (
              <div key={repo.name}>
                <a
                  href={`https://github.com/tesserix/${repo.name}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-semibold text-cobalt hover:underline"
                >
                  {repo.name}
                  <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
                </a>
                <p className="mt-1.5 text-[0.9rem] leading-relaxed text-muted-foreground">
                  {repo.description}
                </p>
              </div>
            ))}
          </div>

          <a
            href="https://github.com/tesserix"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-8 inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            All repositories on GitHub
            <span aria-hidden="true">→</span>
          </a>
        </Reveal>
      </div>
    </section>
  );
}
