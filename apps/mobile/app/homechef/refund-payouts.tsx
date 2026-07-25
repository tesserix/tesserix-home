import { Alert, FlatList, Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { usePendingRefunds, useExecuteRefund, type PendingRefundDay } from '../../lib/hooks';
import { apiError } from '../../lib/api';
import { useConfirm } from '../../components/prompt';
import { formatINR, titleCase } from '@tesserix/homechef-shared';
import { Badge, Button, Card, EmptyState, LoadingRows, Screen, ScreenHeader } from '../../components/kit';
import { usePalette, space, text } from '../../lib/theme';

export default function RefundPayouts() {
  const p = usePalette();
  const q = usePendingRefunds();
  const execute = useExecuteRefund();
  const { confirm } = useConfirm();
  const rows = q.data?.data ?? [];

  async function run(row: PendingRefundDay) {
    const ok = await confirm({
      title: 'Execute refund',
      message: `Refund ${formatINR(row.refundAmount)} to ${row.customerName} for ${row.dishName} (${row.date} ${row.slot})? This triggers a real Razorpay reversal (5–7 business days).`,
      confirmLabel: 'Execute refund',
    });
    if (!ok) return;
    execute.mutate(row.dayId, { onError: (e) => Alert.alert('Refund failed', apiError(e)) });
  }

  return (
    <Screen>
      <ScreenHeader
        title="Refund payouts"
        subtitle={q.data ? `${rows.length} pending` : 'Meal-plan refunds'}
        right={<Pressable onPress={() => router.back()} hitSlop={10} style={{ paddingTop: 4 }}><ChevronLeft size={24} color={p.mutedForeground} /></Pressable>}
      />
      {q.isLoading ? (
        <LoadingRows />
      ) : rows.length === 0 ? (
        <EmptyState title="No refunds pending" body="Approved meal-plan refunds show up here." />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.dayId}
          contentContainerStyle={{ paddingHorizontal: space[4], gap: 12, paddingBottom: space[10] }}
          refreshing={q.isRefetching}
          onRefresh={() => q.refetch()}
          renderItem={({ item }) => (
            <Card>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                <View style={{ flex: 1 }}>
                  <Text style={[text.title, { color: p.foreground }]}>{item.dishName}</Text>
                  <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]}>{item.date} · {item.slot} · {item.customerName}</Text>
                  <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]}>{item.chefName} · plan {item.mealPlanNumber}</Text>
                </View>
                <View style={{ alignItems: 'flex-end', gap: 4 }}>
                  <Text style={{ fontFamily: 'InterTight-SemiBold', fontSize: 16, color: p.foreground, fontVariant: ['tabular-nums'] }}>{formatINR(item.refundAmount)}</Text>
                  <Badge label={titleCase(item.chefChoice)} tone={item.chefChoice === 'full' ? 'danger' : 'warning'} />
                </View>
              </View>
              <View style={{ marginTop: 12, alignSelf: 'flex-start' }}>
                <Button label="Execute refund" disabled={execute.isPending} onPress={() => run(item)} />
              </View>
            </Card>
          )}
          ListFooterComponent={
            <Text style={[text.caption, { color: p.mutedForeground, marginTop: 12 }]}>
              Refund covers food + delivery fee, excluding GST + platform fee.
            </Text>
          }
        />
      )}
    </Screen>
  );
}
