// settings-sections.tsx — HomeChef platform-settings config cards. Route files
// live under app/, so these editable cards live here (outside app/). Each card
// loads its config, edits a string-held form, and PUTs the complete typed object.
// Money is rupees (₹ in the label, no formatINR, no ÷100).
import { useEffect, useState } from 'react';
import { Pressable, Switch, Text, TextInput, View } from 'react-native';
import type { PlatformPolicy, ReferralConfig, SubscriptionPricing } from '@tesserix/homechef-shared';
import { Banner, Button, Card } from '../kit';
import {
  usePlatformPolicy, useSavePlatformPolicy,
  useSubscriptionPricing, useSaveSubscriptionPricing,
  useReferralConfig, useSaveReferralConfig,
} from '../../lib/hooks';
import { apiError } from '../../lib/api';
import { useConfirm } from '../prompt';
import { usePalette, radius, space, text } from '../../lib/theme';

// 0=Sunday..6=Saturday — index IS the value stored in operatingDays (matches Go's
// time.Weekday()). Do not reorder: Monday-first would shift every day by one.
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

function LabeledInput({ label, value, onChangeText, numeric, hint }: { label: string; value: string; onChangeText: (t: string) => void; numeric?: boolean; hint?: string }) {
  const p = usePalette();
  return (
    <View style={{ marginTop: 10 }}>
      <Text style={[text.caption, { color: p.mutedForeground, marginBottom: 4 }]}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        keyboardType={numeric ? 'numeric' : 'default'}
        autoCapitalize="none"
        autoCorrect={false}
        placeholderTextColor={p.mutedForeground}
        style={{ height: 44, borderRadius: radius.md, borderWidth: 1, borderColor: p.border, backgroundColor: p.muted, color: p.foreground, paddingHorizontal: 12, fontFamily: 'InterTight', fontSize: 15 }}
      />
      {hint ? <Text style={[text.caption, { color: p.mutedForeground, marginTop: 4 }]}>{hint}</Text> : null}
    </View>
  );
}

function SavedNotice({ notice }: { notice: { ok: boolean; text: string } | null }) {
  if (!notice) return null;
  return <View style={{ marginTop: 12 }}><Banner text={notice.text} tone={notice.ok ? 'success' : 'danger'} /></View>;
}

