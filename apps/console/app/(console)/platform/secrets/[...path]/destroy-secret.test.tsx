import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

// `./access-actions` is a "use server" boundary reaching `secrets-api` and
// the audit log — mocked so this suite exercises the CLIENT half only (the
// two controls, the exact-match confirmation gate), same discipline
// `access-card.test.tsx` applies to `grantAccessAction`/`revokeAccessAction`.
const deleteSecretAction = vi.fn();
vi.mock("./access-actions", () => ({
  deleteSecretAction: (...args: unknown[]) => deleteSecretAction(...args),
}));

// `router.refresh()` is how this component re-reads after a successful
// change — stood in so the assertion can observe it was called without a
// real Next.js router. Same pattern `access-card.test.tsx` establishes.
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

import { DestroySecret } from "./destroy-secret";

const PATH = "mark8ly/db-password";

describe("DestroySecret", () => {
  beforeEach(() => {
    deleteSecretAction.mockReset();
    refresh.mockReset();
    deleteSecretAction.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("without canWrite", () => {
    it("renders neither the Delete nor the Destroy control", () => {
      render(<DestroySecret store="openbao" path={PATH} canWrite={false} />);

      expect(screen.queryByRole("button", { name: /^delete$/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /^destroy$/i })).toBeNull();
    });
  });

  describe("with canWrite", () => {
    it("renders both controls", () => {
      render(<DestroySecret store="openbao" path={PATH} canWrite />);

      expect(screen.getByRole("button", { name: /^delete$/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^destroy$/i })).toBeInTheDocument();
    });

    it("Delete calls deleteSecretAction with destroy: false, and does not require the typed name", async () => {
      render(<DestroySecret store="openbao" path={PATH} canWrite />);

      // No dialog, no typed-name field — Delete has no confirmation input
      // anywhere on the page.
      expect(screen.queryByLabelText(/type .* to confirm/i)).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));

      await waitFor(() => expect(deleteSecretAction).toHaveBeenCalledTimes(1));
      expect(deleteSecretAction).toHaveBeenCalledWith("openbao", PATH, false);
      await waitFor(() => expect(refresh).toHaveBeenCalled());
    });

    it("Destroy's confirm button is disabled until the typed text exactly equals the secret's full path", () => {
      render(<DestroySecret store="openbao" path={PATH} canWrite />);

      fireEvent.click(screen.getByRole("button", { name: /^destroy$/i }));

      const dialog = within(screen.getByRole("dialog"));
      const confirmButton = dialog.getByRole("button", { name: /^destroy$/i });
      const input = dialog.getByLabelText(/type .* to confirm/i);

      expect(confirmButton).toBeDisabled();

      fireEvent.change(input, { target: { value: PATH } });
      expect(confirmButton).toBeEnabled();
    });

    it("refuses a near-miss: a trailing space after the correct path", () => {
      render(<DestroySecret store="openbao" path={PATH} canWrite />);
      fireEvent.click(screen.getByRole("button", { name: /^destroy$/i }));

      const dialog = within(screen.getByRole("dialog"));
      const confirmButton = dialog.getByRole("button", { name: /^destroy$/i });
      const input = dialog.getByLabelText(/type .* to confirm/i);

      fireEvent.change(input, { target: { value: `${PATH} ` } });

      expect(confirmButton).toBeDisabled();
    });

    it("refuses a near-miss: the correct final segment with the wrong prefix", () => {
      render(<DestroySecret store="openbao" path={PATH} canWrite />);
      fireEvent.click(screen.getByRole("button", { name: /^destroy$/i }));

      const dialog = within(screen.getByRole("dialog"));
      const confirmButton = dialog.getByRole("button", { name: /^destroy$/i });
      const input = dialog.getByLabelText(/type .* to confirm/i);

      // Shares "db-password" with PATH but not the namespace prefix.
      fireEvent.change(input, { target: { value: "other-app/db-password" } });

      expect(confirmButton).toBeDisabled();
    });

    it("confirming calls deleteSecretAction with destroy: true", async () => {
      render(<DestroySecret store="openbao" path={PATH} canWrite />);
      fireEvent.click(screen.getByRole("button", { name: /^destroy$/i }));

      const dialog = within(screen.getByRole("dialog"));
      const confirmButton = dialog.getByRole("button", { name: /^destroy$/i });
      const input = dialog.getByLabelText(/type .* to confirm/i);
      fireEvent.change(input, { target: { value: PATH } });

      fireEvent.click(confirmButton);

      await waitFor(() => expect(deleteSecretAction).toHaveBeenCalledTimes(1));
      expect(deleteSecretAction).toHaveBeenCalledWith("openbao", PATH, true);
      await waitFor(() => expect(refresh).toHaveBeenCalled());
    });

    it("Destroy uses the destructive style; Delete does not", () => {
      render(<DestroySecret store="openbao" path={PATH} canWrite />);

      const deleteButton = screen.getByRole("button", { name: /^delete$/i });
      const destroyButton = screen.getByRole("button", { name: /^destroy$/i });

      expect(deleteButton.className).not.toMatch(/destructive/);
      expect(destroyButton.className).toMatch(/destructive/);
    });
  });
});
