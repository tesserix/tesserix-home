import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContactRow } from "@/lib/db/crm-repo";
import type { TemplateRow } from "@/lib/db/crm-templates";

/**
 * The composer's three jobs, in the order they matter.
 *
 * 1. A REFUSED PREVIEW PRODUCES NO TEXT. The textarea stays empty and the copy
 *    control is disabled — `renderTemplate`'s all-or-nothing contract carried
 *    to the screen intact rather than softened into a warning.
 * 2. THE CLIPBOARD WRITE HAPPENS BEFORE THE SERVER CALL. Asserted on ORDERING,
 *    because both orderings end with the same DOM: the failure this prevents
 *    (Safari rejecting a write whose transient user activation was consumed by
 *    an `await`) is invisible in the final state and shows up only as an
 *    operator with a logged DM and an empty clipboard.
 * 3. A FAILING ACTION SAYS WHICH HALF HAPPENED. "Copied, not logged" is
 *    actionable; a generic failure leaves the operator guessing whether to
 *    send.
 */

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn() }),
}));

vi.mock("./actions", () => ({
  previewTemplate: vi.fn(),
  copyAndLogDm: vi.fn(),
}));

import { previewTemplate, copyAndLogDm } from "./actions";
import { TemplateComposer } from "./template-composer";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const CONTACT_ID = "22222222-2222-4222-8222-222222222222";
const TEMPLATE_ID = "33333333-3333-4333-8333-333333333333";

const RENDERED = "Hi Ada — love what Flour & Ash does.";

