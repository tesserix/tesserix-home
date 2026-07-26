// audit-log.tsx — HomeChef admin audit trail (read-only). Free-text action/entity
// filters + date range; FLAT { logs, total, page, limit } envelope (not Paginated).
import { useState } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { formatDateTime, titleCase, type AuditLogEntry } from '@tesserix/homechef-shared';
import { BackButton, Button, Card, EmptyState, LoadingRows, Screen, ScreenHeader, SearchField } from '../../components/kit';
import { useAuditLogs } from '../../lib/hooks';
import { usePalette, space, text } from '../../lib/theme';

const LIMIT = 50;

function actorLabel(row: AuditLogEntry): string {
  if (!row.user) return row.userId ? row.userId.slice(0, 8) : 'System';
  const name = [row.user.firstName, row.user.lastName].filter(Boolean).join(' ').trim();
  return name || row.user.email || '—';
}

function ChangeToggle({ row }: { row: AuditLogEntry }) {
  const p = usePalette();
  const [open, setOpen] = useState(false);
  if (!row.oldValue && !row.newValue) return null;
  if (!open) {
    return <Text onPress={() => setOpen(true)} style={{ fontFamily: 'InterTight-Medium', fontSize: 12, color: p.primary, marginTop: 6 }}>Show change</Text>;
  }
  return (
    <View style={{ marginTop: 6, gap: 4 }}>
      {row.oldValue ? <Text style={[text.mono, { color: p.destructive }]}>- {row.oldValue}</Text> : null}
      {row.newValue ? <Text style={[text.mono, { color: p.successFg }]}>+ {row.newValue}</Text> : null}
      <Text onPress={() => setOpen(false)} style={{ fontFamily: 'InterTight-Medium', fontSize: 12, color: p.primary }}>Hide</Text>
    </View>
  );
}

export default function AuditLog() {
  const p = usePalette();
  const [action, setAction] = useState('');
  const [entityType, setEntityType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);

  const q = useAuditLogs({
    page,
    limit: LIMIT,
    ...(action ? { action } : {}),
    ...(entityType ? { entityType } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  });
  const logs = q.data?.logs ?? [];
  const total = q.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / (q.data?.limit || LIMIT)));

  function setFilter(fn: () => void) { fn(); setPage(1); }
  const hasFilter = action !== '' || entityType !== '' || from !== '' || to !== '';

  return (
    <Screen>
      <ScreenHeader title="Audit log" subtitle={`${total} entries`} right={<BackButton onPress={() => router.back()} />} />
      <View style={{ paddingHorizontal: space[4], gap: 10, paddingBottom: space[2] }}>
        <SearchField value={action} onChangeText={(t) => setFilter(() => setAction(t))} placeholder="Filter action (e.g. chef.payout.update)" />
        <SearchField value={entityType} onChangeText={(t) => setFilter(() => setEntityType(t))} placeholder="Filter entity (e.g. chef)" />
        <SearchField value={from} onChangeText={(t) => setFilter(() => setFrom(t))} placeholder="From (YYYY-MM-DD)" />
        <SearchField value={to} onChangeText={(t) => setFilter(() => setTo(t))} placeholder="To (YYYY-MM-DD)" />
        {hasFilter ? <Button label="Clear filters" variant="secondary" onPress={() => setFilter(() => { setAction(''); setEntityType(''); setFrom(''); setTo(''); })} /> : null}
      </View>
      {q.isLoading ? (
        <LoadingRows />
      ) : logs.length === 0 ? (
        <EmptyState title="No entries" body={hasFilter ? 'No log entries match your filters.' : 'No audit activity yet.'} />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: space[4], paddingBottom: space[10], gap: 10 }}
          refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => q.refetch()} />}
        >
          {logs.map((row) => (
            <Card key={row.id}>
              <Text style={[text.caption, { color: p.mutedForeground }]}>{formatDateTime(row.createdAt)} · {actorLabel(row)}</Text>
              <Text style={[text.title, { color: p.foreground, marginTop: 2 }]} numberOfLines={2}>{row.action}</Text>
              <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]}>{titleCase(row.entityType)}{row.entityId ? ` · ${row.entityId.slice(0, 8)}` : ''}{row.ipAddress ? ` · ${row.ipAddress}` : ''}</Text>
              <ChangeToggle row={row} />
            </Card>
          ))}
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 4 }}>
            <View style={{ flex: 1 }}><Button label="Previous" variant="secondary" disabled={page <= 1} onPress={() => setPage((n) => Math.max(1, n - 1))} /></View>
            <View style={{ flex: 1 }}><Button label="Next" variant="secondary" disabled={page >= totalPages} onPress={() => setPage((n) => n + 1)} /></View>
          </View>
        </ScrollView>
      )}
    </Screen>
  );
}
