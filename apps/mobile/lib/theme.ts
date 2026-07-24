// theme.ts — the Tesserix admin design system, ported from the web admin's
// globals.css (achromatic slate, Stripe/Linear/Vercel). Light + dark, driven by
// the OS. Colors are the exact hex values the web overrides the DS with.

import { useColorScheme } from 'react-native';

const light = {
  background: '#FFFFFF',
  surface: '#FFFFFF',
  surfaceAlt: '#F8FAFC', // muted
  elevated: '#FFFFFF',
  foreground: '#0F172A',
  muted: '#F1F5F9',
  mutedForeground: '#475569',
  border: '#E2E8F0',
  input: '#E2E8F0',
  ring: '#0F172A',
  primary: '#0F172A',
  primaryForeground: '#FFFFFF',
  // The signature dark-navy nav rail.
  sidebar: '#0F172A',
  sidebarForeground: '#E2E8F0',
  sidebarMuted: '#94A3B8',
  sidebarAccent: '#1E293B',
  sidebarBorder: '#1E293B',
  success: '#16A34A',
  successBg: '#DCFCE7',
  successFg: '#166534',
  warning: '#B45309',
  warningBg: '#FEF3C7',
  warningFg: '#92400E',
  destructive: '#DC2626',
  destructiveBg: '#FEE2E2',
  destructiveFg: '#991B1B',
  info: '#2563EB',
  infoBg: '#DBEAFE',
  infoFg: '#1E40AF',
  neutralBg: '#F1F5F9',
  neutralFg: '#334155',
};

const dark: typeof light = {
  background: '#0B1220',
  surface: '#111827',
  surfaceAlt: '#0F172A',
  elevated: '#111827',
  foreground: '#E2E8F0',
  muted: '#1E293B',
  mutedForeground: '#94A3B8',
  border: '#1E293B',
  input: '#1E293B',
  ring: '#94A3B8',
  primary: '#E2E8F0',
  primaryForeground: '#0B1220',
  sidebar: '#0B1220',
  sidebarForeground: '#E2E8F0',
  sidebarMuted: '#94A3B8',
  sidebarAccent: '#1E293B',
  sidebarBorder: '#1E293B',
  success: '#4ADE80',
  successBg: '#14532D',
  successFg: '#BBF7D0',
  warning: '#FBBF24',
  warningBg: '#78350F',
  warningFg: '#FDE68A',
  destructive: '#F87171',
  destructiveBg: '#7F1D1D',
  destructiveFg: '#FECACA',
  info: '#60A5FA',
  infoBg: '#1E3A8A',
  infoFg: '#BFDBFE',
  neutralBg: '#1E293B',
  neutralFg: '#CBD5E1',
};

export type Palette = typeof light;

export const radius = { sm: 6, md: 10, lg: 14, xl: 20, pill: 999 } as const;

export const space = {
  0: 0, 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40, 12: 48, 16: 64,
} as const;

export const font = {
  sans: 'InterTight',
  sansMedium: 'InterTight-Medium',
  sansSemibold: 'InterTight-SemiBold',
  mono: 'JetBrainsMono',
} as const;

export const text = {
  h1: { fontFamily: font.sansSemibold, fontSize: 26, lineHeight: 32 },
  h2: { fontFamily: font.sansSemibold, fontSize: 20, lineHeight: 26 },
  title: { fontFamily: font.sansSemibold, fontSize: 16, lineHeight: 22 },
  body: { fontFamily: font.sans, fontSize: 15, lineHeight: 21 },
  label: { fontFamily: font.sansMedium, fontSize: 13, lineHeight: 18 },
  caption: { fontFamily: font.sans, fontSize: 12, lineHeight: 16 },
  mono: { fontFamily: font.mono, fontSize: 13, lineHeight: 18 },
} as const;

/** Hook: the active palette for the current OS color scheme. */
export function usePalette(): Palette {
  return useColorScheme() === 'dark' ? dark : light;
}

export const palettes = { light, dark };
