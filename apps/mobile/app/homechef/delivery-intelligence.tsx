import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useDeliveryIntelligence } from '../../lib/hooks';
import { formatINR, formatCount, titleCase } from '@tesserix/homechef-shared';
import { BackButton, Card, LoadingRows, Metric, Screen, ScreenHeader, SectionLabel, StatGrid, StatTile } from '../../components/kit';
import { usePalette, space, text } from '../../lib/theme';

function usd(n: number | null | undefined): string {
  const v = typeof n === 'number' && isFinite(n) ? n : 0;
  return `$${v.toFixed(v < 1 ? 4 : 2)}`;
}
function pct(ratio: number | null | undefined): string {
  const v = typeof ratio === 'number' && isFinite(ratio) ? ratio : 0;
  return `${(v * 100).toFixed(1)}%`;
}

export default function DeliveryIntelligence() {
  const p = usePalette();
  const q = useDeliveryIntelligence();
  const data = q.data;
  const u = data?.usage;

  return (
    <Screen>
      <ScreenHeader title="Delivery intelligence" subtitle="Pricing cost & usage · live" right={<BackButton onPress={() => router.back()} />} />
      {q.isLoading ? (
        <LoadingRows />
      ) : !data ? (
        <Text style={[text.body, { color: p.mutedForeground, padding: space[4] }]}>No delivery-intelligence data yet.</Text>
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: space[10], gap: space[4] }}
          refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => q.refetch()} />}
        >
          <View style={{ paddingHorizontal: space[4] }}><SectionLabel>Requests (since restart)</SectionLabel></View>
          <StatGrid>
            <StatTile label="Cache hit ratio" value={pct(u?.distanceCacheHitRatio)} />
            <StatTile label="Paid routing" value={formatCount(u?.distanceProviderCalls)} />
            <StatTile label="Cache hits (free)" value={formatCount((u?.distanceHotHits ?? 0) + (u?.distanceDurableHits ?? 0))} />
            <StatTile label="Weather calls" value={formatCount(u?.weatherProviderCalls)} />
            <StatTile label="Fuel-index calls" value={formatCount(u?.fuelProviderCalls)} />
            <StatTile label="Traffic calls" value={formatCount(u?.trafficProviderCalls)} />
          </StatGrid>

          <View style={{ paddingHorizontal: space[4] }}><SectionLabel>Expenses</SectionLabel></View>
          <StatGrid>
            <StatTile label="Spend since restart" value={usd(u?.estimatedSpendUsd)} />
            <StatTile label="All-time distance" value={usd(data.allTimeDistanceSpendUsd)} />
            <StatTile label="Routing $/call" value={usd(u?.distancePricePerCall)} />
            <StatTile label="Weather $/call" value={usd(u?.weatherPricePerCall)} />
          </StatGrid>

          <View style={{ paddingHorizontal: space[4] }}><SectionLabel>Zone pricing by tier ({data.zoneTiers.length})</SectionLabel></View>
          <View style={{ paddingHorizontal: space[4], gap: 8 }}>
            {data.zoneTiers.length === 0 ? (
              <Text style={[text.caption, { color: p.mutedForeground }]}>No delivery zones configured yet.</Text>
            ) : (
              data.zoneTiers.map((t) => (
                <Card key={t.tier}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 }}>
                    <Text style={[text.title, { color: p.foreground }]}>{titleCase(t.tier)}</Text>
                    <Text style={[text.caption, { color: p.mutedForeground }]}>{t.activeZoneCount}/{t.count} active</Text>
                  </View>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
                    <Metric label="Base fare" value={formatINR(t.avgBaseFare)} />
                    <Metric label="Per km" value={formatINR(t.avgPerKmRate)} />
                    <Metric label="Minimum" value={formatINR(t.avgMinimumFare)} />
                    <Metric label="Surge" value={`${t.avgSurgeMultiplier.toFixed(2)}×`} />
                  </View>
                </Card>
              ))
            )}
          </View>

          <Text style={[text.caption, { color: p.mutedForeground, paddingHorizontal: space[4] }]}>
            Live counters reset on API restart. Auto-refreshes every 30s.
          </Text>
        </ScrollView>
      )}
    </Screen>
  );
}
