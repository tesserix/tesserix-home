// Palette values sourced from apps/web/app/globals.css's :root block
// (light theme, "Structured Light — paper/ink/cobalt"). console-core owns
// these as plain data so a renderer maps them into its own theming
// mechanism (CSS custom properties on web, a native theme object on
// mobile) instead of each app hand-copying hex values.
export const colors = {
  background: "#f5f7fa",
  foreground: "#0b0e14",
  card: "#ffffff",
  cardForeground: "#0b0e14",
  popover: "#ffffff",
  popoverForeground: "#0b0e14",

  primary: "#0b0e14",
  primaryForeground: "#ffffff",
  secondary: "#eef1f6",
  secondaryForeground: "#3d434f",

  muted: "#eef1f6",
  mutedForeground: "#5f6675",
  accent: "rgba(194, 65, 12, 0.08)",
  accentForeground: "#9a3412",

  destructive: "#dc2626",
  destructiveForeground: "#ffffff",

  border: "rgba(11, 14, 20, 0.10)",
  input: "rgba(11, 14, 20, 0.14)",
  ring: "#c2410c",

  success: "#12a374",
  successForeground: "#ffffff",
  warning: "#925d0e",
  warningForeground: "#ffffff",
  error: "#dc2626",
  errorForeground: "#ffffff",
  info: "#2e5cff",
  infoForeground: "#ffffff",

  chart1: "#0b0e14",
  chart2: "#12a374",
  chart3: "#925d0e",
  chart4: "#2e5cff",
  chart5: "#1f3fd4",

  sidebar: "#0b0e14",
  sidebarForeground: "#cfd4de",
} as const;

// Numeric spacing scale, in px.
export const space = [0, 4, 8, 12, 16, 24, 32, 48, 64] as const;

// Radius ladder, in px, derived from globals.css's --radius: 0.625rem (10px)
// base and its calc() offsets (radius-sm/md/lg/xl/2xl).
export const radius = {
  sm: 6,
  md: 8,
  lg: 10,
  xl: 14,
  "2xl": 18,
} as const;
