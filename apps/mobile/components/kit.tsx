// kit.tsx — the Tesserix admin component vocabulary, native. Hairline-bordered
// surfaces, one navy accent, tabular numerals for stats, restrained motion.
// Everything reads from the theme so light/dark just work.

import { type ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ChevronLeft, ChevronRight, type LucideIcon } from 'lucide-react-native';
import { radius, space, text, usePalette, type Palette } from '../lib/theme';

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

function toneColors(p: Palette, tone: Tone): { bg: string; fg: string } {
  switch (tone) {
    case 'success': return { bg: p.successBg, fg: p.successFg };
    case 'warning': return { bg: p.warningBg, fg: p.warningFg };
    case 'danger': return { bg: p.destructiveBg, fg: p.destructiveFg };
    case 'info': return { bg: p.infoBg, fg: p.infoFg };
    default: return { bg: p.neutralBg, fg: p.neutralFg };
  }
}

export function Screen({ children }: { children: ReactNode }) {
  const p = usePalette();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: p.background }} edges={['top', 'left', 'right']}>
      {children}
    </SafeAreaView>
  );
}

export function ScreenHeader({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
}) {
  const p = usePalette();
  return (
    <View style={styles.header}>
      <View style={{ flex: 1 }}>
        <Text style={[text.h1, { color: p.foreground }]}>{title}</Text>
        {subtitle ? <Text style={[text.body, { color: p.mutedForeground, marginTop: 2 }]}>{subtitle}</Text> : null}
      </View>
      {right}
    </View>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const p = usePalette();
  return (
    <View style={[styles.card, { backgroundColor: p.surface, borderColor: p.border }, style]}>{children}</View>
  );
}

/** A big KPI number with a label. Tabular figures, quiet label. */
export function StatCard({ label, value, tone }: { label: string; value: string; tone?: Tone }) {
  const p = usePalette();
  const accent = tone ? toneColors(p, tone).fg : p.foreground;
  return (
    <Card style={{ flex: 1, minWidth: 150 }}>
      <Text style={[text.caption, { color: p.mutedForeground, textTransform: 'uppercase', letterSpacing: 0.4 }]}>
        {label}
      </Text>
      <Text style={{ fontFamily: 'InterTight-SemiBold', fontSize: 28, color: accent, marginTop: 6, fontVariant: ['tabular-nums'] }}>
        {value}
      </Text>
    </Card>
  );
}

/** Wraps StatCards into a responsive, gapped grid (2-per-row on phones). */
export function StatGrid({ children }: { children: ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, paddingHorizontal: space[4] }}>
      {children}
    </View>
  );
}

/** A compact KPI tile (smaller than StatCard) for dense metric grids. */
export function StatTile({ label, value, tone }: { label: string; value: string; tone?: Tone }) {
  const p = usePalette();
  const accent = tone ? toneColors(p, tone).fg : p.foreground;
  return (
    <Card style={{ flexGrow: 1, flexBasis: '30%', minWidth: 96, padding: space[3] }}>
      <Text style={{ fontFamily: 'InterTight-SemiBold', fontSize: 22, color: accent, fontVariant: ['tabular-nums'] }}>
        {value}
      </Text>
      <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]} numberOfLines={1}>
        {label}
      </Text>
    </Card>
  );
}

/** A small label-over-value pair used inside detail/metric cards. */
export function Metric({ label, value, tone }: { label: string; value: string; tone?: Tone }) {
  const p = usePalette();
  const color = tone ? toneColors(p, tone).fg : p.foreground;
  return (
    <View style={{ minWidth: 88 }}>
      <Text style={[text.caption, { color: p.mutedForeground }]}>{label}</Text>
      <Text style={{ fontFamily: 'InterTight-Medium', fontSize: 15, color, marginTop: 2, fontVariant: ['tabular-nums'] }}>
        {value}
      </Text>
    </View>
  );
}

/** A colored status dot. */
export function StatusDot({ tone }: { tone: Tone }) {
  const p = usePalette();
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: toneColors(p, tone).fg }} />;
}

/** An inline alert banner (warnings, "N need attention", "metrics unavailable"). */
export function Banner({ text: msg, tone = 'warning' }: { text: string; tone?: Tone }) {
  const p = usePalette();
  const c = toneColors(p, tone);
  return (
    <View style={{ marginHorizontal: space[4], marginBottom: space[3], padding: space[3], borderRadius: radius.md, backgroundColor: c.bg }}>
      <Text style={{ fontFamily: 'InterTight-Medium', fontSize: 13, color: c.fg }}>{msg}</Text>
    </View>
  );
}

/** A back chevron for detail-screen headers (use in ScreenHeader `right`/left). */
export function BackButton({ onPress }: { onPress: () => void }) {
  const p = usePalette();
  return (
    <Pressable onPress={onPress} hitSlop={12} style={{ paddingTop: 4, paddingRight: 8 }}>
      <ChevronLeft size={24} color={p.mutedForeground} />
    </Pressable>
  );
}

