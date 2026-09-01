import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// Both action modules cross a "use server" boundary into `lib/secrets-api.ts`
// (`server-only`, an operator-token store over `pg`), so they are mocked and
// this suite exercises the CLIENT half only. The mocks are also the seam every
// assertion about WHAT is sent reads through — `secrets-api.test.ts` already
// proves `writeSecret` puts it on the wire correctly.
const writeSecretAction = vi.fn();
const secretExistsAction = vi.fn();
vi.mock("../[...path]/actions", () => ({
  writeSecretAction: (...args: unknown[]) => writeSecretAction(...args),
}));
vi.mock("./actions", () => ({
  secretExistsAction: (...args: unknown[]) => secretExistsAction(...args),
}));

import { CreateSecretForm } from "./create-secret-form";

const BOTH_STORES = ["openbao", "gcpsm"] as const;

function fillPath(path: string) {
  fireEvent.change(screen.getByLabelText(/^path$/i), { target: { value: path } });
}

function fillKeyAndValue(key: string, value: string) {
  fireEvent.change(screen.getByLabelText(/key name/i), { target: { value: key } });
  fireEvent.change(screen.getByLabelText(/^value$/i), { target: { value } });
}

function clickCreate() {
  fireEvent.click(screen.getByRole("button", { name: "Create secret" }));
}

