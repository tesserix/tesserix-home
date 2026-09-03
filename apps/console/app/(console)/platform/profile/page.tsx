import {
  CONSOLE_ENTRY_CAPABILITY,
  MACHINE_CAPABILITIES,
  RISK_CAPABILITIES,
  SURFACE_CAPABILITIES,
  getCurrentSession,
  toCapabilities,
} from "@tesserix/platform-auth";
import { ConsolePageHeader } from "@/components/kit/page-header";
import { CapabilityGroup } from "./capability-groups";
import { resolveLiveCapabilities } from "@/lib/auth/platform-token";
import { requiresCapability } from "@/lib/internal-access";

/**
 * The operator's own record.
 *
 * # Why this page exists at all
 *
 * Since #262 the console refuses a surface an operator does not hold, and the
 * refusal is a 404 that is deliberately indistinguishable from "never built".
 * That is the right refusal — a permission error confirms the surface exists —
 * but it leaves an operator with no way to answer "what do I actually hold?".
 * This is that answer, and it is why the route is `shell`: the operators most
 * likely to need it are the narrowly-granted ones, so gating it on a surface
 * would deny it to exactly them.
 *
 * # Why this one page may read the live store
 *
 * `lib/auth/render-path-capabilities.test.ts` holds that the RENDER PATH stays
 * on the session cookie: putting a database read, and every five minutes a
 * Zitadel round trip, behind every page render would move an IdP dependency
 * onto the console's critical path to change nothing an operator can act on.
 *
 * That reasoning is about pages rendered incidentally, on the way to somewhere
 * else. This page IS the answer to "what do I hold", visited deliberately and
 * rarely, and the cookie is the thing whose staleness it exists to expose. A
 * cookie-only profile page would confidently show the stale set to the one
 * person asking why a surface just refused them.
 *
 * So it reads the live store, and it SAYS which answer it got — the difference
 * between "Zitadel says this" and "we could not ask, so this is your session's
 * snapshot" is the whole point, and collapsing them would make the page a
 * more authoritative-looking version of the menu it replaces.
 *
 * # What goes here next
 *
 * Per-operator settings: TOTP enrolment (#440 part 3) belongs here rather than
 * on the login page, since enrolling a factor is something you do to your own
 * account while already signed in. Note that shipping it has a precondition —
 * #457, the enrolment-makes-lockout-cheap problem — which is recorded there.
 */
export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const session = await getCurrentSession();
  const snapshot = toCapabilities(session?.roles ?? []);

  // The live store is the authority (#285). `unavailable` is NOT "holds
  // nothing" — see resolveLiveCapabilities — so it falls back to the session
  // snapshot and says so, rather than rendering an empty page that reads as a
  // revocation.
  const live = session ? await resolveLiveCapabilities(session) : null;
  const authoritative = live?.source === "store";
  const held = authoritative ? live.capabilities : snapshot;

  const enforcing = requiresCapability();

  return (
    <div className="flex flex-col gap-6">
      <ConsolePageHeader
        title="Your access"
        description="What this console will let you do, and where that answer came from."
      />

      <section>
        <h2 className="text-sm font-medium">Signed in as</h2>
        <p className="mt-1 text-[13px] text-muted-foreground">
          {session?.email ?? "not signed in"}
        </p>
      </section>

      {enforcing ? (
        <>
          <CapabilityGroup
            title="Surfaces"
            description="Which parts of the console you can open. A surface you do not hold is absent from the rail and answers not-found if you type its address."
            all={SURFACE_CAPABILITIES}
            held={held}
          />
          <CapabilityGroup
            title="Actions"
            description="What you may do once you are in a surface. These layer on top of a surface rather than replacing it — erasing a contact needs this and the CRM."
            all={RISK_CAPABILITIES}
            held={held}
          />
          <CapabilityGroup
            title="Machine"
            description="Held by service identities rather than people. Shown so an operator who somehow holds one can see it."
            all={MACHINE_CAPABILITIES}
            held={held}
          />

          <section className="border-t border-border pt-4">
            <h2 className="text-sm font-medium">Where this came from</h2>
            {authoritative ? (
              <p className="mt-1 text-[13px] text-muted-foreground">
                Checked against Zitadel. A grant added or removed there reaches
                this console within about five minutes — you do not need to
                sign in again.
              </p>
            ) : (
              <p className="mt-1 text-[13px] text-muted-foreground">
                Could not reach the capability store, so this is your
                session&rsquo;s own snapshot, taken when you signed in. It can
                be out of date in either direction — a grant made since then is
                missing, and one removed since then is still listed.
              </p>
            )}
            <p className="mt-2 text-[13px] text-muted-foreground">
              Every operator holds{" "}
              <span className="font-mono text-[11px]">
                {CONSOLE_ENTRY_CAPABILITY}
              </span>
              , which is entry to the console and nothing else. It is not listed
              above because it grants no surface.
            </p>
          </section>
        </>
      ) : (
        <section className="border-t border-border pt-4">
          <p className="text-[13px] text-muted-foreground">
            This console is not recording capabilities on sessions, so there is
            nothing to show. Every signed-in operator can reach every surface.
          </p>
        </section>
      )}
    </div>
  );
}
