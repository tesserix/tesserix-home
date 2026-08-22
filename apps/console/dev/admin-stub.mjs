#!/usr/bin/env node
// admin-stub.mjs — a local stand-in for apps/web's admin API.
//
// Part 2 of #271 (ADR-003 D6). The console reads eight endpoints from
// apps/web server-side, so without this the dashboard, tickets, support
// analytics and audit-log surfaces need a second Next.js app running just to
// render. The console already supports pointing elsewhere:
// `WEB_INTERNAL_ORIGIN` selects the origin and defaults to localhost:3002,
// which is what this serves.
//
//   npm run dev:stub          # this, on 3002
//   npm run dev:console       # console + stub together
//
// # This is scaffolding with a known end
//
// #271 is explicit that it belongs in M13 because it SHRINKS as the platform
// API replaces these endpoints — by the end of M13 most of it is unnecessary.
// It is not permanent infrastructure, and it should not grow features the real
// endpoints do not have.
//
// It also gives the migration its equivalence check: the same e2e assertions
// should pass against this stub and against the real Go module. If they do
// not, the module changed the contract.
//
// # Fidelity over convenience
//
// Responses reproduce what apps/web actually returns, including the parts that
// are awkward: the dashboard's four-domains-in-one-object payload, a populated
// `failures` array on a 200 audit response, and a 404 from conversion-status
// (see below). A stub that returned tidier data than production would hide
// exactly the problems these surfaces have.

import http from "node:http";
import process from "node:process";
import {
  AUDIT_ENTRIES,
  AUDIT_FAILURES,
  DASHBOARD,
  REPLIES,
  SUPPORT_ANALYTICS,
  TICKETS,
} from "./admin-stub-data.mjs";

const PORT = Number.parseInt(process.env.ADMIN_STUB_PORT ?? "3002", 10);

// In-memory, and reset on restart. Writes are accepted so the ticket reply and
// status-change flows are exercisable end to end — that is the console's only
// write verb outside the CRM, and #269 makes it the first module to migrate.
const tickets = TICKETS.map((t) => ({ ...t }));
const replies = new Map(
  Object.entries(REPLIES).map(([id, list]) => [id, list.map((r) => ({ ...r }))]),
);

// The id a PRODUCT would serve, recovered from the namespaced fixture.
//
// The fixture rows are stored the way apps/web emits them — already
// `${source}:${id}` — because that route serves them verbatim. The platform
// API's transport does the namespacing itself, from bare product ids, so its
// route here needs the bare half to apply the rule to. Split at the FIRST
// separator only: a raw id may contain colons of its own, which is why the
// convention parses from the left.
function bareAuditId(entry) {
  const prefix = `${entry.source}:`;
  return entry.id.startsWith(prefix) ? entry.id.slice(prefix.length) : entry.id;
}

