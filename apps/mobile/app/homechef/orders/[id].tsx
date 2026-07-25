import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useOrder } from '../../../lib/hooks';
import { formatINR, formatDateTime, titleCase } from '@tesserix/homechef-shared';
import { Badge, Button, Card, LoadingRows, Screen, ScreenHeader, SectionLabel, type Tone } from '../../../components/kit';
import { usePalette, space, text } from '../../../lib/theme';

function statusTone(s: string): Tone {
  if (s === 'delivered') return 'success';
  if (s === 'cancelled' || s === 'rejected') return 'danger';
  if (s === 'pending') return 'warning';
  return 'info';
}
function paymentTone(s: string): Tone {
  if (s === 'completed') return 'success';
  if (s === 'refunded' || s === 'failed') return 'danger';
  return 'warning';
}

function Fact({ label, value }: { label: string; value: string }) {
  const p = usePalette();
  return (
    <View style={{ minWidth: 120, flexGrow: 1, flexBasis: '40%' }}>
      <Text style={[text.caption, { color: p.mutedForeground }]}>{label}</Text>
      <Text style={[text.body, { color: p.foreground, marginTop: 2 }]}>{value}</Text>
    </View>
  );
}

export default function OrderDetail() {
  const p = usePalette();
  const { id } = useLocalSearchParams<{ id: string }>();
  const q = useOrder(id);
  const back = (
    <Pressable onPress={() => router.back()} hitSlop={10} style={{ paddingTop: 4 }}>
      <ChevronLeft size={24} color={p.mutedForeground} />
    </Pressable>
  );

  if (q.isLoading) {
    return (
      <Screen>
        <ScreenHeader title="Order" right={back} />
        <LoadingRows />
      </Screen>
    );
  }
  if (!q.data) {
    return (
      <Screen>
        <ScreenHeader title="Order" right={back} />
        <Text style={[text.body, { color: p.mutedForeground, padding: space[4] }]}>Order not found.</Text>
      </Screen>
    );
  }

  const { order, customer, chef } = q.data;
  const items = order.items ?? [];
  const refunded = order.refundAmount > 0;

  return (
    <Screen>
      <ScreenHeader
        title={order.orderNumber}
        subtitle={`Placed ${formatDateTime(order.createdAt)} · ${titleCase(order.fulfillmentType)}`}
        right={back}
      />
      <ScrollView contentContainerStyle={{ paddingHorizontal: space[4], paddingBottom: space[10], gap: space[4] }}>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Badge label={titleCase(order.status)} tone={statusTone(order.status)} />
          <Badge label={titleCase(order.paymentStatus)} tone={paymentTone(order.paymentStatus)} />
        </View>

        <View>
          <SectionLabel>Money</SectionLabel>
          <Card>
            <View style={styles.grid}>
              <Fact label="Subtotal" value={formatINR(order.subtotal)} />
              {order.serviceFee > 0 ? <Fact label="Service fee" value={formatINR(order.serviceFee)} /> : null}
              <Fact label="Delivery fee" value={formatINR(order.deliveryFee)} />
              <Fact label="Tax" value={formatINR(order.tax)} />
              {order.chefTip > 0 ? <Fact label="Chef tip" value={formatINR(order.chefTip)} /> : null}
              {order.driverTip > 0 ? <Fact label="Driver tip" value={formatINR(order.driverTip)} /> : null}
              {order.discount > 0 ? (
                <Fact label={order.promoCode ? `Discount (${order.promoCode})` : 'Discount'} value={`−${formatINR(order.discount)}`} />
              ) : null}
              {order.walletApplied > 0 ? <Fact label="Wallet applied" value={`−${formatINR(order.walletApplied)}`} /> : null}
              <Fact label="Total" value={formatINR(order.total)} />
              <Fact label="Paid via" value={titleCase(order.paymentProvider || '—')} />
              <Fact label="Refunded" value={refunded ? formatINR(order.refundAmount) : '—'} />
              {refunded ? <Fact label="Refund reason" value={order.refundReason || '—'} /> : null}
              {refunded ? <Fact label="Refund by" value={order.refundInitiatedBy ? titleCase(order.refundInitiatedBy) : '—'} /> : null}
            </View>
            {order.cancelledAt ? (
              <Text style={[text.caption, { color: p.mutedForeground, marginTop: 12 }]}>
                Cancelled {formatDateTime(order.cancelledAt)}{order.cancelReason ? ` — ${order.cancelReason}` : ''}
              </Text>
            ) : null}
          </Card>
        </View>

        <View>
          <SectionLabel>Customer</SectionLabel>
          <Card>
            <View style={styles.grid}>
              <Fact label="Name" value={customer.name || '—'} />
              <Fact label="Email" value={customer.email || '—'} />
              <Fact label="Phone" value={customer.phone || '—'} />
              <Fact label="Joined" value={formatDateTime(customer.createdAt)} />
            </View>
          </Card>
        </View>

        <View>
          <SectionLabel>Chef</SectionLabel>
          <Card>
            <View style={styles.grid}>
              <Fact label="Kitchen" value={chef.businessName || '—'} />
              <Fact label="City" value={chef.city || '—'} />
            </View>
          </Card>
        </View>

        <View>
          <SectionLabel>Items</SectionLabel>
          <Card>
            {items.length === 0 ? (
              <Text style={[text.caption, { color: p.mutedForeground }]}>No line items on this order.</Text>
            ) : (
              <View style={{ gap: 10 }}>
                {items.map((it) => (
                  <View key={it.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text style={[text.body, { color: p.foreground, flex: 1 }]} numberOfLines={1}>{it.name}</Text>
                    <Text style={[text.caption, { color: p.mutedForeground, fontVariant: ['tabular-nums'] }]}>
                      {formatINR(it.price)} × {it.quantity}
                    </Text>
                    <Text style={[text.body, { color: p.foreground, fontVariant: ['tabular-nums'], minWidth: 68, textAlign: 'right' }]}>
                      {formatINR(it.subtotal)}
                    </Text>
                  </View>
                ))}
              </View>
            )}
          </Card>
        </View>

        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          <View style={{ flexGrow: 1, flexBasis: '45%' }}>
            <Button label="Cancellation arbitration" variant="secondary" onPress={() => router.push('/homechef/cancellations' as never)} />
          </View>
          <View style={{ flexGrow: 1, flexBasis: '45%' }}>
            <Button label="Order issues" variant="secondary" onPress={() => router.push('/homechef/support' as never)} />
          </View>
        </View>

        <Text style={[text.mono, { color: p.mutedForeground }]}>{order.id}</Text>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({ grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 } });
