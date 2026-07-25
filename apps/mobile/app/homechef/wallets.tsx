import { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useWallet, useAdjustWallet } from '../../lib/hooks';
import { apiError } from '../../lib/api';
import { formatINR, formatDateTime, titleCase, type WalletTxn } from '@tesserix/homechef-shared';
import { Button, Card, EmptyState, LoadingRows, Screen, ScreenHeader, SectionLabel } from '../../components/kit';
import { usePalette, space, radius, text } from '../../lib/theme';

export default function Wallets() {
  const p = usePalette();
  const params = useLocalSearchParams<{ userId?: string }>();
  const [input, setInput] = useState(params.userId ?? '');
  const [active, setActive] = useState(params.userId ?? '');
  const [type, setType] = useState<'credit' | 'debit'>('credit');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const q = useWallet(active);
  const adjust = useAdjustWallet(active);
  const data = q.data;

  function apply() {
    setError(null);
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) return setError('Enter an amount greater than zero.');
    if (reason.trim().length < 3) return setError('A reason of at least 3 characters is required.');
    adjust.mutate(
      { amount: amt, reason: reason.trim(), type },
      { onSuccess: () => { setAmount(''); setReason(''); }, onError: (e) => setError(apiError(e)) },
    );
  }

  return (
    <Screen>
      <ScreenHeader
        title="Wallets"
        subtitle="Store credit — ledger & adjustments"
        right={
          <Pressable onPress={() => router.back()} hitSlop={10} style={{ paddingTop: 4 }}>
            <ChevronLeft size={24} color={p.mutedForeground} />
          </Pressable>
        }
      />
      <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: space[4], paddingBottom: space[3] }}>
        <TextInput
          value={input}
          onChangeText={setInput}
          placeholder="Customer user ID"
          placeholderTextColor={p.mutedForeground}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.input, { flex: 1, borderColor: p.border, color: p.foreground, backgroundColor: p.muted }]}
        />
        <Button label="Load" onPress={() => setActive(input.trim())} />
      </View>
      {!active ? (
        <EmptyState title="No wallet loaded" body="Enter a customer user ID, or open a wallet from Users." />
      ) : q.isLoading ? (
        <LoadingRows />
      ) : !data ? (
        <EmptyState title="No wallet found" body="No wallet for this user ID." />
      ) : (
        <FlatList
          data={data.transactions}
          keyExtractor={(t) => t.id}
          contentContainerStyle={{ paddingHorizontal: space[4], paddingBottom: space[10], gap: 12 }}
          refreshing={q.isRefetching}
          onRefresh={() => q.refetch()}
          ListHeaderComponent={
            <View style={{ gap: 16, marginBottom: 4 }}>
              <Card>
                <Text style={[text.caption, { color: p.mutedForeground }]}>Balance</Text>
                <Text style={{ fontFamily: 'InterTight-SemiBold', fontSize: 30, color: p.foreground, marginTop: 4, fontVariant: ['tabular-nums'] }}>
                  {formatINR(data.balance)}
                </Text>
              </Card>
              <Card>
                <SectionLabel>Adjust balance</SectionLabel>
                <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
                  {(['credit', 'debit'] as const).map((t) => {
                    const on = type === t;
                    return (
                      <Pressable
                        key={t}
                        onPress={() => setType(t)}
                        style={[styles.seg, { borderColor: on ? p.primary : p.border, backgroundColor: on ? p.primary : 'transparent' }]}
                      >
                        <Text style={{ fontFamily: 'InterTight-Medium', fontSize: 13, color: on ? p.primaryForeground : p.mutedForeground }}>
                          {t === 'credit' ? 'Credit (+)' : 'Debit (−)'}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
                <TextInput
                  value={amount}
                  onChangeText={setAmount}
                  keyboardType="decimal-pad"
                  placeholder="Amount (₹)"
                  placeholderTextColor={p.mutedForeground}
                  style={[styles.input, { borderColor: p.border, color: p.foreground, backgroundColor: p.muted, marginBottom: 8 }]}
                />
                <TextInput
                  value={reason}
                  onChangeText={setReason}
                  placeholder="Reason"
                  placeholderTextColor={p.mutedForeground}
                  style={[styles.input, { borderColor: p.border, color: p.foreground, backgroundColor: p.muted, marginBottom: 8 }]}
                />
                {error ? (
                  <Text style={{ fontFamily: 'InterTight-Medium', fontSize: 12, color: p.destructive, marginBottom: 8 }}>{error}</Text>
                ) : null}
                <Button label={adjust.isPending ? 'Saving…' : 'Apply'} onPress={apply} loading={adjust.isPending} disabled={adjust.isPending} />
              </Card>
              <SectionLabel>Ledger</SectionLabel>
            </View>
          }
          ListEmptyComponent={<Text style={[text.caption, { color: p.mutedForeground }]}>No transactions.</Text>}
          renderItem={({ item }: { item: WalletTxn }) => (
            <View style={[styles.txn, { borderColor: p.border, backgroundColor: p.surface }]}>
              <View style={{ flex: 1 }}>
                <Text style={[text.title, { color: p.foreground }]}>{titleCase(item.source)}</Text>
                {item.reason ? <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]}>{item.reason}</Text> : null}
                <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]}>{formatDateTime(item.createdAt)}</Text>
              </View>
              <Text style={{ fontFamily: 'InterTight-SemiBold', fontSize: 15, color: item.type === 'credit' ? p.successFg : p.destructive, fontVariant: ['tabular-nums'] }}>
                {item.type === 'credit' ? '+' : '−'}{formatINR(item.amount)}
              </Text>
            </View>
          )}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  input: { height: 44, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, fontFamily: 'InterTight', fontSize: 15 },
  seg: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth },
  txn: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: space[3], borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth },
});
