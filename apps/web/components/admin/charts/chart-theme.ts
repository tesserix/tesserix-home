// Shared theming primitives for the admin recharts kit.
//
// Colours come from the design-token CSS variables defined in app/globals.css
// (`--chart-1` .. `--chart-5`). These are already light/dark-mode aware — the
// `.dark` selector overrides each variable — so referencing the variable keeps
// every chart automatically themed without per-component logic.

export const CHART_TOKEN_COUNT = 5;

/** CSS color string for a 1-indexed chart token, wrapping around 1..5. */
export function chartColor(index: number): string {
  const slot = ((index - 1) % CHART_TOKEN_COUNT + CHART_TOKEN_COUNT) % CHART_TOKEN_COUNT;
  return `var(--chart-${slot + 1})`;
}

/** The full ordered palette as CSS variable references. */
export const CHART_PALETTE: readonly string[] = Array.from(
  { length: CHART_TOKEN_COUNT },
  (_, i) => `var(--chart-${i + 1})`,
);

/**
 * One plotted measure. `dataKey` must match a numeric field on each data row.
 * `color` overrides the auto-assigned palette slot.
 */
export interface ChartSeries {
  /** Field on each data row holding this series' numeric value. */
  dataKey: string;
  /** Human label shown in legend/tooltip. Falls back to `dataKey`. */
  name?: string;
  /** Explicit CSS color. Defaults to the palette slot for the series index. */
  color?: string;
  /** Per-series value formatter for tooltip display. */
  formatValue?: (value: number) => string;
}

/** Resolve the color for a series at a given position. */
export function seriesColor(series: ChartSeries, index: number): string {
  return series.color ?? chartColor(index + 1);
}

/** Shared recharts axis/grid styling, expressed via currentColor + opacity. */
export const AXIS_TICK_STYLE = {
  fontSize: 11,
  fill: "var(--color-muted-foreground, currentColor)",
} as const;

export const GRID_STROKE = "var(--color-border, currentColor)";

/** Default numeric formatter used when a series omits `formatValue`. */
export function defaultValueFormat(value: number): string {
  if (value == null || Number.isNaN(value)) return "—";
  if (Math.abs(value) >= 1000) return value.toLocaleString();
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2);
}
