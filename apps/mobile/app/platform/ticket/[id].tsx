// Platform ticket detail — full thread with status/priority/product badges,
// description, the merchant↔platform reply thread, and either a reply composer
// (with optional status change on send) or a Reopen action for terminal tickets.

import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useTicket, useSetPlatformTicketStatus, useReplyToTicket } from '../../../lib/platform-hooks';
import { apiError } from '../../../lib/api';
import { formatDateTime, formatRelative, titleCase } from '@tesserix/homechef-shared';
import {
  Badge,
  BackButton,
  Button,
  Card,
  EmptyState,
  FilterChips,
  LoadingRows,
  Screen,
  ScreenHeader,
  SectionLabel,
  type Tone,
} from '../../../components/kit';
import { usePalette, radius, space, text } from '../../../lib/theme';
import type { Ticket, TicketReply, TicketStatus, TicketPriority } from '../../../lib/platform-contracts';

function statusTone(s: TicketStatus): Tone {
  if (s === 'open') return 'warning';
  if (s === 'in_progress') return 'info';
  if (s === 'resolved') return 'success';
  return 'neutral';
}

function priorityTone(p: TicketPriority): Tone {
  if (p === 'urgent') return 'danger';
  if (p === 'high') return 'warning';
  return 'neutral';
}

type SendStatus = '' | 'in_progress' | 'resolved';
const SEND_OPTIONS: { key: SendStatus; label: string }[] = [
  { key: '', label: 'Just send' },
  { key: 'in_progress', label: 'Mark in progress' },
  { key: 'resolved', label: 'Mark resolved' },
];

export default function TicketDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const q = useTicket(id);
  const setStatus = useSetPlatformTicketStatus(id);
  const reply = useReplyToTicket(id);
  const p = usePalette();

  const [content, setContent] = useState('');
  const [sendStatus, setSendStatus] = useState<SendStatus>('');

  if (q.isLoading) {
    return (
      <Screen>
        <ScreenHeader title="Ticket" right={<BackButton onPress={() => router.back()} />} />
        <LoadingRows />
      </Screen>
    );
  }

  if (!q.data) {
    return (
      <Screen>
        <ScreenHeader title="Ticket" right={<BackButton onPress={() => router.back()} />} />
        <EmptyState title="Ticket not found" body="This ticket may have been removed." />
      </Screen>
    );
  }

  const ticket: Ticket = q.data.ticket;
  const replies: TicketReply[] = q.data.replies;
  const terminal = ticket.status === 'resolved' || ticket.status === 'closed';

  function reopen() {
    Alert.alert('Reopen ticket', 'Set this ticket back to open so the thread can continue?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Reopen',
        onPress: () =>
          setStatus.mutate('open', { onError: (e) => Alert.alert('Could not reopen', apiError(e)) }),
      },
    ]);
  }

  function send() {
    const body = content.trim();
    if (!body) return;
    reply.mutate(
      { content: body, newStatus: sendStatus || undefined },
      {
        onSuccess: () => {
          setContent('');
          setSendStatus('');
        },
        onError: (e) => Alert.alert('Could not send reply', apiError(e)),
      },
    );
  }

  return (
    <Screen>
      <ScreenHeader
        title={ticket.subject}
        subtitle={`#${ticket.ticket_number}`}
        right={<BackButton onPress={() => router.back()} />}
      />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={80}
      >
        <ScrollView contentContainerStyle={{ paddingHorizontal: space[4], paddingBottom: space[10], gap: space[3] }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            <Badge label={titleCase(ticket.status)} tone={statusTone(ticket.status)} />
            <Badge label={`${ticket.priority} priority`} tone={priorityTone(ticket.priority)} />
            <Badge label={titleCase(ticket.product_id)} tone="info" />
          </View>

          <Card>
            <Text style={[text.caption, { color: p.mutedForeground }]}>
              {ticket.submitted_by_name || 'Unknown'} · {ticket.submitted_by_email}
            </Text>
            <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]}>
              Opened {formatDateTime(ticket.created_at)} · updated {formatDateTime(ticket.updated_at)}
            </Text>
            {ticket.description ? (
              <Text style={[text.body, { color: p.foreground, marginTop: 10 }]}>{ticket.description}</Text>
            ) : null}
          </Card>

          <View>
            <SectionLabel>Replies</SectionLabel>
            {replies.length === 0 ? (
              <Text style={[text.caption, { color: p.mutedForeground }]}>No replies yet.</Text>
            ) : (
              <View style={{ gap: 8 }}>
                {replies.map((r) => (
                  <ReplyCard key={r.id} reply={r} />
                ))}
              </View>
            )}
          </View>

          {terminal ? (
            <Button
              label="Reopen ticket"
              variant="secondary"
              onPress={reopen}
              loading={setStatus.isPending}
            />
          ) : (
            <View style={{ gap: 10 }}>
              <SectionLabel>Reply</SectionLabel>
              <TextInput
                value={content}
                onChangeText={setContent}
                placeholder="Write a reply…"
                placeholderTextColor={p.mutedForeground}
                multiline
                style={[styles.input, { borderColor: p.border, color: p.foreground, backgroundColor: p.muted }]}
              />
              <FilterChips options={SEND_OPTIONS} value={sendStatus} onChange={setSendStatus} />
              <Button
                label="Send reply"
                onPress={send}
                loading={reply.isPending}
                disabled={!content.trim() || reply.isPending}
              />
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

function ReplyCard({ reply }: { reply: TicketReply }) {
  const p = usePalette();
  const isPlatform = reply.author_type === 'platform_admin';
  return (
    <Card style={isPlatform ? { backgroundColor: p.muted, marginLeft: space[5] } : { marginRight: space[5] }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Badge label={isPlatform ? 'Platform' : 'Merchant'} tone={isPlatform ? 'info' : 'neutral'} />
        <Text style={[text.caption, { color: p.mutedForeground, flex: 1 }]} numberOfLines={1}>
          {reply.author_name}
        </Text>
        <Text style={[text.caption, { color: p.mutedForeground }]}>{formatRelative(reply.created_at)}</Text>
      </View>
      <Text style={[text.body, { color: p.foreground, marginTop: 8 }]}>{reply.content}</Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  input: {
    minHeight: 96,
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
