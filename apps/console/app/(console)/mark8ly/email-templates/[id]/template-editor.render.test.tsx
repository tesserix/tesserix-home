import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const saveEmailTemplateAction = vi.fn();
const testSendEmailTemplateAction = vi.fn();
vi.mock("../actions", () => ({
  saveEmailTemplateAction: (...args: unknown[]) => saveEmailTemplateAction(...args),
  testSendEmailTemplateAction: (...args: unknown[]) => testSendEmailTemplateAction(...args),
}));

import type { EmailTemplateDetail } from "@/lib/email-templates";
import { TemplateEditor } from "./template-editor";

const PUBLISHED: EmailTemplateDetail = {
  id: "mark8ly:orderdoc_invoice",
  source: "mark8ly",
  key: "orderdoc_invoice",
  state: "published",
  sends_from: "row",
  has_embedded_default: true,
  subject: "Order {{.OrderNumber}}",
  version: 3,
  updated_at: "2026-08-01T09:30:00Z",
  updated_by: "op_previous",
  html_body: "<p>{{.OrderNumber}}</p>",
  text_body: "{{.OrderNumber}}",
  variables: [{ name: "OrderNumber", type: "string", required: true }],
};

const UNAUTHORED: EmailTemplateDetail = {
  ...PUBLISHED,
  id: "mark8ly:dunning_day_5",
  key: "dunning_day_5",
  state: "unauthored",
  sends_from: "embedded",
  version: undefined,
  updated_at: undefined,
  updated_by: undefined,
};

beforeEach(() => {
  saveEmailTemplateAction.mockReset().mockResolvedValue({ ok: true });
  testSendEmailTemplateAction.mockReset().mockResolvedValue({ ok: true });
});

describe("opening an unauthored key", () => {
  it("says the bodies are mark8ly's, not the operator's", () => {
    render(<TemplateEditor detail={UNAUTHORED} canSend />);
    expect(screen.getByText("This is mark8ly's built-in copy")).toBeInTheDocument();
    expect(screen.getByText(/Saving stores an override/i)).toBeInTheDocument();
  });

  it("defaults to draft rather than publishing on a first save", () => {
    // There is no stored status to preserve, and publishing is what changes
    // what customers receive. A pre-selected Publish would make that happen
    // because a radio happened to be set.
    render(<TemplateEditor detail={UNAUTHORED} canSend />);
    expect(screen.getByRole("radio", { name: /Save as a draft/i })).toBeChecked();
  });
});

describe("choosing draft", () => {
  it("warns, at the moment of the choice, that a draft does not send", async () => {
    const user = userEvent.setup();
    render(<TemplateEditor detail={PUBLISHED} canSend />);
    // Published to start with, so no warning yet.
    expect(screen.queryByText("A draft does not send")).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /Save as a draft/i }));

    expect(screen.getByText("A draft does not send")).toBeInTheDocument();
    // And it names what will keep going out instead, which is the half a
    // generic "drafts are not live" line leaves the operator to work out.
    expect(screen.getByText(/your saved copy\./i)).toBeInTheDocument();
  });

  it("reports a draft save as changing nothing customers receive", async () => {
    const user = userEvent.setup();
    render(<TemplateEditor detail={PUBLISHED} canSend />);
    await user.click(screen.getByRole("radio", { name: /Save as a draft/i }));
    await user.click(screen.getByRole("button", { name: "Save draft" }));

    expect(saveEmailTemplateAction).toHaveBeenCalledWith(
      "mark8ly:orderdoc_invoice",
      expect.objectContaining({ status: "draft" }),
    );
    expect(
      await screen.findByText(/Nothing customers receive has changed/i),
    ).toBeInTheDocument();
  });
});

