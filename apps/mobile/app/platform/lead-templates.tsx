// Lead email templates — read-only list + per-template "Send test".
import { useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { useLeadTemplates, useTestSendTemplate } from '../../lib/platform-hooks';
import type { LeadTemplate } from '../../lib/platform-contracts';
import { useAuth } from '../../lib/auth';
import { apiError } from '../../lib/api';
import { formatRelative } from '@tesserix/homechef-shared';
import {
  Screen, ScreenHeader, BackButton, Card, Badge, Button, SectionLabel, EmptyState, LoadingRows, type Tone,
} from '../../components/kit';
import { usePalette, radius, space, text } from '../../lib/theme';

export default function LeadTemplates() {
  const q = useLeadTemplates();
  const templates = q.data?.templates ?? [];

  return (
    <Screen>
      <ScreenHeader title="Lead templates" subtitle="Marketing email templates" right={<BackButton onPress={() => router.back()} />} />
      {q.isLoading ? (
        <LoadingRows />
      ) : templates.length === 0 ? (
        <Card><EmptyState title="No templates" body={q.isError ? 'Could not load templates.' : 'No lead templates defined.'} /></Card>
      ) : (
        <ScrollView contentContainerStyle={{ paddingHorizontal: space[4], paddingBottom: space[10], gap: 8 }}>
          {templates.map((t) => <TemplateCard key={t.key} t={t} />)}
        </ScrollView>
      )}
    </Screen>
  );
}

function TemplateCard({ t }: { t: LeadTemplate }) {
  const p = usePalette();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState(user?.email ?? '');
  const send = useTestSendTemplate(t.key);
  const statusTone: Tone = t.status === 'published' ? 'success' : 'neutral';

  function submit() {
    if (!to.trim()) {
      Alert.alert('Missing email', 'Enter a recipient email address.');
      return;
    }
    send.mutate(to.trim(), {
      onSuccess: (r) => { setOpen(false); Alert.alert('Test sent', `Sent to ${r.to}.`); },
      onError: (e) => Alert.alert('Send failed', apiError(e)),
    });
  }

  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={[text.title, { color: p.foreground, flex: 1 }]} numberOfLines={1}>{t.label}</Text>
        <Badge label={t.status} tone={statusTone} />
      </View>
      <Text style={[text.caption, { color: p.mutedForeground, marginTop: 4 }]} numberOfLines={1}>{t.subject}</Text>
      <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]} numberOfLines={1}>
        {t.product} · v{t.version} · {formatRelative(t.updatedAt)}
      </Text>
      {open ? (
        <View style={{ marginTop: 12, gap: 8 }}>
          <TextInput
            value={to}
            onChangeText={setTo}
            placeholder="recipient@example.com"
            placeholderTextColor={p.mutedForeground}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            style={[styles.input, { borderColor: p.border, color: p.foreground, backgroundColor: p.muted }]}
          />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Button label="Send test" onPress={submit} loading={send.isPending} />
            </View>
            <View style={{ flex: 1 }}>
              <Button label="Cancel" variant="ghost" onPress={() => setOpen(false)} disabled={send.isPending} />
            </View>
          </View>
        </View>
      ) : (
        <View style={{ marginTop: 12 }}>
          <Button label="Send test" variant="secondary" onPress={() => setOpen(true)} />
        </View>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  input: {
    height: 44,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    fontFamily: 'InterTight',
    fontSize: 15,
  },
});