export function PolicyCard() {
  const p = usePalette();
  const { confirm } = useConfirm();
  const q = usePlatformPolicy();
  const save = useSavePlatformPolicy();
  const [form, setForm] = useState<PlatformPolicy | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [num, setNum] = useState<Record<string, string>>({});

  // Coalesce the nil-slice operatingDays to [] ONCE at load; a null .includes() crashes.
  useEffect(() => {
    const d = q.data;
    if (d) {
      setForm({ ...d, operatingDays: d.operatingDays ?? [] });
      setNum({
        serviceFeePercent: String(d.serviceFeePercent),
        taxPercent: String(d.taxPercent),
        chefPayoutPercent: String(d.chefPayoutPercent),
        driverPayoutPercent: String(d.driverPayoutPercent),
        baseDeliveryFee: String(d.baseDeliveryFee),
        perKmDeliveryFee: String(d.perKmDeliveryFee),
      });
    }
  }, [q.data]);

  if (!form) return null;
  const days = form.operatingDays ?? [];

  function toggleDay(idx: number) {
    setForm((f) => {
      if (!f) return f;
      const cur = f.operatingDays ?? [];
      const next = cur.includes(idx) ? cur.filter((d) => d !== idx) : [...cur, idx].sort((a, b) => a - b);
      return { ...f, operatingDays: next };
    });
  }

  async function onSave() {
    if (!form) return;
    const body: PlatformPolicy = {
      ...form,
      serviceFeePercent: Number(num.serviceFeePercent),
      taxPercent: Number(num.taxPercent),
      chefPayoutPercent: Number(num.chefPayoutPercent),
      driverPayoutPercent: Number(num.driverPayoutPercent),
      baseDeliveryFee: Number(num.baseDeliveryFee),
      perKmDeliveryFee: Number(num.perKmDeliveryFee),
    };
    const ok = await confirm({
      title: 'Save platform policy?',
      message: `Service fee ${body.serviceFeePercent}% and chef payout ${body.chefPayoutPercent}% apply to every new order from the moment you save.`,
      confirmLabel: 'Save policy',
    });
    if (!ok) return;
    setNotice(null);
    save.mutate(body, {
      onSuccess: () => setNotice({ ok: true, text: 'Policy saved.' }),
      onError: (e) => setNotice({ ok: false, text: apiError(e) }),
    });
  }

  return (
    <Card>
      <Text style={[text.title, { color: p.foreground }]}>Fees & payouts</Text>
      <LabeledInput label="Service fee %" value={num.serviceFeePercent ?? ''} onChangeText={(t) => setNum((s) => ({ ...s, serviceFeePercent: t }))} numeric hint="Platform's cut, charged to the customer." />
      <LabeledInput label="Tax %" value={num.taxPercent ?? ''} onChangeText={(t) => setNum((s) => ({ ...s, taxPercent: t }))} numeric />
      <LabeledInput label="Chef payout %" value={num.chefPayoutPercent ?? ''} onChangeText={(t) => setNum((s) => ({ ...s, chefPayoutPercent: t }))} numeric hint="Share of the order that reaches the chef." />
      <LabeledInput label="Driver payout %" value={num.driverPayoutPercent ?? ''} onChangeText={(t) => setNum((s) => ({ ...s, driverPayoutPercent: t }))} numeric />
      <LabeledInput label="Base delivery fee ₹" value={num.baseDeliveryFee ?? ''} onChangeText={(t) => setNum((s) => ({ ...s, baseDeliveryFee: t }))} numeric />
      <LabeledInput label="Per-km delivery fee ₹" value={num.perKmDeliveryFee ?? ''} onChangeText={(t) => setNum((s) => ({ ...s, perKmDeliveryFee: t }))} numeric />
      <LabeledInput label="Opens (HH:MM)" value={form.openingTime} onChangeText={(t) => setForm((f) => (f ? { ...f, openingTime: t } : f))} />
      <LabeledInput label="Closes (HH:MM)" value={form.closingTime} onChangeText={(t) => setForm((f) => (f ? { ...f, closingTime: t } : f))} />
      <LabeledInput label="Timezone" value={form.timezone} onChangeText={(t) => setForm((f) => (f ? { ...f, timezone: t } : f))} />

      <Text style={[text.caption, { color: p.mutedForeground, marginTop: 12, marginBottom: 6 }]}>Operating days</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {WEEKDAYS.map((d, i) => {
          const on = days.includes(i);
          return (
            <Pressable
              key={d}
              onPress={() => toggleDay(i)}
              style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: radius.pill, borderWidth: 1, borderColor: on ? p.primary : p.border, backgroundColor: on ? p.primary : 'transparent' }}
            >
              <Text style={{ fontFamily: 'InterTight-Medium', fontSize: 13, color: on ? p.primaryForeground : p.mutedForeground }}>{d}</Text>
            </Pressable>
          );
        })}
      </View>
      {days.length === 0 ? (
        <Text style={[text.caption, { color: p.mutedForeground, marginTop: 6 }]}>None selected — open every day.</Text>
      ) : null}

      <LabeledInput label="Closed message" value={form.closedMessage} onChangeText={(t) => setForm((f) => (f ? { ...f, closedMessage: t } : f))} hint="What customers see outside trading hours." />

      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 14 }}>
        <Text style={[text.body, { color: p.foreground, flex: 1, paddingRight: 12 }]}>Auto-confirm delivery</Text>
        <Switch value={form.confirmReceiptFlowEnabled ?? true} onValueChange={(v) => setForm((f) => (f ? { ...f, confirmReceiptFlowEnabled: v } : f))} />
      </View>
      <Text style={[text.caption, { color: p.mutedForeground, marginTop: 4 }]}>After delivery, remind the customer to confirm receipt; if they never respond it auto-confirms so the chef's payout can proceed. Off = manual confirmation only.</Text>

      <View style={{ marginTop: 16 }}>
        <Button label={save.isPending ? 'Saving…' : 'Save policy'} onPress={onSave} loading={save.isPending} disabled={save.isPending} />
      </View>
      <SavedNotice notice={notice} />
    </Card>
  );
}

const TIERS = ['standard', 'premium'] as const;
const PERIODS = ['monthly', 'quarterly', 'yearly'] as const;

