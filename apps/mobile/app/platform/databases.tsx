// Databases — CloudNativePG cluster health (instances, replication, backups).
import { FlatList, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useDatabases } from '../../lib/platform-hooks';
import type { ClusterStatus, DbCluster } from '../../lib/platform-contracts';
import { formatBytes, formatCount, formatDuration, formatRelative, titleCase } from '@tesserix/homechef-shared';
import {
  Screen,
  ScreenHeader,
  BackButton,
  Card,
  StatGrid,
  StatTile,
  Metric,
  StatusDot,
  Badge,
  Banner,
  EmptyState,
  LoadingRows,
  type Tone,
} from '../../components/kit';
import { usePalette, space, text } from '../../lib/theme';

const STATUS_TONE: Record<ClusterStatus, Tone> = {
  healthy: 'success',
  degraded: 'warning',
  down: 'danger',
};

export default function Databases() {
  const q = useDatabases();
  const data = q.data;
  const clusters = data?.clusters ?? [];

  return (
    <Screen>
      <ScreenHeader
        title="Databases"
        subtitle="CloudNativePG clusters"
        right={<BackButton onPress={() => router.back()} />}
      />
      {q.isLoading ? (
        <LoadingRows />
      ) : (
        <FlatList
          data={clusters}
          keyExtractor={(c) => `${c.namespace}/${c.cluster}`}
          contentContainerStyle={{ gap: 10, paddingBottom: space[10] }}
          refreshing={q.isRefetching}
          onRefresh={() => q.refetch()}
          ListHeaderComponent={
            <View style={{ gap: space[3] }}>
              {data ? (
                <StatGrid>
                  <StatTile label="Clusters" value={formatCount(data.totals.clusters)} />
                  <StatTile label="Healthy" value={formatCount(data.totals.healthy)} tone="success" />
                  <StatTile label="Degraded" value={formatCount(data.totals.degraded)} tone="warning" />
                  <StatTile label="Down" value={formatCount(data.totals.down)} tone="danger" />
                </StatGrid>
              ) : null}
              {data && data.available === false ? (
                <Banner text="CNPG metrics unavailable" tone="danger" />
              ) : data && data.errorMessage ? (
                <Banner text={data.errorMessage} tone="warning" />
              ) : null}
            </View>
          }
          ListEmptyComponent={<EmptyState title="No clusters" body="No CloudNativePG clusters were reported." />}
          renderItem={({ item }) => <ClusterCard c={item} />}
        />
      )}
    </Screen>
  );
}

function ClusterCard({ c }: { c: DbCluster }) {
  const p = usePalette();
  const instancesTone: Tone =
    c.instances === 0 ? 'danger' : c.readyInstances < c.instances ? 'warning' : 'success';

  const lag = c.maxReplicationLagSeconds;
  const lagValue = lag == null ? '—' : c.instances <= 1 ? 'n/a' : `${lag}s`;
  const lagTone: Tone = lag != null && c.instances > 1 && lag > 60 ? 'warning' : 'neutral';

  const failed = c.lastFailedBackupAt;
  const backupWarn =
    !!failed && (!c.lastAvailableBackupAt || new Date(failed).getTime() > new Date(c.lastAvailableBackupAt).getTime());

  return (
    <View style={{ paddingHorizontal: space[4] }}>
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <StatusDot tone={STATUS_TONE[c.status]} />
          <View style={{ flex: 1 }}>
            <Text style={[text.title, { color: p.foreground }]} numberOfLines={1}>
              {c.cluster}
            </Text>
            <Text style={[text.caption, { color: p.mutedForeground }]} numberOfLines={1}>
              {c.namespace}
            </Text>
          </View>
          <Badge label={titleCase(c.status)} tone={STATUS_TONE[c.status]} />
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16, marginTop: 12 }}>
          <Metric label="Instances" value={`${c.readyInstances}/${c.instances}`} tone={instancesTone} />
          <Metric label="Connections" value={c.connections == null ? '—' : formatCount(c.connections)} />
          <Metric label="Repl lag" value={lagValue} tone={lagTone} />
          <Metric label="Size" value={formatBytes(c.databaseSizeBytes)} />
          <Metric label="Uptime" value={formatDuration(c.postmasterUptimeSeconds)} />
          <Metric
            label="Last backup"
            value={formatRelative(c.lastAvailableBackupAt)}
            tone={backupWarn ? 'warning' : 'neutral'}
          />
        </View>
      </Card>
    </View>
  );
}