function summaryOf(rows) {
  return {
    open: rows.filter((t) => t.status === "open").length,
    inProgress: rows.filter((t) => t.status === "in_progress").length,
    resolvedThisWeek: rows.filter((t) => t.status === "resolved").length,
    urgentOpen: rows.filter((t) => t.status === "open" && t.priority === "urgent")
      .length,
  };
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

export function createStubServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const { pathname } = url;
    const method = req.method ?? "GET";

    // No auth check. The real endpoints authorise the operator by replaying
    // their cookie, but a local stub that rejected an unauthenticated request
    // would only reproduce the login flow, not the surface under test — and
    // the console's dev-auth bypass means there is no real cookie to replay.
    // This is one of the ways the stub is deliberately not production.

    if (method === "GET" && pathname === "/api/admin/dashboard") {
      return json(res, 200, DASHBOARD);
    }

    if (method === "GET" && pathname === "/api/admin/platform-tickets") {
      // The real endpoint filters on these; honoured so the queue's filter UI
      // does something locally rather than appearing inert.
      const status = url.searchParams.get("status");
      const priority = url.searchParams.get("priority");
      const product = url.searchParams.get("product");
      const rows = tickets.filter(
        (t) =>
          (!status || t.status === status) &&
          (!priority || t.priority === priority) &&
          (!product || t.product_id === product),
      );
      // summary is of ALL tickets, not the filtered set — it is a standing
      // count of the queue, and recomputing it per filter would make the
      // headline numbers change as an operator narrows the list.
      return json(res, 200, {
        summary: summaryOf(tickets),
        rows,
        generatedAt: new Date().toISOString(),
      });
    }

    const ticketMatch = pathname.match(
      /^\/api\/admin\/platform-tickets\/([^/]+)(\/replies)?$/,
    );
    if (ticketMatch) {
      const [, id, isReplies] = ticketMatch;
      const ticket = tickets.find((t) => t.id === id);
      if (!ticket) return json(res, 404, { error: "not_found" });

      if (method === "GET" && !isReplies) {
        return json(res, 200, { ticket, replies: replies.get(id) ?? [] });
      }

      if (method === "POST" && isReplies) {
        const body = await readJson(req);
        if (!body || typeof body.content !== "string" || !body.content.trim()) {
          return json(res, 400, { error: "content_required" });
        }
        const reply = {
          id: `reply-${Date.now()}`,
          author_type: "platform_admin",
          author_name: "Dev Operator",
          author_email: "dev@tesserix.test",
          content: body.content,
          created_at: new Date().toISOString(),
        };
        replies.set(id, [...(replies.get(id) ?? []), reply]);
        ticket.updated_at = reply.created_at;
        return json(res, 201, { reply });
      }

      if (method === "PATCH" && !isReplies) {
        const body = await readJson(req);
        if (!body) return json(res, 400, { error: "invalid_body" });
        if (typeof body.status === "string") ticket.status = body.status;
        if (typeof body.priority === "string") ticket.priority = body.priority;
        ticket.updated_at = new Date().toISOString();
        if (ticket.status === "resolved" && !ticket.resolved_at) {
          ticket.resolved_at = ticket.updated_at;
        }
        return json(res, 200, { ticket });
      }
    }

    if (method === "GET" && pathname === "/api/admin/analytics/support") {
      return json(res, 200, SUPPORT_ANALYTICS);
    }

    const auditMatch = pathname.match(/^\/api\/admin\/apps\/([^/]+)\/audit-logs$/);
    if (method === "GET" && auditMatch) {
      const product = decodeURIComponent(auditMatch[1]);
      // `all` fans out across every source — the magic value #269 objects to,
      // reproduced because the console sends it today.
      const entries =
        product === "all"
          ? AUDIT_ENTRIES
          : AUDIT_ENTRIES.filter((e) => e.source === product);
      const limit = Number.parseInt(url.searchParams.get("limit") ?? "200", 10);
      return json(res, 200, {
        entries: entries.slice(0, limit),
        // Populated on a 200: the partial-failure path is the interesting one
        // and the console has real handling for it.
        failures: product === "all" ? AUDIT_FAILURES : [],
      });
    }

    // GET /v1/audit — the platform API's shape (Task 5/7). Served here so a
    // developer can flip PLATFORM_API_ORIGIN at the stub and exercise the
    // cutover path without running platform-api and a product. Reuses the
    // same fixtures as /api/admin/apps/:product/audit-logs above: both
    // transports are deliberately made to emit the same body, and giving
    // them the same rows here keeps that equivalence visible locally.
    if (method === "GET" && pathname === "/v1/audit") {
      const source = url.searchParams.get("source");
      // No `source` means "every source" — the same fan-out the `all`
      // product id triggers above, failures and all. A `source` narrows
      // which sources were asked, so an unrecognised or unrepresented value
      // returns an empty entries array rather than inventing rows, and never
      // a 400: this stub stands in for a transport, not for the platform
      // API's own validation.
      const rows = source
        ? AUDIT_ENTRIES.filter((e) => e.source === source)
        : AUDIT_ENTRIES;
      // The namespacing is PERFORMED here, not assumed from the fixture.
      //
      // Products serve bare ids — an integer primary key, a uuid — and the
      // platform API's audit service stamps `${slug}:${id}` from the slug it
      // called, which is what keeps two products' `12` from colliding in a
      // list keyed by id. Serving the already-namespaced fixture verbatim
      // made this stub agree with a platform API that did not namespace at
      // all, which is how the absence went unnoticed locally. Stripping back
      // to the bare id and re-applying the rule means a platform API that
      // stopped namespacing would no longer match what this stub emits.
      const entries = rows.map((entry) => ({
        ...entry,
        id: `${entry.source}:${bareAuditId(entry)}`,
      }));
      return json(res, 200, {
        data: {
          entries,
          failures: source ? [] : AUDIT_FAILURES,
        },
      });
    }

    const conversionMatch = pathname.match(
      /^\/api\/admin\/apps\/([^/]+)\/conversion-status$/,
    );
    if (method === "GET" && conversionMatch) {
      // 404 BY DEFAULT, AND THAT IS THE HONEST ANSWER.
      //
      // This endpoint does not exist for any product — lib/crm-conversion.ts
      // says so in its own comment, and #246 records that every Handoff signal
      // therefore reads `unknown` in production. A stub that invented a 200
      // here would make a broken feature look healthy locally, which is the
      // opposite of what #271 is for.
      //
      // ADMIN_STUB_CONVERSION=200 serves a real answer instead, so the other
      // branch can be developed against once someone decides to build it
      // (ADR-003: "an endpoint to design, or a feature to withdraw").
      if (process.env.ADMIN_STUB_CONVERSION !== "200") {
        return json(res, 404, { error: "not_implemented_for_product" });
      }
      const email = url.searchParams.get("email") ?? "";
      return json(res, 200, {
        state: email.includes("owner") ? "complete" : "none",
        ref: email.includes("owner") ? "tenant_amber" : undefined,
        label: email.includes("owner") ? "Amber Collective" : undefined,
        idle_hours: 12,
        observed_at: new Date().toISOString(),
      });
    }

    // Loud, not silent. An unmatched path is almost always a console change
    // that added a ninth call site — which is exactly the thing #272's
    // retirement inventory needs to know about.
    console.warn(`[admin-stub] unhandled ${method} ${pathname}`);
    return json(res, 404, { error: "no_stub_for_this_endpoint" });
  });
}

// Only listen when run directly, so the test can import createStubServer and
// bind an ephemeral port instead of fighting for 3002.
if (import.meta.url === `file://${process.argv[1]}`) {
  createStubServer().listen(PORT, () => {
    console.log(`[admin-stub] serving apps/web's admin API on :${PORT}`);
    console.log(
      "[admin-stub] conversion-status answers 404 by default (#246) — " +
      "set ADMIN_STUB_CONVERSION=200 to serve a signal",
    );
  });
}
