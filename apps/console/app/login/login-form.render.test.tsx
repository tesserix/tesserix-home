import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * The form, rendered.
 *
 * The server-action tests prove the decision; this proves an operator can
 * reach the fields it asks for and stay there. Two things are pinned here that
 * the action tests cannot see: that both credentials are asked for on one
 * page, and that a rejected credential is reported against the form rather
 * than against a field — the page must not point at the half that was wrong.
 */

const actions = vi.hoisted(() => ({ submitCredentials: vi.fn(), submitTotp: vi.fn() }));
vi.mock("./actions", () => actions);

const { LoginForm } = await import("./login-form");

// Exact strings, not /password/i: the field's own show/hide toggle is labelled
// "Show password", and a loose matcher finds both.
const LOGIN_NAME = "Username, email or phone number";
const PASSWORD = "Password";
const CODE = "Verification code";

async function signIn(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  render(<LoginForm authRequestId="V2_1" />);
  await user.type(screen.getByLabelText(LOGIN_NAME), "op@tesserix.test");
  await user.type(screen.getByLabelText(PASSWORD), "hunter2");
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  await waitFor(() => expect(actions.submitCredentials).toHaveBeenCalled());
  return user;
}

beforeEach(() => {
  vi.clearAllMocks();
  actions.submitCredentials.mockResolvedValue({ outcome: "second-factor", factor: "totp" });
});

describe("LoginForm", () => {
  it("asks for both credentials on one page and submits them together", async () => {
    render(<LoginForm authRequestId="V2_1" />);
    const user = userEvent.setup();

    // Both present before anything is submitted: no "Next" between them, which
    // is also what lets a password manager fill the pair in one go.
    const loginName = screen.getByLabelText(LOGIN_NAME);
    const password = screen.getByLabelText(PASSWORD);
    expect(loginName).toHaveAttribute("autocomplete", "username");
    expect(password).toHaveAttribute("autocomplete", "current-password");

    await user.type(loginName, "op@tesserix.test");
    await user.type(password, "hunter2");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() =>
      expect(actions.submitCredentials).toHaveBeenCalledWith({
        authRequestId: "V2_1",
        loginName: "op@tesserix.test",
        password: "hunter2",
      }),
    );
  });

  it("reports a credential failure against the form, not against either field", async () => {
    // The instance runs `ignoreUnknownUsernames`. With both fields on one page
    // an error hung on one of them would undo that by pointing at the half
    // that was wrong, so the message belongs to the form and neither input may
    // be marked invalid.
    actions.submitCredentials.mockResolvedValue({
      outcome: "failed",
      message: "That username and password don't match.",
    });
    await signIn();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/that username and password don't match/i);

    const loginName = screen.getByLabelText(LOGIN_NAME);
    const password = screen.getByLabelText(PASSWORD);
    expect(loginName).not.toHaveAttribute("aria-invalid");
    expect(password).not.toHaveAttribute("aria-invalid");
    // A field-level message would render inside the field's own group; the
    // form-level one sits outside both.
    expect(loginName.closest("div")?.parentElement).not.toContainElement(alert);
    expect(password.closest("div")?.parentElement).not.toContainElement(alert);
    // And it leaves the operator on the form, both fields still there.
    expect(loginName).toBeInTheDocument();
    expect(password).toBeInTheDocument();
  });

  it("asks for the code in-page rather than leaving for Zitadel", async () => {
    await signIn();

    expect(await screen.findByLabelText(CODE)).toBeInTheDocument();
    // The authenticator step stays a step: it is owed only after the session
    // exists, so the credential fields go away when it is asked for.
    expect(screen.queryByLabelText(PASSWORD)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(LOGIN_NAME)).not.toBeInTheDocument();
  });

  it("keeps the operator on the code field after a rejected code", async () => {
    // "A half-built factor prompt is worse than none." A wrong code has to
    // leave them able to type the next one, not back at the password.
    actions.submitTotp.mockResolvedValue({ outcome: "failed", message: "That code didn't work." });
    const user = await signIn();

    await user.type(await screen.findByLabelText(CODE), "000000");
    await waitFor(() => expect(actions.submitTotp).toHaveBeenCalled());

    expect(await screen.findByText(/that code didn't work/i)).toBeInTheDocument();
    expect(screen.getByLabelText(CODE)).toBeInTheDocument();
    expect(screen.queryByLabelText(PASSWORD)).not.toBeInTheDocument();
  });

  it("returns to the credential form when the sign-in link has expired", async () => {
    // `restart` means there is no session to add a check to. The whole login
    // starts over, which now means one form rather than the first of two.
    actions.submitTotp.mockResolvedValue({
      outcome: "restart",
      message: "This sign-in link has expired. Start again.",
    });
    const user = await signIn();

    await user.type(await screen.findByLabelText(CODE), "000000");
    await waitFor(() => expect(actions.submitTotp).toHaveBeenCalled());

    expect(await screen.findByLabelText(LOGIN_NAME)).toBeInTheDocument();
    expect(screen.getByLabelText(PASSWORD)).toBeInTheDocument();
    expect(screen.queryByLabelText(CODE)).not.toBeInTheDocument();
  });
});
