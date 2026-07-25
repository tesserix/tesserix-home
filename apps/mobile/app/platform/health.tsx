// Service health — Kubernetes workload readiness & restarts (Prometheus-backed).
import { useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useServiceHealth } from '../../lib/platform-hooks';
import type { WorkloadHealth, WorkloadStatus } from '../../lib/platform-contracts';
import { formatCount } from '@tesserix/homechef-shared';
import {
  Screen,
  ScreenHeader,
  BackButton,
  Card,
  StatGrid,
  StatTile,
  Metric,
  StatusDot,
  Banner,
  EmptyState,
  LoadingRows,
  FilterChips,
  type Tone,
} from '../../components/kit';
import { usePalette, space, text } from '../../lib/theme';

const STATUS_TONE: Record<WorkloadStatus, Tone> = {
  healthy: 'success',
  degraded: 'warning',
  down: 'danger',
  idle: 'neutral',
};

const FILTERS: { key: string; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Hide idle' },
];

export default function Health() {
  const q = useServiceHealth();
  const [filter, setFilter] = useState('all');
  const data = q.data;
  const workloads = (data?.workloads ?? []).filter((w) => filter === 'all' || w.status !== 'idle');

  return (
    <Screen>
      <ScreenHeader
        title="Service health"
        subtitle="Kubernetes workloads"
        right={<BackButton onPress={() => router.back()} />}
      />
      {q.isLoading ? (
        <LoadingRows />
      ) : (
        <FlatList
          data={workloads}
          keyExtractor={(w) => `${w.namespace}/${w.workload}`}
          contentContainerStyle={{ gap: 10, paddingBottom: space[10] }}
          refreshing={q.isRefetching}
          onRefresh={() => q.refetch()}
          ListHeaderComponent={
            <View style={{ gap: space[3] }}>
              {data ? (
                <StatGrid>
                  <StatTile label="Workloads" value={formatCount(data.totals.workloads)} />
                  <StatTile label="Healthy" value={formatCount(data.totals.healthy)} tone="success" />
                  <StatTile label="Degraded" value={formatCount(data.totals.degraded)} tone="warning" />
                  <StatTile label="Down" value={formatCount(data.totals.down)} tone="danger" />
                  <StatTile label="Restarts 24h" value={formatCount(data.totals.restarts24h)} />
                </StatGrid>
              ) : null}
              {data && data.available === false ? (
                <Banner text={data.errorMessage ?? 'Prometheus unavailable'} tone="danger" />
              ) : null}
              <FilterChips options={FILTERS} value={filter} onChange={setFilter} />
            </View>
          }
          ListEmptyComponent={<EmptyState title="No workloads" body="Nothing to show for this filter." />}
          renderItem={({ item }) => <WorkloadCard w={item} />}
        />
      )}
    </Screen>
  );
}

function WorkloadCard({ w }: { w: WorkloadHealth }) {
  const p = usePalette();
  const podsTone: Tone = w.readyPods === 0 ? 'danger' : w.readyPods < w.totalPods ? 'warning' : 'success';
  return (
    <View style={{ paddingHorizontal: space[4] }}>
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <StatusDot tone={STATUS_TONE[w.status]} />
          <View style={{ flex: 1 }}>
            <Text style={[text.title, { color: p.foreground }]} numberOfLines={1}>
              {w.workload}
            </Text>
            <Text style={[text.caption, { color: p.mutedForeground }]} numberOfLines={1}>
              {w.namespace}
            </Text>
          </View>
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16, marginTop: 12 }}>
          <Metric label="Pods" value={`${w.readyPods}/${w.totalPods}`} tone={podsTone} />
          <Metric label="Restarts 24h" value={formatCount(w.restarts24h)} />
          <Metric label="Restarts total" value={formatCount(w.totalRestarts)} />
        </View>
      </Card>
    </View>
  );
}
