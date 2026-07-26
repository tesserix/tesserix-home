"use client";

// Global Live/Test toggle for the HomeChef admin console.
//
// HomeChef runs sandbox ("test") kitchens alongside real ones on the same
// production database. Every admin list and figure is scoped to whichever world
// this toggle selects, so a fake order can never be mistaken for — or blended
// into — a real one.
//
// The choice is persisted per browser and sent to the Go API as `?mode=`, which
// the signed gateway forwards unchanged.

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { cn } from "@/lib/utils";

export type HomechefMode = "live" | "test";

const STORAGE_KEY = "homechef:adminMode";

interface ModeContextValue {
  mode: HomechefMode;
  setMode: (m: HomechefMode) => void;
  /** Spread into an hcAdmin search object so a query is scoped to the toggle. */
  modeParam: { mode: HomechefMode };
}

const ModeContext = createContext<ModeContextValue | null>(null);

export function HomechefModeProvider({ children }: { children: React.ReactNode }) {
  // Always start live. Reading localStorage during render would desync server
  // and client markup, and defaulting to anything but live risks an admin
  // acting on sandbox data believing it is real.
  const [mode, setModeState] = useState<HomechefMode>("live");

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "test") setModeState("test");
  }, []);

  const setMode = useCallback((m: HomechefMode) => {
    setModeState(m);
    window.localStorage.setItem(STORAGE_KEY, m);
  }, []);

  const value = useMemo(() => ({ mode, setMode, modeParam: { mode } }), [mode, setMode]);

  return (
    <ModeContext.Provider value={value}>
      {mode === "test" && <TestModeBar />}
      {children}
    </ModeContext.Provider>
  );
}

/**
 * Reads the console's active world. Returns live outside a provider so a page
 * that forgets to mount one shows real data rather than silently showing none.
 */
export function useHomechefMode(): ModeContextValue {
  return (
    useContext(ModeContext) ?? {
      mode: "live",
      setMode: () => {},
      modeParam: { mode: "live" },
    }
  );
}

/**
 * Persistent banner while the console is in Test. Deliberately loud and
 * un-dismissable: an admin approving a refund or a payout while believing they
 * are in the real world is the failure this exists to prevent.
 */
function TestModeBar() {
  return (
    <div
      role="status"
      className="sticky top-0 z-50 w-full bg-amber-500 px-4 py-1.5 text-center text-sm font-medium text-amber-950"
    >
      TEST MODE — you are viewing sandbox data. Nothing here is real money.
    </div>
  );
}

/** The Live/Test switch itself, for the console header. */
export function HomechefModeToggle({ className }: { className?: string }) {
  const { mode, setMode } = useHomechefMode();

  return (
    <div
      role="group"
      aria-label="Data mode"
      className={cn("inline-flex items-center rounded-lg border p-0.5 text-xs", className)}
    >
      {(["live", "test"] as const).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => setMode(m)}
          aria-pressed={mode === m}
          className={cn(
            "rounded-md px-2.5 py-1 font-medium capitalize transition-colors",
            mode === m
              ? m === "test"
                ? "bg-amber-500 text-amber-950"
                : "bg-foreground text-background"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {m}
        </button>
      ))}
    </div>
  );
}
