// Platform tickets list — cross-product support queue. KPI tiles from the
// summary, status filter chips, and a tappable row per ticket that opens the
// detail screen. Mirrors the tesserix-home web admin Support tickets page.

import { useState } from 'react';
import { FlatList, View } from 'react-native';
import { router } from 'expo-router';
import { useTicketsList } from '../../lib/platform-hooks';
import { titleCase } from '@tesserix/homechef-shared';
import {
  Badge,
  BackButton,
  EmptyState,
  FilterChips,
  ListRow,
  LoadingRows,
  Screen,
  ScreenHeader,
  StatGrid,
  StatTile,
  type Tone,
} from '../../components/kit';
import { space } from '../../lib/theme';
import type { TicketRow, TicketStatus, TicketPriority } from '../../lib/platform-contracts';

const STATUSES: { key: string; label: string }[] = [
  { key: '', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'closed', label: 'Closed' },
];

function statusTone(s: TicketStatus): Tone {
  if (s === 'open') return 'warning';
  if (s === 'in_progress') return 'info';
  if (s === 'resolved') return 'success';
  return 'neutral';
}

function priorityTone(p: TicketPriority): Tone {
  if (p === 'urgent') return 'danger';
  if (p === 'high') return 'warning';
  return 'neutral';
}

export default function Tickets() {
  const [status, setStatus] = useState('');
  const q = useTicketsList({ status: status || undefined });
  const summary = q.data?.summary;
  const rows = q.data?.rows ?? [];

  return (
    <Screen>
      <ScreenHeader
        title="Platform tickets"
        subtitle="Cross-product support"
        right={<BackButton onPress={() => router.back()} />}
      />

      {summary ? (
        <View style={{ paddingBottom: space[3] }}>
          <StatGrid>
            <StatTile label="Open" value={String(summary.open)} />
            <StatTile label="In progress" value={String(summary.inProgress)} />
            <StatTile
              label="Urgent"
              value={String(summary.urgentOpen)}
              tone={summary.urgentOpen > 0 ? 'danger' : undefined}
            />
            <StatTile label="Resolved 7d" value={String(summary.resolvedThisWeek)} />
          </StatGrid>
        </View>
      ) : null}

      <View style={{ paddingBottom: space[3] }}>
        <FilterChips options={STATUSES} value={status} onChange={setStatus} />
      </View>

      {q.isLoading ? (
        <LoadingRows />
      ) : rows.length === 0 ? (
        <EmptyState title="No tickets" body="Nothing matches this filter." />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(t) => t.id}
          contentContainerStyle={{ paddingHorizontal: space[4], gap: 8, paddingBottom: space[10] }}
          refreshing={q.isRefetching}
          onRefresh={() => q.refetch()}
          renderItem={({ item }) => <TicketListRow ticket={item} />}
        />
      )}
    </Screen>
  );
}

function TicketListRow({ ticket }: { ticket: TicketRow }) {
  const showPriority = ticket.priority === 'urgent' || ticket.priority === 'high';
  return (
    <ListRow
      title={ticket.subject}
      subtitle={`#${ticket.ticket_number} · ${titleCase(ticket.product_id)}`}
      trailing={
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {showPriority ? <Badge label={ticket.priority} tone={priorityTone(ticket.priority)} /> : null}
          <Badge label={titleCase(ticket.status)} tone={statusTone(ticket.status)} />
        </View>
      }
      onPress={() => router.push(`/platform/ticket/${ticket.id}`)}
    />
  );
}
