// Erasure requests — read-only DPDP/GDPR erasure queue. Lists customer data-
// deletion requests with a status filter, KPI tiles, and per-request SLA aging.

import { useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useErasureRequests } from '../../lib/platform-hooks';
import { formatDateTime, formatHours } from '@tesserix/homechef-shared';
import {
  Badge,
  BackButton,
  Banner,
  Card,
  EmptyState,
  FilterChips,
  LoadingRows,
  Metric,
  Screen,
  ScreenHeader,
  StatGrid,
  StatTile,
  type Tone,
} from '../../components/kit';
import { usePalette, space, text } from '../../lib/theme';
import type { ErasureRow } from '../../lib/platform-contracts';

const STATUS_OPTIONS: { key: string; label: string }[] = [
  { key: 'pending', label: 'Pending' },
  { key: 'processing', label: 'Processing' },
  { key: 'failed', label: 'Failed' },
  { key: 'completed', label: 'Completed' },
  { key: 'all', label: 'All' },
];

function statusTone(s: string): Tone {
  if (s === 'completed') return 'success';
  if (s === 'processing') return 'info';
  if (s === 'failed') return 'danger';
  return 'warning';
}

function pendingTone(hours: number): Tone {
  if (hours >= 720) return 'danger';
  if (hours >= 336) return 'warning';
  return 'neutral';
}

export default function Erasure() {
  const [status, setStatus] = useState('pending');
  const q = useErasureRequests(status);
  const data = q.data;
  const summary = data?.summary;
  const rows = data?.rows ?? [];

  return (
    <Screen>
      <ScreenHeader
        title="Erasure requests"
        subtitle="DPDP / GDPR queue"
        right={<BackButton onPress={() => router.back()} />}
      />

      {summary ? (
        <View style={{ paddingBottom: space[3] }}>
          <StatGrid>
            <StatTile label="Pending" value={String(summary.pending)} />
            <StatTile label="Processing" value={String(summary.processing)} tone="info" />
            <StatTile label="Resolved 7d" value={String(summary.completedThisWeek)} tone="success" />
            <StatTile
              label="Oldest pending"
              value={formatHours(summary.oldestPendingHours)}
              tone={
                summary.oldestPendingHours != null && summary.oldestPendingHours > 336
                  ? 'warning'
                  : undefined
              }
            />
          </StatGrid>
        </View>
      ) : null}

      {summary && summary.failed > 0 ? (
        <Banner tone="danger" text={`${summary.failed} failed requests need investigation`} />
      ) : null}

      <View style={{ paddingBottom: space[3] }}>
        <FilterChips options={STATUS_OPTIONS} value={status} onChange={setStatus} />
      </View>

      {q.isLoading ? (
        <LoadingRows />
      ) : rows.length === 0 ? (
        <EmptyState title="No requests" body="Nothing matches this filter." />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.id}
          contentContainerStyle={{ paddingHorizontal: space[4], gap: 10, paddingBottom: space[10] }}
          refreshing={q.isRefetching}
          onRefresh={() => q.refetch()}
          renderItem={({ item }) => <ErasureCard row={item} />}
        />
      )}
    </Screen>
  );
}

function ErasureCard({ row }: { row: ErasureRow }) {
  const p = usePalette();
  const showPending = row.status === 'pending' || row.status === 'processing';
  return (
    <Card>
      <View style={styles.rowBetween}>
        <Text style={[text.title, { color: p.foreground, flex: 1, marginRight: 8 }]} numberOfLines={1}>
          {row.customer_email}
        </Text>
        <Badge label={row.status} tone={statusTone(row.status)} />
      </View>
      <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]} numberOfLines={1}>
        {row.store_name ?? row.store_id}
      </Text>

      <View style={styles.metrics}>
        <Metric label="Requested" value={formatDateTime(row.requested_at)} />
        {showPending ? (
          <Metric
            label="Pending for"
            value={formatHours(row.hours_pending)}
            tone={pendingTone(row.hours_pending)}
          />
        ) : null}
      </View>

      {row.notes ? (
        <Text style={[text.caption, { color: p.mutedForeground, marginTop: 8 }]}>{row.notes}</Text>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 16, marginTop: 12 },
});