export function Badge({ label, tone = 'neutral' }: { label: string; tone?: Tone }) {
  const p = usePalette();
  const c = toneColors(p, tone);
  return (
    <View style={[styles.badge, { backgroundColor: c.bg }]}>
      <Text style={{ fontFamily: 'InterTight-Medium', fontSize: 12, color: c.fg }}>{label}</Text>
    </View>
  );
}

/** A tappable list row: title + subtitle, optional leading icon + trailing (badge/chevron). */
export function ListRow({
  title,
  subtitle,
  meta,
  icon: Icon,
  trailing,
  onPress,
}: {
  title: string;
  subtitle?: string;
  meta?: string;
  icon?: LucideIcon;
  trailing?: ReactNode;
  onPress?: () => void;
}) {
  const p = usePalette();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        { borderColor: p.border, backgroundColor: pressed ? p.muted : p.surface },
      ]}
    >
      {Icon ? (
        <View style={[styles.rowIcon, { backgroundColor: p.muted }]}>
          <Icon size={18} color={p.mutedForeground} />
        </View>
      ) : null}
      <View style={{ flex: 1 }}>
        <Text style={[text.title, { color: p.foreground }]} numberOfLines={1}>{title}</Text>
        {subtitle ? (
          <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]} numberOfLines={1}>{subtitle}</Text>
        ) : null}
      </View>
      {meta ? <Text style={[text.mono, { color: p.mutedForeground }]}>{meta}</Text> : null}
      {trailing ?? (onPress ? <ChevronRight size={18} color={p.mutedForeground} /> : null)}
    </Pressable>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  const p = usePalette();
  return (
    <Text style={[text.label, { color: p.mutedForeground, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }]}>
      {children}
    </Text>
  );
}

export function EmptyState({ title, body }: { title: string; body?: string }) {
  const p = usePalette();
  return (
    <View style={styles.empty}>
      <Text style={[text.title, { color: p.foreground }]}>{title}</Text>
      {body ? <Text style={[text.body, { color: p.mutedForeground, textAlign: 'center', marginTop: 4 }]}>{body}</Text> : null}
    </View>
  );
}

export function LoadingRows({ rows = 6 }: { rows?: number }) {
  const p = usePalette();
  return (
    <View style={{ gap: 10, paddingHorizontal: space[4] }}>
      {Array.from({ length: rows }).map((_, i) => (
        <View key={i} style={{ height: 60, borderRadius: radius.md, backgroundColor: p.muted, opacity: 1 - i * 0.08 }} />
      ))}
    </View>
  );
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  loading,
  disabled,
  tone,
}: {
  label: string;
  onPress?: () => void;
  variant?: 'primary' | 'secondary' | 'ghost';
  loading?: boolean;
  disabled?: boolean;
  tone?: 'default' | 'danger';
}) {
  const p = usePalette();
  const isPrimary = variant === 'primary';
  const bg = isPrimary ? (tone === 'danger' ? p.destructive : p.primary) : variant === 'secondary' ? p.muted : 'transparent';
  const fg = isPrimary ? p.primaryForeground : tone === 'danger' ? p.destructive : p.foreground;
  const dim = disabled || loading;
  return (
    <Pressable
      onPress={dim ? undefined : onPress}
      style={({ pressed }) => [
        styles.btn,
        { backgroundColor: bg, borderColor: variant === 'ghost' ? 'transparent' : p.border, opacity: dim ? 0.5 : pressed ? 0.85 : 1 },
      ]}
    >
      {loading ? <ActivityIndicator color={fg} size="small" /> : <Text style={{ fontFamily: 'InterTight-SemiBold', fontSize: 15, color: fg }}>{label}</Text>}
    </Pressable>
  );
}

export function SearchField({ value, onChangeText, placeholder }: { value: string; onChangeText: (t: string) => void; placeholder?: string }) {
  const p = usePalette();
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder ?? 'Search'}
      placeholderTextColor={p.mutedForeground}
      style={[styles.search, { backgroundColor: p.muted, color: p.foreground, borderColor: p.border }]}
      autoCapitalize="none"
      autoCorrect={false}
    />
  );
}

export function FilterChips<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { key: T; label: string }[];
  value: T;
  onChange: (k: T) => void;
}) {
  const p = usePalette();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingHorizontal: space[4] }}>
      {options.map((o) => {
        const active = o.key === value;
        return (
          <Pressable
            key={o.key}
            onPress={() => onChange(o.key)}
            style={[styles.chip, { borderColor: active ? p.primary : p.border, backgroundColor: active ? p.primary : 'transparent' }]}
          >
            <Text style={{ fontFamily: 'InterTight-Medium', fontSize: 13, color: active ? p.primaryForeground : p.mutedForeground }}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: space[4], paddingTop: space[3], paddingBottom: space[4] },
  card: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, padding: space[4] },
  badge: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: radius.pill, alignSelf: 'flex-start' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: space[4], paddingVertical: 12, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth },
  rowIcon: { width: 36, height: 36, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  empty: { padding: space[8], alignItems: 'center', gap: 4 },
  btn: { height: 48, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space[5] },
  search: { height: 44, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, fontFamily: 'InterTight', fontSize: 15 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth },
});
