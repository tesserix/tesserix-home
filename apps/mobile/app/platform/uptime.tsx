// Uptime — synthetic probe results per tenant endpoint over a rolling window.
import { useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useUptime } from '../../lib/platform-hooks';
import type { UptimeRow } from '../../lib/platform-contracts';
import { formatCount, formatMs, formatRatioPct, formatRelative } from '@tesserix/homechef-shared';
import {
  Screen,
  ScreenHeader,
  BackButton,
  Card,
  StatGrid,
  StatTile,
  Metric,
  StatusDot,
  Badge,
  EmptyState,
  LoadingRows,
  FilterChips,
  type Tone,
} from '../../components/kit';
import { usePalette, space, text } from '../../lib/theme';

const WINDOWS: { key: string; label: string }[] = [
  { key: '1', label: '1h' },
  { key: '6', label: '6h' },
  { key: '24', label: '24h' },
  { key: '168', label: '7d' },
];

function uptimeTone(ratio: number): Tone {
  if (ratio >= 0.999) return 'success';
  if (ratio >= 0.99) return 'warning';
  return 'danger';
}

export default function Uptime() {
  const [hours, setHours] = useState(24);
  const q = useUptime(hours);
  const rows = q.data?.rows ?? [];

  const totalProbes = rows.reduce((a, r) => a + r.probes, 0);
  const totalSucc = rows.reduce((a, r) => a + r.successes, 0);
  const overall = totalProbes > 0 ? totalSucc / totalProbes : 0;
  const downNow = rows.filter((r) => !r.last_ok).length;
  const slowest = rows.reduce((m, r) => Math.max(m, r.p95_latency_ms ?? 0), 0);

  return (
    <Screen>
      <ScreenHeader
        title="Uptime"
        subtitle="Tenant endpoint probes"
        right={<BackButton onPress={() => router.back()} />}
      />
      {q.isLoading ? (
        <LoadingRows />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => `${r.product_id}:${r.hostname}`}
          contentContainerStyle={{ gap: 10, paddingBottom: space[10] }}
          refreshing={q.isRefetching}
          onRefresh={() => q.refetch()}
          ListHeaderComponent={
            <View style={{ gap: space[3] }}>
              <StatGrid>
                <StatTile label="Tenants tracked" value={formatCount(rows.length)} />
                <StatTile label="Overall uptime" value={formatRatioPct(overall)} tone={uptimeTone(overall)} />
                <StatTile label="Down now" value={formatCount(downNow)} tone={downNow > 0 ? 'danger' : 'neutral'} />
                <StatTile label="Slowest p95" value={formatMs(slowest)} />
              </StatGrid>
              <FilterChips options={WINDOWS} value={String(hours)} onChange={(k) => setHours(Number(k))} />
            </View>
          }
          ListEmptyComponent={<EmptyState title="No probes" body="No endpoints have been probed in this window." />}
          renderItem={({ item }) => <UptimeCard r={item} />}
        />
      )}
    </Screen>
  );
}

function UptimeCard({ r }: { r: UptimeRow }) {
  const p = usePalette();
  return (
    <View style={{ paddingHorizontal: space[4] }}>
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Text style={[text.title, { color: p.foreground }]} numberOfLines={1}>
              {r.hostname}
            </Text>
            <View style={{ marginTop: 4 }}>
              <Badge label={r.product_id} tone="info" />
            </View>
          </View>
          <StatusDot tone={r.last_ok ? 'success' : 'danger'} />
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16, marginTop: 12 }}>
          <Metric label="Uptime" value={formatRatioPct(r.uptime)} tone={uptimeTone(r.uptime)} />
          <Metric label="p50" value={formatMs(r.p50_latency_ms)} />
          <Metric label="p95" value={formatMs(r.p95_latency_ms)} />
          <Metric label="Probes" value={`${r.successes}/${r.probes}`} />
          <Metric label="Last probed" value={formatRelative(r.last_probed_at)} />
        </View>
        {!r.last_ok && r.last_error ? (
          <Text style={[text.caption, { color: p.destructiveFg, marginTop: 8 }]} numberOfLines={2}>
            {r.last_error}
          </Text>
        ) : null}
      </Card>
    </View>
  );
}
