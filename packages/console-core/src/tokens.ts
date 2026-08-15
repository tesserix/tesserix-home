// Neutral operator palette: one grey ramp, no brand hue.
//
// Colour appears only where it carries meaning — the semantic states and
// severity — so nothing competes with them for attention. Selection and
// emphasis read as contrast (ink on paper) rather than a tint. The single
// exception is the focus ring, which has to be unmistakable.
//
// These values are NOT apps/web's. The console deliberately diverged from
// web's "Structured Light — paper/ink/cobalt" palette, which was approved for
// the marketing site and rejected for an operator console. Do not "resync"
// them; apps/web does not consume this package.
//
// console-core owns these as plain data so a renderer maps them into its own
// theming mechanism (CSS custom properties on web, a native theme object on
// mobile) instead of each app hand-copying hex values. apps/console mirrors
// them into globals.css, and globals.test.ts fails if the two diverge.
export const colors = {
  background: "#fafafa",
  foreground: "#18181b",
  card: "#ffffff",
  cardForeground: "#18181b",
  popover: "#ffffff",
  popoverForeground: "#18181b",

  // Selection and emphasis read as CONTRAST, not hue — ink on paper. This is
  // what keeps a single accent from competing with the semantic colours below.
  primary: "#18181b",
  primaryForeground: "#ffffff",
  secondary: "#f4f4f5",
  secondaryForeground: "#52525b",

  muted: "#f4f4f5",
  mutedForeground: "#52525b",
  // Tertiary text — captions, timestamps, the quiet half of a label pair. A
  // third step is what stops secondary text being overloaded for both roles.
  foregroundSubtle: "#8b8b93",
  accent: "#efeff1",
  accentForeground: "#18181b",

  destructive: "#b0322a",
  destructiveForeground: "#ffffff",

  border: "#e4e4e7",
  input: "#d4d4d8",
  // The one chromatic exception: a focus ring must be unmistakable, and a grey
  // ring fails that at any contrast level.
  ring: "#3b6fd4",

  // Semantic only. These are the sole place colour carries meaning, which is
  // why nothing else in the ramp is allowed a hue.
  success: "#2f7d51",
  successForeground: "#ffffff",
  warning: "#8a6108",
  warningForeground: "#ffffff",
  error: "#b0322a",
  errorForeground: "#ffffff",
  // Soft fills for pills, badges and state tiles. Saturated enough to read as
  // the state, pale enough that a row of them does not shout.
  successSoft: "#eef6f0",
  warningSoft: "#fbf4e4",
  errorSoft: "#fbedec",
  info: "#3b6fd4",
  infoForeground: "#ffffff",

  chart1: "#18181b",
  chart2: "#2f7d51",
  chart3: "#8a6108",
  chart4: "#3b6fd4",
  chart5: "#52525b",

  sidebar: "#17181b",
  sidebarForeground: "#d6d7db",
  sidebarPrimary: "#fafafa",
  sidebarPrimaryForeground: "#17181b",
  sidebarAccent: "#26272c",
  sidebarAccentForeground: "#ececee",
  sidebarBorder: "#26272c",
} as const;

/**
 * Dark palette. Same key set as `colors` — every token has a dark counterpart,
 * enforced by the drift test, so a renderer can swap the whole map without
 * discovering a hole at runtime.
 *
 * Not a naive inversion. The ground darkens further than the surfaces so cards
 * still read as raised; the accents lighten so they hold contrast against a
 * dark ground rather than disappearing into it.
 */
export const colorsDark: Record<keyof typeof colors, string> = {
  background: "#0c0d0f",
  foreground: "#ececee",
  card: "#141518",
  cardForeground: "#ececee",
  popover: "#141518",
  popoverForeground: "#ececee",

  primary: "#ececee",
  primaryForeground: "#141518",
  secondary: "#1b1d21",
  secondaryForeground: "#a4a5ad",

  muted: "#1b1d21",
  mutedForeground: "#a4a5ad",
  foregroundSubtle: "#77787f",
  accent: "#1f2126",
  accentForeground: "#ececee",

  destructive: "#e08a83",
  destructiveForeground: "#141518",

  border: "#26282d",
  input: "#33353b",
  ring: "#7ba0e8",

  success: "#63b585",
  successForeground: "#141518",
  warning: "#cfa049",
  warningForeground: "#141518",
  error: "#e08a83",
  errorForeground: "#141518",
  info: "#7ba0e8",
  infoForeground: "#141518",
  successSoft: "#16241c",
  warningSoft: "#262013",
  errorSoft: "#291817",

  chart1: "#ececee",
  chart2: "#63b585",
  chart3: "#cfa049",
  chart4: "#7ba0e8",
  chart5: "#a4a5ad",

  sidebar: "#0f1013",
  sidebarForeground: "#c9cad0",
  sidebarPrimary: "#ececee",
  sidebarPrimaryForeground: "#0f1013",
  sidebarAccent: "#232529",
  sidebarAccentForeground: "#ececee",
  sidebarBorder: "#232529",
};

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
