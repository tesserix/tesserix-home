// Window helpers shared by the metrics aggregators.

import type { CostWindow } from "./opencost";

export type Window = CostWindow;

export const WINDOW_SECONDS: Readonly<Record<Window, number>> = {
  "1h": 3_600,
  "24h": 86_400,
  "7d": 604_800,
  "30d": 2_592_000,
};

// Sparkline step sized so each window resolves to ~60-300 points —
// dense enough to show shape, sparse enough to keep Prometheus happy.
export const SPARKLINE_STEP_SECONDS: Readonly<Record<Window, number>> = {
  "1h": 60,
  "24h": 300,
  "7d": 3_600,
  "30d": 21_600,
};

export interface SparklinePoint {
  readonly t: number; // ms epoch
  readonly v: number;
}

export function isValidWindow(w: string): w is Window {
  return w === "1h" || w === "24h" || w === "7d" || w === "30d";
}
