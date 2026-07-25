import { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { BellRing, ChevronLeft } from 'lucide-react-native';
import { useApprovals, useEscalatedCount } from '../../../lib/hooks';
import { titleCase, formatDateTime, formatRelative, type ApprovalPriority, type ApprovalRequest } from '@tesserix/homechef-shared';
import {
  Badge, EmptyState, FilterChips, LoadingRows, Screen, ScreenHeader, SearchField, type Tone,
} from '../../../components/kit';
import { usePalette, space, radius, text } from '../../../lib/theme';

// Filter keys — the 4 review states plus the two chase cross-cuts.
type Filter = 'pending' | 'info_requested' | 'approved' | 'rejected' | 'reminded' | 'escalated';
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'pending', label: 'Pending' },
  { key: 'info_requested', label: 'Info requested' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'reminded', label: 'Reminded' },
  { key: 'escalated', label: 'Escalated' },
];

function priorityTone(p: ApprovalPriority): Tone {
  if (p === 'urgent') return 'danger';
  if (p === 'high') return 'warning';
  if (p === 'low') return 'neutral';
  return 'info';
}

// Reminder urgency from chase count: 1 = amber, 2 = purple, ≥3 = escalated (bell).
type ReminderTone = 'none' | 'amber' | 'purple' | 'red';
function reminderLevel(n: number | null | undefined): { tone: ReminderTone; showBell: boolean } {
  const c = n ?? 0;
  if (c >= 3) return { tone: 'red', showBell: true };
  if (c === 2) return { tone: 'purple', showBell: false };
  if (c === 1) return { tone: 'amber', showBell: false };
  return { tone: 'none', showBell: false };
}
const ACCENT: Record<ReminderTone, string | undefined> = {
  none: undefined,
  amber: '#F59E0B',
  purple: '#A855F7',
  red: '#DC2626',
};

// How long a request has waited, phrased for triage.
function waitedFor(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days}d`;
  const hrs = Math.floor(ms / 3_600_000);
  return `${Math.max(hrs, 0)}h`;
}

function listParams(filter: Filter, search: string) {
  const s = search.trim() || undefined;
  if (filter === 'escalated') return { escalated: 'true', search: s, page: 1, limit: 50 };
  if (filter === 'reminded') return { reminded: 'true', search: s, page: 1, limit: 50 };
  return { status: filter, search: s, page: 1, limit: 50 };
}

export default function ApprovalsList() {
  const p = usePalette();
  const [filter, setFilter] = useState<Filter>('pending');
  const [search, setSearch] = useState('');
  const q = useApprovals(listParams(filter, search));
  const escalated = useEscalatedCount();
  const rows = q.data?.data ?? [];

  const chips = FILTERS.map((f) =>
    f.key === 'escalated' && (escalated.data ?? 0) > 0
      ? { key: f.key, label: `${f.label} (${escalated.data})` }
      : f,
  );

  return (
    <Screen>
      <ScreenHeader
        title="Approvals"
        subtitle={q.data ? `${q.data.pagination.total} ${filter === 'escalated' || filter === 'reminded' ? filter : titleCase(filter)}` : 'Review queue'}
        right={
          <Pressable onPress={() => router.back()} hitSlop={10} style={{ paddingTop: 4 }}>
            <ChevronLeft size={24} color={p.mutedForeground} />
          </Pressable>
        }
      />
      <View style={{ paddingHorizontal: space[4], paddingBottom: space[3] }}>
        <SearchField value={search} onChangeText={setSearch} placeholder="Search title or description" />
      </View>
      <View style={{ paddingBottom: space[3] }}>
        <FilterChips options={chips} value={filter} onChange={setFilter} />
      </View>
      {q.isLoading ? (
        <LoadingRows />
      ) : rows.length === 0 ? (
        <EmptyState
          title={filter === 'escalated' ? 'Nothing escalated' : 'Nothing here'}
          body={filter === 'escalated' ? 'Nobody is waiting on us.' : 'Nothing in this state.'}
        />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(a) => a.id}
          contentContainerStyle={{ paddingHorizontal: space[4], gap: 8, paddingBottom: space[10] }}
          refreshing={q.isRefetching}
          onRefresh={() => q.refetch()}
          renderItem={({ item }) => <ApprovalRow a={item} />}
        />
      )}
    </Screen>
  );
}

function ApprovalRow({ a }: { a: ApprovalRequest }) {
  const p = usePalette();
  const level = reminderLevel(a.reminderCount);
  const accent = ACCENT[level.tone];
  const escalated = level.tone === 'red' || Boolean(a.escalatedAt);
  const sub = [a.kitchenName, a.requestedByName].filter(Boolean).join(' · ');
  const reminderLabel =
    (a.reminderCount ?? 0) > 0
      ? `${escalated ? 'Escalated' : `Reminded ×${a.reminderCount}`}${a.lastRemindedAt ? ` · ${formatRelative(a.lastRemindedAt)}` : ''}`
      : null;

  return (
    <Pressable
      onPress={() => router.push(('/homechef/approvals/' + a.id) as never)}
      style={({ pressed }) => [
        styles.row,
        {
          borderColor: p.border,
          backgroundColor: pressed ? p.muted : p.surface,
          borderLeftWidth: accent ? 3 : StyleSheet.hairlineWidth,
          borderLeftColor: accent ?? p.border,
        },
      ]}
    >
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {level.showBell ? <BellRing size={15} color="#DC2626" /> : null}
          <Text style={[text.title, { color: p.foreground, flexShrink: 1 }]} numberOfLines={1}>
            {a.title || titleCase(a.type)}
          </Text>
        </View>
        {sub ? (
          <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]} numberOfLines={1}>{sub}</Text>
        ) : null}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 }}>
          <Badge label={titleCase(a.priority)} tone={priorityTone(a.priority)} />
          <Text style={[text.caption, { color: p.mutedForeground }]}>{titleCase(a.type)}</Text>
        </View>
        {reminderLabel ? (
          <Text style={{ fontFamily: 'InterTight-Medium', fontSize: 12, color: accent ?? p.mutedForeground, marginTop: 6 }}>
            {reminderLabel} · waiting {waitedFor(a.createdAt)}
          </Text>
        ) : null}
        <Text style={[text.caption, { color: p.mutedForeground, marginTop: 4 }]}>{formatDateTime(a.createdAt)}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    paddingHorizontal: space[4],
    paddingVertical: 12,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
