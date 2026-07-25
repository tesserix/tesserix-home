import { useState } from 'react';
import { Alert, FlatList, Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useReviews, useAdminAction } from '../../lib/hooks';
import { apiError } from '../../lib/api';
import { useConfirm } from '../../components/prompt';
import { formatDateTime, type ReviewRow } from '@tesserix/homechef-shared';
import {
  Badge, Button, Card, EmptyState, FilterChips, LoadingRows, Screen, ScreenHeader, type Tone,
} from '../../components/kit';
import { usePalette, space, text } from '../../lib/theme';

const VIEWS = [
  { key: 'visible', label: 'Visible' },
  { key: 'hidden', label: 'Hidden' },
] as const;
type ReviewView = (typeof VIEWS)[number]['key'];

function ratingTone(r: number): Tone {
  if (r >= 4) return 'success';
  if (r >= 3) return 'warning';
  return 'danger';
}

export default function Reviews() {
  const p = usePalette();
  const [view, setView] = useState<ReviewView>('visible');
  const q = useReviews({ hidden: view === 'hidden' ? true : false, page: 1, limit: 50 });
  const action = useAdminAction(['hc', 'reviews']);
  const { prompt } = useConfirm();
  const rows = q.data?.data ?? [];

  async function hide(r: ReviewRow) {
    const reason = await prompt({
      title: 'Hide review',
      message: "This hides the review from the chef's page. The reason is kept for audit.",
      label: 'Reason',
      placeholder: 'e.g. abusive language / spam',
      multiline: true,
      required: true,
      confirmLabel: 'Hide review',
      tone: 'destructive',
    });
    if (reason === null) return;
    action.mutate(
      { method: 'put', path: `/reviews/${r.id}/hide`, body: { reason } },
      { onError: (e) => Alert.alert('Could not hide', apiError(e)) },
    );
  }
  function unhide(r: ReviewRow) {
    action.mutate(
      { method: 'put', path: `/reviews/${r.id}/unhide` },
      { onError: (e) => Alert.alert('Could not unhide', apiError(e)) },
    );
  }

  return (
    <Screen>
      <ScreenHeader
        title="Reviews"
        subtitle={q.data ? `${q.data.pagination.total} ${view}` : 'Moderation'}
        right={
          <Pressable onPress={() => router.back()} hitSlop={10} style={{ paddingTop: 4 }}>
            <ChevronLeft size={24} color={p.mutedForeground} />
          </Pressable>
        }
      />
      <View style={{ paddingBottom: space[3] }}>
        <FilterChips options={VIEWS as unknown as { key: ReviewView; label: string }[]} value={view} onChange={setView} />
      </View>
      {q.isLoading ? (
        <LoadingRows />
      ) : rows.length === 0 ? (
        <EmptyState title="No reviews" body="Nothing in this view." />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.id}
          contentContainerStyle={{ paddingHorizontal: space[4], gap: 12, paddingBottom: space[10] }}
          refreshing={q.isRefetching}
          onRefresh={() => q.refetch()}
          renderItem={({ item }) => {
            const busy = action.isPending;
            return (
              <Card>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Badge label={`${item.overallRating?.toFixed(1) ?? '0.0'}★`} tone={ratingTone(item.overallRating)} />
                  <Text style={[text.caption, { color: p.mutedForeground }]}>{formatDateTime(item.createdAt)}</Text>
                </View>
                <Text style={[text.body, { color: p.foreground, marginTop: 8 }]}>{item.comment || 'No comment'}</Text>
                {item.isHidden && item.hiddenReason ? (
                  <Text style={{ fontFamily: 'InterTight-Medium', fontSize: 12, color: p.destructive, marginTop: 8 }}>
                    Hidden: {item.hiddenReason}
                  </Text>
                ) : null}
                <View style={{ marginTop: 12, alignSelf: 'flex-start' }}>
                  {item.isHidden ? (
                    <Button label="Unhide review" variant="secondary" disabled={busy} onPress={() => unhide(item)} />
                  ) : (
                    <Button label="Hide review" variant="secondary" tone="danger" disabled={busy} onPress={() => hide(item)} />
                  )}
                </View>
              </Card>
            );
          }}
        />
      )}
    </Screen>
  );
}
