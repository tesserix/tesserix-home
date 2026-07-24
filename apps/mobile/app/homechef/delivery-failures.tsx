import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useDeliveryFailures, useResolveDeliveryFailure } from '../../lib/hooks';
import { apiError } from '../../lib/api';
import { formatINR, titleCase } from '../../lib/format';
import { Badge, EmptyState, LoadingRows, Screen, ScreenHeader, SectionLabel, Button, type Tone } from '../../components/kit';
import { usePalette, space, radius, text } from '../../lib/theme';
import type { DeliveryFaultClass, PayoutHoldStatus } from '../../lib/contracts';

// Delivery-failure fault arbitration (#613) — the mobile twin of the web queue.
// CUSTOMER fault → chef paid, customer NOT refunded (delivery fee retained);
// PLATFORM/CHEF fault → customer fully refunded + chef payout blocked. Money moves
// server-side when escrow is live; here we advance the DB hold state.

function holdTone(s: PayoutHoldStatus): Tone {
  switch (s) {
    case 'release_eligible':
      return 'success';
    case 'released':
      return 'info';
    case 'awaiting_customer_confirmation':
    case 'withheld':
      return 'warning';
    case 'reversed':
    case 'disputed':
      return 'danger';
    default:
      return 'neutral';
  }
}

const FAULTS: { fault: DeliveryFaultClass; label: string }[] = [
  { fault: 'customer', label: 'Customer' },
  { fault: 'platform', label: 'Platform' },
  { fault: 'chef', label: 'Chef' },
];

function faultOutcome(fault: DeliveryFaultClass): string {
  return fault === 'customer'
    ? 'the chef is paid and the customer is NOT refunded (delivery fee retained)'
    : 'the customer is fully refunded and the chef payout is blocked';
}

export default function DeliveryFailures() {
  const p = usePalette();
  const q = useDeliveryFailures();
  const resolve = useResolveDeliveryFailure();
  const orders = q.data?.orderIssues ?? [];
  const days = q.data?.mealPlanDays ?? [];
  const groups = q.data?.groupOrders ?? [];
  const total = orders.length + days.length + groups.length;

  function confirmFault(context: string, amount: number, path: string, fault: DeliveryFaultClass) {
    Alert.alert(
      `${titleCase(fault)} fault`,
      `Confirm ${fault.toUpperCase()} fault for ${context} (${formatINR(amount)}): ${faultOutcome(fault)}.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: `Confirm ${fault}`,
          style: fault === 'customer' ? 'default' : 'destructive',
          onPress: () =>
            resolve.mutate({ path, fault }, { onError: (e) => Alert.alert('Could not resolve', apiError(e)) }),
        },
      ],
    );
  }

  function FaultRow({
    title,
    sub,
    hold,
    amount,
    context,
    path,
  }: {
    title: string;
    sub?: string;
    hold: PayoutHoldStatus;
    amount: number;
    context: string;
    path: string;
  }) {
    return (
      <View style={[styles.card, { backgroundColor: p.surface, borderColor: p.border }]}>
        <View style={styles.rowBetween}>
          <Text style={[text.title, { color: p.foreground }]}>{title}</Text>
          <Badge label={titleCase(hold)} tone={holdTone(hold)} />
        </View>
        {sub ? <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]}>{sub}</Text> : null}
        <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]}>{formatINR(amount)}</Text>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
          {FAULTS.map((f) => (
            <View key={f.fault} style={{ flex: 1 }}>
              <Button
                label={f.label}
                variant={f.fault === 'customer' ? 'secondary' : 'primary'}
                tone={f.fault === 'customer' ? 'default' : 'danger'}
                onPress={() => confirmFault(context, amount, path, f.fault)}
                disabled={resolve.isPending}
              />
            </View>
          ))}
        </View>
      </View>
    );
  }

  return (
    <Screen>
      <ScreenHeader
        title="Delivery failures"
        subtitle="Confirm fault on failed deliveries"
        right={
          <Pressable onPress={() => router.back()} hitSlop={10} style={{ paddingTop: 4 }}>
            <ChevronLeft size={24} color={p.mutedForeground} />
          </Pressable>
        }
      />
      {q.isLoading ? (
        <LoadingRows />
      ) : total === 0 ? (
        <EmptyState title="Nothing to resolve" body="Failed deliveries awaiting a fault decision show up here." />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: space[4], paddingBottom: space[10], gap: 16 }}
          refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => q.refetch()} />}
        >
          {orders.length > 0 ? (
            <View style={{ gap: 8 }}>
              <SectionLabel>Orders ({orders.length})</SectionLabel>
              {orders.map((o) => (
                <FaultRow
                  key={o.issueId}
                  title={`Order ${o.orderNumber || o.orderId.slice(0, 8)}`}
                  sub={`${titleCase(o.reason || '—')} · reported by ${titleCase(o.reportedBy || '—')}`}
                  hold={o.holdStatus}
                  amount={o.total}
                  context={`order ${o.orderNumber || o.orderId.slice(0, 8)}`}
                  path={`/order-issues/${o.issueId}/resolve-delivery-failure`}
                />
              ))}
            </View>
          ) : null}

          {days.length > 0 ? (
            <View style={{ gap: 8 }}>
              <SectionLabel>Tiffin days ({days.length})</SectionLabel>
              {days.map((d) => (
                <FaultRow
                  key={d.dayId}
                  title={`Plan ${d.mealPlanNumber || d.mealPlanId.slice(0, 8)}`}
                  sub={d.date ? new Date(d.date).toLocaleDateString() : undefined}
                  hold={d.holdStatus}
                  amount={d.price}
                  context={`tiffin day ${d.mealPlanNumber || d.mealPlanId.slice(0, 8)}`}
                  path={`/meal-plan-days/${d.dayId}/resolve-delivery-failure`}
                />
              ))}
            </View>
          ) : null}

          {groups.length > 0 ? (
            <View style={{ gap: 8 }}>
              <SectionLabel>Group orders ({groups.length})</SectionLabel>
              {groups.map((g) => (
                <FaultRow
                  key={g.groupId}
                  title={`Group ${g.groupId.slice(0, 8)}`}
                  hold={g.holdStatus}
                  amount={g.subtotal + g.tax}
                  context={`group ${g.groupId.slice(0, 8)}`}
                  path={`/group-orders/${g.groupId}/resolve-delivery-failure`}
                />
              ))}
            </View>
          ) : null}
        </ScrollView>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, padding: space[4] },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});
