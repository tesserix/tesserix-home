// Mark8ly subscriptions — MRR summary + per-subscription list (read-only).
import { useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useSubscriptions } from '../../lib/mark8ly-hooks';
import type { SubscriptionRowItem } from '../../lib/mark8ly-contracts';
import { formatCount, titleCase } from '@tesserix/homechef-shared';
import {
  Screen, ScreenHeader, BackButton, Card, Badge, StatGrid, StatTile, FilterChips,
  EmptyState, LoadingRows, Banner, type Tone,
} from '../../components/kit';
import { usePalette, space, text } from '../../lib/theme';

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'trial', label: 'Trial' },
  { key: 'past_due', label: 'Past due' },
  { key: 'cancelled', label: 'Cancelled' },
];

function statusTone(s: string): Tone {
  if (s === 'active') return 'success';
  if (s === 'trialing') return 'info';
  if (s === 'past_due' || s === 'incomplete' || s === 'unpaid') return 'warning';
  if (s === 'canceled') return 'neutral';
  return 'neutral';
}

function money(currency: string, n: number): string {
  return `${currency} ${formatCount(n)}`;
}

export default function Subscriptions() {
  const [filter, setFilter] = useState('all');
  const q = useSubscriptions(filter);
  const rows = q.data?.rows ?? [];
  const s = q.data?.summary;

  return (
    <Screen>
      <ScreenHeader title="Subscriptions" subtitle="Mark8ly billing" right={<BackButton onPress={() => router.back()} />} />
      {q.isLoading ? (
        <LoadingRows />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.tenantId}
          contentContainerStyle={{ gap: 8, paddingHorizontal: space[4], paddingBottom: space[10] }}
          refreshing={q.isRefetching}
          onRefresh={() => q.refetch()}
          ListHeaderComponent={
            <View style={{ gap: space[3], paddingBottom: 8 }}>
              {q.isError ? <Banner text="Could not load subscriptions." tone="danger" /> : null}
              {s ? (
                <StatGrid>
                  <StatTile label="Total MRR" value={money(s.currency, s.totalMrr)} />
                  <StatTile label="Active" value={formatCount(s.activeCount)} tone="success" />
                  <StatTile label="Trial" value={formatCount(s.trialCount)} />
                  <StatTile label="Past due" value={formatCount(s.pastDueCount)} tone={s.pastDueCount > 0 ? 'warning' : 'neutral'} />
                  <StatTile label="Cancelled" value={formatCount(s.cancelledThisMonth)} />
                </StatGrid>
              ) : null}
              <FilterChips options={FILTERS} value={filter} onChange={setFilter} />
            </View>
          }
          ListEmptyComponent={<EmptyState title="No subscriptions" body="Nothing matches this filter." />}
          renderItem={({ item }) => <SubCard r={item} />}
        />
      )}
    </Screen>
  );
}

function SubCard({ r }: { r: SubscriptionRowItem }) {
  const p = usePalette();
  return (
    <Pressable onPress={() => router.push(`/mark8ly/tenants/${r.tenantId}` as never)} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={[text.title, { color: p.foreground, flex: 1 }]} numberOfLines={1}>{r.tenantName}</Text>
          <Badge label={titleCase(r.status)} tone={statusTone(r.status)} />
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 }}>
          <Badge label={r.plan} tone="info" />
          <Text style={[text.mono, { color: p.mutedForeground, flex: 1, textAlign: 'right' }]}>{money(r.currency, r.mrr)}</Text>
        </View>
        {r.dunningState || r.trialDaysRemaining != null ? (
          <Text style={[text.caption, { color: p.mutedForeground, marginTop: 6 }]} numberOfLines={1}>
            {[r.trialDaysRemaining != null ? `${r.trialDaysRemaining} trial days` : null, r.dunningState ? `dunning: ${r.dunningState}` : null].filter(Boolean).join(' · ')}
          </Text>
        ) : null}
      </Card>
    </Pressable>
  );
}
