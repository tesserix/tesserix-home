import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useStats, useAnalytics, useActivities } from '../../lib/hooks';
import { formatINR, formatCount, formatRelative, titleCase, type Activity } from '@tesserix/homechef-shared';
import { BackButton, Card, LoadingRows, Screen, ScreenHeader, SectionLabel, StatGrid, StatTile } from '../../components/kit';
import { usePalette, space, text } from '../../lib/theme';

function delta(n: number | undefined): string {
  if (n == null) return '—';
  return `${n >= 0 ? '▲' : '▼'} ${Math.abs(n).toFixed(1)}%`;
}

export default function Analytics() {
  const p = usePalette();
  const stats = useStats();
  const analytics = useAnalytics();
  const activity = useActivities(12);
  const s = stats.data;
  const a = analytics.data;
  const activities = activity.data ?? [];
  const refreshing = stats.isRefetching || analytics.isRefetching || activity.isRefetching;
  const refetchAll = () => { stats.refetch(); analytics.refetch(); activity.refetch(); };

  const statusRows = Object.entries(a?.ordersByStatus ?? {})
    .map(([k, v]) => ({ label: titleCase(k), count: v }))
    .sort((x, y) => y.count - x.count);
  const maxCount = statusRows.reduce((m, r) => Math.max(m, r.count), 0);

  return (
    <Screen>
      <ScreenHeader title="Analytics" subtitle="Platform performance · live" right={<BackButton onPress={() => router.back()} />} />
      {stats.isLoading && !s ? (
        <LoadingRows />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: space[10], gap: space[4] }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refetchAll} />}
        >
          <View style={{ paddingHorizontal: space[4] }}><SectionLabel>Money & volume</SectionLabel></View>
          <StatGrid>
            <StatTile label="Total revenue" value={formatINR(s?.revenue)} tone={s && s.revenueChange >= 0 ? 'success' : 'danger'} />
            <StatTile label="Revenue today" value={formatINR(s?.revenueToday)} />
            <StatTile label="Total orders" value={formatCount(s?.totalOrders)} />
            <StatTile label="Orders today" value={formatCount(s?.ordersToday)} />
          </StatGrid>
          <View style={{ paddingHorizontal: space[4] }}>
            <Text style={[text.caption, { color: p.mutedForeground }]}>
              Revenue {delta(s?.revenueChange)} · Orders {delta(s?.ordersChange)} vs prev.
            </Text>
          </View>

          <View style={{ paddingHorizontal: space[4] }}><SectionLabel>People & efficiency</SectionLabel></View>
          <StatGrid>
            <StatTile label="Avg order value" value={formatINR(a?.overview.avgOrderValue)} />
            <StatTile label="Total users" value={formatCount(s?.totalUsers)} />
            <StatTile label="Active users" value={formatCount(a?.overview.activeUsers)} tone="info" />
            <StatTile label="Chefs" value={formatCount(s?.totalChefs)} tone={s?.pendingVerifications ? 'warning' : 'neutral'} />
          </StatGrid>
          {s?.pendingVerifications || s?.newUsersToday ? (
            <View style={{ paddingHorizontal: space[4] }}>
              <Text style={[text.caption, { color: p.mutedForeground }]}>
                {s?.pendingVerifications ? `${s.pendingVerifications} chef verification(s) pending · ` : ''}
                {formatCount(s?.newUsersToday)} new users today
              </Text>
            </View>
          ) : null}

          <View style={{ paddingHorizontal: space[4] }}><SectionLabel>Orders by status</SectionLabel></View>
          <View style={{ paddingHorizontal: space[4] }}>
            {statusRows.length === 0 ? (
              <Text style={[text.caption, { color: p.mutedForeground }]}>No order data yet.</Text>
            ) : (
              <Card>
                <View style={{ gap: 10 }}>
                  {statusRows.map((r) => (
                    <View key={r.label} style={{ gap: 4 }}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                        <Text style={[text.caption, { color: p.foreground }]}>{r.label}</Text>
                        <Text style={[text.caption, { color: p.mutedForeground, fontVariant: ['tabular-nums'] }]}>{formatCount(r.count)}</Text>
                      </View>
                      <View style={{ height: 6, borderRadius: 3, backgroundColor: p.muted, overflow: 'hidden' }}>
                        <View style={{ width: `${maxCount > 0 ? (r.count / maxCount) * 100 : 0}%`, height: 6, backgroundColor: p.primary }} />
                      </View>
                    </View>
                  ))}
                </View>
              </Card>
            )}
          </View>

          <View style={{ paddingHorizontal: space[4] }}><SectionLabel>Recent activity</SectionLabel></View>
          <View style={{ paddingHorizontal: space[4] }}>
            <Card>
              {activities.length === 0 ? (
                <Text style={[text.caption, { color: p.mutedForeground }]}>No recent activity.</Text>
              ) : (
                <View style={{ gap: 12 }}>
                  {activities.map((act: Activity) => (
                    <View key={act.id} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                      <View style={{ flex: 1 }}>
                        <Text style={[text.title, { color: p.foreground }]} numberOfLines={1}>{act.title}</Text>
                        <Text style={[text.caption, { color: p.mutedForeground }]} numberOfLines={1}>{act.description}</Text>
                      </View>
                      <Text style={[text.caption, { color: p.mutedForeground }]}>{formatRelative(act.timestamp)}</Text>
                    </View>
                  ))}
                </View>
              )}
            </Card>
          </View>
        </ScrollView>
      )}
    </Screen>
  );
}
