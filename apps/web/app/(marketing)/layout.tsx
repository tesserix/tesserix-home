import { Navbar } from "@/components/common/navbar";
import { Footer } from "@/components/common/footer";

/**
 * Blueprint grid background — the Structured Light plan's spec'd but
 * never-built background layer (plan §2). A fixed, full-viewport hairline
 * grid sitting behind all marketing content; masked to fade out past 70% of
 * the viewport height so it doesn't compete with the footer. Scoped to this
 * `(marketing)` layout only, so admin routes are unaffected.
 */
function BlueprintGrid() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-[-1]"
      style={{
        backgroundImage:
          "linear-gradient(to right, rgba(11,14,20,0.028) 1px, transparent 1px), linear-gradient(to bottom, rgba(11,14,20,0.028) 1px, transparent 1px)",
        backgroundSize: "72px 72px",
        maskImage: "linear-gradient(black, black 70%, transparent)",
        WebkitMaskImage: "linear-gradient(black, black 70%, transparent)",
      }}
    />
  );
}

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col">
      <BlueprintGrid />
      <Navbar />
      <main id="main-content" className="flex-1">{children}</main>
      <Footer />
    </div>
  );
}
