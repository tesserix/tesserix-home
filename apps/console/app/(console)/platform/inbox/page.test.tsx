import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const fetchEstateInbox = vi.fn();

vi.mock("@/lib/platform-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform-api")>()),
  fetchEstateInbox: (...args: unknown[]) => fetchEstateInbox(...args),
}));

import { PlatformApiError } from "@/lib/platform-api";
import type { EstateInbox } from "@/lib/inbox";
import EstateInboxPage, {
  INBOX_EMPTY_MESSAGE,
  INBOX_UNAVAILABLE_MESSAGE,
  INBOX_UNAVAILABLE_TITLE,
  currentPath,
  emptyMessageFor,
  inboxReadError,
  queueState,
  readSource,
} from "./page";
import { InboxQueue, kindLabel, severityTone, waitedFor } from "./inbox-queue";

// The page is a server component. Its default export is an async function
// that can be awaited and the result rendered directly — the same pattern
// `kora/page.test.tsx` uses for `KoraOverviewPage`. Its other logic is
// exercised through its exported pure functions, and the client half is
// rendered directly — the same split the tenant directory's tests use.

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

describe("readSource", () => {
  it("reads the URL's ?source= value", () => {
    expect(readSource({ source: "kora" })).toBe("kora");
  });

  // Absence must round-trip to `undefined`, not `""` or `"all"` — that is
  // what makes fetchEstateInbox's own no-filter branch fire.
  it("is undefined when the URL carries no source", () => {
    expect(readSource({})).toBeUndefined();
  });

  it("treats a blank source the same as an absent one", () => {
    expect(readSource({ source: "" })).toBeUndefined();
    expect(readSource({ source: "  " })).toBeUndefined();
  });

  it("ignores a repeated ?source= rather than guessing which one was meant", () => {
    expect(readSource({ source: ["kora", "mark8ly"] })).toBeUndefined();
  });
});

describe("currentPath", () => {
  it("is the bare path with no params", () => {
    expect(currentPath({})).toBe("/platform/inbox");
  });

  it("carries the source through for the reauth return URL", () => {
    expect(currentPath({ source: "kora" })).toBe("/platform/inbox?source=kora");
  });
});

describe("EstateInboxPage — the ?source filter", () => {
  // THE non-negotiable: this is a shared surface every product's operators
  // read. A default that quietly narrows it is a regression for every one of
  // them, so the no-param path must ask for exactly what it always has.
  it("passes no filter to fetchEstateInbox when the URL carries none — unchanged from before this task", async () => {
    fetchEstateInbox.mockResolvedValue(inbox());
    render(await EstateInboxPage({ searchParams: Promise.resolve({}) }));
    expect(fetchEstateInbox).toHaveBeenCalledWith(undefined);
  });

  it("passes the URL's source straight through to the read", async () => {
    fetchEstateInbox.mockResolvedValue(inbox());
    render(await EstateInboxPage({ searchParams: Promise.resolve({ source: "kora" }) }));
    expect(fetchEstateInbox).toHaveBeenCalledWith("kora");
  });

  it("keeps the source in the reauth return URL, so signing in again returns to the same filtered queue", async () => {
    fetchEstateInbox.mockRejectedValue({ noOperatorToken: true, message: "no token" });
    render(await EstateInboxPage({ searchParams: Promise.resolve({ source: "kora" }) }));
    expect(screen.getByRole("link", { name: /sign in again/i })).toHaveAttribute(
      "href",
      `/auth/login?returnTo=${encodeURIComponent("/platform/inbox?source=kora")}`,
    );
  });

  // DECISION: an unknown/garbage source is not validated or rejected by the
  // page. `fetchEstateInbox` already treats "all" as the absence of a filter
  // and sends anything else straight through; the platform API refuses a
  // source it does not recognise with a 400 rather than an empty 200. That
  // 400 is caught here exactly like any other read failure and rendered
  // through the same `queueState`/`SurfaceStateView` error path — a legible
  // error, never a silently empty queue. The console does not keep its own
  // list of valid sources to pre-validate against; that vocabulary belongs to
  // the API, the same reason `kind` and `severity` are rendered verbatim
  // rather than enumerated console-side.
  it("renders the API's 400 for an unknown source as a legible error, not an empty queue", async () => {
    fetchEstateInbox.mockRejectedValue(
      new PlatformApiError("inbox: UNKNOWN_SOURCE — no such product 'not-a-product'", 400),
    );
    render(
      await EstateInboxPage({ searchParams: Promise.resolve({ source: "not-a-product" }) }),
    );
    expect(screen.getByText(/UNKNOWN_SOURCE/)).toBeInTheDocument();
    expect(screen.queryByText(INBOX_EMPTY_MESSAGE)).toBeNull();
  });
});
