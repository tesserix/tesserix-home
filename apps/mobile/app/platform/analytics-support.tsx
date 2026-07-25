// Support analytics — Otto cross-tenant support rollup (KPIs + breakdowns).
import { ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useSupportAnalytics } from '../../lib/platform-hooks';
import { formatCount, formatDuration, formatRatioPct } from '@tesserix/homechef-shared';
import {
  Screen, ScreenHeader, BackButton, Card, StatGrid, StatTile, SectionLabel, EmptyState, LoadingRows,
} from '../../components/kit';
import { usePalette, space, text } from '../../lib/theme';

type Row = { label: string; value: number };

function toRows(m: Record<string, number> | undefined, rename?: (k: string) => string): Row[] {
  if (!m) return [];
  return Object.entries(m)
    .map(([k, v]) => ({ label: rename ? rename(k) : k, value: v }))
    .sort((a, b) => b.value - a.value);
}

function RankedList({ title, rows }: { title: string; rows: Row[] }) {
  const p = usePalette();
  const max = rows.reduce((a, r) => Math.max(a, r.value), 0) || 1;
  return (
    <View style={{ paddingHorizontal: space[4] }}>
      <SectionLabel>{title}</SectionLabel>
      {rows.length === 0 ? (
        <Card><EmptyState title="No data" /></Card>
      ) : (
        <View style={{ gap: 8 }}>
          {rows.map((r) => (
            <Card key={r.label}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={[text.body, { color: p.foreground, flex: 1 }]} numberOfLines={1}>{r.label}</Text>
                <Text style={[text.mono, { color: p.mutedForeground }]}>{formatCount(r.value)}</Text>
              </View>
              <View style={{ height: 4, borderRadius: 2, backgroundColor: p.muted, marginTop: 8 }}>
                <View style={{ height: 4, borderRadius: 2, width: `${(r.value / max) * 100}%`, backgroundColor: p.foreground }} />
              </View>
            </Card>
          ))}
        </View>
      )}
    </View>
  );
}

export default function SupportAnalytics() {
  const p = usePalette();
  const q = useSupportAnalytics();
  const d = q.data;

  return (
    <Screen>
      <ScreenHeader title="Support analytics" subtitle="Otto rollup" right={<BackButton onPress={() => router.back()} />} />
      {q.isLoading ? (
        <LoadingRows />
      ) : !d ? (
        <Card><EmptyState title="Unavailable" body="Support analytics could not be loaded." /></Card>
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: space[10], gap: space[4] }}>
          <StatGrid>
            <StatTile label="Total" value={formatCount(d.total)} />
            <StatTile label="Open" value={formatCount(d.open)} tone={d.open > 0 ? 'info' : 'neutral'} />
            <StatTile label="AI-resolved" value={formatCount(d.ai_resolved)} tone={d.ai_resolved > 0 ? 'success' : 'neutral'} />
            <StatTile label="Escalated" value={formatCount(d.escalated)} tone={d.escalated > 0 ? 'warning' : 'neutral'} />
            <StatTile label="Avg resolution" value={formatDuration(d.avg_resolution_seconds)} />
            <StatTile label="CSAT" value={d.csat ? `${d.csat.toFixed(1)} / 5` : '—'} />
            <StatTile label="Resolved rate" value={d.feedback_count ? formatRatioPct(d.resolved_rate) : '—'} />
            <StatTile label="Feedback" value={formatCount(d.feedback_count)} />
          </StatGrid>
          <RankedList title="By status" rows={toRows(d.by_status)} />
          <RankedList title="By reason" rows={toRows(d.by_reason)} />
          <RankedList title="By tenant" rows={toRows(d.by_tenant, (id) => d.tenant_names?.[id] ?? id)} />
        </ScrollView>
      )}
    </Screen>
  );
}
