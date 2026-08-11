import Link from "next/link";
import Image from "next/image";
import { ArrowRight, Mail } from "lucide-react";
import { Reveal } from "@/components/marketing/reveal";
import { MarketingButton } from "@/components/marketing/marketing-button";

export function ContactCTA() {
  return (
    <section className="relative py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <Reveal>
          {/* `.dark` scopes this panel to the ink theme in globals.css
              (--background/--foreground/--muted-foreground), which is the
              exact palette this panel was hand-authoring in hex before —
              see the "used by the CTA panel" comment on that theme block. */}
          <div
            className="dark relative overflow-hidden rounded-[22px] bg-background px-6 py-20 text-foreground sm:px-16 sm:py-24"
            style={{
              backgroundImage:
                "radial-gradient(50rem 26rem at 82% -30%, rgba(106,165,255,0.14), transparent 60%)",
            }}
          >
            <div className="relative z-10 grid grid-cols-1 items-center gap-x-[2.5rem] gap-y-10 xl:grid-cols-[1.5fr_1fr_minmax(14rem,17rem)]">
              <div className="relative z-10">
                <h2 className="text-[clamp(2rem,4.6vw,3.4rem)] font-[650] leading-[1.04] tracking-[-0.04em] text-balance">
                  Have a question?
                  <br />
                  You&apos;ll get a human.
                </h2>
              </div>

              <div className="relative z-10 flex flex-col justify-end gap-4">
                <p className="max-w-md text-base leading-relaxed text-muted-foreground">
                  No sales pitch, no chatbot queue — just a conversation with
                  the people who build the products.
                </p>
                <div className="flex flex-col items-start gap-4">
                  <MarketingButton as={Link} href="/contact" variant="pill-white">
                    Get in touch
                    <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
                  </MarketingButton>
                  <a
                    href="mailto:sales@tesserix.app"
                    className="inline-flex items-center gap-2 font-mono text-sm text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <Mail className="h-4 w-4" aria-hidden="true" />
                    sales@tesserix.app
                  </a>
                </div>
              </div>

              <div className="relative z-10 order-last mx-auto w-full max-w-[17rem] xl:order-none xl:mx-0 xl:max-w-none">
                <Image
                  src="/tesseract-render.jpg"
                  alt=""
                  aria-hidden="true"
                  width={900}
                  height={900}
                  className="w-full rounded-[14px] opacity-95"
                  style={{
                    maskImage:
                      "radial-gradient(70% 70% at 50% 50%, black 55%, transparent 100%)",
                    WebkitMaskImage:
                      "radial-gradient(70% 70% at 50% 50%, black 55%, transparent 100%)",
                  }}
                />
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
