import { describe, expect, it } from "vitest";
import {
  ROUTE_IDS,
  consolePath,
  isPending,
  isRetired,
  isRouteActive,
  mobilePath,
  webPath,
} from "./routes";
import { navItems, platformNav } from "./nav";

describe("consolePath", () => {
  it("never serves apps/web's /admin paths", () => {
    // The console is not a second copy of the old admin. Serving `/admin/*` on
    // a host that IS the admin would read as a leftover, and would tie the
    // console's URLs to an app being deleted.
    for (const id of ROUTE_IDS) {
      expect(consolePath(id), `${id} leaks a web path into the console`).not.toMatch(
        /^\/admin\//,
      );
    }
  });

  it("falls back to the mobile path when no console path is set", () => {
    // The fallback is what keeps this a 3-line change rather than 22 invented
    // URLs. It only holds while the shapes agree — see the divergence test.
    // "platform.dashboard" is excluded: it sets an explicit `console: "/"`
    // because the console root, not `/platform`, is where that surface lives.
    // "platform.tools" is excluded too: it has no mobile counterpart at all
    // (see RouteEntry.mobile), so there is nothing for `console` to agree
    // with — the fallback has nothing to fall back to.
    // "mark8ly.migrationFastPath" is excluded for exactly that second reason:
    // the CSM queue is a console surface over mark8ly's federated
    // /admin/inbox, and expo-router has no screen for it. A `mobile` path
    // written here purely to satisfy this loop would claim a screen that was
    // never built — the failure RouteEntry.mobile exists to prevent.
    // "platform.onboarding" is excluded for that same second reason: the
    // funnel is a console surface over the platform API's federated read, and
    // expo-router has no screen for it either.
    // "platform.onboardingSessions" likewise, and more so: the session list is
    // reached only from the funnel and carries merchant email addresses, which
    // is not a surface to put on a phone by default.
    for (const id of ROUTE_IDS) {
      if (
        id === "platform.dashboard" ||
        id === "platform.tools" ||
        id === "mark8ly.migrationFastPath" ||
        id === "platform.onboarding" ||
        id === "platform.onboardingSessions"
      )
        continue;
      expect(consolePath(id)).toBe(mobilePath(id));
    }
  });

  it("serves the console root for the dashboard, not the mobile path", () => {
    // platform.dashboard is the one entry with a real console/mobile
    // divergence: the console root ("/") already is the estate map plus the
    // internal tools directory, which is not the same surface `mobile`
    // ("/platform") points at.
    expect(consolePath("platform.dashboard")).toBe("/");
    expect(consolePath("platform.dashboard")).not.toBe(mobilePath("platform.dashboard"));
  });

  it("keeps web paths distinct from console paths", () => {
    for (const id of ROUTE_IDS) {
      const web = webPath(id);
      // A console-native surface has no web path at all; `undefined` would
      // satisfy `not.toBe` vacuously, so skip it here and assert the gap
      // explicitly in the test below instead.
      if (web === undefined) continue;
      expect(web).not.toBe(consolePath(id));
    }
  });
});

