import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { useStats, useActivities } from '../../lib/hooks';
import { usePlatformDashboard } from '../../lib/platform-hooks';
import { formatINR, formatCount, formatRelative, type Activity } from "@tesserix/homechef-shared";
import { Card, EmptyState, LoadingRows, Screen, ScreenHeader, SectionLabel, StatCard } from '../../components/kit';
import { usePalette, space, text } from '../../lib/theme';

export default function Dashboard() {
  const dash = usePlatformDashboard();
  const stats = useStats();
  const activities = useActivities();
  const p = usePalette();
  const d = dash.data;
  const s = stats.data;

  const converted = d?.leads.by_status.converted ?? 0;
  const leadTotal = d?.leads.total ?? 0;
  const conversionPct = leadTotal > 0 ? Math.round((converted / leadTotal) * 100) : 0;

  return (
    <Screen>
      <ScreenHeader title="Overview" subtitle="Platform at a glance" />
      <ScrollView
        contentContainerStyle={{ paddingBottom: space[10], gap: space[5] }}
        refreshControl={
          <RefreshControl
            refreshing={dash.isRefetching || stats.isRefetching}
            onRefresh={() => { dash.refetch(); stats.refetch(); activities.refetch(); }}
            tintColor={p.mutedForeground}
          />
        }
      >
        {/* Platform-wide KPIs */}
        <View style={{ paddingHorizontal: space[4] }}>
          <SectionLabel>Platform</SectionLabel>
          {dash.isLoading ? (
            <LoadingRows rows={4} />
          ) : (
            <View style={{ gap: 12 }}>
              <View style={{ flexDirection: 'row', gap: 12 }}>
                <StatCard label="Active tenants" value={formatCount(d?.tenants.active ?? 0)} />
                <StatCard label="Stores" value={formatCount(d?.stores.total ?? 0)} />
              </View>
              <View style={{ flexDirection: 'row', gap: 12 }}>
                <StatCard label="Products" value={formatCount(d?.apps.active ?? 0)} />
                <StatCard
                  label="Leads"
                  value={formatCount(leadTotal)}
                  tone={conversionPct >= 20 ? 'success' : undefined}
                />
              </View>
            </View>
          )}
        </View>

        {/* HomeChef live metrics */}
        <View style={{ paddingHorizontal: space[4] }}>
          <SectionLabel>HomeChef</SectionLabel>
          {stats.isLoading ? (
            <LoadingRows rows={4} />
          ) : (
            <View style={{ gap: 12 }}>
              <View style={{ flexDirection: 'row', gap: 12 }}>
                <StatCard label="Orders today" value={formatCount(s?.ordersToday ?? 0)} />
                <StatCard label="GMV today" value={formatINR(s?.revenueToday ?? 0)} />
              </View>
              <View style={{ flexDirection: 'row', gap: 12 }}>
                <StatCard label="Active chefs" value={formatCount(s?.totalChefs ?? 0)} />
                <StatCard
                  label="Pending approvals"
                  value={formatCount(s?.pendingVerifications ?? 0)}
                  tone={(s?.pendingVerifications ?? 0) > 0 ? 'warning' : 'neutral'}
                />
              </View>
            </View>
          )}
        </View>

        <View style={{ paddingHorizontal: space[4] }}>
          <SectionLabel>Recent activity</SectionLabel>
          {activities.isLoading ? (
            <LoadingRows rows={4} />
          ) : (activities.data?.length ?? 0) === 0 ? (
            <Card><EmptyState title="Nothing yet" body="Platform activity will show up here." /></Card>
          ) : (
            <Card style={{ padding: 0 }}>
              {activities.data?.map((a: Activity, i: number) => (
                <View
                  key={a.id}
                  style={{
                    padding: space[4],
                    borderTopWidth: i === 0 ? 0 : 0.5,
                    borderTopColor: p.border,
                  }}
                >
                  <Text style={[text.title, { color: p.foreground }]}>{a.title}</Text>
                  <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]}>{a.description}</Text>
                  <Text style={[text.caption, { color: p.mutedForeground, marginTop: 4 }]}>{formatRelative(a.timestamp)}</Text>
                </View>
              ))}
            </Card>
          )}
        </View>
      </ScrollView>
    </Screen>
  );
}
