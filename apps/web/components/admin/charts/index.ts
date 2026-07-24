// Admin analytics chart kit — recharts v3 + @tesserix/web Card, design-token themed.

export { ChartCard } from "./chart-card";
export type { ChartCardProps } from "./chart-card";

export { BarChartCard } from "./bar-chart-card";
export type { BarChartCardProps } from "./bar-chart-card";

export { LineChartCard } from "./line-chart-card";
export type { LineChartCardProps } from "./line-chart-card";

export { AreaChartCard } from "./area-chart-card";
export type { AreaChartCardProps } from "./area-chart-card";

export { DonutChartCard } from "./donut-chart-card";
export type { DonutChartCardProps, DonutSlice } from "./donut-chart-card";

export { AnalyticsShell } from "./analytics-shell";
export type { AnalyticsShellProps } from "./analytics-shell";

export { KpiCard } from "./kpi-card";
export type { KpiCardProps, KpiTone } from "./kpi-card";

export {
  CHART_PALETTE,
  CHART_TOKEN_COUNT,
  chartColor,
  seriesColor,
  defaultValueFormat,
} from "./chart-theme";
export type { ChartSeries } from "./chart-theme";

export { ChartLegend, ChartEmpty, ChartLoading } from "./chart-primitives";
export type { ChartTooltipEntry } from "./chart-primitives";
