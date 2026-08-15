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