describe("CreateSecretForm", () => {
  beforeEach(() => {
    writeSecretAction.mockReset();
    secretExistsAction.mockReset();
    writeSecretAction.mockResolvedValue({ ok: true, version: 1 });
    secretExistsAction.mockResolvedValue({ ok: true, exists: false });
  });

  it("a happy create calls writeSecretAction with no ifVersion at all", async () => {
    render(<CreateSecretForm stores={BOTH_STORES} preferred="openbao" />);
    fillPath("mark8ly/stripe/webhook");
    fillKeyAndValue("STRIPE_WEBHOOK_SECRET", "hunter2");
    clickCreate();

    await waitFor(() => expect(writeSecretAction).toHaveBeenCalled());

    const call = writeSecretAction.mock.calls[0];
    expect(call[0]).toBe("openbao");
    expect(call[1]).toBe("mark8ly/stripe/webhook");
    expect(call[2]).toEqual({ STRIPE_WEBHOOK_SECRET: "hunter2" });
    // THE assertion of this task. An `ifVersion` here would 409 against an
    // empty path, or — worse — behave as a rotate on a path that is not
    // empty while the copy says "created".
    expect(call[3]).toBeUndefined();
  });

  it("the key name is trimmed before it becomes the payload's key", async () => {
    render(<CreateSecretForm stores={BOTH_STORES} preferred="openbao" />);
    fillPath("mark8ly/stripe/webhook");
    fillKeyAndValue("  STRIPE_WEBHOOK_SECRET  ", "hunter2");
    clickCreate();

    await waitFor(() => expect(writeSecretAction).toHaveBeenCalled());
    expect(writeSecretAction.mock.calls[0][2]).toEqual({ STRIPE_WEBHOOK_SECRET: "hunter2" });
  });

  it("an invalid path shows the validator's message and calls neither action", async () => {
    render(<CreateSecretForm stores={BOTH_STORES} preferred="openbao" />);
    fillPath("mark8ly/stripe");
    fillKeyAndValue("STRIPE_WEBHOOK_SECRET", "hunter2");
    clickCreate();

    expect(await screen.findByText(/at least 3 segments/i)).toBeInTheDocument();
    expect(secretExistsAction).not.toHaveBeenCalled();
    expect(writeSecretAction).not.toHaveBeenCalled();
  });

  it("changing the store re-validates the path against the store now selected", async () => {
    render(<CreateSecretForm stores={BOTH_STORES} preferred="openbao" />);
    // Valid for OpenBao; the `--` is only a problem for Google Secret
    // Manager, where it is the separator a path is encoded with.
    fillPath("mark8ly/stripe/web--hook");

    fireEvent.change(screen.getByLabelText(/^store$/i), { target: { value: "gcpsm" } });

    // A "valid" verdict left over from before the switch is a lie the
    // operator would act on, so the switch itself must produce the message.
    // This is the whole test: two assertions that stood here before it —
    // "no alert yet" before the switch, and "no write" after a submit with
    // nothing awaited — were both incapable of failing, so they were
    // deleted rather than dressed up. The submit-blocks-on-an-invalid-path
    // property is pinned live by the invalid-path test above.
    expect(await screen.findByText(/may not contain "--"/i)).toBeInTheDocument();
  });

  it("a path that already holds a secret is refused, and writeSecretAction is never called", async () => {
    secretExistsAction.mockResolvedValue({ ok: true, exists: true });
    render(<CreateSecretForm stores={BOTH_STORES} preferred="openbao" />);
    fillPath("mark8ly/stripe/webhook");
    fillKeyAndValue("STRIPE_WEBHOOK_SECRET", "hunter2");
    clickCreate();

    await waitFor(() => expect(secretExistsAction).toHaveBeenCalled());
    // Waits for the transition to have SETTLED into either outcome — the
    // refusal alert, or (were the guard removed) the success card — so the
    // "never called" assertion below is the one that fails when the guard
    // goes, rather than an earlier `findByText` that would only report the
    // missing copy and hide which property actually broke.
    await waitFor(() =>
      expect(screen.queryByRole("alert") ?? screen.queryByText(/^secret created\.$/i)).not.toBeNull(),
    );
    expect(writeSecretAction).not.toHaveBeenCalled();

    expect(await screen.findByText(/a secret already exists at this path/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /mark8ly\/stripe\/webhook/i })).toHaveAttribute(
      "href",
      "/platform/secrets/mark8ly/stripe/webhook?store=openbao",
    );
  });

  it("a failed existence check is treated as a failure, not as 'the path is free'", async () => {
    secretExistsAction.mockResolvedValue({ ok: false, message: "Could not check whether this path is already in use." });
    render(<CreateSecretForm stores={BOTH_STORES} preferred="openbao" />);
    fillPath("mark8ly/stripe/webhook");
    fillKeyAndValue("STRIPE_WEBHOOK_SECRET", "hunter2");
    clickCreate();

    expect(await screen.findByText(/could not check whether this path is already in use/i)).toBeInTheDocument();
    expect(writeSecretAction).not.toHaveBeenCalled();
  });

  it("renders the failure message from a rejected write", async () => {
    writeSecretAction.mockResolvedValue({ ok: false, message: "write secret: secrets-api returned 403" });
    render(<CreateSecretForm stores={BOTH_STORES} preferred="openbao" />);
    fillPath("mark8ly/stripe/webhook");
    fillKeyAndValue("STRIPE_WEBHOOK_SECRET", "hunter2");
    clickCreate();

    expect(await screen.findByText(/secrets-api returned 403/i)).toBeInTheDocument();
    expect(screen.queryByText(/secret created/i)).toBeNull();
  });

  it("the success state says created, never rotated, and links to the new secret with its store", async () => {
    writeSecretAction.mockResolvedValue({ ok: true, version: 1 });
    render(<CreateSecretForm stores={BOTH_STORES} preferred="gcpsm" />);
    fillPath("mark8ly/stripe/webhook");
    fillKeyAndValue("STRIPE_WEBHOOK_SECRET", "hunter2");
    clickCreate();

    expect(await screen.findByText(/^secret created\.$/i)).toBeInTheDocument();
    expect(screen.queryByText(/rotated/i)).toBeNull();
    expect(screen.getByRole("link", { name: /view the secret/i })).toHaveAttribute(
      "href",
      "/platform/secrets/mark8ly/stripe/webhook?store=gcpsm",
    );
  });

  it("the success state does not display the value", async () => {
    render(<CreateSecretForm stores={BOTH_STORES} preferred="openbao" />);
    fillPath("mark8ly/stripe/webhook");
    fillKeyAndValue("STRIPE_WEBHOOK_SECRET", "a-very-distinctive-secret-value");
    clickCreate();

    await screen.findByText(/^secret created\.$/i);
    // The raw text check, not `queryByText`: a value interpolated beside
    // other words never equals any single element's whole text. It also
    // subsumes a `queryByDisplayValue` check — the success card replaces the
    // form outright, so there is no input left to hold a display value.
    expect(document.body.textContent).not.toContain("a-very-distinctive-secret-value");
  });

  it("offers the grant seam after creating an OpenBao secret", async () => {
    render(<CreateSecretForm stores={BOTH_STORES} preferred="openbao" />);
    fillPath("mark8ly/stripe/webhook");
    fillKeyAndValue("STRIPE_WEBHOOK_SECRET", "hunter2");
    clickCreate();

    expect(await screen.findByText(/grant an app access to this\?/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /grant access/i })).toHaveAttribute(
      "href",
      "/platform/secrets/mark8ly/stripe/webhook?store=openbao",
    );
  });

  it("does NOT offer the grant seam after creating a Google Secret Manager secret", async () => {
    render(<CreateSecretForm stores={BOTH_STORES} preferred="gcpsm" />);
    fillPath("mark8ly/stripe/webhook");
    fillKeyAndValue("STRIPE_WEBHOOK_SECRET", "hunter2");
    clickCreate();

    // Wait for the success state first, so this is an assertion about what a
    // RENDERED success card offers — not one that passes because nothing has
    // rendered yet.
    expect(await screen.findByText(/^secret created\.$/i)).toBeInTheDocument();
    expect(screen.queryByText(/grant an app access to this\?/i)).toBeNull();
    expect(screen.queryByRole("link", { name: /grant access/i })).toBeNull();
    // A GSM secret's readers are IAM bindings this console cannot propose
    // against (§6), and the card says so rather than staying silent.
    expect(screen.getByText(/google cloud iam/i)).toBeInTheDocument();
  });

  it("renders a single enabled store as static text, not a one-option select", async () => {
    render(<CreateSecretForm stores={["openbao"]} preferred={null} />);

    expect(screen.queryByRole("combobox")).toBeNull();
    // Found by its accessible name, not a test id: the static store field
    // must carry a real label association (`aria-labelledby`), because a
    // `<Label htmlFor>` pointing at a `<p>` is inert markup that names
    // nothing.
    expect(screen.getByLabelText(/^store$/i)).toHaveTextContent("OpenBao");

    fillPath("mark8ly/stripe/webhook");
    fillKeyAndValue("STRIPE_WEBHOOK_SECRET", "hunter2");
    clickCreate();

    await waitFor(() => expect(writeSecretAction).toHaveBeenCalled());
    expect(writeSecretAction.mock.calls[0][0]).toBe("openbao");
  });

  it("with no preferred store and more than one enabled, nothing is preselected and submitting asks for one", async () => {
    render(<CreateSecretForm stores={BOTH_STORES} preferred={null} />);

    expect((screen.getByLabelText(/^store$/i) as HTMLSelectElement).value).toBe("");

    fillPath("mark8ly/stripe/webhook");
    fillKeyAndValue("STRIPE_WEBHOOK_SECRET", "hunter2");
    clickCreate();

    expect(await screen.findByText(/choose a store\./i)).toBeInTheDocument();
    expect(secretExistsAction).not.toHaveBeenCalled();
    expect(writeSecretAction).not.toHaveBeenCalled();
  });

  it("with a single enabled store, that store wins even when preferred names the other one", () => {
    render(<CreateSecretForm stores={["openbao"]} preferred="gcpsm" />);
    expect(screen.getByLabelText(/^store$/i)).toHaveTextContent("OpenBao");
  });

  it("an empty key or value never reaches either action", async () => {
    render(<CreateSecretForm stores={BOTH_STORES} preferred="openbao" />);
    fillPath("mark8ly/stripe/webhook");
    fillKeyAndValue("   ", "hunter2");
    clickCreate();
    expect(await screen.findByText(/enter a key name\./i)).toBeInTheDocument();

    fillKeyAndValue("STRIPE_WEBHOOK_SECRET", "");
    clickCreate();
    expect(await screen.findByText(/enter a value, or generate one\./i)).toBeInTheDocument();

    expect(secretExistsAction).not.toHaveBeenCalled();
    expect(writeSecretAction).not.toHaveBeenCalled();
  });
});
