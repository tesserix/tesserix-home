import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// `./access-actions` is a "use server" boundary reaching `secrets-api` and
// the audit log — mocked so this suite exercises the CLIENT half only
// (the form, the prefill wiring, the render-path gate), same discipline
// `write-secret-form.test.tsx` applies to `./actions`.
const grantAccessAction = vi.fn();
const proposeAccessAction = vi.fn();
const revokeAccessAction = vi.fn();
vi.mock("./access-actions", () => ({
  grantAccessAction: (...args: unknown[]) => grantAccessAction(...args),
  proposeAccessAction: (...args: unknown[]) => proposeAccessAction(...args),
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

const PULL_REQUEST = "https://github.com/tesserix/tesserix-k8s/pull/7";

const READERS: Grant[] = [
  { namespace: "mark8ly", app: "storefront" },
  { namespace: "mark8ly", app: "admin" },
];

describe("AccessCard", () => {
  beforeEach(() => {
    grantAccessAction.mockReset();
    proposeAccessAction.mockReset();
    revokeAccessAction.mockReset();
    refresh.mockReset();
    grantAccessAction.mockResolvedValue({ ok: true });
    proposeAccessAction.mockResolvedValue({
      ok: true,
      status: "proposed",
      pullRequest: PULL_REQUEST,
    });
    revokeAccessAction.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("with canWrite", () => {
    it("renders the Add an app field group, the Grant access button, and a Remove button per reader", () => {
      render(
        <AccessCard store="openbao" readers={READERS} canWrite />,
      );

      expect(screen.getByText(/add an app/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /grant access/i })).toBeInTheDocument();
      expect(screen.getAllByRole("button", { name: /remove/i })).toHaveLength(READERS.length);
    });

    it("submitting calls grantAccessAction once with the parsed namespace/app/serviceAccount", async () => {
      render(<AccessCard store="openbao" readers={[]} canWrite />);

      fireEvent.change(screen.getByLabelText(/namespace/i), { target: { value: "mark8ly" } });
      fireEvent.change(screen.getByLabelText(/^app$/i), { target: { value: "orders" } });
      fireEvent.change(screen.getByLabelText(/service account/i), {
        target: { value: "mark8ly-orders" },
      });

      fireEvent.click(screen.getByRole("button", { name: /grant access/i }));

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

      fireEvent.click(screen.getByRole("button", { name: /grant access/i }));

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
      fireEvent.click(screen.getByRole("button", { name: /grant access/i }));

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

      fireEvent.submit(screen.getByRole("button", { name: /grant access/i }).closest("form")!);

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
      fireEvent.click(screen.getByRole("button", { name: /grant access/i }));

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
    it("names the capability the reader is actually missing, and renders no write control", () => {
      render(
        <AccessCard
          store="openbao"
          readers={READERS}
          canWrite={false}
        />,
      );

      // This branch is reached ONLY by an operator without `platform`, so
      // `platform` is what the copy must name. It previously read "Granting
      // access needs rotate-credentials." — true about the immediate grant,
      // but it named the one capability this reader is NOT missing and said
      // nothing about the one they are.
      //
      // Rendered as text plus a <code> element, not a single text node with
      // literal backticks — matched by function so the code-formatted
      // capability name isn't required to be inline text.
      expect(
        screen.getByText(
          (_, element) => element?.textContent === "Changing who can read this needs platform.",
        ),
      ).toBeInTheDocument();
      expect(screen.getByText("platform").tagName).toBe("CODE");
      // Neither write control, under either label.
      expect(screen.queryByRole("button", { name: /grant access/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /propose in a pull request/i })).toBeNull();
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

  describe("with canPropose (platform, without rotate-credentials)", () => {
    function renderProposeMode(readers: Grant[] = []) {
      return render(
        <AccessCard store="openbao" readers={readers} canWrite={false} canPropose />,
      );
    }

    it("offers the propose control instead of the refusal sentence", () => {
      renderProposeMode(READERS);

      expect(
        screen.getByRole("button", { name: /propose in a pull request/i }),
      ).toBeInTheDocument();
      expect(screen.getByLabelText(/namespace/i)).toBeInTheDocument();
      // The immediate path is still not offered: no Remove, and none of the
      // "merges immediately" copy that belongs to `rotate-credentials`.
      expect(screen.queryByRole("button", { name: /remove/i })).toBeNull();
      expect(screen.queryByText(/merges immediately/i)).toBeNull();
    });

    it("says what actually happens: a pull request, real only once merged and synced", () => {
      renderProposeMode();

      // Matched on the <p> itself: the sentence is split across <strong> and
      // <code> children, so every ancestor's textContent matches too and an
      // unscoped matcher finds several elements rather than failing.
      const copy = screen.getByText(
        (_, element) =>
          element?.tagName === "P" &&
          /opens a pull request against tesserix-k8s/i.test(element.textContent ?? ""),
      );
      expect(copy).toHaveTextContent(
        /access becomes real when that pull request is merged and ArgoCD syncs it/i,
      );
    });

    it("submitting calls proposeAccessAction — not grantAccessAction — with the three fields", async () => {
      renderProposeMode();

      fireEvent.change(screen.getByLabelText(/namespace/i), { target: { value: "mark8ly" } });
      fireEvent.change(screen.getByLabelText(/^app$/i), { target: { value: "orders" } });
      fireEvent.change(screen.getByLabelText(/service account/i), {
        target: { value: "mark8ly-orders" },
      });
      fireEvent.click(screen.getByRole("button", { name: /propose in a pull request/i }));

      await waitFor(() => expect(proposeAccessAction).toHaveBeenCalledTimes(1));
      expect(proposeAccessAction).toHaveBeenCalledWith({
        namespace: "mark8ly",
        app: "orders",
        serviceAccount: "mark8ly-orders",
      });
      expect(grantAccessAction).not.toHaveBeenCalled();
    });

    async function propose() {
      fireEvent.change(screen.getByLabelText(/namespace/i), { target: { value: "mark8ly" } });
      fireEvent.change(screen.getByLabelText(/^app$/i), { target: { value: "orders" } });
      fireEvent.change(screen.getByLabelText(/service account/i), {
        target: { value: "mark8ly-orders" },
      });
      fireEvent.click(screen.getByRole("button", { name: /propose in a pull request/i }));
      await waitFor(() => expect(proposeAccessAction).toHaveBeenCalledTimes(1));
    }

    it("links the pull request on a proposed answer", async () => {
      renderProposeMode();
      await propose();

      const link = await screen.findByRole("link", { name: /review it in tesserix-k8s/i });
      expect(link).toHaveAttribute("href", PULL_REQUEST);
    });

    it("reports unchanged as a success and renders NO link, because there is no pull request", async () => {
      proposeAccessAction.mockResolvedValue({ ok: true, status: "unchanged" });
      renderProposeMode();
      await propose();

      const status = await screen.findByRole("status");
      expect(status).toHaveTextContent(/the whitelist already grants this app access/i);
      // The failure this guards: rendering an anchor whose href is the
      // absent URL, which secrets-api deliberately omits rather than
      // sending empty (see `Whitelist.submit`).
      //
      // ASSERTED ON THE ELEMENT, NOT ON `queryByRole("link", …)`. WARNING FOR
      // ANY FUTURE LINK ASSERTION IN THIS REPO: Testing Library does NOT
      // resolve `<a href="">` to the `link` role, and `href=""` is exactly
      // what a missing URL renders — so `expect(queryByRole("link", …))
      // .toBeNull()` PASSES while the broken anchor is on screen. That is an
      // assertion that cannot fail. Confirmed by mutation: adding
      // `<a href="">review it in tesserix-k8s</a>` to the unchanged branch
      // left the role-query version green, and only `querySelector("a")`
      // caught it.
      expect(status.querySelector("a")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("shows the refusal message on a failure, and no proposal outcome", async () => {
      proposeAccessAction.mockResolvedValue({ ok: false, message: "That change was not saved." });
      renderProposeMode();
      await propose();

      expect(await screen.findByRole("alert")).toHaveTextContent("That change was not saved.");
      expect(screen.queryByRole("status")).toBeNull();
    });

    it("does not re-read the page: a proposal changes nothing the reader list is read from", async () => {
      renderProposeMode();
      await propose();

      await screen.findByRole("status");
      expect(refresh).not.toHaveBeenCalled();
    });

    // A GSM secret's readers are IAM bindings; there is no `tesserix-k8s`
    // whitelist to propose against, so the control must not appear even when
    // the operator holds `platform`.
    it("is never offered for a GSM secret, whatever the capabilities say", () => {
      render(<AccessCard store="gcpsm" readers={[]} canWrite canPropose />);

      expect(screen.queryByRole("button", { name: /propose in a pull request/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /propose access/i })).toBeNull();
      expect(screen.queryByLabelText(/namespace/i)).toBeNull();
      expect(screen.getByText(/governed by/i)).toBeInTheDocument();
    });
  });

  it("prefers the immediate control when the operator can do both", () => {
    render(<AccessCard store="openbao" readers={[]} canWrite canPropose />);

    expect(screen.queryByRole("button", { name: /propose in a pull request/i })).toBeNull();
    // The immediate control must NOT be named "propose": it sits directly
    // above copy saying the change "merges immediately", and a card offering
    // both modes cannot have the one that acts immediately called Propose.
    const immediate = screen.getByRole("button", { name: /grant access/i });
    expect(immediate).toHaveTextContent("Grant access");
    expect(immediate.textContent).not.toMatch(/propose/i);
    expect(screen.getByText(/adding or removing a reader here merges immediately/i)).toBeInTheDocument();
  });
});
