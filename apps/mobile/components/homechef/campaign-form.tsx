// campaign-form.tsx — HomeChef campaign composer: segment builder + message
// composer + live audience preview + schedule. Lives outside app/ (route dir).
import { useState } from 'react';
import { Alert, Switch, Text, TextInput, View } from 'react-native';
import {
  parseSegment,
  type Campaign,
  type CampaignInput,
  type CampaignStatus,
  type SegmentCriteria,
  type SegmentPreview,
} from '@tesserix/homechef-shared';
import { Banner, Button, Card, FilterChips, type Tone } from '../kit';
import { previewCampaign, useCreateCampaign, useScheduleCampaign, useUpdateCampaign } from '../../lib/hooks';
import { apiError } from '../../lib/api';
import { usePalette, radius, space, text } from '../../lib/theme';

export const CAMPAIGN_STATUS_TONE: Record<CampaignStatus, Tone> = {
  draft: 'neutral',
  scheduled: 'info',
  queued: 'info',
  sending: 'warning',
  sent: 'success',
  cancelled: 'danger',
};

// Editable/sendable only before it has gone out; UpdateCampaign 409s past draft/scheduled.
export function isEditableCampaign(s: CampaignStatus): boolean {
  return s === 'draft' || s === 'scheduled';
}
export function isTerminalCampaign(s: CampaignStatus): boolean {
  return s === 'sent' || s === 'cancelled' || s === 'sending' || s === 'queued';
}

const ROLES = ['customer', 'chef', 'delivery'] as const;
const RECENCY_OPTIONS: { key: '' | 'active' | 'lapsed'; label: string }[] = [
  { key: '', label: 'Any recency' },
  { key: 'active', label: 'Active' },
  { key: 'lapsed', label: 'Lapsed' },
];
const SUBSCRIPTION_OPTIONS: { key: '' | 'active' | 'paused' | 'none'; label: string }[] = [
  { key: '', label: 'Any subscription' },
  { key: 'active', label: 'Active' },
  { key: 'paused', label: 'Paused' },
  { key: 'none', label: 'None' },
];

function FormField({ label, value, onChangeText, multiline, numeric, placeholder }: { label: string; value: string; onChangeText: (t: string) => void; multiline?: boolean; numeric?: boolean; placeholder?: string }) {
  const p = usePalette();
  return (
    <View style={{ marginTop: 10 }}>
      <Text style={[text.caption, { color: p.mutedForeground, marginBottom: 4 }]}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        multiline={multiline}
        keyboardType={numeric ? 'numeric' : 'default'}
        placeholder={placeholder}
        placeholderTextColor={p.mutedForeground}
        style={{ minHeight: multiline ? 88 : 44, borderRadius: radius.md, borderWidth: 1, borderColor: p.border, backgroundColor: p.muted, color: p.foreground, paddingHorizontal: 12, paddingVertical: multiline ? 10 : 0, fontFamily: 'InterTight', fontSize: 15, textAlignVertical: multiline ? 'top' : 'center' }}
      />
    </View>
  );
}

