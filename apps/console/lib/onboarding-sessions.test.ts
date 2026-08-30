import { describe, expect, it } from "vitest";
import { PlatformApiError } from "./platform-api-error";
import { parseOnboardingSessions } from "./onboarding-sessions";

/**
 * One row exactly as mark8ly's `sessionRow` marshals it (verified against
 * `platformadmin/onboarding.go` on 2026-08-30, NOT against its Go client
 * type — the internal `onboardingfunnel.Session` carries an
 * `email_verified_at` the wire row deliberately does not).
 */
const ROW = {
  id: "sess-1",
  email: "merchant@example.com",
  status: "in_progress",
  created_at: "2026-08-28T09:00:00Z",
  last_activity_at: "2026-08-29T11:30:00Z",
  idle_hours: 21.5,
  abandoned: false,
  completed_at: null,
  tenant_id: null,
};

const META = { total: 137, limit: 50 };

describe("parseOnboardingSessions", () => {
  it("reads the wire row field for field", () => {
    expect(parseOnboardingSessions([ROW], META).rows[0]).toEqual({
      id: "sess-1",
      email: "merchant@example.com",
      status: "in_progress",
      createdAt: "2026-08-28T09:00:00Z",
      lastActivityAt: "2026-08-29T11:30:00Z",
      idleHours: 21.5,
      abandoned: false,
      completedAt: null,
      tenantId: null,
    });
  });

  it("carries the tenant a converted session became", () => {
    const row = { ...ROW, completed_at: "2026-08-29T12:00:00Z", tenant_id: "tnt-9" };
    expect(parseOnboardingSessions([row], META).rows[0]).toMatchObject({
      completedAt: "2026-08-29T12:00:00Z",
      tenantId: "tnt-9",
    });
  });

  it("accepts an empty list — that is a measurement, not a failure", () => {
    expect(parseOnboardingSessions([], { total: 0, limit: 50 })).toEqual({
      rows: [],
      total: 0,
      limit: 50,
    });
  });

  it("refuses every shape that decodes one layer down as an empty queue", () => {
    // The load-bearing guard. `data ?? []` and `data.map(…)` on a null both
    // render "nobody signed up", which is a different answer from "we could
    // not read the list".
    for (const data of [null, undefined, {}, "", 0]) {
      expect(() => parseOnboardingSessions(data, META)).toThrow(PlatformApiError);
    }
    expect(() => parseOnboardingSessions(null, META)).toThrow(
      /an unreadable list is not an empty one/,
    );
  });

  it("refuses a page with no total — that reads as the whole list", () => {
    expect(() => parseOnboardingSessions([ROW], {})).toThrow(/meta.total/);
    expect(() => parseOnboardingSessions([ROW], null)).toThrow(/meta is missing/);
  });

  it("reports an absent applied limit as null rather than as a page size of zero", () => {
    // `meta.limit` is `omitempty` on the wire, so an absent key means zero,
    // and zero is not a size any range arithmetic can use.
    expect(parseOnboardingSessions([ROW], { total: 1 }).limit).toBeNull();
    expect(parseOnboardingSessions([ROW], { total: 1, limit: 0 }).limit).toBeNull();
  });

  it("keeps the applied limit, which is not always the one asked for", () => {
    expect(parseOnboardingSessions([ROW], { total: 500, limit: 200 }).limit).toBe(200);
  });

  it("refuses a row missing a field the contract pins as an explicit null", () => {
    const { completed_at: _completed, ...withoutCompleted } = ROW;
    expect(() => parseOnboardingSessions([withoutCompleted], META)).toThrow(
      /completed_at is absent/,
    );
    const { tenant_id: _tenant, ...withoutTenant } = ROW;
    expect(() => parseOnboardingSessions([withoutTenant], META)).toThrow(/tenant_id is absent/);
  });

  it("refuses a row whose types are wrong, naming the path and never the value", () => {
    // PII discipline: platform-api keeps merchant addresses out of every
    // failure path and this parser holds the same line. A message quoting the
    // offending value would put an address in a callout the moment the shape
    // is right and the content is not.
    const bad = { ...ROW, id: 7, email: "merchant@example.com" };
    let message = "";
    try {
      parseOnboardingSessions([bad], META);
    } catch (caught) {
      message = (caught as Error).message;
    }
    expect(message).toContain("data[0].id");
    expect(message).not.toContain("merchant@example.com");
    expect(message).not.toContain("@");
  });

  it("refuses a non-numeric idle_hours and a non-boolean abandoned", () => {
    expect(() => parseOnboardingSessions([{ ...ROW, idle_hours: "21.5" }], META)).toThrow(
      /idle_hours/,
    );
    expect(() => parseOnboardingSessions([{ ...ROW, abandoned: "false" }], META)).toThrow(
      /abandoned is not a boolean/,
    );
  });

  it("passes a status this build has never heard of straight through", () => {
    // mark8ly's vocabulary is mark8ly's. A console-side enum here would drop
    // rows the product considers ordinary.
    const row = { ...ROW, status: "awaiting_kyc_review" };
    expect(parseOnboardingSessions([row], META).rows[0]!.status).toBe("awaiting_kyc_review");
  });
});
