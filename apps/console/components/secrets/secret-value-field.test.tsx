import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useState } from "react";
import { SecretValueField } from "./secret-value-field";

// A controlled component needs a stateful host to render meaningfully — this
// mirrors how `write-secret-form.tsx` owns `value`/`setValue` and passes
// them straight through.
function ControlledField(props: { disabled?: boolean; id?: string }) {
  const [value, setValue] = useState("");
  return <SecretValueField value={value} onChange={setValue} {...props} />;
}

describe("SecretValueField", () => {
  beforeEach(() => {
    // jsdom has no Clipboard implementation at all — `navigator.clipboard`
    // is `undefined` there, not merely un-permissioned — so the Copy test
    // needs a real spy to call.
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Generate populates the value field, and two generates in a row differ", () => {
    render(<ControlledField />);
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

    render(<ControlledField />);
    fireEvent.click(screen.getByRole("button", { name: /generate/i }));

    expect(getRandomValues).toHaveBeenCalled();
    expect(mathRandom).not.toHaveBeenCalled();
  });

  it("Reveal toggles the value's visibility without making any network call", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    render(<ControlledField />);
    const value = screen.getByLabelText(/^value$/i) as HTMLInputElement;
    fireEvent.change(value, { target: { value: "hunter2" } });

    expect(value.type).toBe("password");

    fireEvent.click(screen.getByRole("button", { name: /reveal value/i }));
    expect(value.type).toBe("text");

    fireEvent.click(screen.getByRole("button", { name: /hide value/i }));
    expect(value.type).toBe("password");

    // The whole point of this test: reveal reads the React state this field
    // already holds. There is no endpoint to fetch a value from — see
    // `handleReveal`'s own comment — and this assertion is what stops a
    // later "improvement" from adding one.
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("Copy writes the current value to the clipboard", async () => {
    render(<ControlledField />);
    fireEvent.change(screen.getByLabelText(/^value$/i), { target: { value: "hunter2" } });

    fireEvent.click(screen.getByRole("button", { name: /copy value/i }));

    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("hunter2"));
  });

  it("Copy surfaces a distinguishable failure when the Clipboard API is unavailable", async () => {
    // A secure-context absence, not a permission denial: `navigator.clipboard`
    // itself is undefined here, exactly as jsdom already has it before the
    // `beforeEach` above assigns a mock onto it — this test removes that
    // mock to exercise the real absent-API path.
    Object.assign(navigator, { clipboard: undefined });

    render(<ControlledField />);
    fireEvent.change(screen.getByLabelText(/^value$/i), { target: { value: "hunter2" } });
    fireEvent.click(screen.getByRole("button", { name: /copy value/i }));

    expect(await screen.findByText(/clipboard access isn.t available/i)).toBeInTheDocument();
  });

  it("sets autoComplete to new-password, not off — Chrome ignores off on credential-classified inputs", () => {
    render(<ControlledField />);
    const value = screen.getByLabelText(/^value$/i) as HTMLInputElement;

    expect(value.autocomplete).toBe("new-password");
  });

  it("Copy surfaces a distinguishable failure when the clipboard write is rejected", async () => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });

    render(<ControlledField />);
    fireEvent.change(screen.getByLabelText(/^value$/i), { target: { value: "hunter2" } });
    fireEvent.click(screen.getByRole("button", { name: /copy value/i }));

    expect(await screen.findByText(/copy failed/i)).toBeInTheDocument();
  });
});
