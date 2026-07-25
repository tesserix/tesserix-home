// campaigns.tsx — HomeChef push/email campaigns: compose, preview, schedule, send,
// test, cancel, delete + sent-campaign metrics. hc gateway. Sends are irreversible.
import { useState } from 'react';
import { Alert, RefreshControl, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { formatDateTime, parseSegment, titleCase, type Campaign } from '@tesserix/homechef-shared';
import {
  Badge, BackButton, Button, Card, EmptyState, LoadingRows, Metric, Screen, ScreenHeader,
} from '../../components/kit';
import { CampaignForm, CAMPAIGN_STATUS_TONE, isEditableCampaign, isTerminalCampaign } from '../../components/homechef/campaign-form';
import { previewCampaign, useCampaignAction, useCampaignMetrics, useCampaigns } from '../../lib/hooks';
import { apiError } from '../../lib/api';
import { useConfirm } from '../../components/prompt';
import { usePalette, space, text } from '../../lib/theme';

export default function Campaigns() {
  const q = useCampaigns();
  const [composing, setComposing] = useState(false);
  const campaigns = q.data?.data ?? [];

  return (
    <Screen>
      <ScreenHeader title="Campaigns" subtitle="Push/email blasts" right={<BackButton onPress={() => router.back()} />} />
      <ScrollView
        contentContainerStyle={{ paddingBottom: space[10], gap: space[3] }}
        refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => q.refetch()} />}
      >
        <View style={{ paddingHorizontal: space[4], gap: 10 }}>
          <Button
            label={composing ? 'Close composer' : 'New campaign'}
            variant={composing ? 'secondary' : 'primary'}
            onPress={() => setComposing((v) => !v)}
          />
          {composing ? <CampaignForm onDone={() => setComposing(false)} /> : null}
        </View>

        {q.isLoading ? (
          <LoadingRows />
        ) : campaigns.length === 0 ? (
          <EmptyState title="No campaigns" body="Compose your first push or email blast." />
        ) : (
          <View style={{ paddingHorizontal: space[4], gap: 10 }}>
            {campaigns.map((c) => (
              <CampaignRow key={c.id} campaign={c} />
            ))}
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}

function CampaignRow({ campaign: c }: { campaign: Campaign }) {
  const p = usePalette();
  const { confirm } = useConfirm();
  const action = useCampaignAction();
  const [editing, setEditing] = useState(false);
  const metrics = useCampaignMetrics(c.id, c.status === 'sent');

  const canEdit = isEditableCampaign(c.status);
  const canCancel = c.status === 'draft' || c.status === 'scheduled';
  const canDelete = c.status === 'draft' || c.status === 'cancelled';
  const canLifecycle = !isTerminalCampaign(c.status); // send / test / schedule window

  async function onSend() {
    // Re-fetch a fresh audience count immediately before the confirm so the number is never stale.
    let detail = 'This sends immediately and cannot be undone.';
    try {
      const pv = await previewCampaign(parseSegmentSafe(c));
      detail = `${pv.matched} recipients will be messaged immediately. This cannot be undone.`;
    } catch {
      // best-effort — fall back to the blunt warning
    }
    const ok = await confirm({ title: 'Send campaign?', message: detail, confirmLabel: 'Send now', tone: 'destructive' });
    if (ok) action.mutate({ id: c.id, action: 'send' }, { onError: (e) => Alert.alert('Send failed', apiError(e)) });
  }

  async function onCancel() {
    if (await confirm({ title: 'Cancel campaign?', message: 'This stops it from sending.', confirmLabel: 'Cancel campaign', tone: 'destructive' })) {
      action.mutate({ id: c.id, action: 'cancel' }, { onError: (e) => Alert.alert('Could not cancel', apiError(e)) });
    }
  }

  async function onDelete() {
    if (await confirm({ title: 'Delete campaign?', message: 'This permanently removes the draft.', confirmLabel: 'Delete', tone: 'destructive' })) {
      action.mutate({ id: c.id, action: 'delete' }, { onError: (e) => Alert.alert('Could not delete', apiError(e)) });
    }
  }

  const m = metrics.data;

  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={[text.title, { color: p.foreground, flex: 1 }]} numberOfLines={1}>{c.name}</Text>
        <Badge label={titleCase(c.status)} tone={CAMPAIGN_STATUS_TONE[c.status]} />
      </View>
      <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]} numberOfLines={1}>
        {[c.sendPush ? 'Push' : null, c.sendEmail ? 'Email' : null].filter(Boolean).join(' + ') || 'No channel'} · {c.recipients} recipients
        {c.scheduledAt ? ` · scheduled ${formatDateTime(c.scheduledAt)}` : ''}
        {c.sentAt ? ` · sent ${formatDateTime(c.sentAt)}` : ''}
      </Text>

      {c.status === 'sent' && m ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16, marginTop: 12 }}>
          <Metric label="Recipients" value={String(m.recipients)} />
          <Metric label="Push sent" value={`${m.push.sent}`} />
          <Metric label="Push opened" value={`${m.push.opened}`} tone="success" />
          <Metric label="Email sent" value={`${m.email.sent}`} />
          <Metric label="Email opened" value={`${m.email.opened}`} tone="success" />
        </View>
      ) : null}

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
        {canEdit ? <Button label={editing ? 'Close' : 'Edit'} variant="secondary" onPress={() => setEditing((v) => !v)} /> : null}
        {canLifecycle ? <Button label="Test send" variant="secondary" onPress={() => action.mutate({ id: c.id, action: 'test' }, { onError: (e) => Alert.alert('Test failed', apiError(e)) })} /> : null}
        {canLifecycle ? <Button label="Send" onPress={onSend} /> : null}
        {canCancel ? <Button label="Cancel" variant="secondary" tone="danger" onPress={onCancel} /> : null}
        {canDelete ? <Button label="Delete" variant="secondary" tone="danger" onPress={onDelete} /> : null}
      </View>

      {editing && canEdit ? (
        <View style={{ marginTop: 12 }}>
          <CampaignForm existing={c} onDone={() => setEditing(false)} />
        </View>
      ) : null}
    </Card>
  );
}

// Campaign.segment is a JSON string on the wire; parse it (tolerant) for the pre-send preview.
function parseSegmentSafe(c: Campaign) {
  return parseSegment(c.segment);
}
