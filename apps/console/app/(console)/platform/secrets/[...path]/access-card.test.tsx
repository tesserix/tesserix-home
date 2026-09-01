import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// `./access-actions` is a "use server" boundary reaching `secrets-api` and
// the audit log — mocked so this suite exercises the CLIENT half only
// (the form, the prefill wiring, the render-path gate), same discipline
// `write-secret-form.test.tsx` applies to `./actions`.
const grantAccessAction = vi.fn();
const revokeAccessAction = vi.fn();
vi.mock("./access-actions", () => ({
  grantAccessAction: (...args: unknown[]) => grantAccessAction(...args),
  revokeAccessAction: (...args: unknown[]) => revokeAccessAction(...args),
}));

// `router.refresh()` is how this card re-reads after a successful change
// (see Step 3 of the brief) — stood in so the assertion can observe it was
// called without a real Next.js router.
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

import { AccessCard } from "./access-card";
import type { Grant } from "@/lib/secrets";

const READERS: Grant[] = [
  { namespace: "mark8ly", app: "storefront" },
  { namespace: "mark8ly", app: "admin" },
];

describe("AccessCard", () => {
  beforeEach(() => {
    grantAccessAction.mockReset();
    revokeAccessAction.mockReset();
    refresh.mockReset();
    grantAccessAction.mockResolvedValue({ ok: true });
    revokeAccessAction.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("with canWrite", () => {
    it("renders the Add an app field group, the Propose access button, and a Remove button per reader", () => {
      render(
        <AccessCard store="openbao" readers={READERS} canWrite />,
      );

      expect(screen.getByText(/add an app/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /propose access/i })).toBeInTheDocument();
      expect(screen.getAllByRole("button", { name: /remove/i })).toHaveLength(READERS.length);
    });

    it("submitting calls grantAccessAction once with the parsed namespace/app/serviceAccount", async () => {
      render(<AccessCard store="openbao" readers={[]} canWrite />);

      fireEvent.change(screen.getByLabelText(/namespace/i), { target: { value: "mark8ly" } });
      fireEvent.change(screen.getByLabelText(/^app$/i), { target: { value: "orders" } });
      fireEvent.change(screen.getByLabelText(/service account/i), {
        target: { value: "mark8ly-orders" },
      });

      fireEvent.click(screen.getByRole("button", { name: /propose access/i }));

      await waitFor(() => expect(grantAccessAction).toHaveBeenCalledTimes(1));
      expect(grantAccessAction).toHaveBeenCalledWith({
        namespace: "mark8ly",
        app: "orders",
        serviceAccount: "mark8ly-orders",
      });
    });

    it("typing an app name prefills the service account field", () => {
      render(<AccessCard store="openbao" readers={[]} canWrite />);

      fireEvent.change(screen.getByLabelText(/^app$/i), { target: { value: "orders" } });

      expect(screen.getByLabelText(/service account/i)).toHaveValue("orders");
    });

    it("editing the service account first, then editing the app name, does not overwrite the operator's edit", () => {
      render(<AccessCard store="openbao" readers={[]} canWrite />);

      const serviceAccount = screen.getByLabelText(/service account/i);
      fireEvent.change(serviceAccount, { target: { value: "custom-sa" } });
      fireEvent.change(screen.getByLabelText(/^app$/i), { target: { value: "orders" } });

      expect(serviceAccount).toHaveValue("custom-sa");
    });

    it("editing the app name before ever touching the service account keeps prefilling it", () => {
      render(<AccessCard store="openbao" readers={[]} canWrite />);

      fireEvent.change(screen.getByLabelText(/^app$/i), { target: { value: "orders" } });
      fireEvent.change(screen.getByLabelText(/^app$/i), { target: { value: "orders-v2" } });

      expect(screen.getByLabelText(/service account/i)).toHaveValue("orders-v2");
    });

    it("submit is a quiet no-op when any of the three fields is empty — no error banner", async () => {
      render(<AccessCard store="openbao" readers={[]} canWrite />);

      // Namespace and app filled (which prefills service account too), but
      // the operator then clears the service account back out.
      fireEvent.change(screen.getByLabelText(/namespace/i), { target: { value: "mark8ly" } });
      fireEvent.change(screen.getByLabelText(/^app$/i), { target: { value: "orders" } });
      fireEvent.change(screen.getByLabelText(/service account/i), { target: { value: "" } });

      fireEvent.click(screen.getByRole("button", { name: /propose access/i }));

      // Give any accidental async work a tick to run.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(grantAccessAction).not.toHaveBeenCalled();
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("fields clear after a successful grant", async () => {
      render(<AccessCard store="openbao" readers={[]} canWrite />);

      fireEvent.change(screen.getByLabelText(/namespace/i), { target: { value: "mark8ly" } });
      fireEvent.change(screen.getByLabelText(/^app$/i), { target: { value: "orders" } });
      fireEvent.change(screen.getByLabelText(/service account/i), {
        target: { value: "mark8ly-orders" },
      });
      fireEvent.click(screen.getByRole("button", { name: /propose access/i }));

      await waitFor(() => expect(grantAccessAction).toHaveBeenCalledTimes(1));

      expect(screen.getByLabelText(/namespace/i)).toHaveValue("");
      expect(screen.getByLabelText(/^app$/i)).toHaveValue("");
      expect(screen.getByLabelText(/service account/i)).toHaveValue("");
    });

    it("submitting the form with Enter triggers the same grant call", async () => {
      render(<AccessCard store="openbao" readers={[]} canWrite />);

      fireEvent.change(screen.getByLabelText(/namespace/i), { target: { value: "mark8ly" } });
      fireEvent.change(screen.getByLabelText(/^app$/i), { target: { value: "orders" } });
      fireEvent.change(screen.getByLabelText(/service account/i), {
        target: { value: "mark8ly-orders" },
      });

      fireEvent.submit(screen.getByRole("button", { name: /propose access/i }).closest("form")!);

      await waitFor(() => expect(grantAccessAction).toHaveBeenCalledTimes(1));
    });

    it("Remove calls revokeAccessAction with the reader's namespace and app, and re-reads afterward", async () => {
      render(
        <AccessCard store="openbao" readers={READERS} canWrite />,
      );

      const removeButtons = screen.getAllByRole("button", { name: /remove/i });
      fireEvent.click(removeButtons[0]);

      await waitFor(() => expect(revokeAccessAction).toHaveBeenCalledTimes(1));
      expect(revokeAccessAction).toHaveBeenCalledWith("mark8ly", "storefront");
      await waitFor(() => expect(refresh).toHaveBeenCalled());
    });

    it("a successful grant re-reads via router.refresh rather than mutating the reader list locally", async () => {
      render(<AccessCard store="openbao" readers={[]} canWrite />);

      fireEvent.change(screen.getByLabelText(/namespace/i), { target: { value: "mark8ly" } });
      fireEvent.change(screen.getByLabelText(/^app$/i), { target: { value: "orders" } });
      fireEvent.change(screen.getByLabelText(/service account/i), {
        target: { value: "mark8ly-orders" },
      });
      fireEvent.click(screen.getByRole("button", { name: /propose access/i }));

      await waitFor(() => expect(refresh).toHaveBeenCalled());
      // The reader list rendered here is still exactly the `readers` prop —
      // this card never invents a new row from the grant it just submitted.
      expect(screen.getByText(/nothing reads this secret yet/i)).toBeInTheDocument();
    });

    it("shows the approver copy: adding or removing merges immediately", () => {
      render(<AccessCard store="openbao" readers={[]} canWrite />);

      expect(
        screen.getByText(/adding or removing a reader here merges immediately/i),
      ).toBeInTheDocument();
    });
  });

  describe("without canWrite", () => {
    it("shows the refusal sentence and renders neither Propose access nor Remove", () => {
      render(
        <AccessCard
          store="openbao"
          readers={READERS}
          canWrite={false}
        />,
      );

      // Rendered as "Granting access needs " + a <code> element, not a
      // single text node with literal backticks — matched by function so
      // the code-formatted credential name isn't required to be inline text.
      expect(
        screen.getByText((_, element) => element?.textContent === "Granting access needs rotate-credentials."),
      ).toBeInTheDocument();
      expect(screen.getByText("rotate-credentials").tagName).toBe("CODE");
      expect(screen.queryByRole("button", { name: /propose access/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /remove/i })).toBeNull();
      // `queryByLabelText(/add an app/i)` looked like it covered the whole
      // form, but Testing Library's label matching never resolves a
      // `<fieldset>`/`<legend>` pairing — that query returns `null`
      // regardless of whether `AddReaderForm` is rendered, so it could
      // never fail. `Namespace` is a real `<Label htmlFor>`/`<Input id>`
      // pair inside that form, so its absence is real evidence the form
      // itself is gone, not just its submit button.
      expect(screen.queryByLabelText(/namespace/i)).toBeNull();
    });

    it("still lists the readers, just without a Remove control", () => {
      render(
        <AccessCard
          store="openbao"
          readers={READERS}
          canWrite={false}
        />,
      );

      expect(screen.getByText(/mark8ly\/storefront/)).toBeInTheDocument();
      expect(screen.getByText(/mark8ly\/admin/)).toBeInTheDocument();
    });
  });
});
