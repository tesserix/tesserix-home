import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseDashboard } from "../lib/platform-api";
import { parseTickets, parseTicketDetail } from "../lib/tickets";
import { parseSupportAnalytics } from "../lib/support-analytics";
import { parseEstateAuditLog } from "../lib/audit";

// The stub is a plain .mjs dev script, deliberately outside the TS build —
// it must be runnable with bare `node` and no compile step. TypeScript
// resolves the .mjs under allowJs, so no directive is needed.
import { createStubServer } from "./admin-stub.mjs";

/**
 * The stub is verified by the console's OWN parsers.
 *
 * This is the whole point of the file. A hand-written stub drifts from the
 * contract silently: someone renames a field in apps/web, the parser is
 * updated, and the stub keeps serving the old shape — so local development
 * and e2e both pass against a contract that no longer exists. Running the real
 * parsers over the real stub responses makes that drift a failing test.
 *
 * It is also the equivalence harness #271 asks for. When the platform API
 * replaces one of these endpoints, the same parser must accept the Go module's
 * response — so this file is the shape the module has to match.
 */

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createStubServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function get(path: string) {
  const response = await fetch(`${origin}${path}`);
  return { status: response.status, body: await response.json() };
}

describe("dashboard", () => {
  it("is accepted by parseDashboard", async () => {
    const { status, body } = await get("/api/admin/dashboard");

    expect(status).toBe(200);
    const parsed = parseDashboard(body);
    expect(parsed.tenants.total).toBeGreaterThan(0);
    // Every lead status the parser demands must be present — it throws on a
    // missing bucket rather than defaulting to zero.
    expect(Object.keys(parsed.leads.by_status).sort()).toEqual(
      ["contacted", "converted", "lost", "new", "qualified"],
    );
  });
});

describe("tickets", () => {
  it("the listing is accepted by parseTickets", async () => {
    const { status, body } = await get("/api/admin/platform-tickets");

    expect(status).toBe(200);
    const parsed = parseTickets(body);
    expect(parsed.rows.length).toBeGreaterThan(0);
    expect(parsed.summary.open).toBeGreaterThan(0);
  });

  it("serves an urgent open ticket, so the queue's severity styling renders", async () => {
    const { body } = await get("/api/admin/platform-tickets");

    const parsed = parseTickets(body);
    expect(parsed.rows.some((t) => t.priority === "urgent")).toBe(true);
    expect(parsed.summary.urgentOpen).toBeGreaterThan(0);
  });

  it("honours the status filter", async () => {
    const { body } = await get("/api/admin/platform-tickets?status=open");

    const parsed = parseTickets(body);
    expect(parsed.rows.length).toBeGreaterThan(0);
    expect(parsed.rows.every((t) => t.status === "open")).toBe(true);
  });

  it("keeps the summary over ALL tickets when a filter narrows the rows", async () => {
    const all = parseTickets((await get("/api/admin/platform-tickets")).body);
    const filtered = parseTickets(
      (await get("/api/admin/platform-tickets?status=open")).body,
    );

    // A standing count of the queue. Recomputing it per filter would make the
    // headline numbers move as an operator narrows the list.
    expect(filtered.summary).toEqual(all.summary);
    expect(filtered.rows.length).toBeLessThan(all.rows.length);
  });

  it("the detail is accepted by parseTicketDetail, with both author types", async () => {
    const list = parseTickets((await get("/api/admin/platform-tickets")).body);
    const withReplies = list.rows[0];

    const { status, body } = await get(
      `/api/admin/platform-tickets/${withReplies.id}`,
    );

    expect(status).toBe(200);
    const parsed = parseTicketDetail(body);
    expect(parsed.ticket.description).not.toBe("");
    // parseTicketDetail REJECTS an unknown author_type, and the two render
    // differently — a misattributed message is worse than an error.
    const authorTypes = parsed.replies.map((r) => r.authorType);
    expect(authorTypes).toContain("merchant");
    expect(authorTypes).toContain("platform_admin");
  });

  it("404s an unknown ticket rather than serving an empty one", async () => {
    const { status } = await get(
      "/api/admin/platform-tickets/00000000-0000-4000-8000-000000000000",
    );

    expect(status).toBe(404);
  });

  it("accepts a reply and reflects it in the detail", async () => {
    const list = parseTickets((await get("/api/admin/platform-tickets")).body);
    const id = list.rows[0].id;
    const before = parseTicketDetail(
      (await get(`/api/admin/platform-tickets/${id}`)).body,
    );

    const posted = await fetch(`${origin}/api/admin/platform-tickets/${id}/replies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "Acknowledged — investigating now." }),
    });
    expect(posted.status).toBe(201);

    const after = parseTicketDetail(
      (await get(`/api/admin/platform-tickets/${id}`)).body,
    );
    expect(after.replies.length).toBe(before.replies.length + 1);
    expect(after.replies.at(-1)?.content).toBe("Acknowledged — investigating now.");
  });

  it("rejects an empty reply", async () => {
    const list = parseTickets((await get("/api/admin/platform-tickets")).body);

    const posted = await fetch(
      `${origin}/api/admin/platform-tickets/${list.rows[0].id}/replies`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "   " }),
      },
    );

    expect(posted.status).toBe(400);
  });

  it("applies a status transition and stamps resolved_at", async () => {
    const list = parseTickets((await get("/api/admin/platform-tickets")).body);
    const open = list.rows.find((t) => t.status === "open");
    if (!open) throw new Error("fixture must contain an open ticket");

    const patched = await fetch(`${origin}/api/admin/platform-tickets/${open.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "resolved" }),
    });
    expect(patched.status).toBe(200);

    const after = parseTicketDetail(
      (await get(`/api/admin/platform-tickets/${open.id}`)).body,
    );
    expect(after.ticket.status).toBe("resolved");
    expect(after.ticket.resolvedAt).not.toBeNull();
  });
});

