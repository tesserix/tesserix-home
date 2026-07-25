// promo-forms.tsx — HomeChef promo create/edit composers. Route files live under
// app/, so these form components live here (outside app/) to avoid becoming routes.
// Numeric fields are string-held and Number()-converted on submit (web pattern).
import { useMemo, useState } from 'react';
import { Alert, Text, TextInput, View } from 'react-native';
import {
  type Promo,
  type PromoDiscountType,
  type PromoFundingSource,
} from '@tesserix/homechef-shared';
import { Banner, Button, Card, FilterChips } from '../kit';
import { useChefs, useCreatePromo, useUpdatePromo, type PromoCreateBody, type PromoUpdateBody } from '../../lib/hooks';
import { apiError } from '../../lib/api';
import { useConfirm } from '../prompt';
import { usePalette, radius, text } from '../../lib/theme';

export type ApplicableTo = 'all' | 'new_users' | 'returning_users';

export const APPLICABLE_OPTIONS: { key: ApplicableTo; label: string }[] = [
  { key: 'all', label: 'Everyone' },
  { key: 'new_users', label: 'New users' },
  { key: 'returning_users', label: 'Returning users' },
];
export const APPLICABLE_LABEL: Record<string, string> = {
  all: 'Everyone',
  new_users: 'New users',
  returning_users: 'Returning users',
};

const DISCOUNT_OPTIONS: { key: PromoDiscountType; label: string }[] = [
  { key: 'percentage', label: 'Percentage' },
  { key: 'fixed', label: 'Fixed ₹' },
];
const FUNDING_OPTIONS: { key: PromoFundingSource; label: string }[] = [
  { key: 'platform', label: 'Platform' },
  { key: 'chef', label: 'Chef' },
];

function Field({
  label,
  value,
  onChangeText,
  numeric,
  autoCapitalize,
  placeholder,
}: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  numeric?: boolean;
  autoCapitalize?: 'none' | 'characters';
  placeholder?: string;
}) {
  const p = usePalette();
  return (
    <View style={{ marginTop: 10 }}>
      <Text style={[text.caption, { color: p.mutedForeground, marginBottom: 4 }]}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        keyboardType={numeric ? 'numeric' : 'default'}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        placeholder={placeholder}
        placeholderTextColor={p.mutedForeground}
        style={{ height: 44, borderRadius: radius.md, borderWidth: 1, borderColor: p.border, backgroundColor: p.muted, color: p.foreground, paddingHorizontal: 12, fontFamily: 'InterTight', fontSize: 15 }}
      />
    </View>
  );
}

function Selector<T extends string>({ label, options, value, onChange }: { label: string; options: { key: T; label: string }[]; value: T; onChange: (k: T) => void }) {
  const p = usePalette();
  return (
    <View style={{ marginTop: 12 }}>
      <Text style={[text.caption, { color: p.mutedForeground, marginBottom: 6 }]}>{label}</Text>
      <FilterChips options={options} value={value} onChange={onChange} />
    </View>
  );
}

export function PromoCreateForm({ onDone }: { onDone: () => void }) {
  const p = usePalette();
  const create = useCreatePromo();
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [discountType, setDiscountType] = useState<PromoDiscountType>('percentage');
  const [discountValue, setDiscountValue] = useState('');
  const [minOrderAmount, setMinOrderAmount] = useState('0');
  const [maxDiscount, setMaxDiscount] = useState('0');
  const [usageLimit, setUsageLimit] = useState('0');
  const [perUserLimit, setPerUserLimit] = useState('1');
  const [validUntil, setValidUntil] = useState('');
  const [fundingSource, setFundingSource] = useState<PromoFundingSource>('platform');
  const [applicableTo, setApplicableTo] = useState<ApplicableTo>('all');
  const [chefId, setChefId] = useState('');
  const [budgetCap, setBudgetCap] = useState('0');
  const [error, setError] = useState<string | null>(null);

  // Chef list is fetched lazily — the query is disabled until chef-funding is
  // chosen (mirrors the web SWR null-key lazy fetch), so no /chefs call fires
  // for platform-funded codes.
  const chefsQ = useChefs({ page: 1, limit: 200 }, fundingSource === 'chef');
  const chefs = fundingSource === 'chef' ? chefsQ.data?.data ?? [] : [];

  function submit() {
    setError(null);
    if (!code.trim()) return setError('A code is required.');
    if (Number(discountValue) <= 0) return setError('Discount must be greater than zero.');
    if (fundingSource === 'chef' && !chefId) return setError('Pick the chef whose payout funds this code.');
    const body: PromoCreateBody = {
      code: code.trim().toUpperCase(),
      description: description.trim(),
      discountType,
      discountValue: Number(discountValue),
      minOrderAmount: Number(minOrderAmount),
      maxDiscount: Number(maxDiscount),
      usageLimit: Number(usageLimit),
      perUserLimit: Number(perUserLimit),
      validUntil: validUntil || undefined,
      fundingSource,
      applicableTo,
      chefId: fundingSource === 'chef' ? chefId : undefined,
      budgetCap: Number(budgetCap),
    };
    create.mutate(body, {
      onSuccess: () => onDone(),
      onError: (e) => Alert.alert('Could not create promo', apiError(e)),
    });
  }

  return (
    <Card>
      {error ? <View style={{ marginBottom: 8 }}><Banner text={error} tone="danger" /></View> : null}
      <Field label="Code" value={code} onChangeText={setCode} autoCapitalize="characters" placeholder="SUMMER20" />
      <Field label="Description" value={description} onChangeText={setDescription} />
      <Selector label="Discount type" options={DISCOUNT_OPTIONS} value={discountType} onChange={setDiscountType} />
      <Field label={discountType === 'percentage' ? 'Discount %' : 'Discount ₹'} value={discountValue} onChangeText={setDiscountValue} numeric />
      <Field label="Min order amount (₹)" value={minOrderAmount} onChangeText={setMinOrderAmount} numeric />
      <Field label="Max discount (₹, 0 = uncapped)" value={maxDiscount} onChangeText={setMaxDiscount} numeric />
      <Field label="Usage limit (0 = unlimited)" value={usageLimit} onChangeText={setUsageLimit} numeric />
      <Field label="Per-user limit" value={perUserLimit} onChangeText={setPerUserLimit} numeric />
      <Field label="Valid until (ISO date, optional)" value={validUntil} onChangeText={setValidUntil} placeholder="2026-12-31" autoCapitalize="none" />
      <Selector label="Funding source" options={FUNDING_OPTIONS} value={fundingSource} onChange={setFundingSource} />
      {fundingSource === 'chef' ? (
        <View style={{ marginTop: 12 }}>
          <Text style={[text.caption, { color: p.mutedForeground, marginBottom: 6 }]}>Chef</Text>
          {chefsQ.isLoading ? (
            <Text style={[text.body, { color: p.mutedForeground }]}>Loading chefs…</Text>
          ) : (
            <FilterChips
              options={chefs.map((c) => ({ key: c.id, label: c.businessName }))}
              value={chefId}
              onChange={setChefId}
            />
          )}
        </View>
      ) : null}
      <Selector label="Applies to" options={APPLICABLE_OPTIONS} value={applicableTo} onChange={setApplicableTo} />
      <Field label="Budget cap (₹, 0 = uncapped)" value={budgetCap} onChangeText={setBudgetCap} numeric />
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
        <View style={{ flex: 1 }}><Button label="Cancel" variant="secondary" onPress={onDone} /></View>
        <View style={{ flex: 1 }}><Button label={create.isPending ? 'Creating…' : 'Create promo'} onPress={submit} loading={create.isPending} disabled={create.isPending} /></View>
      </View>
    </Card>
  );
}

