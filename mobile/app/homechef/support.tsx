import { useState } from 'react';
import { FlatList, Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronLeft, LifeBuoy } from 'lucide-react-native';
import { useTickets } from '../../lib/hooks';
import { titleCase } from '../../lib/format';
import { Badge, EmptyState, LoadingRows, ListRow, Screen, ScreenHeader, FilterChips, type Tone } from '../../components/kit';
import { usePalette, space } from '../../lib/theme';

const STATUSES = [
  { key: '', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'closed', label: 'Closed' },
] as const;

function tone(s: string): Tone {
  if (s === 'resolved' || s === 'closed') return 'success';
  if (s === 'open') return 'warning';
  return 'info';
}

export default function Support() {
  const [status, setStatus] = useState('');
  const p = usePalette();
  const q = useTickets({ status: status || undefined, page: 1, limit: 30 });
  const rows = q.data?.data ?? [];

  return (
    <Screen>
      <ScreenHeader title="Support" subtitle="Tickets" right={<Pressable onPress={() => router.back()} hitSlop={10} style={{ paddingTop: 4 }}><ChevronLeft size={24} color={p.mutedForeground} /></Pressable>} />
      <View style={{ paddingBottom: space[3] }}>
        <FilterChips options={STATUSES as unknown as { key: string; label: string }[]} value={status} onChange={setStatus} />
      </View>
      {q.isLoading ? <LoadingRows /> : rows.length === 0 ? <EmptyState title="No tickets" /> : (
        <FlatList
          data={rows}
          keyExtractor={(t) => t.id}
          contentContainerStyle={{ paddingHorizontal: space[4], gap: 8, paddingBottom: space[10] }}
          refreshing={q.isRefetching}
          onRefresh={() => q.refetch()}
          renderItem={({ item }) => (
            <ListRow
              title={item.subject}
              subtitle={`#${item.ticketNumber} · ${titleCase(item.category)} · ${item.priority}`}
              icon={LifeBuoy}
              trailing={<Badge label={titleCase(item.status)} tone={tone(item.status)} />}
            />
          )}
        />
      )}
    </Screen>
  );
}
