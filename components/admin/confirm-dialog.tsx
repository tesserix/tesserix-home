"use client";

// Promise-based confirm/prompt dialog for the admin — a professional in-app
// replacement for window.confirm / window.prompt. Usage:
//   const { confirm, prompt } = useConfirm();
//   if (!(await confirm({ title: "Verify kitchen", message: "…", confirmLabel: "Verify" }))) return;
//   const reason = await prompt({ title: "Reject", required: true, multiline: true });
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { Button } from "@tesserix/web";

type Tone = "default" | "destructive";

interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: Tone;
}

interface PromptOptions extends ConfirmOptions {
  label?: string;
  placeholder?: string;
  defaultValue?: string;
  multiline?: boolean;
  numeric?: boolean;
  required?: boolean;
  minLength?: number;
}

interface ConfirmContextValue {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  prompt: (opts: PromptOptions) => Promise<string | null>;
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

type DialogState =
  | { kind: "confirm"; opts: ConfirmOptions; resolve: (v: boolean) => void }
  | { kind: "prompt"; opts: PromptOptions; resolve: (v: string | null) => void }
  | null;

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<DialogState>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setError(null);
        setState({ kind: "confirm", opts, resolve });
      }),
    [],
  );

  const prompt = useCallback(
    (opts: PromptOptions) =>
      new Promise<string | null>((resolve) => {
        setError(null);
        setValue(opts.defaultValue ?? "");
        setState({ kind: "prompt", opts, resolve });
      }),
    [],
  );

  function finish(result: boolean | string | null) {
    if (!state) return;
    if (state.kind === "confirm") state.resolve(result as boolean);
    else state.resolve(result as string | null);
    setState(null);
    setValue("");
    setError(null);
  }

  function cancel() {
    if (!state) return;
    finish(state.kind === "confirm" ? false : null);
  }

  function submit() {
    if (!state) return;
    if (state.kind === "confirm") {
      finish(true);
      return;
    }
    const o = state.opts;
    const v = value.trim();
    if (o.required && !v) {
      setError("This field is required.");
      return;
    }
    if (o.minLength && v.length < o.minLength) {
      setError(`Please enter at least ${o.minLength} characters.`);
      return;
    }
    if (o.numeric) {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) {
        setError("Enter a number greater than zero.");
        return;
      }
    }
    finish(v);
  }

  // Escape closes; Enter confirms (single-line prompts + plain confirms).
  useEffect(() => {
    if (!state) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      } else if (
        e.key === "Enter" &&
        !(state?.kind === "prompt" && (state.opts as PromptOptions).multiline)
      ) {
        e.preventDefault();
        submit();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, value]);

  const opts = state?.opts;
  const isPrompt = state?.kind === "prompt";
  const destructive = opts?.tone === "destructive";

  return (
    <ConfirmContext.Provider value={{ confirm, prompt }}>
      {children}
      {state ? (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-title"
        >
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-[1px] animate-in fade-in"
            onClick={cancel}
          />
          <div className="relative w-full max-w-md rounded-xl border border-border bg-background p-6 shadow-2xl animate-in fade-in zoom-in-95">
            <h2 id="confirm-title" className="text-lg font-semibold text-foreground">
              {opts?.title}
            </h2>
            {opts?.message ? (
              <p className="mt-1.5 text-sm text-muted-foreground">{opts.message}</p>
            ) : null}

            {isPrompt ? (
              <div className="mt-4">
                {(opts as PromptOptions).label ? (
                  <label className="mb-1.5 block text-sm font-medium text-foreground">
                    {(opts as PromptOptions).label}
                  </label>
                ) : null}
                {(opts as PromptOptions).multiline ? (
                  <textarea
                    autoFocus
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    placeholder={(opts as PromptOptions).placeholder}
                    rows={4}
                    className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-foreground/20"
                  />
                ) : (
                  <input
                    autoFocus
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    placeholder={(opts as PromptOptions).placeholder}
                    inputMode={(opts as PromptOptions).numeric ? "decimal" : undefined}
                    className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-foreground/20"
                  />
                )}
              </div>
            ) : null}

            {error ? <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p> : null}

            <div className="mt-6 flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={cancel}>
                {opts?.cancelLabel ?? "Cancel"}
              </Button>
              <Button
                variant={destructive ? "destructive" : "default"}
                size="sm"
                onClick={submit}
              >
                {opts?.confirmLabel ?? "Confirm"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmContextValue {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used within <ConfirmProvider>");
  return ctx;
}
