import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { AiUsageEvent } from "@/lib/ai-usage";
import { EventsTable, eventCostLabel, eventTimeLabel } from "./events-table";
import { GuardrailRules } from "./guardrail-rules";

const EVENT: AiUsageEvent = {
  spanId: "span-1",
  traceId: "trace-1",
  occurredAt: "2026-08-20T06:59:12.482Z",
  gateway: "kora-ai",
  product: "kora",
  capability: "summarise",
  provider: "vertex",
  requestModel: "gemini-2.5-pro",
  responseModel: "gemini-2.5-pro",
  tokens: { input: 1200, output: 300, cachedInput: 0 },
  costUsd: 0.0031,
  costSource: "catalog",
  statusCode: 200,
  outcome: "ok",
  guardrailAction: null,
  guardrailRule: null,
  latencyMs: 412,
};

function renderEvents(events: readonly AiUsageEvent[]) {
  render(<EventsTable events={events} state={{ kind: "ready" }} emptyMessage="nothing here" />);
}

describe("eventCostLabel", () => {
  it("shows an em dash when the request was never priced", () => {
    // The stored zero is an absence of a price, not a free request, and
    // "$0.00" would be a claim the ledger cannot make.
    expect(eventCostLabel({ ...EVENT, costSource: "unpriced", costUsd: 0 })).toBe("—");
  });

  it("shows the cost when the gateway or the catalog priced it", () => {
    expect(eventCostLabel(EVENT)).toBe("$0.0031");
  });
});

describe("eventTimeLabel", () => {
  it("renders UTC to the second, matching the rest of the surface", () => {
    expect(eventTimeLabel(EVENT.occurredAt)).toBe("2026-08-20 06:59:12");
  });
});

describe("EventsTable", () => {
  it("shows the capability under the product, which is the sub-usage", () => {
    renderEvents([EVENT]);
    expect(screen.getByText("summarise")).toBeInTheDocument();
  });

  it("names the rule that refused a request", () => {
    renderEvents([
      {
        ...EVENT,
        outcome: "guardrail_blocked",
        guardrailAction: "reject",
        guardrailRule: "CreditCard",
        costSource: "unpriced",
        costUsd: 0,
      },
    ]);
    expect(screen.getByText("Blocked")).toBeInTheDocument();
    expect(screen.getByText("CreditCard (reject)")).toBeInTheDocument();
  });

  it("shows an unmeasured latency as an em dash rather than as zero", () => {
    renderEvents([{ ...EVENT, latencyMs: null }]);
    const row = screen.getByText("kora").closest("tr");
    expect(within(row!).getAllByText("—").length).toBeGreaterThan(0);
  });
});

describe("GuardrailRules", () => {
  it("distinguishes a rejected request from a masked one", () => {
    // A rejected request never reached a provider; a masked one did, with the
    // match removed. Counting them together would report a refusal rate that
    // is not one.
    render(
      <GuardrailRules
        state={{ kind: "ready" }}
        emptyMessage="nothing here"
        rules={[
          {
            rule: "CreditCard",
            action: "reject",
            product: "kora",
            requests: 4,
            lastSeen: "2026-08-20T06:59:00Z",
          },
          {
            rule: "Email",
            action: "mask",
            product: "hms",
            requests: 9,
            lastSeen: "2026-08-20T06:58:00Z",
          },
        ]}
      />,
    );
    expect(screen.getByText("Rejected")).toBeInTheDocument();
    expect(screen.getByText("Masked")).toBeInTheDocument();
  });
});
