// Outbox — transactional-outbox delivery health across service databases.
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useOutbox } from '../../lib/platform-hooks';
import type { OutboxDatabase, OutboxDatabaseSummary, OutboxRow, OutboxStatus } from '../../lib/platform-contracts';
import { formatCount, formatDuration, titleCase } from '@tesserix/homechef-shared';
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
  SectionLabel,
  EmptyState,
  LoadingRows,
  type Tone,
} from '../../components/kit';
import { usePalette, space, text } from '../../lib/theme';

const STATUS_TONE: Record<OutboxStatus, Tone> = {
  pending: 'warning',
  in_flight: 'info',
  completed: 'success',
  dead: 'danger',
};

const DB_META: Record<OutboxDatabase, { tone: Tone; label: string }> = {
  platform_api: { tone: 'info', label: 'platform' },
  marketplace_api: { tone: 'success', label: 'marketplace' },
};

export default function Outbox() {
  const p = usePalette();
  const q = useOutbox();
  const data = q.data;
  const summaries = data?.summaries ?? [];
  const recent = data?.recent ?? [];

  const pending = summaries.reduce((a, s) => a + s.pending, 0);
  const stuck = summaries.reduce((a, s) => a + s.stuck, 0);
  const dead = summaries.reduce((a, s) => a + s.dead, 0);
  const oldestVals = summaries.map((s) => s.oldestPendingAgeSeconds).filter((v): v is number => v != null);
  const oldest = oldestVals.length ? Math.max(...oldestVals) : null;

  return (
    <Screen>
      <ScreenHeader
        title="Outbox"
        subtitle="Event delivery health"
        right={<BackButton onPress={() => router.back()} />}
      />
      {q.isLoading ? (
        <LoadingRows />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: space[10], gap: space[4] }}
          refreshControl={
            <RefreshControl refreshing={q.isRefetching} onRefresh={() => q.refetch()} tintColor={p.mutedForeground} />
          }
        >
          <StatGrid>
            <StatTile label="Pending" value={formatCount(pending)} />
            <StatTile label="Stuck" value={formatCount(stuck)} tone={stuck > 0 ? 'warning' : 'neutral'} />
            <StatTile label="Dead" value={formatCount(dead)} tone={dead > 0 ? 'danger' : 'neutral'} />
            <StatTile label="Oldest pending" value={formatDuration(oldest)} />
          </StatGrid>

          <View style={{ paddingHorizontal: space[4], gap: 10 }}>
            {summaries.map((s) => (
              <SummaryCard key={s.database} s={s} />
            ))}
          </View>

          <View style={{ paddingHorizontal: space[4] }}>
            <SectionLabel>Stuck & dead rows</SectionLabel>
            {recent.length === 0 ? (
              <Card>
                <EmptyState title="No stuck rows" body="Every outbox event is being delivered." />
              </Card>
            ) : (
              <View style={{ gap: 10 }}>
                {recent.map((r) => (
                  <RowCard key={`${r.database}:${r.id}`} r={r} />
                ))}
              </View>
            )}
          </View>
        </ScrollView>
      )}
    </Screen>
  );
}

function SummaryCard({ s }: { s: OutboxDatabaseSummary }) {
  const meta = DB_META[s.database];
  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Badge label={meta.label} tone={meta.tone} />
        <View style={{ flex: 1 }} />
        {s.available ? <StatusDot tone="success" /> : <Badge label="offline" tone="danger" />}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16, marginTop: 12 }}>
        <Metric label="Pending" value={formatCount(s.pending)} />
        <Metric label="In flight" value={formatCount(s.inFlight)} />
        <Metric label="Stuck" value={formatCount(s.stuck)} tone={s.stuck > 0 ? 'warning' : 'neutral'} />
        <Metric label="Dead" value={formatCount(s.dead)} tone={s.dead > 0 ? 'danger' : 'neutral'} />
        <Metric label="Oldest" value={formatDuration(s.oldestPendingAgeSeconds)} />
      </View>
    </Card>
  );
}

function RowCard({ r }: { r: OutboxRow }) {
  const p = usePalette();
  const context = [r.tenantId, r.aggregate].filter(Boolean).join(' · ');
  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={[text.title, { color: p.foreground, flex: 1 }]} numberOfLines={1}>
          {r.kind}
        </Text>
        <Badge label={titleCase(r.status)} tone={STATUS_TONE[r.status]} />
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16, marginTop: 12 }}>
        <Metric label="Age" value={formatDuration(r.ageSeconds)} />
        <Metric label="Attempts" value={r.attempts == null ? '—' : formatCount(r.attempts)} />
      </View>
      {context ? (
        <Text style={[text.caption, { color: p.mutedForeground, marginTop: 8 }]} numberOfLines={1}>
          {context}
        </Text>
      ) : null}
      {r.lastError ? (
        <Text style={[text.caption, { color: p.destructiveFg, marginTop: 4 }]} numberOfLines={2}>
          {r.lastError}
        </Text>
      ) : null}
    </Card>
  );
}
