import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// `./access-actions` is a "use server" boundary reaching `secrets-api` and
// the audit log — mocked so this suite exercises the CLIENT half only (which
// versions get a control, and what the control sends), the same discipline
// `destroy-secret.test.tsx` applies to `deleteSecretAction`.
const restoreSecretVersionAction = vi.fn();
vi.mock("./access-actions", () => ({
  restoreSecretVersionAction: (...args: unknown[]) => restoreSecretVersionAction(...args),
}));

// `router.refresh()` is how this control re-reads after a successful
// restore — stood in so the assertion can observe it without a real Next.js
// router. Same pattern `destroy-secret.test.tsx` uses.
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

import type { SecretVersion } from "@/lib/secrets";
import { RestoreVersionControl } from "./restore-version";

const PATH = "mark8ly/db-password";

const DESTROYED: SecretVersion = { version: 1, destroyed: true, deleted: true };
const DELETED: SecretVersion = { version: 2, destroyed: false, deleted: true };
const ACTIVE: SecretVersion = { version: 3, destroyed: false, deleted: false };

function renderControl(version: SecretVersion, canWrite = true) {
  return render(
    <RestoreVersionControl store="openbao" path={PATH} version={version} canWrite={canWrite} />,
  );
}

describe("RestoreVersionControl", () => {
  beforeEach(() => {
    restoreSecretVersionAction.mockReset();
    refresh.mockReset();
    restoreSecretVersionAction.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("which versions it is offered for", () => {
    // The crux of this component. All three cases assert on the SAME
    // accessible name, so collapsing any two of the three states into one
    // branch fails here rather than passing quietly.
    it("offers nothing for a destroyed version — secrets-api cannot bring it back", () => {
      renderControl(DESTROYED);

      expect(screen.queryByRole("button", { name: /restore/i })).toBeNull();
    });

    it("offers Restore for a version that is deleted but not destroyed", () => {
      renderControl(DELETED);

      expect(screen.getByRole("button", { name: "Restore version 2" })).toBeInTheDocument();
    });

    it("offers nothing for an active version — there is nothing to restore", () => {
      renderControl(ACTIVE);

      expect(screen.queryByRole("button", { name: /restore/i })).toBeNull();
    });

    // Pins the contract that `destroyed` means no control WHATEVER `deleted`
    // says — so a rewrite that folds the two guards into one composite
    // condition (`destroyed && deleted`, say) cannot quietly narrow it.
    // `destroyed` alone is not a state KV v2 produces, its only path there
    // being through `deleted`; today this input is also caught by the
    // `!deleted` guard, so this case is a contract pin rather than the thing
    // that catches a missing `destroyed` guard — the destroyed-AND-deleted
    // case above is what catches that.
    it("offers nothing for a destroyed version even when `deleted` is false", () => {
      renderControl({ version: 4, destroyed: true, deleted: false });

      expect(screen.queryByRole("button", { name: /restore/i })).toBeNull();
    });
  });

  describe("the canWrite gate", () => {
    it("offers no control to an operator who cannot write, even on a restorable version", () => {
      renderControl(DELETED, false);

      expect(screen.queryByRole("button", { name: /restore/i })).toBeNull();
    });
  });

  describe("restoring", () => {
    it("calls restoreSecretVersionAction with the store, path, and THIS row's version number", async () => {
      renderControl(DELETED);

      fireEvent.click(screen.getByRole("button", { name: "Restore version 2" }));

      await waitFor(() => expect(restoreSecretVersionAction).toHaveBeenCalledTimes(1));
      expect(restoreSecretVersionAction).toHaveBeenCalledWith("openbao", PATH, 2);
    });

    it("passes the store through unchanged rather than assuming openbao", async () => {
      render(
        <RestoreVersionControl store="gcpsm" path={PATH} version={DELETED} canWrite />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Restore version 2" }));

      await waitFor(() => expect(restoreSecretVersionAction).toHaveBeenCalledTimes(1));
      expect(restoreSecretVersionAction).toHaveBeenCalledWith("gcpsm", PATH, 2);
    });

    it("re-reads the page on success, so the row stops reading Deleted", async () => {
      renderControl(DELETED);

      fireEvent.click(screen.getByRole("button", { name: "Restore version 2" }));

      await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    });

    it("surfaces the action's message on failure, and does not re-read", async () => {
      restoreSecretVersionAction.mockResolvedValue({
        ok: false,
        message: "That change was not saved.",
      });
      renderControl(DELETED);

      fireEvent.click(screen.getByRole("button", { name: "Restore version 2" }));

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("That change was not saved.");
      expect(refresh).not.toHaveBeenCalled();
    });

    it("does not require a typed confirmation — a restore is reversible", () => {
      renderControl(DELETED);

      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.queryByLabelText(/to confirm/i)).toBeNull();
    });
  });
});
