import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// `./actions` reaches `writeSecret` (`lib/secrets-api.ts`, `server-only`, an
// operator-token read through `pg`) through a "use server" boundary — mocked
// so this suite exercises the CLIENT half only (generate/reveal/copy, the
// submit wiring, the success state) without a database in a jsdom test. This
// is also the seam every assertion below about WHAT gets sent to
// `writeSecret` reads through: the mock records the call, `secrets-api.test.ts`
// (Task 2) already proves `writeSecret` itself PUTs it correctly on the wire.
const writeSecretAction = vi.fn();
vi.mock("./actions", () => ({
  writeSecretAction: (...args: unknown[]) => writeSecretAction(...args),
}));

import { WriteSecretForm } from "./write-secret-form";

function typeKeyAndValue(key: string, value: string) {
  fireEvent.change(screen.getByLabelText(/key name/i), { target: { value: key } });
  fireEvent.change(screen.getByLabelText(/^value$/i), { target: { value } });
}

async function submit() {
  fireEvent.click(screen.getByRole("button", { name: /write secret|create secret|rotate secret/i }));
  // The action runs inside a `useTransition`, so its resolution is
  // asynchronous even though the mock itself resolves immediately.
  await waitFor(() => expect(writeSecretAction).toHaveBeenCalled());
}

