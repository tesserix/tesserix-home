import { useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useCancellations, useResolveCancellation } from '../../lib/hooks';
import { apiError } from '../../lib/api';
import { formatINR } from '../../lib/format';
import { Badge, Button, EmptyState, LoadingRows, Screen, ScreenHeader, type Tone } from '../../components/kit';
import { usePalette, space, radius, text } from '../../lib/theme';
import { CANCEL_REASONS, type AdminCancellationRequest, type CancelReasonValue } from '../../lib/contracts';

// Admin arbitration of cancellation requests (#475/#480) — the mobile twin of the
// tesserix-home web page + the HomeChef mobile-admin screen. Disputes + vendor
// timeouts; the admin picks the correct tier and the Go API issues the refund
// (timeout) or tops it up to the difference (dispute). Money is in paise.
const money = (paise: number) => formatINR((paise ?? 0) / 100);

function statusMeta(status: string): { label: string; tone: Tone } {
  if (status === 'disputed') return { label: 'Disputed', tone: 'danger' };
  if (status === 'admin_review') return { label: 'Vendor timeout', tone: 'warning' };
  if (status === 'resolved') return { label: 'Resolved', tone: 'success' };
  return { label: status, tone: 'info' };
}

export default function Cancellations() {
  const p = usePalette();
  const q = useCancellations();
  const rows = q.data?.data ?? [];

  return (
    <Screen>
      <ScreenHeader
        title="Cancellations"
        subtitle="Disputes & vendor timeouts"
        right={
          <Pressable onPress={() => router.back()} hitSlop={10} style={{ paddingTop: 4 }}>
            <ChevronLeft size={24} color={p.mutedForeground} />
          </Pressable>
        }
      />
      {q.isLoading ? (
        <LoadingRows />
      ) : rows.length === 0 ? (
        <EmptyState title="Nothing to review" body="Disputes and vendor timeouts show up here." />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.id}
          contentContainerStyle={{ paddingHorizontal: space[4], gap: 12, paddingBottom: space[10] }}
          refreshing={q.isRefetching}
          onRefresh={() => q.refetch()}
          renderItem={({ item }) => <ArbitrationCard req={item} />}
        />
      )}
    </Screen>
  );
}

function ArbitrationCard({ req }: { req: AdminCancellationRequest }) {
  const p = usePalette();
  const [reason, setReason] = useState<CancelReasonValue | null>(null);
  const [note, setNote] = useState('');
  const resolve = useResolveCancellation();
  const st = statusMeta(req.status);

  function onResolve() {
    if (!reason) return;
    resolve.mutate(
      { id: req.id, reason, note },
      {
        onSuccess: () => Alert.alert('Resolved', 'Any additional refund has been issued to the customer.'),
        onError: (e) => Alert.alert('Could not resolve', apiError(e)),
      },
    );
  }

  return (
    <View style={[styles.card, { backgroundColor: p.surface, borderColor: p.border }]}>
      <View style={styles.rowBetween}>
        <Text style={[text.title, { color: p.foreground }]}>Order {req.orderId.slice(0, 8)}</Text>
        <Badge label={st.label} tone={st.tone} />
      </View>
      {req.customerReason ? (
        <Text style={[text.caption, { color: p.mutedForeground, marginTop: 4 }]}>Customer: “{req.customerReason}”</Text>
      ) : null}
      {req.disputeReason ? (
        <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]}>Dispute: “{req.disputeReason}”</Text>
      ) : null}
      {req.refundExecuted ? (
        <Text style={[text.caption, { color: p.mutedForeground, marginTop: 4 }]}>
          Already refunded {money(req.refundTotalPaise)} · vendor kept {money(req.vendorKeptPaise)}
        </Text>
      ) : null}

      <Text style={[text.label, { color: p.foreground, marginTop: 12, marginBottom: 6 }]}>Correct tier</Text>
      <View style={{ gap: 8 }}>
        {CANCEL_REASONS.map((t) => {
          const active = reason === t.value;
          return (
            <Pressable
              key={t.value}
              onPress={() => setReason(t.value)}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              style={[styles.tier, { borderColor: active ? p.primary : p.border, backgroundColor: active ? p.muted : 'transparent' }]}
            >
              <Text style={{ fontFamily: 'InterTight-SemiBold', fontSize: 14, color: p.foreground }}>{t.label}</Text>
              <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]}>{t.hint}</Text>
            </Pressable>
          );
        })}
      </View>

      <TextInput
        value={note}
        onChangeText={setNote}
        placeholder="Internal note (optional)"
        placeholderTextColor={p.mutedForeground}
        multiline
        style={[styles.note, { borderColor: p.border, color: p.foreground, backgroundColor: p.muted }]}
      />

      <View style={{ marginTop: 12 }}>
        <Button
          label="Resolve"
          onPress={onResolve}
          disabled={!reason || resolve.isPending}
          loading={resolve.isPending}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, padding: space[4] },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  tier: { borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, padding: 12 },
  note: {
    marginTop: 12,
    minHeight: 44,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: 'InterTight',
    fontSize: 14,
    textAlignVertical: 'top',
  },
});
