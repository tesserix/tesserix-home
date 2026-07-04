import { useState } from 'react';
import { Alert, FlatList, Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronLeft, Star } from 'lucide-react-native';
import { useReviews, useAdminAction, qk } from '../../lib/hooks';
import { apiError } from '../../lib/api';
import { Badge, EmptyState, LoadingRows, ListRow, Screen, ScreenHeader, FilterChips } from '../../components/kit';
import { usePalette, space } from '../../lib/theme';
import type { ReviewRow } from '../../lib/contracts';

const TABS = [
  { key: 'false', label: 'Visible' },
  { key: 'true', label: 'Hidden' },
] as const;

export default function Reviews() {
  const [hidden, setHidden] = useState('false');
  const p = usePalette();
  const q = useReviews({ hidden: hidden === 'true', page: 1, limit: 30 });
  const action = useAdminAction(qk.reviews({}));
  const rows = q.data?.data ?? [];

  function act(r: ReviewRow) {
    if (r.isHidden) {
      action.mutate({ method: 'put', path: `/reviews/${r.id}/unhide` }, { onError: (e) => Alert.alert('Failed', apiError(e)) });
    } else {
      action.mutate({ method: 'put', path: `/reviews/${r.id}/hide`, body: { reason: 'Hidden by admin' } }, { onError: (e) => Alert.alert('Failed', apiError(e)) });
    }
  }

  return (
    <Screen>
      <ScreenHeader title="Reviews" right={<Pressable onPress={() => router.back()} hitSlop={10} style={{ paddingTop: 4 }}><ChevronLeft size={24} color={p.mutedForeground} /></Pressable>} />
      <View style={{ paddingBottom: space[3] }}>
        <FilterChips options={TABS as unknown as { key: string; label: string }[]} value={hidden} onChange={setHidden} />
      </View>
      {q.isLoading ? <LoadingRows /> : rows.length === 0 ? <EmptyState title="No reviews" /> : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.id}
          contentContainerStyle={{ paddingHorizontal: space[4], gap: 8, paddingBottom: space[10] }}
          refreshing={q.isRefetching}
          onRefresh={() => q.refetch()}
          renderItem={({ item }) => (
            <ListRow
              title={`${'★'.repeat(Math.round(item.rating))}${'☆'.repeat(5 - Math.round(item.rating))}`}
              subtitle={item.text || item.comment || 'No comment'}
              icon={Star}
              trailing={<Badge label={item.isHidden ? 'Unhide' : 'Hide'} tone={item.isHidden ? 'info' : 'neutral'} />}
              onPress={() => act(item)}
            />
          )}
        />
      )}
    </Screen>
  );
}