export function PricingCard() {
  const p = usePalette();
  const { confirm } = useConfirm();
  const q = useSubscriptionPricing();
  const save = useSaveSubscriptionPricing();
  const [form, setForm] = useState<SubscriptionPricing | null>(null);
  const [num, setNum] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    const d = q.data;
    if (d) {
      setForm(d);
      setNum({
        trialDays: String(d.trialDays),
        minEarningsThreshold: String(d.minEarningsThreshold),
        premiumCommissionRate: String(d.premiumCommissionRate),
        standard_monthly: String(d.standard.monthly),
        standard_quarterly: String(d.standard.quarterly),
        standard_yearly: String(d.standard.yearly),
        premium_monthly: String(d.premium.monthly),
        premium_quarterly: String(d.premium.quarterly),
        premium_yearly: String(d.premium.yearly),
      });
    }
  }, [q.data]);

  if (!form) return null;

  async function onSave() {
    if (!form) return;
    const body: SubscriptionPricing = {
      ...form, // keeps country/currency pass-through (not edited on this screen)
      trialDays: Number(num.trialDays),
      minEarningsThreshold: Number(num.minEarningsThreshold),
      premiumCommissionRate: Number(num.premiumCommissionRate),
      standard: { monthly: Number(num.standard_monthly), quarterly: Number(num.standard_quarterly), yearly: Number(num.standard_yearly) },
      premium: { monthly: Number(num.premium_monthly), quarterly: Number(num.premium_quarterly), yearly: Number(num.premium_yearly) },
    };
    const ok = await confirm({
      title: 'Save subscription pricing?',
      message: 'New prices apply to every new subscription from the moment you save.',
      confirmLabel: 'Save pricing',
    });
    if (!ok) return;
    setNotice(null);
    save.mutate(body, {
      onSuccess: () => setNotice({ ok: true, text: 'Pricing saved.' }),
      onError: (e) => setNotice({ ok: false, text: apiError(e) }),
    });
  }

  return (
    <Card>
      <Text style={[text.title, { color: p.foreground }]}>Subscription pricing</Text>
      <LabeledInput label="Trial days" value={num.trialDays ?? ''} onChangeText={(t) => setNum((s) => ({ ...s, trialDays: t }))} numeric />
      <LabeledInput label="Min earnings before billing ₹" value={num.minEarningsThreshold ?? ''} onChangeText={(t) => setNum((s) => ({ ...s, minEarningsThreshold: t }))} numeric hint="A chef under this isn't charged." />
      <LabeledInput label="Premium commission rate %" value={num.premiumCommissionRate ?? ''} onChangeText={(t) => setNum((s) => ({ ...s, premiumCommissionRate: t }))} numeric />
      {TIERS.map((tier) => (
        <View key={tier} style={{ marginTop: 12 }}>
          <Text style={[text.caption, { color: p.mutedForeground, textTransform: 'capitalize' }]}>{tier}</Text>
          {PERIODS.map((period) => (
            <LabeledInput
              key={period}
              label={`${period} ₹`}
              value={num[`${tier}_${period}`] ?? ''}
              onChangeText={(t) => setNum((s) => ({ ...s, [`${tier}_${period}`]: t }))}
              numeric
            />
          ))}
        </View>
      ))}
      <View style={{ marginTop: 16 }}>
        <Button label={save.isPending ? 'Saving…' : 'Save pricing'} onPress={onSave} loading={save.isPending} disabled={save.isPending} />
      </View>
      <SavedNotice notice={notice} />
    </Card>
  );
}

export function ReferralCard() {
  const p = usePalette();
  const q = useReferralConfig();
  const save = useSaveReferralConfig();
  const [form, setForm] = useState<ReferralConfig | null>(null);
  const [num, setNum] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    const d = q.data;
    if (d) {
      setForm(d);
      setNum({ referrerReward: String(d.referrerReward), refereeReward: String(d.refereeReward), monthlySpendCap: String(d.monthlySpendCap) });
    }
  }, [q.data]);

  if (!form) return null;

  function onSave() {
    if (!form) return;
    const body: ReferralConfig = {
      enabled: form.enabled,
      referrerReward: Number(num.referrerReward),
      refereeReward: Number(num.refereeReward),
      monthlySpendCap: Number(num.monthlySpendCap),
    };
    setNotice(null);
    save.mutate(body, {
      onSuccess: () => setNotice({ ok: true, text: 'Referral config saved.' }),
      onError: (e) => setNotice({ ok: false, text: apiError(e) }),
    });
  }

  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={[text.title, { color: p.foreground }]}>Referrals</Text>
        <Switch value={form.enabled} onValueChange={(v) => setForm((f) => (f ? { ...f, enabled: v } : f))} />
      </View>
      <Text style={[text.caption, { color: p.mutedForeground, marginTop: 4 }]}>Both rewards are paid by the platform, so the monthly cap is the real exposure control.</Text>
      <LabeledInput label="Referrer reward ₹" value={num.referrerReward ?? ''} onChangeText={(t) => setNum((s) => ({ ...s, referrerReward: t }))} numeric />
      <LabeledInput label="Referee reward ₹" value={num.refereeReward ?? ''} onChangeText={(t) => setNum((s) => ({ ...s, refereeReward: t }))} numeric />
      <LabeledInput label="Monthly spend cap ₹" value={num.monthlySpendCap ?? ''} onChangeText={(t) => setNum((s) => ({ ...s, monthlySpendCap: t }))} numeric hint="Total the programme may pay out in a month." />
      <View style={{ marginTop: 16 }}>
        <Button label={save.isPending ? 'Saving…' : 'Save'} onPress={onSave} loading={save.isPending} disabled={save.isPending} />
      </View>
      <SavedNotice notice={notice} />
    </Card>
  );
}
