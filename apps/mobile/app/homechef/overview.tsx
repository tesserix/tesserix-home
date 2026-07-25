import { RefreshControl, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { useProductKpis, useProductMetrics } from '../../lib/platform-hooks';
import { formatINR, formatCount, formatBytes } from '@tesserix/homechef-shared';
import { BackButton, Banner, LoadingRows, Screen, ScreenHeader, SectionLabel, StatGrid, StatTile } from '../../components/kit';
import { space } from '../../lib/theme';

const PRODUCT = 'homechef';

export default function Overview() {
  const kpis = useProductKpis(PRODUCT);
  const metrics = useProductMetrics(PRODUCT);
  const k = kpis.data;
  const res = metrics.data?.resources;
  const refreshing = kpis.isRefetching || metrics.isRefetching;
  const refetchAll = () => { kpis.refetch(); metrics.refetch(); };
  const num = (key: string): number | undefined => (k && key in k ? k[key] : undefined);

  return (
    <Screen>
      <ScreenHeader title="HomeChef" subtitle="Overview" right={<BackButton onPress={() => router.back()} />} />
      {kpis.isLoading || metrics.isLoading ? (
        <LoadingRows />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: space[10], gap: space[4] }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refetchAll} />}
        >
          {kpis.isError ? (
            <View style={{ paddingHorizontal: space[4] }}>
              <Banner text="Some data could not be loaded." tone="danger" />
            </View>
          ) : null}

          <View style={{ paddingHorizontal: space[4] }}><SectionLabel>Business</SectionLabel></View>
          <StatGrid>
            <StatTile label="Active chefs" value={formatCount(num('chefs_active'))} />
            <StatTile label="Orders today" value={formatCount(num('orders_today'))} />
            <StatTile label="GMV today" value={formatINR(num('gmv_today'))} />
            <StatTile label="Pending approvals" value={formatCount(num('approvals_pending'))} tone={num('approvals_pending') ? 'warning' : 'neutral'} />
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
