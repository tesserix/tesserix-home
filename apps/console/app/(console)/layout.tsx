import { getCurrentSession, toCapabilities } from "@tesserix/platform-auth";
import { ConsoleSidebar } from "@/components/nav/sidebar";
import { ConsoleHeader } from "@/components/nav/console-header";
import { requiresCapability } from "@/lib/internal-access";
import { readToolsDirectory } from "@/lib/tools-directory";

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
  const directory = await readToolsDirectory();

  return (
    <div className="flex min-h-screen">
      <div className="hidden lg:fixed lg:inset-y-0 lg:left-0 lg:z-30 lg:flex">
        <ConsoleSidebar />
      </div>
      <main id="main-content" className="flex-1 lg:pl-56">
        <ConsoleHeader
          name={session?.name ?? ""}
          email={session?.email ?? ""}
          capabilities={showCapabilities ? toCapabilities(session?.roles ?? []) : []}
          showCapabilities={showCapabilities}
          toolsBaseDomain={process.env.NEXT_PUBLIC_TOOLS_DOMAIN ?? "tesserix.app"}
          tools={directory.tools}
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
