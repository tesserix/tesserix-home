import { describe, expect, it } from "vitest";

import type { EmailTemplateRow } from "@/lib/email-templates";
import { emailTemplatesState } from "./page";

const ROW: EmailTemplateRow = {
  id: "mark8ly:orderdoc_invoice",
  source: "mark8ly",
  key: "orderdoc_invoice",
  state: "published",
  sends_from: "row",
  has_embedded_default: true,
  subject: "Order {{.OrderNumber}}",
};

describe("emailTemplatesState", () => {
  it("is ready when rows arrived and every source answered", () => {
    expect(emailTemplatesState({ error: null, rows: [ROW], failures: [] })).toEqual({
      kind: "ready",
    });
  });

  it("is empty only when the registry really is empty", () => {
    expect(emailTemplatesState({ error: null, rows: [], failures: [] })).toEqual({
      kind: "empty",
    });
  });

  it("is an error — not empty — when no rows arrived and a source failed", () => {
    // THE ROW THIS FUNCTION EXISTS FOR. `resolveState` decides on `rows.length`
    // and knows nothing about `failures`, so this case would otherwise render
    // "Nothing here yet" over a product that is down. The HTTP response is a
    // genuine 200, so nothing in the transport can catch it.
    const state = emailTemplatesState({
      error: null,
      rows: [],
      failures: [{ source: "mark8ly", message: "responded 500" }],
    });
    expect(state.kind).toBe("error");
    expect(state.kind === "error" ? state.message : "").toMatch(
      /not an empty list.*mark8ly could not be read \(responded 500\)/,
    );
  });

  it("shows the rows it did get when only some sources failed", () => {
    // Ready, so the table renders — the view carries the incomplete-listing
    // warning above it. Resolving this to an error would hide templates that
    // arrived perfectly well.
    expect(
      emailTemplatesState({
        error: null,
        rows: [ROW],
        failures: [{ source: "other", message: "responded 500" }],
      }),
    ).toEqual({ kind: "ready" });
  });

  it("prefers a thrown failure over anything the payload said", () => {
    const state = emailTemplatesState({
      error: Object.assign(new Error("boom"), { status: 503 }),
      rows: [],
      failures: [],
    });
    expect(state.kind).toBe("error");
  });

  it("reads a 501 as not-wired-up rather than as a failure", () => {
    // `NOT_IMPLEMENTED` means no product declares this registry. Rendering it
    // red would tell an operator to fix an outage that is not happening.
    expect(
      emailTemplatesState({
        error: Object.assign(new Error("parked"), { status: 501 }),
        rows: [],
        failures: [],
      }).kind,
    ).toBe("instrumentation-unavailable");
  });
});
