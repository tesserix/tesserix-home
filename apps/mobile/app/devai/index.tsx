// devai/index.tsx — DevAI product overview (read-only). DevAI has no product-owned
// data model in tesserix-home; this mirrors the generic per-product KPI + resource
// tiles via the `plat` client. SRE/ALM KPIs (requests/errors/p95/incidents), not
// commerce ones. The "critical events" audit tile is intentionally omitted — that
// endpoint is a global unscoped audit table, so incidents_open is the real signal.
import { RefreshControl, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { useProductKpis, useProductMetrics } from '../../lib/platform-hooks';
import { formatCount, formatMs, formatBytes } from '@tesserix/homechef-shared';
import { BackButton, Banner, LoadingRows, Screen, ScreenHeader, SectionLabel, StatGrid, StatTile } from '../../components/kit';
import { space } from '../../lib/theme';

const PRODUCT = 'devai';

export default function DevAIOverview() {
  const kpis = useProductKpis(PRODUCT);
  const metrics = useProductMetrics(PRODUCT);
  const k = kpis.data;
  const res = metrics.data?.resources;
  const refreshing = kpis.isRefetching || metrics.isRefetching;
  const refetchAll = () => { kpis.refetch(); metrics.refetch(); };
  const num = (key: string): number | undefined => (k && key in k ? k[key] : undefined);

  const errors = num('errors_24h');
  const incidents = num('incidents_open');

  return (
    <Screen>
      <ScreenHeader title="DevAI" subtitle="Overview" right={<BackButton onPress={() => router.back()} />} />
      {kpis.isLoading || metrics.isLoading ? (
        <LoadingRows />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: space[10], gap: space[4] }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refetchAll} />}
        >
          {kpis.isError || metrics.isError ? (
            <View style={{ paddingHorizontal: space[4] }}>
              <Banner text="Some data could not be loaded." tone="danger" />
            </View>
          ) : null}

          <View style={{ paddingHorizontal: space[4] }}><SectionLabel>Reliability (24h)</SectionLabel></View>
          <StatGrid>
            <StatTile label="Requests" value={formatCount(num('requests_24h'))} />
            <StatTile label="Errors" value={formatCount(errors)} tone={errors ? 'danger' : 'neutral'} />
            <StatTile label="p95 latency" value={formatMs(num('p95_ms'))} />
            <StatTile label="Open incidents" value={formatCount(incidents)} tone={incidents ? 'warning' : 'neutral'} />
          </StatGrid>

          <View style={{ paddingHorizontal: space[4] }}><SectionLabel>Resources (24h)</SectionLabel></View>
          <StatGrid>
            <StatTile label="CPU" value={res?.cpu ? `${formatCount(res.cpu.current)} cores` : '—'} />
            <StatTile label="Memory" value={res?.memory ? formatBytes(res.memory.current) : '—'} />
          </StatGrid>
        </ScrollView>
      )}
    </Screen>
  );
}