describe("the save body", () => {
  it("forwards the declared variables unchanged", async () => {
    // They belong to mark8ly's Go call site. A console that edited them would
    // be authoring a contract it does not own.
    const user = userEvent.setup();
    render(<TemplateEditor detail={PUBLISHED} canSend />);
    await user.click(screen.getByRole("button", { name: "Save and publish" }));

    expect(saveEmailTemplateAction).toHaveBeenCalledWith("mark8ly:orderdoc_invoice", {
      subject: "Order {{.OrderNumber}}",
      html_body: "<p>{{.OrderNumber}}</p>",
      text_body: "{{.OrderNumber}}",
      variables: [{ name: "OrderNumber", type: "string", required: true }],
      status: "published",
    });
  });

  it("carries an edited body rather than the value it opened with", async () => {
    const user = userEvent.setup();
    render(<TemplateEditor detail={PUBLISHED} canSend />);
    await user.clear(screen.getByLabelText("Subject"));
    await user.type(screen.getByLabelText("Subject"), "New subject");
    await user.click(screen.getByRole("button", { name: "Save and publish" }));

    expect(saveEmailTemplateAction).toHaveBeenCalledWith(
      "mark8ly:orderdoc_invoice",
      expect.objectContaining({ subject: "New subject" }),
    );
  });

  it("shows the action's own sentence when the save fails", async () => {
    saveEmailTemplateAction.mockResolvedValue({ ok: false, message: "mark8ly rejected this." });
    const user = userEvent.setup();
    render(<TemplateEditor detail={PUBLISHED} canSend />);
    await user.click(screen.getByRole("button", { name: "Save and publish" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("mark8ly rejected this.");
  });
});

describe("the test send", () => {
  it("says it is a real email before the field, not after the button", () => {
    render(<TemplateEditor detail={PUBLISHED} canSend />);
    expect(screen.getByText(/sends a real email/i)).toBeInTheDocument();
    // And that it renders what is LIVE, not the unsaved text above — reading a
    // stale test as "the fix failed" is the obvious mistake.
    expect(screen.getByText(/never unsaved edits/i)).toBeInTheDocument();
  });

  it("stays disabled until an address is entered", async () => {
    const user = userEvent.setup();
    render(<TemplateEditor detail={PUBLISHED} canSend />);
    const button = screen.getByRole("button", { name: "Send real email" });
    expect(button).toBeDisabled();

    await user.type(screen.getByLabelText("Recipient address"), "ops@tesserix.app");
    expect(button).toBeEnabled();
  });

  it("names the address it actually sent to", async () => {
    const user = userEvent.setup();
    render(<TemplateEditor detail={PUBLISHED} canSend />);
    await user.type(screen.getByLabelText("Recipient address"), "ops@tesserix.app");
    await user.click(screen.getByRole("button", { name: "Send real email" }));

    expect(testSendEmailTemplateAction).toHaveBeenCalledWith(
      "mark8ly:orderdoc_invoice",
      "ops@tesserix.app",
    );
    expect(await screen.findByText(/Sent a real email to ops@tesserix\.app\./)).toBeInTheDocument();
  });

  it("offers no send control without mass-send, and says why", () => {
    // Hiding it is UX; the action asserts the capability itself regardless.
    // Saying WHY matters — "editing a template and sending one are separate
    // permissions" is not something an absent button conveys.
    render(<TemplateEditor detail={PUBLISHED} canSend={false} />);
    expect(screen.queryByRole("button", { name: "Send real email" })).not.toBeInTheDocument();
    expect(screen.getByText(/separate permissions/i)).toBeInTheDocument();
    // The editing half is still offered.
    expect(screen.getByRole("button", { name: "Save and publish" })).toBeInTheDocument();
  });
});

describe("preview", () => {
  it("renders the HTML body in a sandboxed frame that grants nothing", () => {
    render(<TemplateEditor detail={PUBLISHED} canSend />);
    const frame = screen.getByTitle("orderdoc_invoice preview");
    expect(frame).toHaveAttribute("srcdoc", PUBLISHED.html_body);
    // THE ROW THIS TEST EXISTS FOR. The body is operator-authored HTML; the
    // empty sandbox is what stops it running script against a live operator
    // session in the console's own origin. `allow-same-origin` here would be
    // a real vulnerability, and it looks like a harmless fix.
    expect(frame).toHaveAttribute("sandbox", "");
  });

  it("tracks the textarea, so the preview shows what is about to be saved", async () => {
    const user = userEvent.setup();
    render(<TemplateEditor detail={PUBLISHED} canSend />);
    const body = screen.getByLabelText("HTML body");
    await user.clear(body);
    await user.type(body, "<p>edited</p>");
    expect(screen.getByTitle("orderdoc_invoice preview")).toHaveAttribute(
      "srcdoc",
      "<p>edited</p>",
    );
  });

  it("switches to the plain-text body", async () => {
    const user = userEvent.setup();
    render(<TemplateEditor detail={PUBLISHED} canSend />);
    await user.click(screen.getByRole("button", { name: "text" }));
    expect(screen.queryByTitle("orderdoc_invoice preview")).not.toBeInTheDocument();
    // Scoped to the <pre>: the same string is also in the plain-text
    // TEXTAREA, so an unscoped getByText matches two nodes and fails.
    const pre = document.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toBe(PUBLISHED.text_body);
  });

  it("says the preview is raw, so nobody reads it as what the customer gets", () => {
    // The interpolated version needs the product to render it (#587). Until
    // then the honest thing is to say `{{.OrderNumber}}` is not filled in,
    // rather than let an operator assume a literal is a bug in their copy.
    render(<TemplateEditor detail={PUBLISHED} canSend />);
    expect(screen.getByText(/variables are not filled in/i)).toBeInTheDocument();
  });
});
