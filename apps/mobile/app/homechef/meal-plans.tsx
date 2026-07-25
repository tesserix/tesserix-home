import { useState } from 'react';
import { FlatList, Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useMealPlans } from '../../lib/hooks';
import { formatDate, formatINR, titleCase, type MealPlanRow } from '@tesserix/homechef-shared';
import { Badge, EmptyState, FilterChips, ListRow, LoadingRows, Screen, ScreenHeader, type Tone } from '../../components/kit';
import { usePalette, space } from '../../lib/theme';

const STATUSES = [
  { key: '', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'paused', label: 'Paused' },
  { key: 'cancelled', label: 'Cancelled' },
] as const;

function planTone(status: string): Tone {
  if (status === 'active') return 'success';
  if (status === 'cancelled') return 'danger';
  if (status === 'paused') return 'warning';
  return 'neutral';
}

export default function MealPlans() {
  const p = usePalette();
  const [status, setStatus] = useState('');
  const q = useMealPlans({ status: status || undefined, page: 1, limit: 50 });
  const rows = q.data?.data ?? [];

  return (
    <Screen>
      <ScreenHeader
        title="Meal plans"
        subtitle={q.data ? `${q.data.pagination.total} subscriptions · read-only` : 'Subscription oversight'}
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
        <EmptyState title="No meal plans" body="Nothing in this filter." />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(m) => m.id}
          contentContainerStyle={{ paddingHorizontal: space[4], gap: 8, paddingBottom: space[10] }}
          refreshing={q.isRefetching}
          onRefresh={() => q.refetch()}
          renderItem={({ item }: { item: MealPlanRow }) => {
            const window = item.startDate
              ? `${formatDate(item.startDate)} → ${item.endDate ? formatDate(item.endDate) : 'ongoing'}`
              : '—';
            return (
              <ListRow
                title={item.id.slice(0, 8)}
                subtitle={`${window} · ${item.days?.length ?? 0} meals`}
                meta={formatINR(item.total)}
                trailing={<Badge label={titleCase(item.status)} tone={planTone(item.status)} />}
              />
            );
          }}
        />
      )}
    </Screen>
  );
}
