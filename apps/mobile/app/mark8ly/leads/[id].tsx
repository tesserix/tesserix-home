// Lead detail — status/star/activity/send-email. Lead sourced from the leads
// list cache (no GET /leads/{id} exists); activities fetched separately.
import { useMemo, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useLeads, useLeadActivities, useSetLeadStatus, useToggleLeadStar, useLogLeadActivity, useSendLeadEmail } from '../../../lib/mark8ly-hooks';
import { useLeadTemplates } from '../../../lib/platform-hooks';
import type { LeadActivity } from '../../../lib/mark8ly-contracts';
import type { LeadStatus } from '../../../lib/platform-contracts';
import { apiError } from '../../../lib/api';
import { formatRelative, titleCase } from '@tesserix/homechef-shared';
import {
  Screen, ScreenHeader, BackButton, Card, Badge, Button, FilterChips, SectionLabel,
  EmptyState, LoadingRows, type Tone,
} from '../../../components/kit';
import { usePalette, radius, space, text } from '../../../lib/theme';

const STATUS_OPTS: { key: LeadStatus; label: string }[] = [
  { key: 'new', label: 'New' },
  { key: 'contacted', label: 'Contacted' },
  { key: 'qualified', label: 'Qualified' },
  { key: 'converted', label: 'Converted' },
  { key: 'lost', label: 'Lost' },
];

const ACTIVITY_TONE: Record<LeadActivity['kind'], Tone> = {
  note: 'neutral', dm_sent: 'info', dm_received: 'info', email_sent: 'info',
  email_received: 'info', call: 'success', status_change: 'warning', assigned: 'warning',
};

export default function LeadDetail() {
  const p = usePalette();
  const { id } = useLocalSearchParams<{ id: string }>();
  // No GET /leads/{id}; find the lead in the (unfiltered) leads cache/fetch.
  const list = useLeads({});
  const lead = useMemo(() => list.data?.leads.find((l) => l.id === id), [list.data, id]);
  const activities = useLeadActivities(id ?? '');
  const setStatus = useSetLeadStatus(id ?? '');
  const toggleStar = useToggleLeadStar(id ?? '');
  const logActivity = useLogLeadActivity(id ?? '');
  const sendEmail = useSendLeadEmail(id ?? '');
  const templates = useLeadTemplates();

  const [note, setNote] = useState('');

  if (list.isLoading) return <Screen><ScreenHeader title="Lead" right={<BackButton onPress={() => router.back()} />} /><LoadingRows /></Screen>;
  if (!lead) return <Screen><ScreenHeader title="Lead" right={<BackButton onPress={() => router.back()} />} /><Card><EmptyState title="Lead not found" body="Open it from the leads list." /></Card></Screen>;

  const displayName = lead.name || lead.company || lead.instagram_handle || lead.email || 'Lead';

  function addNote() {
    if (!note.trim()) return;
    logActivity.mutate({ kind: 'note', body: note.trim() }, {
      onSuccess: () => setNote(''),
      onError: (e) => Alert.alert('Could not log', apiError(e)),
    });
  }

  const pickTemplateAndSend = () => {
    if (templates.isLoading) { Alert.alert('Please wait', 'Templates are still loading.'); return; }
    const published = (templates.data?.templates ?? []).filter((t) => t.status === 'published');
    if (!lead.email) { Alert.alert('No email', 'This lead has no email address.'); return; }
    if (published.length === 0) { Alert.alert('No templates', 'No published templates to send.'); return; }
    Alert.alert('Send email', `Pick a template to send to ${lead.email}`, [
      ...published.slice(0, 8).map((t) => ({
        text: t.label,
        onPress: () => sendEmail.mutate(t.key, {
          onSuccess: (r) => Alert.alert('Sent', `Email sent to ${r.recipient}.`),
          onError: (e) => Alert.alert('Send failed', apiError(e)),
        }),
      })),
      { text: 'Cancel', style: 'cancel' as const },
    ]);
  };

  return (
    <Screen>
      <ScreenHeader title={displayName} subtitle={lead.email ?? lead.instagram_handle ?? undefined} right={<BackButton onPress={() => router.back()} />} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={80}>
        <ScrollView contentContainerStyle={{ paddingHorizontal: space[4], paddingBottom: space[10], gap: space[4] }}>
          <Card>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={[text.label, { color: p.mutedForeground, flex: 1 }]}>Status</Text>
              <Button
                label={lead.is_starred ? '★ Starred' : '☆ Star'}
                variant="ghost"
                loading={toggleStar.isPending}
                onPress={() => toggleStar.mutate(!lead.is_starred, { onError: (e) => Alert.alert('Failed', apiError(e)) })}
              />
            </View>
            <View style={{ marginTop: 8 }}>
              <FilterChips
                options={STATUS_OPTS}
                value={lead.status}
                onChange={(s) => setStatus.mutate(s, { onError: (e) => Alert.alert('Failed', apiError(e)) })}
              />
            </View>
            <View style={{ marginTop: 12 }}>
              <Button label="Send email" variant="secondary" loading={sendEmail.isPending} onPress={pickTemplateAndSend} />
            </View>
          </Card>

          <View>
            <SectionLabel>Log a note</SectionLabel>
            <Card>
              <TextInput
                value={note}
                onChangeText={setNote}
                placeholder="Add a note…"
                placeholderTextColor={p.mutedForeground}
                multiline
                style={[styles.input, { borderColor: p.border, color: p.foreground, backgroundColor: p.muted }]}
              />
              <View style={{ marginTop: 8 }}>
                <Button label="Add note" onPress={addNote} loading={logActivity.isPending} disabled={!note.trim() || logActivity.isPending} />
              </View>
            </Card>
          </View>

          <View>
            <SectionLabel>Activity</SectionLabel>
            {activities.isLoading ? (
              <LoadingRows rows={3} />
            ) : (activities.data?.activities ?? []).length === 0 ? (
              <Card><EmptyState title="No activity" body="No logged activity yet." /></Card>
            ) : (
              <View style={{ gap: 8 }}>
                {(activities.data?.activities ?? []).map((a) => (
                  <Card key={a.id}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <Badge label={titleCase(a.kind)} tone={ACTIVITY_TONE[a.kind]} />
                      <View style={{ flex: 1 }} />
                      <Text style={[text.caption, { color: p.mutedForeground }]}>{formatRelative(a.created_at)}</Text>
                    </View>
                    {a.body ? <Text style={[text.body, { color: p.foreground, marginTop: 8 }]}>{a.body}</Text> : null}
                    <Text style={[text.caption, { color: p.mutedForeground, marginTop: 4 }]} numberOfLines={1}>{a.actor_email}</Text>
                  </Card>
                ))}
              </View>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  input: {
    minHeight: 72,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingTop: 12,
    textAlignVertical: 'top',
    fontFamily: 'InterTight',
    fontSize: 15,
  },
});