describe("WriteSecretForm", () => {
  beforeEach(() => {
    writeSecretAction.mockReset();
    writeSecretAction.mockResolvedValue({ ok: true, version: 1 });
    // jsdom has no Clipboard implementation at all — `navigator.clipboard`
    // is `undefined` there, not merely un-permissioned — so the Copy test
    // needs a real spy to call.
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Generate populates the value field, and two generates in a row differ", () => {
    render(<WriteSecretForm store="openbao" path="mark8ly/db-password" />);
    const generate = screen.getByRole("button", { name: /generate/i });
    const value = screen.getByLabelText(/^value$/i) as HTMLInputElement;

    fireEvent.click(generate);
    const first = value.value;
    expect(first).not.toBe("");

    fireEvent.click(generate);
    const second = value.value;

    // 32 random bytes collide with a probability no test run will ever hit;
    // still backed by the crypto-call assertion below per the brief's own
    // fallback, so this is never the only thing standing between a real
    // `crypto.getRandomValues` call and `Math.random`.
    expect(second).not.toBe(first);
  });

  it("Generate calls crypto.getRandomValues, not Math.random", () => {
    const getRandomValues = vi.spyOn(crypto, "getRandomValues");
    const mathRandom = vi.spyOn(Math, "random");

    render(<WriteSecretForm store="openbao" path="mark8ly/db-password" />);
    fireEvent.click(screen.getByRole("button", { name: /generate/i }));

    expect(getRandomValues).toHaveBeenCalled();
    expect(mathRandom).not.toHaveBeenCalled();
  });

  it("Reveal toggles the value's visibility without making any network call", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    render(<WriteSecretForm store="openbao" path="mark8ly/db-password" />);
    typeKeyAndValue("PASSWORD", "hunter2");

    const value = screen.getByLabelText(/^value$/i) as HTMLInputElement;
    expect(value.type).toBe("password");

    fireEvent.click(screen.getByRole("button", { name: /reveal value/i }));
    expect(value.type).toBe("text");

    fireEvent.click(screen.getByRole("button", { name: /hide value/i }));
    expect(value.type).toBe("password");

    // The whole point of this test: reveal reads the React state this form
    // already holds. There is no endpoint to fetch a value from — see
    // `handleReveal`'s own comment — and this assertion is what stops a
    // later "improvement" from adding one.
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("Copy writes the current value to the clipboard", async () => {
    render(<WriteSecretForm store="openbao" path="mark8ly/db-password" />);
    typeKeyAndValue("PASSWORD", "hunter2");

    fireEvent.click(screen.getByRole("button", { name: /copy value/i }));

    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("hunter2"));
  });

  it("submitting calls writeSecret with the typed key/value pair", async () => {
    render(<WriteSecretForm store="openbao" path="mark8ly/db-password" />);
    typeKeyAndValue("PASSWORD", "hunter2");

    await submit();

    expect(writeSecretAction).toHaveBeenCalledWith(
      "openbao",
      "mark8ly/db-password",
      { PASSWORD: "hunter2" },
      undefined,
    );
  });

  it("a rotate (a current version was passed in) sends that positive ifVersion", async () => {
    render(<WriteSecretForm store="openbao" path="mark8ly/db-password" currentVersion={5} />);
    typeKeyAndValue("PASSWORD", "hunter2");

    await submit();

    expect(writeSecretAction).toHaveBeenCalledWith(
      "openbao",
      "mark8ly/db-password",
      { PASSWORD: "hunter2" },
      5,
    );
  });

  it("a create (no current version) sends no ifVersion at all", async () => {
    render(<WriteSecretForm store="openbao" path="mark8ly/new-secret" />);
    typeKeyAndValue("PASSWORD", "hunter2");

    await submit();

    const call = writeSecretAction.mock.calls[0];
    expect(call[3]).toBeUndefined();
  });

  it("a second write after a successful rotate carries the version the store just assigned, not the stale prop", async () => {
    writeSecretAction.mockResolvedValueOnce({ ok: true, version: 6 });
    render(<WriteSecretForm store="openbao" path="mark8ly/db-password" currentVersion={5} />);
    typeKeyAndValue("PASSWORD", "first-value");
    await submit();

    expect(writeSecretAction).toHaveBeenNthCalledWith(
      1,
      "openbao",
      "mark8ly/db-password",
      { PASSWORD: "first-value" },
      5,
    );

    fireEvent.click(screen.getByRole("button", { name: /write another version/i }));
    typeKeyAndValue("PASSWORD", "second-value");
    fireEvent.click(screen.getByRole("button", { name: /write secret|create secret|rotate secret/i }));
    await waitFor(() => expect(writeSecretAction).toHaveBeenCalledTimes(2));

    // NOT 5 (the prop this form was rendered with) — the store is at 6 now,
    // because the first write just told this component so.
    expect(writeSecretAction).toHaveBeenNthCalledWith(
      2,
      "openbao",
      "mark8ly/db-password",
      { PASSWORD: "second-value" },
      6,
    );
  });

  it("currentVersion={0} does not present as a rotate — 0 and omitted are the same thing on the wire", async () => {
    render(<WriteSecretForm store="openbao" path="mark8ly/new-secret" currentVersion={0} />);
    expect(screen.getByRole("button", { name: /create secret/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /rotate secret/i })).toBeNull();

    typeKeyAndValue("PASSWORD", "hunter2");
    await submit();

    const call = writeSecretAction.mock.calls[0];
    expect(call[3]).toBeUndefined();
  });

  // Belt-and-braces alongside `parseWriteResult`'s own rejection of a
  // non-positive version (`secrets-api.test.ts`): that parser stands between
  // the real server and this form, so a real response can never carry a `0`
  // here. This test exercises the form's OWN guard directly, by handing its
  // mocked action exactly the malformed value the parser exists to block —
  // proving `asRotateVersion` is applied at advancement, not only at the
  // initial seed, regardless of what stands upstream of it.
  it("does not present as a rotate after a write that (hypothetically) reports version 0", async () => {
    writeSecretAction.mockResolvedValueOnce({ ok: true, version: 0 });
    render(<WriteSecretForm store="openbao" path="mark8ly/db-password" currentVersion={5} />);
    typeKeyAndValue("PASSWORD", "first-value");
    await submit();

    fireEvent.click(screen.getByRole("button", { name: /write another version/i }));

    expect(screen.getByRole("button", { name: /create secret/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /rotate secret/i })).toBeNull();

    typeKeyAndValue("PASSWORD", "second-value");
    fireEvent.click(screen.getByRole("button", { name: /write secret|create secret|rotate secret/i }));
    await waitFor(() => expect(writeSecretAction).toHaveBeenCalledTimes(2));

    expect(writeSecretAction).toHaveBeenNthCalledWith(
      2,
      "openbao",
      "mark8ly/db-password",
      { PASSWORD: "second-value" },
      undefined,
    );
  });

  it("Copy surfaces a distinguishable failure when the Clipboard API is unavailable", async () => {
    // A secure-context absence, not a permission denial: `navigator.clipboard`
    // itself is undefined here, exactly as jsdom already has it before the
    // `beforeEach` above assigns a mock onto it — this test removes that
    // mock to exercise the real absent-API path.
    Object.assign(navigator, { clipboard: undefined });

    render(<WriteSecretForm store="openbao" path="mark8ly/db-password" />);
    typeKeyAndValue("PASSWORD", "hunter2");
    fireEvent.click(screen.getByRole("button", { name: /copy value/i }));

    expect(await screen.findByText(/clipboard access isn.t available/i)).toBeInTheDocument();
  });

  it("Copy surfaces a distinguishable failure when the clipboard write is rejected", async () => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });

    render(<WriteSecretForm store="openbao" path="mark8ly/db-password" />);
    typeKeyAndValue("PASSWORD", "hunter2");
    fireEvent.click(screen.getByRole("button", { name: /copy value/i }));

    expect(await screen.findByText(/copy failed/i)).toBeInTheDocument();
  });

  // Finding 4: `setIfVersion` (advancing to the version the store just
  // assigned, for the NEXT write) and `setResult` fire together inside the
  // same `startTransition` callback, so React batches them — a render that
  // reads live `isRotate` (`ifVersion !== undefined`) after both updates
  // always sees the ADVANCED value, which is truthy for a create too (a
  // create's response carries a real positive version, same shape as a
  // rotate's). The existing "success state" test's regex
  // (`/secret (written|created|rotated)/i`) matches either word, so it
  // cannot catch this — this test pins the exact word for each case.
  it("a create reports 'written', not 'rotated', even though ifVersion is truthy immediately afterward", async () => {
    render(<WriteSecretForm store="openbao" path="mark8ly/new-secret" />);
    typeKeyAndValue("PASSWORD", "hunter2");

    await submit();

    expect(await screen.findByText(/^secret written\./i)).toBeInTheDocument();
    expect(screen.queryByText(/rotated/i)).toBeNull();
  });

  it("a rotate reports 'rotated'", async () => {
    render(<WriteSecretForm store="openbao" path="mark8ly/db-password" currentVersion={5} />);
    typeKeyAndValue("PASSWORD", "hunter2");

    await submit();

    expect(await screen.findByText(/^secret rotated\./i)).toBeInTheDocument();
  });

  it("the key name field disables autofill so Chrome does not offer the operator's saved email there", () => {
    render(<WriteSecretForm store="openbao" path="mark8ly/db-password" />);
    expect(screen.getByLabelText(/key name/i)).toHaveAttribute("autoComplete", "off");
  });

  it("the success state does not display the value", async () => {
    render(<WriteSecretForm store="openbao" path="mark8ly/db-password" currentVersion={5} />);
    typeKeyAndValue("PASSWORD", "a-very-distinctive-secret-value");

    await submit();

    await waitFor(() => expect(screen.getByText(/secret (written|created|rotated)/i)).toBeInTheDocument());
    // `queryByText` only matches an element whose OWN normalized text equals
    // the target exactly — a value interpolated inline beside other words
    // (e.g. `now exists: {value}`) never equals any single element's whole
    // text, so it would slip past that assertion undetected. Checking the
    // rendered container's raw text content instead catches a substring
    // leak wherever it lands in the markup.
    expect(document.body.textContent).not.toContain("a-very-distinctive-secret-value");
    expect(screen.queryByDisplayValue("a-very-distinctive-secret-value")).toBeNull();
  });
});
