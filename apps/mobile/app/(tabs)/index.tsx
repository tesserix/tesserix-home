import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { useStats, useActivities } from '../../lib/hooks';
import { formatINR, formatCount, formatRelative } from '../../lib/format';
import { Card, EmptyState, LoadingRows, Screen, ScreenHeader, SectionLabel, StatCard } from '../../components/kit';
import { usePalette, space, text } from '../../lib/theme';

export default function Dashboard() {
  const stats = useStats();
  const activities = useActivities();
  const p = usePalette();
  const s = stats.data;

  return (
    <Screen>
      <ScreenHeader title="Overview" subtitle="Platform at a glance" />
      <ScrollView
        contentContainerStyle={{ paddingBottom: space[10], gap: space[5] }}
        refreshControl={
          <RefreshControl
            refreshing={stats.isRefetching}
            onRefresh={() => { stats.refetch(); activities.refetch(); }}
            tintColor={p.mutedForeground}
          />
        }
      >
        {stats.isLoading ? (
          <LoadingRows rows={4} />
        ) : (
          <View style={{ paddingHorizontal: space[4], gap: 12 }}>
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

        <View style={{ paddingHorizontal: space[4] }}>
          <SectionLabel>Recent activity</SectionLabel>
          {activities.isLoading ? (
            <LoadingRows rows={4} />
          ) : (activities.data?.data.length ?? 0) === 0 ? (
            <Card><EmptyState title="Nothing yet" body="Platform activity will show up here." /></Card>
          ) : (
            <Card style={{ padding: 0 }}>
              {activities.data?.data.map((a, i) => (
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
