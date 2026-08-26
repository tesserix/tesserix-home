import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, replace: vi.fn(), push: vi.fn() }),
}));

// The action is a `"use server"` module whose seam is `server-only`. Mocked
// here for the same reason `tools-manager.render.test.tsx` mocks its own: the
// component imports it directly (the house pattern), and these tests need to
// drive every result shape the seam can produce.
vi.mock("./actions", () => ({ setTenantLifecycleAction: vi.fn() }));

import { parseReasonCodes, type ReasonCodeCatalog } from "@/lib/tenant-lifecycle";
import type { EstateTenant } from "@/lib/tenants";
import { setTenantLifecycleAction } from "./actions";
import {
  TenantLifecycleAction,
  lifecycleOutcomeMessage,
  lifecycleVerbFor,
  unknownProductNotice,
} from "./tenant-lifecycle-controls";

afterEach(() => {
  vi.resetAllMocks();
});

const ACTIVE: EstateTenant = {
  id: "mark8ly:42",
  source: "mark8ly",
  name: "Acme Stores",
  status: "active",
};

const SUSPENDED: EstateTenant = { ...ACTIVE, status: "suspended" };

/**
 * mark8ly's vocabulary as the page would have fetched it (contract §8.8),
 * built through the real parser rather than as a literal — a hand-written
 * catalog here could hold a shape `parseReasonCodes` would never produce, and
 * these tests would then be asserting against a fiction.
 */
const CATALOG: ReasonCodeCatalog = {
  mark8ly: parseReasonCodes({
    data: {
      suspend: [
        { code: "abuse", label: "Abuse — abusive content or behaviour" },
        { code: "fraud", label: "Fraud — suspected fraudulent transactions" },
      ],
      unsuspend: [
        { code: "resolved", label: "Resolved — the issue is settled" },
        { code: "appeal_upheld", label: "Appeal upheld" },
      ],
    },
  }),
};

/** A product this render has no reason codes for — it is absent from the
 *  catalog, which is what a product that failed to answer looks like. */
const UNKNOWN_PRODUCT: EstateTenant = {
  id: "kora:c-9",
  source: "kora",
  name: "Northwind Clinic",
  status: "active",
};

function open(tenant: EstateTenant, reasonCodes: ReasonCodeCatalog = CATALOG) {
  const user = userEvent.setup();
  render(<TenantLifecycleAction tenant={tenant} reasonCodes={reasonCodes} />);
  return user;
}

describe("which verb a status implies", () => {
  it("offers Unsuspend only for a tenant the product calls suspended", () => {
    expect(lifecycleVerbFor("suspended")).toBe("unsuspend");
    // Case and surrounding space are not different states — the same
    // normalisation the status badge already applies.
    expect(lifecycleVerbFor("  SUSPENDED ")).toBe("unsuspend");
  });

  it("offers Suspend for an active tenant", () => {
    expect(lifecycleVerbFor("active")).toBe("suspend");
  });

  it("offers Suspend — NOT Unsuspend — for a status this build has never seen", () => {
    // The asymmetry is the safety property. A product inventing "frozen" must
    // not have it read as "already suspended", which would invite an operator
    // to file a reversal reason against a suspension that never happened.
    expect(lifecycleVerbFor("frozen")).toBe("suspend");
    expect(lifecycleVerbFor("")).toBe("suspend");
    expect(lifecycleVerbFor("suspension_pending")).toBe("suspend");
  });

  it("labels the row control with the verb its status implies", () => {
    const { unmount } = render(
      <TenantLifecycleAction tenant={SUSPENDED} reasonCodes={CATALOG} />,
    );
    expect(
      screen.getByRole("button", { name: "Unsuspend Acme Stores" }),
    ).toBeInTheDocument();
    unmount();

    render(
      <TenantLifecycleAction tenant={{ ...ACTIVE, status: "frozen" }} reasonCodes={CATALOG} />,
    );
    expect(
      screen.getByRole("button", { name: "Suspend Acme Stores" }),
    ).toBeInTheDocument();
  });
});

