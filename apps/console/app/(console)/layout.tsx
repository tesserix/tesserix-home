import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { CapabilityError, getCurrentSession, toCapabilities } from "@tesserix/platform-auth";
import { capabilityForPath } from "@tesserix/console-core";
import { checkOperatorCapabilityLive } from "@/lib/auth/operator";
import { CONSOLE_PATHNAME_HEADER } from "@/lib/auth/console-pathname";
import { ConsoleSidebar } from "@/components/nav/sidebar";
import { ConsoleHeader } from "@/components/nav/console-header";
import { requiresCapability } from "@/lib/internal-access";
import { readToolsDirectory } from "@/lib/tools-directory";
import { readEstateHealth } from "@/lib/health";

// Every route in this group reads the session cookie to render operator
// identity in the header, and middleware already refuses unauthenticated
// requests before they reach here — so there is no valid cached response to
// serve. Without this, `next build` tries to prerender "/" statically and
// `cookies()` throws because there is no request to read it from.
export const dynamic = "force-dynamic";

export default async function ConsoleLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Middleware has already refused anyone without a session, so this is only
  // ever null in a misconfiguration — render the header without identity
  // rather than failing the whole console.
  const session = await getCurrentSession();
  const showCapabilities = requiresCapability();

  // THE ACCESS GATE (#262, R2). Until this existed every operator who could
  // log in could reach every page by typing its URL — `routes.ts` says of its
  // own capability field that it is "a discoverability gate, not an access
  // gate", and nothing else consulted it.
  //
  // It runs here, in the layout, rather than in middleware because middleware
  // holds only the session cookie, whose roles are up to seven days old. This
  // reads the live capability store — the same authority every gated write
  // uses since #285 — so a revocation takes effect in about five minutes here
  // too, instead of a week.
  //
  // NOT-FOUND, NEVER FORBIDDEN (R2.2). A permission error confirms the
  // surface exists and leaks the shape of the estate to someone who should
  // not know it. Pages already answer `notFound()` for records that do not
  // exist, so a restricted surface is indistinguishable from one that was
  // never built.
  //
  // API routes are deliberately NOT covered: per R2.3 they keep their own
  // `assertCapability` checks, so routing is never the only thing between an
  // operator and a verb.
  const pathname = (await headers()).get(CONSOLE_PATHNAME_HEADER) ?? "";
  const required = capabilityForPath(pathname);
  try {
    await checkOperatorCapabilityLive(session, required);
  } catch (cause) {
    if (cause instanceof CapabilityError) notFound();
    throw cause;
  }

  // What the rail may offer (#263, R3) — the same `routeCapability` the gate
  // above reads, so hiding and refusing cannot disagree. `visibleNav` fails
  // closed on an absent claims list for the reason `visibleTo` does.
  const capabilities = showCapabilities ? toCapabilities(session?.roles ?? []) : [];
  // Read alongside the directory rather than after it: both are independent
  // server reads and awaiting them in sequence adds one round trip to every
  // console page render.
  const [directory, health] = await Promise.all([
    readToolsDirectory(),
    readEstateHealth(),
  ]);

  return (
    <div className="flex min-h-screen">
      <div className="hidden lg:fixed lg:inset-y-0 lg:left-0 lg:z-30 lg:flex">
        <ConsoleSidebar capabilities={capabilities} enforceCapabilities={showCapabilities} />
      </div>
      <main id="main-content" className="flex-1 lg:pl-56">
        <ConsoleHeader
          name={session?.name ?? ""}
          email={session?.email ?? ""}
          capabilities={capabilities}
          showCapabilities={showCapabilities}
          toolsBaseDomain={process.env.NEXT_PUBLIC_TOOLS_DOMAIN ?? "tesserix.app"}
          tools={directory.tools}
          health={health}
        />
        {/* Every console surface gets the same measure and gutters here rather
            than each page inventing its own. Without this, content sits flush
            against the viewport edge. */}
        {/* Gutters, not a centred measure. An operator console is a dense
            full-width frame; centring a max-width column inside the space left
            by the sidebar reads as off-centre, with dead margin on both sides. */}
        <div className="w-full px-6 py-8 sm:px-8">{children}</div>
      </main>
    </div>
  );
}