export function PromoEditForm({ promo, onDone }: { promo: Promo; onDone: () => void }) {
  const update = useUpdatePromo();
  const { confirm } = useConfirm();
  const [description, setDescription] = useState(promo.description);
  const [discountValue, setDiscountValue] = useState(String(promo.discountValue));
  const [minOrderAmount, setMinOrderAmount] = useState(String(promo.minOrderAmount));
  const [maxDiscount, setMaxDiscount] = useState(String(promo.maxDiscount));
  const [usageLimit, setUsageLimit] = useState(String(promo.usageLimit));
  const [perUserLimit, setPerUserLimit] = useState(String(promo.perUserLimit));
  const [budgetCap, setBudgetCap] = useState(String(promo.budgetCap));
  const [applicableTo, setApplicableTo] = useState<ApplicableTo>((promo.applicableTo as ApplicableTo) || 'all');
  const [error, setError] = useState<string | null>(null);

  const base = useMemo<PromoUpdateBody>(
    () => ({
      description: description.trim(),
      discountValue: Number(discountValue),
      minOrderAmount: Number(minOrderAmount),
      maxDiscount: Number(maxDiscount),
      usageLimit: Number(usageLimit),
      perUserLimit: Number(perUserLimit),
      budgetCap: Number(budgetCap),
      applicableTo,
    }),
    [description, discountValue, minOrderAmount, maxDiscount, usageLimit, perUserLimit, budgetCap, applicableTo],
  );

  function save(patch?: Partial<PromoUpdateBody>) {
    setError(null);
    update.mutate(
      { id: promo.id, body: { ...base, ...patch } },
      { onSuccess: () => onDone(), onError: (e) => setError(apiError(e)) },
    );
  }

  return (
    <Card>
      {error ? <View style={{ marginBottom: 8 }}><Banner text={error} tone="danger" /></View> : null}
      <Field label="Description" value={description} onChangeText={setDescription} />
      <Field label="Discount value" value={discountValue} onChangeText={setDiscountValue} numeric />
      <Field label="Min order amount (₹)" value={minOrderAmount} onChangeText={setMinOrderAmount} numeric />
      <Field label="Max discount (₹, 0 = uncapped)" value={maxDiscount} onChangeText={setMaxDiscount} numeric />
      <Field label="Usage limit (0 = unlimited)" value={usageLimit} onChangeText={setUsageLimit} numeric />
      <Field label="Per-user limit" value={perUserLimit} onChangeText={setPerUserLimit} numeric />
      <Field label="Budget cap (₹, 0 = uncapped)" value={budgetCap} onChangeText={setBudgetCap} numeric />
      <Selector label="Applies to" options={APPLICABLE_OPTIONS} value={applicableTo} onChange={setApplicableTo} />
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
        <View style={{ flex: 1 }}><Button label="Cancel" variant="secondary" onPress={onDone} /></View>
        <View style={{ flex: 1 }}><Button label={update.isPending ? 'Saving…' : 'Save'} onPress={() => save()} loading={update.isPending} disabled={update.isPending} /></View>
      </View>
      {!promo.isActive ? (
        <View style={{ marginTop: 10 }}>
          <Button
            label="Reactivate code"
            variant="secondary"
            onPress={async () => {
              if (await confirm({ title: 'Reactivate code?', message: `${promo.code} will start working again.`, confirmLabel: 'Reactivate' })) {
                save({ isActive: true });
              }
            }}
          />
        </View>
      ) : null}
    </Card>
  );
}