describe("what the operator is told afterwards", () => {
  it("does NOT report an unchanged tenant as a fresh suspension", () => {
    const changed = lifecycleOutcomeMessage("Acme Stores", "suspend", {
      changed: true,
      status: "suspended",
      storesAffected: 0,
    });
    const unchanged = lifecycleOutcomeMessage("Acme Stores", "suspend", {
      changed: false,
      status: "suspended",
      storesAffected: 0,
    });

    expect(changed).not.toBe(unchanged);
    // Not merely different: the difference has to be in the part a scanning
    // reader actually reads, which is the beginning of the sentence.
    expect(unchanged).toMatch(/^Nothing changed —/);
    expect(unchanged).toContain("was already suspended");
    expect(changed).not.toContain("already");
  });

  it("reports how many stores a suspension took offline, and stays silent at zero", () => {
    expect(
      lifecycleOutcomeMessage("Acme Stores", "suspend", {
        changed: true,
        status: "suspended",
        storesAffected: 3,
      }),
    ).toContain("3 stores were taken offline");

    expect(
      lifecycleOutcomeMessage("Acme Stores", "unsuspend", {
        changed: true,
        status: "active",
        storesAffected: 1,
      }),
    ).toContain("1 store was returned to service");

    expect(
      lifecycleOutcomeMessage("Acme Stores", "suspend", {
        changed: true,
        status: "suspended",
        storesAffected: 0,
      }),
    ).not.toMatch(/store/);
  });

  it("prefers the product's own status word to the console's past tense", () => {
    expect(
      lifecycleOutcomeMessage("Acme Stores", "unsuspend", {
        changed: true,
        status: "live",
        storesAffected: 0,
      }),
    ).toBe("Acme Stores is now live.");
    expect(
      lifecycleOutcomeMessage("Acme Stores", "unsuspend", {
        changed: true,
        status: "",
        storesAffected: 0,
      }),
    ).toBe("Acme Stores is now unsuspended.");
  });

  it("shows the unchanged wording on screen and still re-reads the directory", async () => {
    vi.mocked(setTenantLifecycleAction).mockResolvedValue({
      ok: true,
      changed: false,
      status: "suspended",
      storesAffected: 0,
    });
    const user = open(SUSPENDED);

    await user.click(screen.getByRole("button", { name: "Unsuspend Acme Stores" }));
    await user.selectOptions(screen.getByLabelText("Reason"), "resolved");
    await user.click(screen.getByRole("button", { name: "Unsuspend" }));

    expect(setTenantLifecycleAction).toHaveBeenCalledWith(
      // The NAMESPACED id: platform-api splits it to decide which product to
      // call, so the product's bare id would be refused.
      "mark8ly:42",
      "unsuspend",
      "resolved",
      "",
    );
    expect(await screen.findByRole("status")).toHaveTextContent(/^Nothing changed —/);
    // The status column is the product's answer, so it is re-read rather than
    // patched locally — including when nothing changed, because the reason
    // nothing changed may be a change someone else made.
    expect(refresh).toHaveBeenCalled();
  });
});

describe("when the write is refused", () => {
  it("attaches a refused reason code to the reason-code input, not the form", async () => {
    vi.mocked(setTenantLifecycleAction).mockResolvedValue({
      ok: false,
      message: "the product refused this change: invalid_reason_code",
      field: "reasonCode",
    });
    const user = open(ACTIVE);

    await user.click(screen.getByRole("button", { name: "Suspend Acme Stores" }));
    const select = screen.getByLabelText("Reason");
    await user.selectOptions(select, "abuse");
    await user.click(screen.getByRole("button", { name: "Suspend" }));

    const message = await screen.findByRole("alert");
    expect(message).toHaveTextContent("invalid_reason_code");
    // The association, not just the proximity: a message rendered beside an
    // input a screen reader never reaches it from is not attached to it.
    expect(select).toHaveAttribute("aria-invalid", "true");
    expect(select).toHaveAttribute("aria-describedby", message.id);
    // Refused, so the dialog stays open for the operator to pick another.
    expect(screen.getByRole("button", { name: "Suspend" })).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("shows a message with no field at form level", async () => {
    vi.mocked(setTenantLifecycleAction).mockResolvedValue({
      ok: false,
      message: "You do not have permission to change a tenant's status.",
    });
    const user = open(ACTIVE);

    await user.click(screen.getByRole("button", { name: "Suspend Acme Stores" }));
    await user.selectOptions(screen.getByLabelText("Reason"), "abuse");
    await user.click(screen.getByRole("button", { name: "Suspend" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/do not have permission/i);
    expect(screen.getByLabelText("Reason")).not.toHaveAttribute("aria-invalid");
  });
});

describe("a product that did not supply its reason codes", () => {
  it("disables the action and says why, rather than borrowing another product's codes", () => {
    // CATALOG deliberately, not an empty one: this must fail because kora is
    // ABSENT from a populated catalog — a product that did not answer while
    // others did — rather than because nothing was fetched at all.
    render(<TenantLifecycleAction tenant={UNKNOWN_PRODUCT} reasonCodes={CATALOG} />);

    const button = screen.getByRole("button", { name: "Suspend" });
    expect(button).toBeDisabled();
    expect(screen.getByText(unknownProductNotice("kora"))).toBeInTheDocument();
    // The explanation is reachable from the disabled control itself — a
    // disabled button whose reason is only visually adjacent tells a
    // screen-reader operator nothing.
    expect(button.getAttribute("aria-describedby")).toBe(
      screen.getByText(unknownProductNotice("kora")).id,
    );
  });

  it("names the product in the notice", () => {
    // `sourceLabel` renders an id it does not recognise verbatim, so the
    // sentence works for a product that postdates this build too.
    expect(unknownProductNotice("kora")).toMatch(/reason codes/);
    expect(unknownProductNotice("kora")).not.toMatch(/undefined/);
  });
});
