// Mark8ly overview — scalar revenue + business KPIs (no sparklines/cost).
import { RefreshControl, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { usePlatformDashboard } from '../../lib/platform-hooks';
import { useRevenue, useCriticalCount } from '../../lib/mark8ly-hooks';
import { formatCount, formatRatioPct } from '@tesserix/homechef-shared';
import {
  Screen, ScreenHeader, BackButton, StatGrid, StatTile, SectionLabel, LoadingRows, Banner,
} from '../../components/kit';
import { space } from '../../lib/theme';

function money(currency: string, n: number): string {
  return `${currency} ${formatCount(n)}`;
}

export default function Mark8lyOverview() {
  const dash = usePlatformDashboard();
  const rev = useRevenue(30);
  const crit = useCriticalCount();
  const r = rev.data;
  const d = dash.data;
  const refreshing = rev.isRefetching || dash.isRefetching || crit.isRefetching;
  const refetchAll = () => { rev.refetch(); dash.refetch(); crit.refetch(); };

  return (
    <Screen>
      <ScreenHeader title="Mark8ly" subtitle="Overview" right={<BackButton onPress={() => router.back()} />} />
      {rev.isLoading || dash.isLoading || crit.isLoading ? (
        <LoadingRows />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: space[10], gap: space[4] }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refetchAll} />}
        >
          {rev.isError || dash.isError || crit.isError ? (
            <View style={{ paddingHorizontal: space[4] }}>
              <Banner text="Some data could not be loaded." tone="danger" />
            </View>
          ) : null}
          <View style={{ paddingHorizontal: space[4] }}><SectionLabel>Revenue</SectionLabel></View>
          <StatGrid>
            <StatTile label="MRR" value={r ? money(r.currency, r.mrr) : '—'} />
            <StatTile label="ARR" value={r ? money(r.currency, r.arr) : '—'} />
            <StatTile label="Trials 30d" value={r ? formatCount(r.newTrials30d) : '—'} />
            <StatTile label="Churn" value={r ? formatRatioPct(r.churnRate) : '—'} tone={r && r.churnRate > 0 ? 'warning' : 'neutral'} />
            <StatTile label="Active subs" value={r ? formatCount(r.activeCount) : '—'} />
          </StatGrid>

          <View style={{ paddingHorizontal: space[4] }}><SectionLabel>Business</SectionLabel></View>
          <StatGrid>
            <StatTile label="Active tenants" value={d ? formatCount(d.tenants.active) : '—'} />
            <StatTile label="Stores" value={d ? formatCount(d.stores.total) : '—'} />
            <StatTile label="Leads" value={d ? formatCount(d.leads.total) : '—'} />
            <StatTile
              label="Critical 24h"
              value={crit.data ? formatCount(crit.data.summary.criticalLast24h) : '—'}
              tone={crit.data && crit.data.summary.criticalLast24h > 0 ? 'danger' : 'neutral'}
            />
          </StatGrid>
        </ScrollView>
      )}
    </Screen>
  );
}