export function CampaignForm({ existing, onDone }: { existing?: Campaign; onDone: () => void }) {
  const p = usePalette();
  const create = useCreateCampaign();
  const update = useUpdateCampaign();
  const schedule = useScheduleCampaign();

  const seed: SegmentCriteria = existing ? parseSegment(existing.segment) : { recency: '', subscription: '' };
  const [name, setName] = useState(existing?.name ?? '');
  const [sendPush, setSendPush] = useState(existing?.sendPush ?? true);
  const [sendEmail, setSendEmail] = useState(existing?.sendEmail ?? false);
  const [pushTitle, setPushTitle] = useState(existing?.pushTitle ?? '');
  const [pushBody, setPushBody] = useState(existing?.pushBody ?? '');
  const [emailSubject, setEmailSubject] = useState(existing?.emailSubject ?? '');
  const [emailHtml, setEmailHtml] = useState(existing?.emailHtml ?? '');
  const [roles, setRoles] = useState<string[]>(seed.roles ?? []);
  const [recency, setRecency] = useState<'' | 'active' | 'lapsed'>(seed.recency ?? '');
  const [recencyDays, setRecencyDays] = useState(seed.recencyDays != null ? String(seed.recencyDays) : '');
  const [subscription, setSubscription] = useState<'' | 'active' | 'paused' | 'none'>(seed.subscription ?? '');
  const [cities, setCities] = useState((seed.cities ?? []).join(', '));
  const [newWithinDays, setNewWithinDays] = useState(seed.newWithinDays != null ? String(seed.newWithinDays) : '');
  const [scheduledAt, setScheduledAt] = useState(existing?.scheduledAt ?? '');
  const [preview, setPreview] = useState<SegmentPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function buildSegment(): SegmentCriteria {
    return {
      roles: roles.length ? roles : undefined,
      recency,
      recencyDays: recencyDays ? Number(recencyDays) : undefined,
      cities: cities.trim() ? cities.split(',').map((c) => c.trim()).filter(Boolean) : undefined,
      subscription,
      newWithinDays: newWithinDays ? Number(newWithinDays) : undefined,
    };
  }

  function buildInput(): CampaignInput {
    return { name: name.trim(), sendPush, sendEmail, pushTitle, pushBody, emailSubject, emailHtml, segment: buildSegment() };
  }

  function toggleRole(role: string) {
    setRoles((rs) => (rs.includes(role) ? rs.filter((r) => r !== role) : [...rs, role]));
  }

  async function runPreview() {
    setPreviewing(true);
    setError(null);
    try {
      setPreview(await previewCampaign(buildSegment()));
    } catch (e) {
      setError(apiError(e));
    } finally {
      setPreviewing(false);
    }
  }

  function validate(): string | null {
    if (!name.trim()) return 'Give the campaign a name.';
    if (!sendPush && !sendEmail) return 'Pick at least one channel.';
    if (sendPush && !pushTitle.trim()) return 'Push needs a title.';
    if (sendEmail && !emailSubject.trim()) return 'Email needs a subject.';
    return null;
  }

  function save() {
    const v = validate();
    if (v) return setError(v);
    setError(null);
    const input = buildInput();
    const onErr = (e: unknown) => Alert.alert('Could not save campaign', apiError(e));
    if (existing) {
      update.mutate({ id: existing.id, input }, { onSuccess: () => maybeSchedule(existing.id), onError: onErr });
    } else {
      create.mutate(input, { onSuccess: (c) => maybeSchedule(c.id), onError: onErr });
    }
  }

  // If a schedule time was entered, apply it after the draft is saved; else finish.
  function maybeSchedule(id: string) {
    if (scheduledAt.trim()) {
      schedule.mutate({ id, scheduledAt: scheduledAt.trim() }, { onSuccess: () => onDone(), onError: (e) => Alert.alert('Saved, but scheduling failed', apiError(e)) });
    } else {
      onDone();
    }
  }

  const busy = create.isPending || update.isPending || schedule.isPending;

  return (
    <Card>
      {error ? <View style={{ marginBottom: 8 }}><Banner text={error} tone="danger" /></View> : null}
      <FormField label="Campaign name" value={name} onChangeText={setName} />

      <Text style={[text.label, { color: p.foreground, marginTop: 16, marginBottom: 6 }]}>Audience</Text>
      <Text style={[text.caption, { color: p.mutedForeground, marginBottom: 6 }]}>Roles</Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {ROLES.map((role) => {
          const on = roles.includes(role);
          return (
            <Button key={role} label={role} variant={on ? 'primary' : 'secondary'} onPress={() => toggleRole(role)} />
          );
        })}
      </View>
      <View style={{ marginTop: 12 }}>
        <Text style={[text.caption, { color: p.mutedForeground, marginBottom: 6 }]}>Recency</Text>
        <FilterChips options={RECENCY_OPTIONS} value={recency} onChange={setRecency} />
      </View>
      <FormField label="Recency window (days, optional)" value={recencyDays} onChangeText={setRecencyDays} numeric />
      <View style={{ marginTop: 12 }}>
        <Text style={[text.caption, { color: p.mutedForeground, marginBottom: 6 }]}>Subscription</Text>
        <FilterChips options={SUBSCRIPTION_OPTIONS} value={subscription} onChange={setSubscription} />
      </View>
      <FormField label="Cities (comma-separated, optional)" value={cities} onChangeText={setCities} />
      <FormField label="New within (days, optional)" value={newWithinDays} onChangeText={setNewWithinDays} numeric />

      <View style={{ marginTop: 12 }}>
        <Button label={previewing ? 'Previewing…' : 'Preview audience'} variant="secondary" onPress={runPreview} loading={previewing} />
        {preview ? (
          <Text style={[text.caption, { color: p.mutedForeground, marginTop: 8 }]}>
            {preview.matched} matched · {preview.reachablePush} reachable push · {preview.reachableEmail} reachable email
          </Text>
        ) : null}
      </View>

      <Text style={[text.label, { color: p.foreground, marginTop: 16, marginBottom: 6 }]}>Message</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={[text.body, { color: p.foreground }]}>Send push</Text>
        <Switch value={sendPush} onValueChange={setSendPush} />
      </View>
      {sendPush ? (
        <>
          <FormField label="Push title" value={pushTitle} onChangeText={setPushTitle} />
          <FormField label="Push body" value={pushBody} onChangeText={setPushBody} multiline />
        </>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 }}>
        <Text style={[text.body, { color: p.foreground }]}>Send email</Text>
        <Switch value={sendEmail} onValueChange={setSendEmail} />
      </View>
      {sendEmail ? (
        <>
          <FormField label="Email subject" value={emailSubject} onChangeText={setEmailSubject} />
          <FormField label="Email HTML" value={emailHtml} onChangeText={setEmailHtml} multiline />
        </>
      ) : null}

      <FormField label="Schedule at (ISO datetime, optional)" value={scheduledAt} onChangeText={setScheduledAt} placeholder="2026-08-01T09:00:00Z" />

      <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
        <View style={{ flex: 1 }}><Button label="Cancel" variant="secondary" onPress={onDone} /></View>
        <View style={{ flex: 1 }}><Button label={busy ? 'Saving…' : existing ? 'Save changes' : 'Create draft'} onPress={save} loading={busy} disabled={busy} /></View>
      </View>
    </Card>
  );
}