describe("support analytics", () => {
  it("is accepted by parseSupportAnalytics", async () => {
    const { status, body } = await get("/api/admin/analytics/support");

    expect(status).toBe(200);
    const parsed = parseSupportAnalytics(body);
    expect(parsed.total).toBeGreaterThan(0);
    expect(parsed.byStatus.length).toBeGreaterThan(0);
    expect(parsed.byTenant.length).toBeGreaterThan(0);
  });

  it("resolves tenant ids to names, so the breakdown is readable", async () => {
    const { body } = await get("/api/admin/analytics/support");

    const parsed = parseSupportAnalytics(body);
    // The label must differ from the raw key for at least one row, or
    // tenant_names is not being exercised at all.
    expect(parsed.byTenant.some((r) => r.label !== r.key)).toBe(true);
  });

  it("carries feedback, so CSAT renders as a score rather than a dash", async () => {
    const { body } = await get("/api/admin/analytics/support");

    const parsed = parseSupportAnalytics(body);
    // formatCsat renders "—" when feedbackCount is 0. A fixture that tripped
    // that would leave the populated state unrendered locally.
    expect(parsed.feedbackCount).toBeGreaterThan(0);
    expect(parsed.csat).toBeGreaterThan(0);
  });
});

describe("audit log", () => {
  it("is accepted by parseEstateAuditLog", async () => {
    const { status, body } = await get(
      "/api/admin/apps/all/audit-logs?limit=200&since_hours=720",
    );

    expect(status).toBe(200);
    const parsed = parseEstateAuditLog(body);
    expect(parsed.entries.length).toBeGreaterThan(0);
  });

  it("returns a populated failures array on a 200", async () => {
    const { body } = await get("/api/admin/apps/all/audit-logs");

    const parsed = parseEstateAuditLog(body);
    // The partial-failure path — some sources answered, one did not. The
    // console has real handling for it, and a stub that always returned []
    // would leave it unrendered locally.
    expect(parsed.failures.length).toBeGreaterThan(0);
    expect(parsed.failures[0].source).toBeTruthy();
  });

  it("attributes every entry to a source", async () => {
    const { body } = await get("/api/admin/apps/all/audit-logs");

    const parsed = parseEstateAuditLog(body);
    // parseEntry REQUIRES source — a wrong Source column is worse than a
    // failed read, so it must never be defaulted.
    expect(parsed.entries.every((e) => e.source.length > 0)).toBe(true);
  });

  it("scopes to one product when asked", async () => {
    const { body } = await get("/api/admin/apps/console/audit-logs");

    const parsed = parseEstateAuditLog(body);
    expect(parsed.entries.every((e) => e.source === "console")).toBe(true);
  });

  // The platform transport, which the console reads whenever
  // PLATFORM_API_ORIGIN is set. Its route must behave like the real module,
  // and the property that was silently missing is the id namespace.
  describe("the platform API's /v1/audit", () => {
    // The platform API wraps every payload in `{ success, data }` and
    // `platformRequest` hands the parser the `data` half; this mirrors that.
    const payload = (body: unknown) => (body as { data: unknown }).data;

    it("is accepted by the same parser, through the envelope", async () => {
      const { status, body } = await get("/v1/audit?limit=200&since_hours=720");

      expect(status).toBe(200);
      const parsed = parseEstateAuditLog(payload(body));
      expect(parsed.entries.length).toBeGreaterThan(0);
      expect(parsed.failures.length).toBeGreaterThan(0);
    });

    it("namespaces every id with the source that produced it", async () => {
      const { body } = await get("/v1/audit");

      const parsed = parseEstateAuditLog(payload(body));
      // The real service stamps `${slug}:${id}` from the slug it called,
      // because two products returning primary key `12` are otherwise
      // indistinguishable in a list keyed by id. A bare id here would let a
      // platform API that stopped namespacing still look correct locally.
      expect(parsed.entries.every((e) => e.id.startsWith(`${e.source}:`))).toBe(true);
      expect(parsed.entries.every((e) => e.id.length > e.source.length + 1)).toBe(true);
    });

    it("emits the same ids as the apps/web route, which is the point of the cutover", async () => {
      const platform = parseEstateAuditLog(payload((await get("/v1/audit")).body));
      const web = parseEstateAuditLog(
        (await get("/api/admin/apps/all/audit-logs")).body,
      );

      // Unsetting PLATFORM_API_ORIGIN is meant to be a true rollback. Two
      // transports that key the same event differently are two different
      // audit logs.
      expect(platform.entries.map((e) => e.id).sort()).toEqual(
        web.entries.map((e) => e.id).sort(),
      );
    });
  });
});

describe("conversion-status", () => {
  it("404s by default, matching production", async () => {
    const { status } = await get(
      "/api/admin/apps/mark8ly/conversion-status?email=owner@amber.test",
    );

    // #246: this endpoint exists for no product, so every Handoff signal reads
    // `unknown`. A stub that invented a 200 would make a broken feature look
    // healthy locally — the opposite of what #271 is for.
    expect(status).toBe(404);
  });
});

describe("unhandled paths", () => {
  it("404s rather than serving something plausible", async () => {
    const { status, body } = await get("/api/admin/something-new");

    expect(status).toBe(404);
    // Named distinctly, so a ninth console call site is identifiable as "the
    // stub has no answer" rather than "the resource does not exist".
    expect(body).toMatchObject({ error: "no_stub_for_this_endpoint" });
  });
});
