// Mark8ly audit logs — event feed with severity filter (read-only).
import { useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useMark8lyAuditLogs } from '../../lib/mark8ly-hooks';
import type { AuditEventRow } from '../../lib/mark8ly-contracts';
import { formatCount, formatRelative, titleCase } from '@tesserix/homechef-shared';
import {
  Screen, ScreenHeader, BackButton, Card, Badge, StatGrid, StatTile, FilterChips,
  EmptyState, LoadingRows, Banner, type Tone,
} from '../../components/kit';
import { usePalette, space, text } from '../../lib/theme';

// severity is an open string; 'critical' is the one guaranteed value. Chips are a
// pragmatic fixed set — unmatched values simply filter to empty.
const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'critical', label: 'Critical' },
  { key: 'error', label: 'Error' },
  { key: 'warning', label: 'Warning' },
  { key: 'info', label: 'Info' },
];

function sevTone(s: string): Tone {
  const v = s.toLowerCase();
  if (v === 'critical' || v === 'error') return 'danger';
  if (v === 'warning') return 'warning';
  if (v === 'info') return 'info';
  return 'neutral';
}

export default function AuditLogs() {
  const [severity, setSeverity] = useState('all');
  const q = useMark8lyAuditLogs(severity);
  const rows = q.data?.rows ?? [];

  return (
    <Screen>
      <ScreenHeader title="Audit logs" subtitle="Mark8ly admin trail" right={<BackButton onPress={() => router.back()} />} />
      {q.isLoading ? (
        <LoadingRows />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.id}
          contentContainerStyle={{ gap: 8, paddingHorizontal: space[4], paddingBottom: space[10] }}
          refreshing={q.isRefetching}
          onRefresh={() => q.refetch()}
          ListHeaderComponent={
            <View style={{ gap: space[3], paddingBottom: 8 }}>
              {q.isError ? <Banner text="Could not load audit logs." tone="danger" /> : null}
              {q.data ? (
                <StatGrid>
                  <StatTile label="Critical 24h" value={formatCount(q.data.summary.criticalLast24h)} tone={q.data.summary.criticalLast24h > 0 ? 'danger' : 'neutral'} />
                  <StatTile label="Events" value={formatCount(rows.length)} />
                </StatGrid>
              ) : null}
              <FilterChips options={FILTERS} value={severity} onChange={setSeverity} />
            </View>
          }
          ListEmptyComponent={<EmptyState title="No events" body="No audit events for this filter." />}
          renderItem={({ item }) => <EventCard e={item} />}
        />
      )}
    </Screen>
  );
}

function EventCard({ e }: { e: AuditEventRow }) {
  const p = usePalette();
  const [open, setOpen] = useState(false);
  const hasMeta = e.metadata && Object.keys(e.metadata).length > 0;
  return (
    <Pressable onPress={hasMeta ? () => setOpen((v) => !v) : undefined} style={({ pressed }) => ({ opacity: pressed && hasMeta ? 0.6 : 1 })}>
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={[text.title, { color: p.foreground, flex: 1 }]} numberOfLines={1}>{e.action}</Text>
          <Badge label={titleCase(e.severity)} tone={sevTone(e.severity)} />
        </View>
        <Text style={[text.caption, { color: p.mutedForeground, marginTop: 4 }]} numberOfLines={1}>
          {[e.resource_type + (e.resource_id ? ` ${e.resource_id}` : ''), e.actor_email, e.tenantName, formatRelative(e.created_at)].filter(Boolean).join(' · ')}
        </Text>
        {open && hasMeta ? (
          <Text style={[text.mono, { color: p.mutedForeground, marginTop: 8, fontSize: 11 }]}>{JSON.stringify(e.metadata, null, 2)}</Text>
        ) : null}
      </Card>
    </Pressable>
  );
}
