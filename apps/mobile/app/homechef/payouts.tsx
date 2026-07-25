import { useState } from 'react';
import { Alert, FlatList, Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useStatements, useMarkPaid } from '../../lib/platform-hooks';
import type { StatementRow } from '../../lib/platform-contracts';
import { apiError } from '../../lib/api';
import { useConfirm } from '../../components/prompt';
import { formatINR, formatDate, titleCase } from '@tesserix/homechef-shared';
import { Badge, Button, Card, EmptyState, FilterChips, LoadingRows, Screen, ScreenHeader, type Tone } from '../../components/kit';
import { usePalette, space, text } from '../../lib/theme';

const STATUSES = [
  { key: '', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'paid', label: 'Paid' },
] as const;

function statusTone(s: string): Tone {
  if (s === 'paid') return 'success';
  if (s === 'pending') return 'warning';
  return 'neutral';
}

export default function Payouts() {
  const p = usePalette();
  const [status, setStatus] = useState('');
  const q = useStatements({ status: status || undefined, page: 1 });
  const markPaid = useMarkPaid();
  const { prompt } = useConfirm();
  const rows = q.data?.data ?? [];

  async function mark(row: StatementRow) {
    const ref = await prompt({
      title: 'Mark paid',
      message: `Record a disbursement reference for ${row.chef_name ?? row.chef_id}'s ${formatINR(row.net_payout)} payout. Enter this only after the transfer has actually been sent.`,
      label: 'Payout reference', required: true, confirmLabel: 'Mark paid',
    });
    if (ref === null) return;
    markPaid.mutate({ id: row.id, payoutRef: ref }, { onError: (e) => Alert.alert('Failed', apiError(e)) });
  }

  return (
    <Screen>
      <ScreenHeader
        title="Payouts"
        subtitle={q.data ? `${q.data.pagination.total} statements` : 'Weekly settlements'}
        right={<Pressable onPress={() => router.back()} hitSlop={10} style={{ paddingTop: 4 }}><ChevronLeft size={24} color={p.mutedForeground} /></Pressable>}
      />
      <View style={{ paddingBottom: space[3] }}>
        <FilterChips options={STATUSES as unknown as { key: string; label: string }[]} value={status} onChange={setStatus} />
      </View>
      {q.isLoading ? (
        <LoadingRows />
      ) : rows.length === 0 ? (
        <EmptyState title="No statements" body="Nothing in this filter." />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.id}
          contentContainerStyle={{ paddingHorizontal: space[4], gap: 12, paddingBottom: space[10] }}
          refreshing={q.isRefetching}
          onRefresh={() => q.refetch()}
          renderItem={({ item }) => {
            const paid = item.status === 'paid';
            return (
              <Card>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={[text.title, { color: p.foreground }]}>{item.chef_name ?? item.chef_id.slice(0, 8)}</Text>
                    <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]}>
                      {formatDate(item.week_start)} → {formatDate(item.week_end)} · {item.orders_count} orders
                    </Text>
                  </View>
                  <View style={{ alignItems: 'flex-end', gap: 4 }}>
                    <Text style={{ fontFamily: 'InterTight-SemiBold', fontSize: 16, color: p.foreground, fontVariant: ['tabular-nums'] }}>{formatINR(item.net_payout)}</Text>
                    <Badge label={titleCase(item.status)} tone={statusTone(item.status)} />
                  </View>
                </View>
                <Text style={[text.caption, { color: p.mutedForeground, marginTop: 8 }]}>
                  Gross {formatINR(item.gross_revenue)} · Commission {formatINR(item.platform_commission)} · GST {formatINR(item.cgst + item.sgst + item.igst)} · TDS {formatINR(item.tds)}
                </Text>
                {paid ? (
                  item.payout_ref ? <Text style={[text.caption, { color: p.mutedForeground, marginTop: 4 }]}>Ref: {item.payout_ref}</Text> : null
                ) : (
                  <View style={{ marginTop: 12, alignSelf: 'flex-start' }}>
                    <Button label="Mark paid" variant="secondary" disabled={markPaid.isPending} onPress={() => mark(item)} />
                  </View>
                )}
              </Card>
            );
          }}
        />
      )}
    </Screen>
  );
}
