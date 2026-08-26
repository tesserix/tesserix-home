import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PlatformApiError } from "@/lib/platform-api";
import type { EstateInbox } from "@/lib/inbox";
import {
  INBOX_EMPTY_MESSAGE,
  INBOX_UNAVAILABLE_MESSAGE,
  INBOX_UNAVAILABLE_TITLE,
  emptyMessageFor,
  inboxReadError,
  queueState,
} from "./page";
import { InboxQueue, kindLabel, severityTone, waitedFor } from "./inbox-queue";

// The page is a server component and cannot be rendered by Testing Library, so
// its own logic is exercised through its exported pure functions and the
// client half is rendered directly — the same split the tenant directory's
// tests use.

const item = {
  id: "kora:u9",
  source: "kora",
  kind: "unresolved_food",
  title: "ragi mudde",
  subtitle: "no match",
  waitingSince: "2026-08-18T09:00:00Z",
  actions: [],
};

const inbox = (over: Partial<EstateInbox> = {}): EstateInbox => ({
  items: [item],
  total: 1,
  failures: [],
  ...over,
});

describe("the empty state, which is what this surface ships with", () => {
  // The queue is genuinely empty today — Kora's source tables are at zero rows
  // and mark8ly implements no inbox — so this sentence is the first thing
  // anyone sees. "Nothing is waiting" must not read as "nothing is connected".
  it("says nothing is waiting, and says who answered", () => {
    expect(emptyMessageFor([])).toBe(INBOX_EMPTY_MESSAGE);
    expect(INBOX_EMPTY_MESSAGE).toMatch(/answered/);
  });

  // "Nothing is waiting" and "nothing is waiting that we could read" are
  // different claims, and only the second is true when a source was lost.
  it("refuses to claim an all-clear when a product could not be read", () => {
    const message = emptyMessageFor([{ source: "kora", message: "connection failed" }]);
    expect(message).not.toBe(INBOX_EMPTY_MESSAGE);
    expect(message).toMatch(/not evidence/);
  });

  it("counts the lost products rather than saying 'some'", () => {
    const two = emptyMessageFor([
      { source: "a", message: "x" },
      { source: "b", message: "y" },
    ]);
    expect(two).toMatch(/2 products/);
  });
});

describe("a 501 is not an error", () => {
  it("renders config copy rather than the kit's observability default", () => {
    const surfaced = inboxReadError(new PlatformApiError("inbox: not configured", 501));
    expect(surfaced?.unavailable?.title).toBe(INBOX_UNAVAILABLE_TITLE);
    // The kit's default points at the observability park, which is the right
    // remedy for a parked metrics plane and the wrong one here.
    expect(INBOX_UNAVAILABLE_MESSAGE).toMatch(/nothing to retry/);
  });

  it("leaves a real failure alone", () => {
    const surfaced = inboxReadError(new PlatformApiError("boom", 502));
    expect(surfaced?.unavailable).toBeUndefined();
  });
});

describe("queueState", () => {
  // A partial answer is a 200 carrying failures: the items still render and
  // the lost products are reported beside them, never instead of them.
  it("renders items even when a source failed", () => {
    expect(queueState({ error: null, items: [item] }).kind).toBe("ready");
  });

  it("is empty, not error, when the read succeeded with nothing", () => {
    expect(queueState({ error: null, items: [] }).kind).toBe("empty");
  });

  it("replaces the table only when the whole read threw", () => {
    expect(queueState({ error: new PlatformApiError("boom", 502), items: [] }).kind).toBe("error");
  });
});

describe("waitedFor", () => {
  const now = new Date("2026-08-20T12:00:00Z");

  // Rounded DOWN: overstating a wait makes a queue look worse than it is, and
  // this is the number an operator triages on.
  it("rounds down rather than up", () => {
    expect(waitedFor("2026-08-20T11:01:00Z", now)).toBe("59m");
  });

  it("renders minutes, hours and days", () => {
    expect(waitedFor("2026-08-20T11:30:00Z", now)).toBe("30m");
    expect(waitedFor("2026-08-20T09:00:00Z", now)).toBe("3h");
    expect(waitedFor("2026-08-18T09:00:00Z", now)).toBe("2d");
  });

  it("says 'just now' rather than '0m'", () => {
    expect(waitedFor("2026-08-20T11:59:59Z", now)).toBe("just now");
  });

  // Inventing a duration from a value we could not read would put a confident
  // wrong number in front of an operator.
  it("renders an unparseable timestamp verbatim rather than guessing", () => {
    expect(waitedFor("not a date", now)).toBe("not a date");
  });
});

describe("the product's vocabulary is rendered, not translated", () => {
  it("shows an unknown kind as itself", () => {
    expect(kindLabel("some_future_kind")).toBe("some future kind");
  });

  // Mapping an unknown severity onto a loud tone would let a product's new
  // low-priority category arrive painted as an emergency.
  it("gives an unknown severity a neutral tone", () => {
    expect(severityTone("chartreuse")).toBe("neutral");
    expect(severityTone(undefined)).toBe("neutral");
    expect(severityTone("warning")).toBe("warning");
    expect(severityTone("critical")).toBe("destructive");
  });
});

describe("InboxQueue", () => {
  it("renders an item with its product and kind", () => {
    render(
      <InboxQueue
        inbox={inbox()}
        state={queueState({ error: null, items: [item] })}
        emptyMessage={INBOX_EMPTY_MESSAGE}
        scopeNote="note"
        reauthReturnTo="/platform/inbox"
      />,
    );
    expect(screen.getByText("ragi mudde")).toBeInTheDocument();
    expect(screen.getByText("unresolved food")).toBeInTheDocument();
  });

  // A short queue must be true. An operator reading one concludes the work is
  // nearly done, so a lost source has to be visible above it.
  it("warns that the queue is incomplete when a source failed", () => {
    render(
      <InboxQueue
        inbox={inbox({ failures: [{ source: "kora", message: "connection failed" }] })}
        state={queueState({ error: null, items: [item] })}
        emptyMessage={INBOX_EMPTY_MESSAGE}
        scopeNote="note"
        reauthReturnTo="/platform/inbox"
      />,
    );
    expect(screen.getByText(/queue is incomplete/i)).toBeInTheDocument();
    // And says the total is an undercount, because a failed product
    // contributes nothing rather than zero.
    expect(screen.getByText(/understates/i)).toBeInTheDocument();
  });

  // The estate's queue DEPTH may exceed the rows shown; saying so plainly
  // beats leaving someone to infer it from a row count that stops at the bound.
  it("says how many are shown of how many are waiting", () => {
    render(
      <InboxQueue
        inbox={inbox({ total: 40 })}
        state={queueState({ error: null, items: [item] })}
        emptyMessage={INBOX_EMPTY_MESSAGE}
        scopeNote="note"
        reauthReturnTo="/platform/inbox"
      />,
    );
    expect(screen.getByText(/Showing 1 of 40 waiting/)).toBeInTheDocument();
  });

  it("does not say 'showing N of N' when the page is the whole queue", () => {
    render(
      <InboxQueue
        inbox={inbox()}
        state={queueState({ error: null, items: [item] })}
        emptyMessage={INBOX_EMPTY_MESSAGE}
        scopeNote="note"
        reauthReturnTo="/platform/inbox"
      />,
    );
    expect(screen.getByText(/1 waiting\./)).toBeInTheDocument();
    expect(screen.queryByText(/Showing/)).not.toBeInTheDocument();
  });
});