const TEMPLATE: TemplateRow = {
  id: TEMPLATE_ID,
  name: "Cold intro",
  channel: "dm",
  product: null,
  subject: null,
  body: "Hi {{contact.name}} — love what {{org.name}} does.",
  isArchived: false,
  createdBy: "op@tesserix.dev",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

const CONTACT: ContactRow = {
  id: CONTACT_ID,
  name: "Ada",
  email: "ada@example.com",
  phone: null,
  instagramHandle: "@ada",
  isPrimary: true,
};

// Radix's Select relies on browser APIs jsdom does not implement; without
// these the trigger throws before the listbox opens, which reads as a
// component failure rather than a missing environment.
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

/** jsdom ships no Clipboard API. Installed as a spy so the ORDER of the write
 *  relative to the server call is observable, which is the whole point. */
const writeText = vi.fn<(text: string) => Promise<void>>();

/**
 * A user, and then the clipboard spy — IN THAT ORDER, which is not incidental.
 *
 * `userEvent.setup()` installs its OWN `navigator.clipboard` stub so that
 * `user.copy()` and friends work. Defining the spy first means userEvent
 * overwrites it, the component writes to userEvent's stub, and every assertion
 * about the clipboard here silently becomes an assertion about nothing — the
 * ordering test passes with `["action"]` alone because the write was never
 * observed rather than because it never happened. Installing after setup is
 * what makes these tests evidence.
 *
 * `pointerEventsCheck: 0` is the usual Radix accommodation: it marks the rest
 * of the document inert with `pointer-events: none` while a listbox is open,
 * and userEvent refuses to click through that by default.
 */
function setupUser() {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  return user;
}

beforeEach(() => {
  vi.clearAllMocks();
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  vi.mocked(copyAndLogDm).mockResolvedValue({ ok: true });
});

function renderComposer() {
  return render(
    <TemplateComposer organisationId={ORG_ID} templates={[TEMPLATE]} contacts={[CONTACT]} />,
  );
}

/** Selects the one template. The contact is pre-selected because there is
 *  exactly one, so this is the last input the preview waits on. */
async function chooseTemplate() {
  const user = setupUser();
  await user.click(screen.getByLabelText("Template"));
  await user.click(await screen.findByRole("option", { name: "Cold intro" }));
  return user;
}

function copyButton() {
  return screen.getByRole("button", { name: /Copy & log DM sent/ });
}

describe("TemplateComposer — a refused preview", () => {
  it("disables the copy control, names the missing field, and seeds no text", async () => {
    vi.mocked(previewTemplate).mockResolvedValue({
      ok: false,
      reason: "missing-fields",
      missing: ["contact.biography"],
      message: "Cannot use this template: no bio recorded for this contact.",
    });

    renderComposer();
    await chooseTemplate();

    expect(
      await screen.findByText("Cannot use this template: no bio recorded for this contact."),
    ).toBeInTheDocument();
    expect(copyButton()).toBeDisabled();
    // Not "empty enough" — empty. A partial render is the one thing the
    // renderer refuses to produce, and a textarea holding anything here would
    // be the composer producing one on its behalf.
    expect(screen.getByLabelText("Message")).toHaveValue("");
  });

  it("says nothing has been rendered for a suppressed organisation", async () => {
    vi.mocked(previewTemplate).mockResolvedValue({
      ok: false,
      reason: "suppressed",
      message:
        "This organisation is on the do-not-contact list. No message was rendered for it.",
    });

    renderComposer();
    await chooseTemplate();

    expect(await screen.findByText(/do-not-contact list/)).toBeInTheDocument();
    expect(copyButton()).toBeDisabled();
  });
});

describe("TemplateComposer — a successful preview", () => {
  beforeEach(() => {
    vi.mocked(previewTemplate).mockResolvedValue({ ok: true, text: RENDERED });
  });

  it("seeds the textarea with the rendered message and enables the control", async () => {
    renderComposer();
    await chooseTemplate();

    await waitFor(() => expect(screen.getByLabelText("Message")).toHaveValue(RENDERED));
    expect(copyButton()).toBeEnabled();
  });

  it("writes to the clipboard BEFORE the action is called", async () => {
    const order: string[] = [];
    writeText.mockImplementation(async () => {
      order.push("clipboard");
    });
    vi.mocked(copyAndLogDm).mockImplementation(async () => {
      order.push("action");
      return { ok: true };
    });

    renderComposer();
    const user = await chooseTemplate();
    await waitFor(() => expect(copyButton()).toBeEnabled());
    await user.click(copyButton());

    await waitFor(() => expect(copyAndLogDm).toHaveBeenCalled());
    expect(order).toEqual(["clipboard", "action"]);
    expect(writeText).toHaveBeenCalledWith(RENDERED);
  });

  it("submits the text the operator can see, not the template", async () => {
    renderComposer();
    const user = await chooseTemplate();
    await waitFor(() => expect(screen.getByLabelText("Message")).toHaveValue(RENDERED));
    await user.type(screen.getByLabelText("Message"), "!");
    await user.click(copyButton());

    await waitFor(() =>
      expect(copyAndLogDm).toHaveBeenCalledWith({
        organisationId: ORG_ID,
        contactId: CONTACT_ID,
        templateId: TEMPLATE_ID,
        submittedText: `${RENDERED}!`,
      }),
    );
    // No `edited` flag, and this assertion is the point: whether the text is
    // ours is decided by the server re-rendering, never by anything this
    // component claims. See `copyAndLogDm`.
    expect(Object.keys(vi.mocked(copyAndLogDm).mock.calls[0][0])).not.toContain("edited");
  });

  it("confirms both halves happened", async () => {
    renderComposer();
    const user = await chooseTemplate();
    await waitFor(() => expect(copyButton()).toBeEnabled());
    await user.click(copyButton());

    expect(await screen.findByText("Copied, and logged as sent.")).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
  });
});

describe("TemplateComposer — when one half fails", () => {
  beforeEach(() => {
    vi.mocked(previewTemplate).mockResolvedValue({ ok: true, text: RENDERED });
  });

  it("says the message WAS copied and was NOT logged", async () => {
    vi.mocked(copyAndLogDm).mockResolvedValue({
      ok: false,
      message: "This organisation is on the do-not-contact list.",
    });

    renderComposer();
    const user = await chooseTemplate();
    await waitFor(() => expect(copyButton()).toBeEnabled());
    await user.click(copyButton());

    expect(
      await screen.findByText(/WAS copied to your clipboard and was NOT logged/),
    ).toBeInTheDocument();
  });

  it("says nothing was copied when the clipboard write itself was rejected", async () => {
    // Safari's refusal, reproduced. The operator must not be told to look for
    // text that is not there.
    writeText.mockRejectedValue(new Error("write permission denied"));
    vi.mocked(copyAndLogDm).mockResolvedValue({ ok: false, message: "That change was not saved." });

    renderComposer();
    const user = await chooseTemplate();
    await waitFor(() => expect(copyButton()).toBeEnabled());
    await user.click(copyButton());

    expect(await screen.findByText(/Nothing was copied and nothing was logged/)).toBeInTheDocument();
  });

  it("warns when the DM was logged but the clipboard write failed", async () => {
    // The dangerous half: the CRM now says a DM was sent and the operator does
    // not have the text. Stated rather than swallowed.
    writeText.mockRejectedValue(new Error("write permission denied"));

    renderComposer();
    const user = await chooseTemplate();
    await waitFor(() => expect(copyButton()).toBeEnabled());
    await user.click(copyButton());

    expect(
      await screen.findByText(/could not be copied to your clipboard/),
    ).toBeInTheDocument();
  });
});

describe("TemplateComposer — no templates", () => {
  it("points at the authoring surface instead of rendering a dead control", async () => {
    render(<TemplateComposer organisationId={ORG_ID} templates={[]} contacts={[CONTACT]} />);

    expect(screen.getByText(/No DM templates yet/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Copy & log/ })).not.toBeInTheDocument();
  });
});
