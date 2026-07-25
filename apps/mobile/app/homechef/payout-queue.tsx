import { useState } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { usePendingPayouts, usePayoutAction, useBulkReleasePayouts } from '../../lib/hooks';
import { apiError } from '../../lib/api';
import { useConfirm } from '../../components/prompt';
import { formatINR, titleCase, type PendingPayout, type PayoutHoldStatus } from '@tesserix/homechef-shared';
import { Badge, Button, Card, EmptyState, LoadingRows, Screen, ScreenHeader, type Tone } from '../../components/kit';
import { usePalette, space, text } from '../../lib/theme';

const SLA_HOURS = 24;

function holdTone(status: PayoutHoldStatus): Tone {
  switch (status) {
    case 'release_eligible': return 'success';
    case 'awaiting_customer_confirmation':
    case 'withheld': return 'warning';
    case 'released': return 'info';
    case 'reversed':
    case 'disputed': return 'danger';
    default: return 'neutral';
  }
}
function ageLabel(hours: number): { label: string; overdue: boolean } {
  const rounded = Math.max(0, Math.round(hours));
  const label = rounded >= 48 ? `${Math.round(rounded / 24)}d` : `${rounded}h`;
  return { label, overdue: hours > SLA_HOURS };
}
function aggLabel(aggType: PendingPayout['aggType']): string {
  return aggType === 'meal-plan-day' ? 'Tiffin day' : aggType === 'group-order' ? 'Group order' : 'Order';
}

export default function PayoutQueue() {
  const p = usePalette();
  const [includeAwaiting, setIncludeAwaiting] = useState(false);
  const q = usePendingPayouts(includeAwaiting);
  const action = usePayoutAction();
  const bulk = useBulkReleasePayouts();
  const { confirm, prompt } = useConfirm();
  const rows = q.data?.payouts ?? [];
  const eligible = rows.filter((x) => x.holdStatus === 'release_eligible' && !x.hasOpenIssue);
  const busy = action.isPending || bulk.isPending;

  async function release(pp: PendingPayout) {
    const ok = await confirm({
      title: 'Release payout',
      message: pp.hasOpenIssue
        ? `This hold has an OPEN ISSUE. Release ${formatINR(pp.netPayout)} to the chef anyway?`
        : `Release ${formatINR(pp.netPayout)} to the chef?`,
      confirmLabel: 'Release',
      tone: pp.hasOpenIssue ? 'destructive' : 'default',
    });
    if (!ok) return;
    action.mutate({ path: `/payouts/${pp.aggType}/${pp.id}/release` }, { onError: (e) => Alert.alert('Release failed', apiError(e)) });
  }
  async function withhold(pp: PendingPayout) {
    const reason = await prompt({
      title: 'Withhold payout', message: 'Park this hold. A reason is required.',
      label: 'Reason', multiline: true, required: true, confirmLabel: 'Withhold',
    });
    if (reason === null) return;
    action.mutate({ path: `/payouts/${pp.aggType}/${pp.id}/withhold`, reason }, { onError: (e) => Alert.alert('Withhold failed', apiError(e)) });
  }
  async function reverse(pp: PendingPayout) {
    const reason = await prompt({
      title: 'Reverse payout', message: 'Claw back an already-released payout. A reason is required.',
      label: 'Reason', multiline: true, required: true, confirmLabel: 'Reverse', tone: 'destructive',
    });
    if (reason === null) return;
    action.mutate({ path: `/payouts/${pp.aggType}/${pp.id}/reverse`, reason }, { onError: (e) => Alert.alert('Reverse failed', apiError(e)) });
  }
  async function releaseAll() {
    if (eligible.length === 0) return;
    const ok = await confirm({ title: 'Release all', message: `Release ${eligible.length} eligible payout(s) to chefs?`, confirmLabel: `Release ${eligible.length}` });
    if (!ok) return;
    bulk.mutate(eligible.map((x) => ({ aggType: x.aggType, id: x.id })), { onError: (e) => Alert.alert('Bulk release failed', apiError(e)) });
  }

  return (
    <Screen>
      <ScreenHeader
        title="Payout queue"
        subtitle={q.data ? `${q.data.count} holds · ${eligible.length} eligible` : 'Escrow release'}
        right={<Pressable onPress={() => router.back()} hitSlop={10} style={{ paddingTop: 4 }}><ChevronLeft size={24} color={p.mutedForeground} /></Pressable>}
      />
      {q.isLoading ? (
        <LoadingRows />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: space[4], paddingBottom: space[10], gap: 12 }}
          refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => q.refetch()} />}
        >
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Button label={eligible.length > 0 ? `Release all (${eligible.length})` : 'Release all'} disabled={busy || eligible.length === 0} onPress={releaseAll} />
            </View>
            <View style={{ flex: 1 }}>
              <Button label={includeAwaiting ? 'Eligible only' : 'Include awaiting'} variant="secondary" onPress={() => setIncludeAwaiting((v) => !v)} />
            </View>
          </View>
          {rows.length === 0 ? (
            <EmptyState title="Queue empty" body="No holds to release." />
          ) : (
            rows.map((pp) => {
              const age = ageLabel(pp.ageHours);
              return (
                <Card key={`${pp.aggType}-${pp.id}`}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                    <View style={{ flex: 1 }}>
                      <Text style={[text.title, { color: p.foreground }]} numberOfLines={1}>{pp.context || aggLabel(pp.aggType)}</Text>
                      <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]}>
                        {aggLabel(pp.aggType)} · {pp.customerConfirmedAt ? 'confirmed' : 'auto'} · {formatINR(pp.amount)} gross
                      </Text>
                    </View>
                    <View style={{ alignItems: 'flex-end', gap: 4 }}>
                      <Text style={{ fontFamily: 'InterTight-SemiBold', fontSize: 16, color: p.foreground, fontVariant: ['tabular-nums'] }}>{formatINR(pp.netPayout)}</Text>
                      <Badge label={age.label} tone={age.overdue ? 'danger' : 'neutral'} />
                    </View>
                  </View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 }}>
                    <Badge label={titleCase(pp.holdStatus)} tone={holdTone(pp.holdStatus)} />
                    {pp.hasOpenIssue ? <Badge label="Open issue" tone="danger" /> : null}
                  </View>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
                    <Button label="Release" disabled={busy} tone={pp.hasOpenIssue ? 'danger' : 'default'} onPress={() => release(pp)} />
                    <Button label="Withhold" variant="secondary" disabled={busy} onPress={() => withhold(pp)} />
                    <Button label="Reverse" variant="secondary" tone="danger" disabled={busy} onPress={() => reverse(pp)} />
                  </View>
                </Card>
              );
            })
          )}
        </ScrollView>
      )}
    </Screen>
  );
}
