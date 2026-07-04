import { useState } from 'react';
import { FlatList, Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useMealPlans } from '../../lib/hooks';
import { formatINR, titleCase } from '../../lib/format';
import { Badge, EmptyState, LoadingRows, ListRow, Screen, ScreenHeader, FilterChips, type Tone } from '../../components/kit';
import { usePalette, space } from '../../lib/theme';

const STATUSES = [
  { key: '', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'pending_chef', label: 'Pending' },
  { key: 'completed', label: 'Completed' },
  { key: 'cancelled', label: 'Cancelled' },
] as const;

function tone(s: string): Tone {
  if (s === 'active') return 'success';
  if (s === 'cancelled') return 'danger';
  if (s.startsWith('pending') || s.includes('await')) return 'warning';
  return 'neutral';
}

export default function MealPlans() {
  const [status, setStatus] = useState('');
  const p = usePalette();
  const q = useMealPlans({ status: status || undefined, page: 1, limit: 30 });
  const rows = q.data?.data ?? [];

  return (
    <Screen>
      <ScreenHeader title="Meal plans" right={<Pressable onPress={() => router.back()} hitSlop={10} style={{ paddingTop: 4 }}><ChevronLeft size={24} color={p.mutedForeground} /></Pressable>} />
      <View style={{ paddingBottom: space[3] }}>
        <FilterChips options={STATUSES as unknown as { key: string; label: string }[]} value={status} onChange={setStatus} />
      </View>
      {q.isLoading ? <LoadingRows /> : rows.length === 0 ? <EmptyState title="No meal plans" /> : (
        <FlatList
          data={rows}
          keyExtractor={(m) => m.id}
          contentContainerStyle={{ paddingHorizontal: space[4], gap: 8, paddingBottom: space[10] }}
          refreshing={q.isRefetching}
          onRefresh={() => q.refetch()}
          renderItem={({ item }) => (
            <ListRow
              title={`${item.mealCount ?? item.daysPerWeek ?? ''} meals`.trim() || 'Meal plan'}
              subtitle={[item.startDate, item.endDate].filter(Boolean).join(' → ') || 'Tiffin subscription'}
              meta={item.totalPrice ? formatINR(item.totalPrice) : undefined}
              trailing={<Badge label={titleCase(item.status)} tone={tone(item.status)} />}
            />
          )}
        />
      )}
    </Screen>
  );
}