describe("console-native surfaces record no apps/web path", () => {
  it("gives the estate audit log no web path", () => {
    // #139. apps/web served three product-scoped audit pages and no
    // estate-wide one, so there is no single predecessor to record. Naming one
    // of the three would say "the capability lives here today" about a third
    // of it. See RouteEntry.web.
    expect(webPath("platform.auditLog")).toBeUndefined();
    expect(consolePath("platform.auditLog")).toBe("/platform/audit-log");
  });

  it("still records a web path for surfaces that have one", () => {
    // Guards the guard: making `web` optional must not become a licence to
    // stop recording it. Every route that apps/web actually serves still says
    // where, and only a genuinely console-native surface may omit it.
    //
    // Nine ids now, each for its own reason, not one blanket "the CRM has no
    // predecessor". Listed here in the array's own order:
    //   - platform.tools: apps/web has no directory management surface and is
    //     being retired, so there is nothing here to point at either.
    //   - platform.auditLog: apps/web served three product-scoped audit pages
    //     and no estate-wide one — naming any single one would misrepresent
    //     it as the whole capability's home. See RouteEntry.web.
    //   - platform.inbox: apps/web never had an estate-wide queue at all.
    //     Each product's waiting work was only ever visible on that product's
    //     own pages, which is the fragmentation this surface exists to end —
    //     so there is no predecessor, not even a partial one like the audit
    //     log's three product pages.
    //   - platform.billing: apps/web never had an estate billing surface.
    //     Each product's subscriptions were only ever visible inside that
    //     product, which is the fragmentation §8.2 exists to end — so there is
    //     no predecessor, not even a partial one.
    //   - platform.tenants: apps/web DOES serve /admin/tenants, but it is a
    //     different surface, not this one's predecessor — it reads and WRITES
    //     mark8ly's tenants table directly over the cross-database grant
    //     (#210), which this replaces rather than succeeds. Recording it here
    //     would make "fall back to web" read as a rollback, when it is a
    //     return to the write path being removed.
    //   - platform.aiUsage: the gateway's spend ledger did not exist before
    //     the console, in apps/web or anywhere else.
    //   - platform.crmImport: the import flow has no distinct page in
    //     apps/web — it lives inside the leads page (`platform.crm`, which
    //     DOES record a `web` path). There is nothing separate to point at.
    //   - platform.crmSuppressions: a suppression list never existed in
    //     apps/web at all. This is genuinely console-native, not a migration.
    //   - platform.crmOrganisations: same as suppressions — the old leads
    //     page was a flat list of lead rows with no concept of a business
    //     distinct from the person, so there is no predecessor to record.
    //   - platform.billingCatalog: the plan catalog is console-native since
    //     #380 — apps/web never had a catalog surface at all.
    //   - kora.aiMetrics: apps/web never served this — `/v1/kora/ai-metrics`
    //     postdates it entirely. Console-native, like platform.aiUsage.
    //   - mark8ly.migrationFastPath: apps/web's mark8ly rail is eight
    //     tenant/onboarding/subscription entries and has nothing resembling a
    //     migration fast-path review queue. The surface it renders —
    //     mark8ly's `/admin/inbox` `migration_fast_path` kind — postdates
    //     apps/web, so there is no predecessor to record.
    //   - platform.onboarding: apps/web's mark8ly rail has onboarding
    //     surfaces, but they are one product's own screens — there was never
    //     an estate-wide funnel to succeed, which is the whole reason this
    //     route is `platform.*` rather than `mark8ly.*`.
    //   - platform.onboardingSessions: the same, one level down. The rows
    //     behind the funnel's counts come from a federated read (#447) that
    //     postdates apps/web entirely.
    //   - platform.secrets: apps/web never served this. Its predecessor is
    //     secret-service's own UI, a separate application being retired, which
    //     is not what this field records.
    //   - platform.secretsReviews: same predecessor gap as platform.secrets —
    //     apps/web never served a review queue for secret access changes.
    //   - platform.newSecret: same predecessor gap again. secret-service's own
    //     UI had a create dialog; apps/web never did.
    const missing = ROUTE_IDS.filter((id) => webPath(id) === undefined);
    expect(missing).toEqual([
      "kora.aiMetrics",
      "mark8ly.migrationFastPath",
      "platform.tools",
      "platform.auditLog",
      "platform.secrets",
      "platform.secretsReviews",
      "platform.newSecret",
      "platform.inbox",
      "platform.billing",
      "platform.billingCatalog",
      "platform.tenants",
      "platform.onboarding",
      "platform.onboardingSessions",
      "platform.aiUsage",
      "platform.crmImport",
      "platform.crmSuppressions",
      "platform.crmOrganisations",
    ]);
  });
});

describe("the CRM serves its queue, its do-not-contact list, and its import flow", () => {
  it("serves the CRM, the suppression list, and the import flow — nothing left pending", () => {
    expect(isPending("platform.crm")).toBe(false);
    // Task 8 built the CSV import flow this id points at.
    expect(isPending("platform.crmImport")).toBe(false);
    // Task 7 built the do-not-contact list this id points at.
    expect(isPending("platform.crmSuppressions")).toBe(false);
  });

  it("records apps/web's leads page as the CRM's predecessor", () => {
    // platform.tickets records its apps/web predecessor even though that page
    // was deleted in #199 — `web` is a record of where a capability lived,
    // not a link, and the no-linking rule binds `isPending`/renderers, not
    // this field. The CRM queue is a genuine successor to the leads page, so
    // it records the same way.
    expect(webPath("platform.crm")).toBe("/admin/apps/mark8ly/leads");
  });
});

describe("isRouteActive understands the console prefix", () => {
  it("matches a console path exactly", () => {
    expect(isRouteActive("/platform/tickets", "platform.tickets", "console")).toBe(
      true,
    );
  });

  it("matches nested routes under a non-exact entry", () => {
    expect(
      isRouteActive("/platform/tickets/M8-1042", "platform.tickets", "console"),
    ).toBe(true);
  });

  it("does not match on a bare string prefix", () => {
    // The bug this guards: `/platform/ticketsXYZ` shares a prefix with
    // `/platform/tickets` but is a different route.
    expect(
      isRouteActive("/platform/ticketsXYZ", "platform.tickets", "console"),
    ).toBe(false);
  });

  it("does not confuse the web path for the console one", () => {
    expect(
      isRouteActive("/admin/platform-tickets", "platform.tickets", "console"),
    ).toBe(false);
  });
});

