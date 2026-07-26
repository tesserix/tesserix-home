// mediation.tsx — HomeChef message mediation: relay or block pending messages
// between customers and chefs. Inbox polls every 20s. Relay + block are BOTH
// always confirm-gated on mobile (relay forwards PII irreversibly; block is silent).
import { useState } from 'react';
import { Alert, RefreshControl, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { formatDateTime, MEDIATION_ROLE_LABEL, type MediatedMessage } from '@tesserix/homechef-shared';
import { Badge, BackButton, Button, Card, EmptyState, LoadingRows, Screen, ScreenHeader } from '../../components/kit';
import { useMediationAction, useMediationInbox } from '../../lib/hooks';
import { apiError } from '../../lib/api';
import { useConfirm } from '../../components/prompt';
import { usePalette, space, text } from '../../lib/theme';

export default function Mediation() {
  const p = usePalette();
  const { confirm } = useConfirm();
  const q = useMediationInbox();
  const act = useMediationAction();
  const [busyId, setBusyId] = useState<string | null>(null);
  const inbox = q.data?.data ?? [];

  async function relay(m: MediatedMessage) {
    const ok = await confirm({
      title: m.piiDetected ? 'Relay a message with contact details?' : 'Relay this message?',
      message: m.piiDetected
        ? 'This message looks like it contains a phone number or address. Relaying lets the customer and chef contact each other directly and take the order off-platform.'
        : 'This delivers the message to the recipient.',
      confirmLabel: m.piiDetected ? 'Relay anyway' : 'Relay',
      tone: 'destructive',
    });
    if (!ok) return;
    setBusyId(m.id);
    act.mutate({ id: m.id, action: 'relay' }, { onError: (e) => Alert.alert('Could not relay', apiError(e)), onSettled: () => setBusyId(null) });
  }

  async function block(m: MediatedMessage) {
    const ok = await confirm({ title: 'Block this message?', message: 'It is never delivered. The sender is not told it was blocked.', confirmLabel: 'Block', tone: 'destructive' });
    if (!ok) return;
    setBusyId(m.id);
    act.mutate({ id: m.id, action: 'block' }, { onError: (e) => Alert.alert('Could not block', apiError(e)), onSettled: () => setBusyId(null) });
  }

  return (
    <Screen>
      <ScreenHeader title="Mediation" subtitle="Message relay queue" right={<BackButton onPress={() => router.back()} />} />
      {q.isLoading ? (
        <LoadingRows />
      ) : inbox.length === 0 ? (
        <EmptyState title="Inbox empty" body="No messages are waiting for mediation." />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: space[4], paddingBottom: space[10], gap: 10 }}
          refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => q.refetch()} />}
        >
          {inbox.map((m) => {
            const busy = busyId === m.id;
            return (
              <Card key={m.id}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={[text.title, { color: p.foreground, flex: 1 }]} numberOfLines={1}>
                    {MEDIATION_ROLE_LABEL[m.senderRole]} → {MEDIATION_ROLE_LABEL[m.recipientRole]}
                  </Text>
                  {m.piiDetected ? <Badge label="Contact details" tone="danger" /> : null}
                </View>
                <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]}>order {m.orderId.slice(0, 8)} · {formatDateTime(m.createdAt)}</Text>
                <Text style={[text.body, { color: p.foreground, marginTop: 8 }]}>{m.content}</Text>
                {m.filename ? <Text style={[text.caption, { color: p.mutedForeground, marginTop: 6 }]}>Attachment: {m.filename}</Text> : null}
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
                  <View style={{ flex: 1 }}><Button label="Relay" onPress={() => relay(m)} loading={busy && act.variables?.action === 'relay'} disabled={busy} /></View>
                  <View style={{ flex: 1 }}><Button label="Block" variant="secondary" tone="danger" onPress={() => block(m)} disabled={busy} /></View>
                </View>
              </Card>
            );
          })}
        </ScrollView>
      )}
    </Screen>
  );
}
