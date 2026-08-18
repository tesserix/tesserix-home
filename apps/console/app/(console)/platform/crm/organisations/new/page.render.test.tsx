import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ESTATE } from "@tesserix/console-core";
import { NO_PRODUCT_VALUE } from "@/lib/db/crm-filters";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));

vi.mock("./actions", () => ({
  createOrganisationAction: vi.fn(),
}));

import { createOrganisationAction } from "./actions";
import NewOrganisationPage from "./page";

// The product this suite chooses through the UI. Read from `ESTATE` rather
// than hardcoded, because the page builds its options from `ESTATE` too — a
// literal here would start testing a stale copy of the estate the day a
// product is renamed.
const PRODUCT = ESTATE[0];

// Radix's Select relies on browser APIs jsdom does not implement. Without
// these the trigger throws before the listbox ever opens, which would look
// like a component failure rather than a missing environment.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

// Radix marks the rest of the document inert while the Select's listbox is
// open by setting `pointer-events: none` on `document.body` — the same modal
// treatment its Dialog gets, and the same reason
// `organisation-edit-form.render.test.tsx` needs this. userEvent refuses to
// click through that by default, so choosing an option would fail for a
// reason that has nothing to do with the mechanism under test.
function setupUser() {
  return userEvent.setup({ pointerEventsCheck: 0 });
}

/** The `FormData` the one call to the action was given. */
function submitted(): FormData {
  const calls = vi.mocked(createOrganisationAction).mock.calls;
  expect(calls).toHaveLength(1);
  return calls[0][0];
}

/** Fills the one required field, so `submit` reaches the action at all. */
async function fillName(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Organisation name"), "Bondi Baker");
}

async function save(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /add organisation/i }));
}

/** Opens the product Select and picks the option with the given label. */
async function chooseProduct(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(screen.getByRole("combobox", { name: /product/i }));
  await waitFor(() => expect(screen.getByRole("listbox")).toBeInTheDocument());
  await user.click(screen.getByRole("option", { name: label }));
}

// The page asserts in a comment that Radix's Select mirrors its value onto a
// hidden native <select> keyed by `name`, so it participates in `FormData`
// with no controlled state. `actions.test.ts` builds its `FormData` by hand
// and so cannot notice if that stops being true. These are the tests that do.
describe("NewOrganisationPage product field", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createOrganisationAction).mockResolvedValue({ ok: true });
  });

  it("carries the chosen product into the submitted FormData", async () => {
    const user = setupUser();
    render(<NewOrganisationPage />);

    await fillName(user);
    await chooseProduct(user, PRODUCT.name);
    await save(user);

    await waitFor(() => expect(createOrganisationAction).toHaveBeenCalled());
    expect(submitted().get("product")).toBe(PRODUCT.context);
  });

  it("carries the no-product sentinel when the operator chooses nothing", async () => {
    const user = setupUser();
    render(<NewOrganisationPage />);

    await fillName(user);
    await save(user);

    await waitFor(() => expect(createOrganisationAction).toHaveBeenCalled());
    expect(submitted().get("product")).toBe(NO_PRODUCT_VALUE);
  });

  it("carries the sentinel again when the operator picks a product and backs out", async () => {
    const user = setupUser();
    render(<NewOrganisationPage />);

    await fillName(user);
    await chooseProduct(user, PRODUCT.name);
    await chooseProduct(user, "No product yet");
    await save(user);

    await waitFor(() => expect(createOrganisationAction).toHaveBeenCalled());
    expect(submitted().get("product")).toBe(NO_PRODUCT_VALUE);
  });
});
