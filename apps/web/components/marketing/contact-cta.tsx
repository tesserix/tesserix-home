"use client";

import Link from "next/link";
import Image from "next/image";
import { ArrowRight, Mail } from "lucide-react";
import { AnimateOnScroll } from "@tesserix/web";

export function ContactCTA() {
  return (
    <section className="relative py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <AnimateOnScroll variant="fade-up">
          <div
            className="relative overflow-hidden rounded-[22px] px-6 py-20 text-[#f0f3f9] sm:px-16 sm:py-24"
            style={{
              backgroundColor: "#0b0e14",
              backgroundImage:
                "radial-gradient(50rem 26rem at 82% -30%, rgba(106,165,255,0.14), transparent 60%)",
            }}
          >
            <Image
              src="/tesseract-render.jpg"
              alt=""
              aria-hidden="true"
              width={1200}
              height={669}
              className="pointer-events-none absolute right-[-5%] top-1/2 z-0 w-[clamp(20rem,44%,34rem)] -translate-y-1/2 opacity-95 max-[860px]:hidden"
              style={{
                maskImage:
                  "radial-gradient(70% 70% at 50% 50%, black 55%, transparent 100%)",
                WebkitMaskImage:
                  "radial-gradient(70% 70% at 50% 50%, black 55%, transparent 100%)",
              }}
            />

            <div className="relative z-10 grid grid-cols-12 gap-x-12 gap-y-10 max-[860px]:grid-cols-1">
              <div className="col-span-7 max-[860px]:col-span-1">
                <h2 className="text-[clamp(2rem,4.6vw,3.4rem)] font-[650] leading-[1.04] tracking-[-0.04em] text-balance">
                  Have a question?
                  <br />
                  You&apos;ll get a human.
                </h2>
              </div>

              <div className="col-span-4 col-start-9 flex flex-col justify-end gap-4 max-[860px]:col-span-1 max-[860px]:col-start-1">
                <p className="max-w-md text-base leading-relaxed text-[#aab2c2]">
                  No sales pitch, no chatbot queue — just a conversation with
                  the people who build the products.
                </p>
                <div className="flex flex-col items-start gap-4">
                  <Link
                    href="/contact"
                    className="inline-flex items-center rounded-full bg-white px-[1.7rem] py-[0.9rem] text-[0.98rem] font-semibold text-[#0b0e14] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_10px_30px_-10px_rgba(46,92,255,0.6)]"
                  >
                    Get in touch
                    <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
                  </Link>
                  <a
                    href="mailto:sales@tesserix.app"
                    className="inline-flex items-center gap-2 font-mono text-sm text-[#aab2c2] transition-colors hover:text-[#f0f3f9]"
                  >
                    <Mail className="h-4 w-4" aria-hidden="true" />
                    sales@tesserix.app
                  </a>
                </div>
              </div>
            </div>

            {/* Full-width render below content on small screens */}
            <div className="relative z-10 mt-10 hidden max-[860px]:block">
              <Image
                src="/tesseract-render.jpg"
                alt=""
                aria-hidden="true"
                width={1200}
                height={669}
                className="w-full opacity-95"
                style={{
                  maskImage:
                    "radial-gradient(70% 70% at 50% 50%, black 55%, transparent 100%)",
                  WebkitMaskImage:
                    "radial-gradient(70% 70% at 50% 50%, black 55%, transparent 100%)",
                }}
              />
            </div>
          </div>
        </AnimateOnScroll>
      </div>
    </section>
  );
}
