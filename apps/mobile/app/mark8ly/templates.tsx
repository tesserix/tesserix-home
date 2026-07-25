// Mark8ly email templates — read-only list (DB toggle) + per-template Send-test.
import { useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { useEmailTemplates, useTestSendEmailTemplate } from '../../lib/mark8ly-hooks';
import type { EmailTemplateRow } from '../../lib/mark8ly-contracts';
import { useAuth } from '../../lib/auth';
import { apiError } from '../../lib/api';
import { formatRelative } from '@tesserix/homechef-shared';
import {
  Screen, ScreenHeader, BackButton, Card, Badge, Button, FilterChips,
  EmptyState, LoadingRows, Banner, type Tone,
} from '../../components/kit';
import { usePalette, radius, space, text } from '../../lib/theme';

const DB_OPTS = [
  { key: 'platform_api', label: 'Platform' },
  { key: 'marketplace_api', label: 'Marketplace' },
];

export default function Templates() {
  const [database, setDatabase] = useState('platform_api');
  const q = useEmailTemplates(database);
  const templates = q.data?.templates ?? [];

  return (
    <Screen>
      <ScreenHeader title="Email templates" subtitle="Mark8ly notifications" right={<BackButton onPress={() => router.back()} />} />
      <View style={{ paddingHorizontal: space[4], paddingBottom: 8 }}>
        <FilterChips options={DB_OPTS} value={database} onChange={setDatabase} />
      </View>
      {q.isLoading ? (
        <LoadingRows />
      ) : (
        <ScrollView contentContainerStyle={{ paddingHorizontal: space[4], paddingBottom: space[10], gap: 8 }}>
          {q.isError ? <Banner text="Could not load templates." tone="danger" /> : null}
          {templates.length === 0 ? (
            <Card><EmptyState title="No templates" body="No templates in this database." /></Card>
          ) : (
            templates.map((t) => <TemplateCard key={`${database}:${t.key}`} t={t} database={database} />)
          )}
        </ScrollView>
      )}
    </Screen>
  );
}

function TemplateCard({ t, database }: { t: EmailTemplateRow; database: string }) {
  const p = usePalette();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState(user?.email ?? '');
  const send = useTestSendEmailTemplate(t.key, database);
  const statusTone: Tone = t.status === 'published' ? 'success' : 'neutral';

  function submit() {
    if (!to.trim()) { Alert.alert('Missing email', 'Enter a recipient email.'); return; }
    send.mutate(to.trim(), {
      onSuccess: (r) => { setOpen(false); Alert.alert('Test sent', `Sent to ${r.to}.`); },
      onError: (e) => Alert.alert('Send failed', apiError(e)),
    });
  }

  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={[text.title, { color: p.foreground, flex: 1 }]} numberOfLines={1}>{t.key}</Text>
        <Badge label={t.status} tone={statusTone} />
      </View>
      <Text style={[text.caption, { color: p.mutedForeground, marginTop: 4 }]} numberOfLines={1}>{t.subject}</Text>
      <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]} numberOfLines={1}>v{t.version} · {formatRelative(t.updatedAt)}</Text>
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
            <View style={{ flex: 1 }}><Button label="Send test" onPress={submit} loading={send.isPending} /></View>
            <View style={{ flex: 1 }}><Button label="Cancel" variant="ghost" onPress={() => setOpen(false)} disabled={send.isPending} /></View>
          </View>
        </View>
      ) : (
        <View style={{ marginTop: 12 }}><Button label="Send test" variant="secondary" onPress={() => setOpen(true)} /></View>
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
