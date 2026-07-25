// Otto thread — full message history with the product/reason/case-id header,
// an Accept button while pending, a composer + Close action while active
// (these threads are the admin's own — the Active tab is scoped to the
// signed-in staff via ?assignee=mine), and a read-only banner once closed.
// Polls every 3s while focused.

import { useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { router, useIsFocused, useLocalSearchParams } from 'expo-router';
import { formatRelative, titleCase } from '@tesserix/homechef-shared';
import {
  Badge,
  BackButton,
  Banner,
  Button,
  EmptyState,
  LoadingRows,
  Screen,
  ScreenHeader,
  type Tone,
} from '../../../components/kit';
import { apiError } from '../../../lib/api';
import { usePalette, radius, space, text } from '../../../lib/theme';
import {
  useAcceptOtto,
  useCloseOtto,
  useOttoConversation,
  useOttoMessages,
  useSendOttoMessage,
} from '../../../lib/otto-hooks';
import { ottoTenantLabel, type OttoMessage, type OttoStatus } from '../../../lib/otto-contracts';

function statusLabel(s: OttoStatus): string {
  if (s === 'pending') return 'Waiting';
  if (s === 'active') return 'Active';
  return 'Closed';
}

function statusTone(s: OttoStatus): Tone {
  if (s === 'pending') return 'warning';
  if (s === 'active') return 'success';
  return 'neutral';
}

export default function OttoThreadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const focused = useIsFocused();
  const p = usePalette();

  const convQ = useOttoConversation(id, focused ? 3_000 : false);
  const msgsQ = useOttoMessages(id, focused ? 3_000 : false);
  const accept = useAcceptOtto(id);
  const send = useSendOttoMessage(id);
  const close = useCloseOtto(id);

  const [draft, setDraft] = useState('');

  const conv = convQ.data?.conversation;
  const messages = useMemo(
    () => [...(msgsQ.data?.messages ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at)),
    [msgsQ.data],
  );

  if (convQ.isLoading && !conv) {
    return (
      <Screen>
        <ScreenHeader title="Chat" right={<BackButton onPress={() => router.back()} />} />
        <LoadingRows />
      </Screen>
    );
  }
  if (!conv) {
    return (
      <Screen>
        <ScreenHeader title="Chat" right={<BackButton onPress={() => router.back()} />} />
        <EmptyState title="Conversation not found" body="It may have been removed." />
      </Screen>
    );
  }

  const who = conv.customer?.name || conv.customer?.email || 'Anonymous';

  function doAccept() {
    accept.mutate(undefined, { onError: (e) => Alert.alert('Could not accept', apiError(e)) });
  }
  function doSend() {
    const body = draft.trim();
    if (!body) return;
    send.mutate(body, {
      onSuccess: () => setDraft(''),
      onError: (e) => Alert.alert('Could not send', apiError(e)),
    });
  }
  function doClose() {
    Alert.alert('Close chat', 'Close this conversation? The customer can no longer reply.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Close',
        style: 'destructive',
        onPress: () => close.mutate(undefined, { onError: (e) => Alert.alert('Could not close', apiError(e)) }),
      },
    ]);
  }

  return (
    <Screen>
      <ScreenHeader title={who} subtitle={conv.case_id} right={<BackButton onPress={() => router.back()} />} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: space[4], paddingBottom: space[3] }}>
        <Badge label={ottoTenantLabel(conv.tenant_id)} tone="info" />
        {conv.intake?.reason ? <Badge label={titleCase(conv.intake.reason)} tone="neutral" /> : null}
        <Badge label={statusLabel(conv.status)} tone={statusTone(conv.status)} />
      </View>

      {conv.intake?.status ? <Banner text={conv.intake.status} tone="info" /> : null}

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={80}
      >
        {messages.length === 0 ? (
          <View style={{ flex: 1 }}>
            <EmptyState title="No messages yet" />
          </View>
        ) : (
          <FlatList
            data={messages}
            keyExtractor={(m) => m.id}
            contentContainerStyle={{ paddingHorizontal: space[4], paddingBottom: space[4], gap: 8 }}
            renderItem={({ item }) => <MessageBubble msg={item} />}
          />
        )}

        {conv.status === 'pending' ? (
          <View style={{ padding: space[4] }}>
            <Button label="Accept chat" onPress={doAccept} loading={accept.isPending} />
          </View>
        ) : conv.status === 'active' ? (
          <View style={{ padding: space[4], gap: 8, borderTopWidth: StyleSheet.hairlineWidth, borderColor: p.border }}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder="Write a reply…"
              placeholderTextColor={p.mutedForeground}
              multiline
              style={[styles.input, { borderColor: p.border, color: p.foreground, backgroundColor: p.muted }]}
            />
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <View style={{ flex: 1 }}>
                <Button label="Send" onPress={doSend} loading={send.isPending} disabled={!draft.trim() || send.isPending} />
              </View>
              <Button label="Close" variant="secondary" tone="danger" onPress={doClose} loading={close.isPending} />
            </View>
          </View>
        ) : (
          <Banner text="This conversation is closed." tone="neutral" />
        )}
      </KeyboardAvoidingView>
    </Screen>
  );
}

function MessageBubble({ msg }: { msg: OttoMessage }) {
  const p = usePalette();
  const mine = msg.sender_type === 'staff';
  if (msg.sender_type === 'system') {
    return (
      <Text style={[text.caption, { color: p.mutedForeground, textAlign: 'center', marginVertical: 4 }]}>
        {msg.body}
      </Text>
    );
  }
  return (
    <View
      style={{
        alignSelf: mine ? 'flex-end' : 'flex-start',
        maxWidth: '82%',
        backgroundColor: mine ? p.primary : p.muted,
        borderRadius: radius.lg,
        paddingHorizontal: 14,
        paddingVertical: 10,
      }}
    >
      {!mine ? (
        <Text style={[text.caption, { color: p.mutedForeground, marginBottom: 2 }]}>
          {msg.sender_name || 'Customer'}
        </Text>
      ) : null}
      <Text style={{ fontFamily: 'InterTight', fontSize: 15, lineHeight: 21, color: mine ? p.primaryForeground : p.foreground }}>
        {msg.body}
      </Text>
      <Text
        style={{
          fontFamily: 'InterTight',
          fontSize: 11,
          color: mine ? p.primaryForeground : p.mutedForeground,
          opacity: 0.7,
          marginTop: 4,
          textAlign: 'right',
        }}
      >
        {formatRelative(msg.created_at)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  input: {
    minHeight: 72,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 12,
    fontFamily: 'InterTight',
    fontSize: 15,
    textAlignVertical: 'top',
  },
});