describe("pending reflects what the console actually serves", () => {
  it("has tickets built", () => {
    // The first surface to land here. If this flips back to pending without
    // the page being removed, the rail stops linking a page that works.
    expect(isPending("platform.tickets")).toBe(false);
  });

  it("has the dashboard built", () => {
    // The console root ("/") is the estate map plus the internal tools
    // directory — that surface exists, so the rail must not badge it SOON
    // or block the palette from offering it.
    expect(isPending("platform.dashboard")).toBe(false);
  });

  it("has the estate audit log built", () => {
    // #139 built it here. If this flips to pending while the page still
    // exists, the rail renders a working surface as an inert SOON badge.
    expect(isPending("platform.auditLog")).toBe(false);
  });

  it("has the estate outbox built", () => {
    // Task 3 of the v1 outbox federation plan built /platform/outbox, reading
    // the platform API's federated GET /v1/outbox. If this flips back to
    // pending without the page being removed, the rail renders a working
    // surface as an inert SOON badge.
    expect(isPending("platform.outbox")).toBe(false);
    expect(consolePath("platform.outbox")).toBe("/platform/outbox");
  });

  it("reports kora.audit as retired rather than pending", () => {
    // The other half of the test this replaces, which held `kora.audit` pending
    // "until Task 3 retires it" so the sequencing was visible from here. Task 3
    // is this change: the page is deleted, `/admin/apps/kora/audit` redirects to
    // /platform/audit-log?source=kora, and Kora's trail is one source in the
    // merged timeline.
    //
    // `retired`, not `pending`, for the same reason as `platform.supportAnalytics`:
    // `pending` would say "a Kora audit page is coming to the console". None is.
    // The capability is here already, in a surface that spans every product.
    expect(isRetired("kora.audit")).toBe(true);
    expect(isPending("kora.audit")).toBe(false);
  });

  it("still records where Kora's audit page used to live", () => {
    // Retiring an id must not erase what it retired. `/admin/apps/kora/audit` is
    // the path next.config.ts redirects, and this is the one place that says so.
    expect(webPath("kora.audit")).toBe("/admin/apps/kora/audit");
  });

  it("serves Kora's food index and users, and keeps Overview pending", () => {
    // The food index is the console's first PRODUCT-rail page. It was pending
    // until tesserix/kora#480 gave §3.4 a browse mode — before that an index
    // page was impossible, because opening it with no query answered 400.
    expect(isPending("kora.foods")).toBe(false);
    expect(consolePath("kora.foods")).toBe("/kora/foods");

    // Guards against a blanket un-pend, which is what this test was originally
    // for: the rail must not offer navigation to pages that do not exist.
    //
    // Users is built too now (#355), read-only — Kora's DELETE exists and the
    // console does not offer it, pending the verb-capability decision
    // mark8ly#288 also waits on.
    expect(isPending("kora.users")).toBe(false);
    expect(consolePath("kora.users")).toBe("/kora/users");

    // `kora.overview` WAS pending, and the reason was good: Kora answers 501 on
    // /admin/kpis, tesserix/kora#472 decided to KEEP that rather than invent a
    // metric to fill a page, and an overview with nothing honest to show is
    // worse than an absent one.
    //
    // That premise changed rather than being overridden. Kora shipped
    // /v1/admin/ai-metrics (kora#507) — real resolution outcomes, not a
    // manufactured headline — and tesserix-home#412 federated it as
    // /v1/kora/ai-metrics. Together with entity totals and the kora-scoped
    // inbox depth, the page now renders four things Kora actually measures.
    //
    // #472 still stands: /admin/kpis remains 501 and the overview does NOT
    // invent a metric to fill the gap. Nothing here reads /v1/kpis.
    expect(isPending("kora.overview")).toBe(false);
    expect(consolePath("kora.overview")).toBe("/kora");
  });

  it("serves Kora's AI metrics — the full surface behind the overview's tiles", () => {
    // The overview links its three AI-resolution tiles here now that the
    // destination exists — see kora/overview-view.tsx.
    expect(isPending("kora.aiMetrics")).toBe(false);
    expect(consolePath("kora.aiMetrics")).toBe("/kora/ai-metrics");
  });

  it("keeps live chat pending", () => {
    // #197 owns it. apps/web still serves /admin/support/live-chat — it was
    // deliberately excluded from #133's redirects and deletions — but the
    // console has no chat inbox, and `pending` means "not here", not "not
    // anywhere". Flip this when #197 lands, not before.
    expect(isPending("platform.liveChat")).toBe(true);
  });

  it("keeps platform.apps pending, which the ticket detail depends on", () => {
    // Not housekeeping — this one is load-bearing. The ticket detail's tenant
    // deep link resolves through `platform.apps` (tenant-link.tsx) and renders
    // as inert text *only because* this is pending. Un-pending it turns that
    // into a live link to /platform/apps/{product}/tenants/{id}, a page the
    // console does not have: a 404 reached from a working surface.
    //
    // tenant-link.render.test.tsx mocks `isPending`, so it asserts both
    // branches render correctly and cannot notice which one is real. This is
    // the assertion that notices. Un-pend `platform.apps` in the same change
    // that builds the Apps rail, and delete this test then.
    expect(isPending("platform.apps")).toBe(true);
  });

  it("keeps the identity lookup pending because nothing can serve it yet", () => {
    // #134. This is a statement of intent, not housekeeping. The console holds
    // an OIDC login client only — it can verify the operator signing in, and
    // cannot enumerate users at all, because there is no Zitadel Management
    // API client in this repo. Un-pending this would put a live rail link and
    // an enabled palette entry onto a page that does not exist.
    //
    // Flip it in the change that lands both the credential and the surface.
    expect(isPending("platform.identityLookup")).toBe(true);
  });

  it("records the identity lookup's web path without linking it", () => {
    // `/admin/search` is where the capability lives TODAY. Recording it keeps
    // the retirement honest — one place says what the console is replacing.
    // `pending` is what stops any renderer treating it as a destination.
    expect(webPath("platform.identityLookup")).toBe("/admin/search");
    expect(consolePath("platform.identityLookup")).not.toMatch(/^\/admin\//);
  });

  it("reports support analytics as retired rather than pending", () => {
    // #133 folded it into platform.tickets as a tab. `pending` would say "a
    // Support analytics page is coming to the console" — it is not; there is
    // no page to come. The rail drops it entirely (nav.test.ts).
    expect(isRetired("platform.supportAnalytics")).toBe(true);
    expect(isPending("platform.supportAnalytics")).toBe(false);
  });

  it("retires nothing else", () => {
    // Guards the guard: `isRetired` returning true for everything would satisfy
    // the assertions above while quietly emptying both rails. Listed rather
    // than counted so adding one is a decision someone writes down here.
    //
    // `kora.feedback` is the third, added because Kora's own `/admin/inbox`
    // already merges feedback into the estate queue (tesserix/kora#474) — so a
    // Kora feedback page would be a second door onto rows the platform rail
    // serves. Same rule as `kora.audit`, §8.5.
    expect(ROUTE_IDS.filter(isRetired)).toEqual([
      "kora.audit",
      "kora.feedback",
      "platform.supportAnalytics",
    ]);
  });

  it("does not retire the other three product audit pages into route ids", () => {
    // #139 also deleted /admin/apps/mark8ly/audit-logs and
    // /admin/apps/homechef/audit-logs, and there is deliberately no
    // `mark8ly.audit` / `homechef.audit` id for them. Inventing ids for pages
    // that no longer exist, purely to mark them retired, would record IA the
    // estate never had. `kora.audit` is in the table only because it was
    // already there — Kora's rail is modelled here, the other products' are not.
    const ids: readonly string[] = ROUTE_IDS;
    expect(ids).not.toContain("mark8ly.audit");
    expect(ids).not.toContain("homechef.audit");
  });
});

describe("the onboarding session list", () => {
  it("is a route of its own, under the funnel", () => {
    // Its own id rather than a `?view=` on the funnel: the funnel answers
    // "where do merchants stall" and this answers "which merchant do I call".
    // The nesting is what keeps the rail highlighting the funnel's entry while
    // an operator is here — `platform.onboarding` is deliberately not `exact`.
    expect(consolePath("platform.onboardingSessions")).toBe("/platform/onboarding/sessions");
    expect(isPending("platform.onboardingSessions")).toBe(false);
    expect(consolePath("platform.onboardingSessions").startsWith(consolePath("platform.onboarding"))).toBe(
      true,
    );
  });

  it("appears in no rail — it is the funnel's detail, and the estate's one PII queue", () => {
    // A rail entry would advertise it as a peer of the funnel and put merchant
    // email addresses one click from every operator's landing page.
    const railed = navItems(platformNav).map((item) => item.route);
    expect(railed).toContain("platform.onboarding");
    expect(railed).not.toContain("platform.onboardingSessions");
  });
});
