import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { CapabilityError, getCurrentSession, toCapabilities } from "@tesserix/platform-auth";
import { capabilityForPath } from "@tesserix/console-core";
import { checkOperatorCapabilityLive } from "@/lib/auth/operator";
import { recordDeniedAttempt } from "@/lib/db/denied-attempts";
import { CONSOLE_PATHNAME_HEADER } from "@/lib/auth/console-pathname";
import { ConsoleSidebar } from "@/components/nav/sidebar";
import { ConsoleHeader } from "@/components/nav/console-header";
import { enforcesRouteCapabilities, requiresCapability } from "@/lib/internal-access";
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
  // Whether this session CARRIES capabilities — what the operator menu shows.
  const showCapabilities = requiresCapability();
  // Whether the console ACTS on them (#266 R6.2). One value for the gate and
  // the rail: they must not disagree, or the console hides a surface it would
  // still serve, or offers one it refuses.
  const enforcing = enforcesRouteCapabilities();

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
  // Gated on `enforcesRouteCapabilities()`, the SAME value the rail filter
  // below is given — the two must not disagree, or the console hides a surface
  // it would still serve, or offers one it refuses. Two reasons it is a
  // condition at all, and the second is not a test convenience:
  //
  //  1. The legacy provider carries no capability claims at all, so enforcing
  //     would refuse every surface to every operator. "Off means unchanged" is
  //     the contract `visibleTo` and `visibleNav` both give, and a gate that
  //     disagreed with the rail about whether enforcement is on would hide a
  //     surface it still served, or serve one it hid.
  //
  //  2. `checkOperatorCapabilityLive` throws on a NULL session before it
  //     checks the provider, and this layout deliberately tolerates a null
  //     session — its comment above says a misconfiguration should render the
  //     header without identity rather than fail the whole console. Without
  //     this guard the gate turns that into a 404 for every page, which is
  //     how it broke the e2e run: the auth bypass returns from middleware
  //     before a session exists.
  //
  // In production `AUTH_PROVIDER=zitadel` and the kill switch is unset, so
  // this is true and the gate runs. A null session THERE is still refused,
  // which is the fail-closed direction for an access control.
  //
  // Setting `CONSOLE_RBAC_ENFORCEMENT=off` on the deployment turns both the
  // gate and the rail filter off together, which is the way back from a grant
  // narrowed by mistake — see `enforcesRouteCapabilities`.
  if (enforcing) {
    const pathname = (await headers()).get(CONSOLE_PATHNAME_HEADER) ?? "";
    const required = capabilityForPath(pathname);
    try {
      await checkOperatorCapabilityLive(session, required);
    } catch (cause) {
      if (cause instanceof CapabilityError) {
        // Recorded BEFORE notFound(), because notFound() throws to unwind the
        // render — anything after it never runs. Awaited rather than fired and
        // forgotten: a floating promise in a server component can be cut short
        // when the render ends, which would drop exactly the rows this exists
        // to write. It cannot fail the refusal — see recordDeniedAttempt.
        // `recordDeniedAttempt` promises never to throw. This does not RELY on
        // that promise: the refusal is an access-control outcome, and the one
        // thing worse than an unrecorded denial is a denial that turns into a
        // 500 because the log failed. Belt and braces on the path where the
        // cost of being wrong is highest.
        await recordDeniedAttempt({
          actor: session?.sub ?? session?.email ?? "unknown",
          required,
          target: pathname,
          kind: "surface",
        }).catch(() => {});
        notFound();
      }
      throw cause;
    }
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
        <ConsoleSidebar capabilities={capabilities} enforceCapabilities={enforcing} />
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
