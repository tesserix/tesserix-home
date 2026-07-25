// Break-glass — read-only inventory of emergency-access accounts. Tracks MFA
// enrollment, secret rotation age, and recent use so stale/abused accounts surface.

import { FlatList, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useBreakGlass } from '../../lib/platform-hooks';
import { formatDate } from '@tesserix/homechef-shared';
import {
  Badge,
  BackButton,
  Banner,
  Card,
  EmptyState,
  LoadingRows,
  Metric,
  Screen,
  ScreenHeader,
  StatGrid,
  StatTile,
  type Tone,
} from '../../components/kit';
import { usePalette, space, text } from '../../lib/theme';
import type { BreakGlassRow } from '../../lib/platform-contracts';

export default function BreakGlassScreen() {
  const q = useBreakGlass();
  const data = q.data;
  const summary = data?.summary;
  const rows = data?.rows ?? [];

  return (
    <Screen>
      <ScreenHeader
        title="Break-glass"
        subtitle="Emergency access accounts"
        right={<BackButton onPress={() => router.back()} />}
      />

      {summary ? (
        <View style={{ paddingBottom: space[3] }}>
          <StatGrid>
            <StatTile label="Accounts" value={String(summary.total)} />
            <StatTile label="MFA enrolled" value={String(summary.mfaEnrolled)} tone="success" />
            <StatTile
              label="Stale 90d+"
              value={String(summary.stale90d)}
              tone={summary.stale90d > 0 ? 'warning' : undefined}
            />
            <StatTile
              label="Used 7d"
              value={String(summary.usedThisWeek)}
              tone={summary.usedThisWeek > 0 ? 'warning' : undefined}
            />
          </StatGrid>
        </View>
      ) : null}

      {summary && summary.usedThisWeek > 0 ? (
        <Banner
          tone="warning"
          text={`${summary.usedThisWeek} accounts used this week — review access`}
        />
      ) : null}

      {q.isLoading ? (
        <LoadingRows />
      ) : rows.length === 0 ? (
        <EmptyState title="No break-glass accounts" body="Nothing to show." />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.secret_path}
          contentContainerStyle={{ paddingHorizontal: space[4], gap: 10, paddingBottom: space[10] }}
          refreshing={q.isRefetching}
          onRefresh={() => q.refetch()}
          renderItem={({ item }) => <BreakGlassCard row={item} />}
        />
      )}
    </Screen>
  );
}

function BreakGlassCard({ row }: { row: BreakGlassRow }) {
  const p = usePalette();

  const rotated = row.days_since_rotation == null ? 'never' : `${row.days_since_rotation}d ago`;
  const rotatedTone: Tone | undefined =
    row.days_since_rotation == null || row.days_since_rotation >= 90 ? 'danger' : undefined;

  const used = row.days_since_use == null ? 'never' : `${row.days_since_use}d ago`;
  const usedTone: Tone | undefined =
    row.days_since_use != null && row.days_since_use <= 7 ? 'warning' : undefined;

  return (
    <Card>
      <View style={styles.rowBetween}>
        <Text style={[text.title, { color: p.foreground, flex: 1, marginRight: 8 }]} numberOfLines={1}>
          {row.tenant_name ?? row.tenant_id}
        </Text>
        <Badge
          label={row.totp_enrolled ? 'MFA' : 'No MFA'}
          tone={row.totp_enrolled ? 'success' : 'danger'}
        />
      </View>
      <Text style={[text.mono, { color: p.mutedForeground, marginTop: 2 }]} numberOfLines={1}>
        {row.secret_path}
      </Text>

      <View style={styles.metrics}>
        <Metric label="Last rotated" value={rotated} tone={rotatedTone} />
        <Metric label="Last used" value={used} tone={usedTone} />
        <Metric
          label="Rotation due"
          value={row.rotation_scheduled_at ? formatDate(row.rotation_scheduled_at) : '—'}
        />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 16, marginTop: 12 },
});
