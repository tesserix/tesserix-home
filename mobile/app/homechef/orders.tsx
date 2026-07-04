import { useState } from 'react';
import { FlatList, Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useOrders } from '../../lib/hooks';
import { formatINR, titleCase } from '../../lib/format';
import { Badge, EmptyState, LoadingRows, ListRow, Screen, ScreenHeader, FilterChips, type Tone } from '../../components/kit';
import { usePalette, space } from '../../lib/theme';

const STATUSES = [
  { key: '', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'preparing', label: 'Preparing' },
  { key: 'delivering', label: 'Delivering' },
  { key: 'delivered', label: 'Delivered' },
  { key: 'cancelled', label: 'Cancelled' },
] as const;

function orderTone(status: string): Tone {
  if (status === 'delivered') return 'success';
  if (status === 'cancelled' || status === 'rejected') return 'danger';
  if (status === 'pending') return 'warning';
  return 'info';
}

export default function Orders() {
  const [status, setStatus] = useState('');
  const p = usePalette();
  const q = useOrders({ status: status || undefined, page: 1, limit: 30 });
  const rows = q.data?.data ?? [];

  return (
    <Screen>
      <ScreenHeader
        title="Orders"
        right={
          <Pressable onPress={() => router.back()} hitSlop={10} style={{ paddingTop: 4 }}>
            <ChevronLeft size={24} color={p.mutedForeground} />
          </Pressable>
        }
      />
      <View style={{ paddingBottom: space[3] }}>
        <FilterChips options={STATUSES as unknown as { key: string; label: string }[]} value={status} onChange={setStatus} />
      </View>
      {q.isLoading ? (
        <LoadingRows />
      ) : rows.length === 0 ? (
        <EmptyState title="No orders" body="Nothing matches this filter." />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(o) => o.id}
          contentContainerStyle={{ paddingHorizontal: space[4], gap: 8, paddingBottom: space[10] }}
          refreshing={q.isRefetching}
          onRefresh={() => q.refetch()}
          renderItem={({ item }) => (
            <ListRow
              title={`#${item.orderNumber}`}
              subtitle={`${item.customerName} → ${item.chefName} · ${item.itemCount} item${item.itemCount === 1 ? '' : 's'}`}
              meta={formatINR(item.total)}
              trailing={<Badge label={titleCase(item.status)} tone={orderTone(item.status)} />}
            />
          )}
        />
      )}
    </Screen>
  );
}
