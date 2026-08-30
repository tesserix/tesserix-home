import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * The third step, rendered.
 *
 * The server-action tests prove the decision; this proves an operator can
 * reach the field it asks for and stay there. Between the two sits the failure
 * this change exists to fix — a login that decided correctly and then
 * navigated to a URL that could not resolve the auth request.
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
  await user.click(screen.getByRole("button", { name: "Sign in" }));
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
  it("asks for the code in-page rather than leaving for Zitadel", async () => {
    await signIn();

    expect(await screen.findByLabelText(CODE)).toBeInTheDocument();
    expect(screen.queryByLabelText(PASSWORD)).not.toBeInTheDocument();
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
});
