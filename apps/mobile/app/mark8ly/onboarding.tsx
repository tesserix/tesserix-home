// Mark8ly onboarding — signup funnel KPIs + session list (read-only).
import { useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useOnboarding } from '../../lib/mark8ly-hooks';
import type { OnboardingSessionRow } from '../../lib/mark8ly-contracts';
import { formatCount, formatDuration, formatRelative, titleCase } from '@tesserix/homechef-shared';
import {
  Screen, ScreenHeader, BackButton, Card, Badge, StatGrid, StatTile, FilterChips,
  EmptyState, LoadingRows, Banner, type Tone,
} from '../../components/kit';
import { usePalette, space, text } from '../../lib/theme';

const FILTERS = [
  { key: 'in_flight', label: 'In flight' },
  { key: 'completed', label: 'Completed' },
  { key: 'abandoned', label: 'Abandoned' },
  { key: 'all', label: 'All' },
];

function sessionTone(row: OnboardingSessionRow): Tone {
  if (row.completed_at) return 'success';
  if (row.is_abandoned) return 'danger';
  return 'info';
}

export default function Onboarding() {
  const [status, setStatus] = useState('in_flight');
  const q = useOnboarding(status);
  const s = q.data?.stats;
  const sessions = q.data?.sessions ?? [];

  return (
    <Screen>
      <ScreenHeader title="Onboarding" subtitle="Signup funnel" right={<BackButton onPress={() => router.back()} />} />
      {q.isLoading ? (
        <LoadingRows />
      ) : (
        <FlatList
          data={sessions}
          keyExtractor={(r) => r.id}
          contentContainerStyle={{ gap: 8, paddingHorizontal: space[4], paddingBottom: space[10] }}
          refreshing={q.isRefetching}
          onRefresh={() => q.refetch()}
          ListHeaderComponent={
            <View style={{ gap: space[3], paddingBottom: 8 }}>
              {q.isError ? <Banner text="Could not load onboarding." tone="danger" /> : null}
              {s ? (
                <StatGrid>
                  <StatTile label="In flight" value={formatCount(s.inFlight)} tone="info" />
                  <StatTile label="Verified" value={formatCount(s.emailVerified)} />
                  <StatTile label="Completed" value={formatCount(s.completed)} tone="success" />
                  <StatTile label="Abandoned" value={formatCount(s.abandoned)} tone={s.abandoned > 0 ? 'warning' : 'neutral'} />
                  <StatTile label="Median time" value={formatDuration(s.medianTimeToCompleteSeconds)} />
                  <StatTile label="Started 24h" value={formatCount(s.last24h.started)} />
                </StatGrid>
              ) : null}
              <FilterChips options={FILTERS} value={status} onChange={setStatus} />
            </View>
          }
          ListEmptyComponent={<EmptyState title="No sessions" body="Nothing matches this filter." />}
          renderItem={({ item }) => <SessionCard row={item} />}
        />
      )}
    </Screen>
  );
}

function SessionCard({ row }: { row: OnboardingSessionRow }) {
  const p = usePalette();
  const label = row.completed_at ? 'Completed' : row.is_abandoned ? 'Abandoned' : 'In flight';
  const body = (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={[text.title, { color: p.foreground, flex: 1 }]} numberOfLines={1}>{row.business_name || row.email}</Text>
        <Badge label={label} tone={sessionTone(row)} />
      </View>
      <Text style={[text.caption, { color: p.mutedForeground, marginTop: 4 }]} numberOfLines={1}>
        {[row.email, row.email_verified_at ? 'verified' : 'unverified', `idle ${formatCount(row.hours_idle)}h`, formatRelative(row.created_at)].filter(Boolean).join(' · ')}
      </Text>
    </Card>
  );
  return row.tenant_id ? (
    <Pressable onPress={() => router.push(`/mark8ly/tenants/${row.tenant_id}` as never)} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
      {body}
    </Pressable>
  ) : body;
}
