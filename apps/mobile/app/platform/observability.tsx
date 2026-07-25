// Observability — distributed-trace summaries across products (read-only).
import { useState } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useObservability } from '../../lib/platform-hooks';
import { formatCount, formatMs, formatPct, formatRelative } from '@tesserix/homechef-shared';
import {
  Screen,
  ScreenHeader,
  BackButton,
  StatGrid,
  StatTile,
  ListRow,
  Badge,
  SectionLabel,
  EmptyState,
  LoadingRows,
  FilterChips,
  type Tone,
} from '../../components/kit';
import { usePalette, space, text } from '../../lib/theme';

const APPS: { key: string; label: string }[] = [
  { key: '', label: 'All' },
  { key: 'mark8ly', label: 'Mark8ly' },
  { key: 'fe3dr', label: 'HomeChef' },
  { key: 'platform', label: 'Platform' },
  { key: 'devai', label: 'DevAI' },
];

const RANGES: { key: string; label: string }[] = [
  { key: '1h', label: '1h' },
  { key: '24h', label: '24h' },
  { key: '7d', label: '7d' },
];

function errTone(rate: number): Tone {
  if (rate >= 5) return 'danger';
  if (rate >= 1) return 'warning';
  return 'success';
}

export default function Observability() {
  const p = usePalette();
  const [range, setRange] = useState('24h');
  const [app, setApp] = useState('');
  const q = useObservability({ range, app });
  const data = q.data;

  return (
    <Screen>
      <ScreenHeader
        title="Observability"
        subtitle="Traces across products"
        right={<BackButton onPress={() => router.back()} />}
      />
      <ScrollView
        contentContainerStyle={{ paddingBottom: space[10], gap: space[4] }}
        refreshControl={
          <RefreshControl refreshing={q.isRefetching} onRefresh={() => q.refetch()} tintColor={p.mutedForeground} />
        }
      >
        <View style={{ gap: space[3] }}>
          <FilterChips options={APPS} value={app} onChange={setApp} />
          <FilterChips options={RANGES} value={range} onChange={setRange} />
        </View>

        {q.isLoading || !data ? (
          <LoadingRows />
        ) : (
          <>
            <StatGrid>
              <StatTile label="Traces" value={formatCount(data.overview.requests)} />
              <StatTile
                label="Error rate"
                value={formatPct(data.overview.errorRate)}
                tone={errTone(data.overview.errorRate)}
              />
              <StatTile label="p95" value={formatMs(data.overview.p95Ms)} />
              <StatTile label="Services" value={formatCount(data.overview.services)} />
            </StatGrid>

            <View style={{ paddingHorizontal: space[4], gap: 8 }}>
              <SectionLabel>By product</SectionLabel>
              {data.byApp.map((row) => (
                <ListRow
                  key={row.app}
                  title={row.app}
                  subtitle={`${formatCount(row.requests)} traces`}
                  meta={formatPct(row.errorRate)}
                  onPress={() => setApp(app === row.app ? '' : row.app)}
                />
              ))}
            </View>

            <View style={{ paddingHorizontal: space[4], gap: 8 }}>
              <SectionLabel>Slowest operations</SectionLabel>
              {data.topSlow.slice(0, 8).map((row, i) => (
                <ListRow key={`${row.service}:${row.op}:${i}`} title={`${row.service} · ${row.op}`} meta={formatMs(row.p95Ms)} />
              ))}
            </View>

            {data.topErrors.length > 0 ? (
              <View style={{ paddingHorizontal: space[4], gap: 8 }}>
                <SectionLabel>Top errors</SectionLabel>
                {data.topErrors.map((row, i) => (
                  <ListRow
                    key={`${row.service}:${row.op}:${i}`}
                    title={`${row.service} · ${row.op}`}
                    trailing={
                      <Text style={[text.mono, { color: p.destructiveFg }]}>{`${row.errors}/${row.count}`}</Text>
                    }
                  />
                ))}
              </View>
            ) : null}

            <View style={{ paddingHorizontal: space[4], gap: 8 }}>
              <SectionLabel>Recent traces</SectionLabel>
              {data.recentTraces.length === 0 ? (
                <EmptyState title="No traces" body="No traces reported for this filter." />
              ) : (
                data.recentTraces.slice(0, 30).map((t, i) => (
                  <ListRow
                    key={`${t.traceId}:${i}`}
                    title={t.op}
                    subtitle={`${t.service} · ${formatRelative(t.ts)}`}
                    meta={formatMs(t.durationMs)}
                    trailing={<Badge label={t.status} tone={t.status === 'Error' ? 'danger' : 'success'} />}
                    onPress={() => router.push(`/platform/trace/${t.traceId}`)}
                  />
                ))
              )}
            </View>
          </>
        )}
      </ScrollView>
    </Screen>
  );
}
