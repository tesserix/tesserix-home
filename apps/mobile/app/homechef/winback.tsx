import { useEffect, useState } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useWinbackConfig, useWinbackAnalytics, useSaveWinback } from '../../lib/hooks';
import { apiError } from '../../lib/api';
import { WINBACK_TRIGGER_LABEL, formatCount, formatRatioPct, type WinbackConfig } from '@tesserix/homechef-shared';
import { Banner, Button, Card, LoadingRows, Screen, ScreenHeader, SectionLabel, StatGrid, StatTile } from '../../components/kit';
import { usePalette, space, radius, text } from '../../lib/theme';

const FIELDS: { key: keyof WinbackConfig; label: string }[] = [
  { key: 'discountPercent', label: 'Discount %' },
  { key: 'maxDiscount', label: 'Max discount (₹)' },
  { key: 'validityDays', label: 'Valid for (days)' },
  { key: 'lapseThresholdDays', label: 'Lapse after (days)' },
  { key: 'cooldownDays', label: 'Cooldown (days)' },
];

export default function Winback() {
  const p = usePalette();
  const cfg = useWinbackConfig();
  const analytics = useWinbackAnalytics();
  const save = useSaveWinback();
  const [enabled, setEnabled] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const d = cfg.data;
    if (d) {
      setEnabled(d.enabled);
      setForm(Object.fromEntries(FIELDS.map((f) => [f.key, String(d[f.key])])));
    }
  }, [cfg.data]);

  function onSave() {
    const body: WinbackConfig = {
      enabled,
      discountPercent: Number(form.discountPercent),
      maxDiscount: Number(form.maxDiscount),
      validityDays: Number(form.validityDays),
      lapseThresholdDays: Number(form.lapseThresholdDays),
      cooldownDays: Number(form.cooldownDays),
    };
    setNotice(null);
    save.mutate(body, { onSuccess: () => setNotice('Saved.'), onError: (e) => Alert.alert('Save failed', apiError(e)) });
  }

  const a = analytics.data;
  const back = <Pressable onPress={() => router.back()} hitSlop={10} style={{ paddingTop: 4 }}><ChevronLeft size={24} color={p.mutedForeground} /></Pressable>;

  return (
    <Screen>
      <ScreenHeader title="Win-back" subtitle="Auto reactivation offers" right={back} />
      {cfg.isLoading ? (
        <LoadingRows />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: space[10], gap: space[4] }}
          refreshControl={<RefreshControl refreshing={cfg.isRefetching || analytics.isRefetching} onRefresh={() => { cfg.refetch(); analytics.refetch(); }} />}
        >
          {notice ? <Banner text={notice} tone="success" /> : null}
          <View style={{ paddingHorizontal: space[4] }}>
            <SectionLabel>Configuration</SectionLabel>
            <Card>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text style={[text.title, { color: p.foreground }]}>Enabled</Text>
                <Switch value={enabled} onValueChange={setEnabled} />
              </View>
              {FIELDS.map((f) => (
                <View key={f.key} style={{ marginTop: 10 }}>
                  <Text style={[text.caption, { color: p.mutedForeground, marginBottom: 4 }]}>{f.label}</Text>
                  <TextInput
                    value={form[f.key] ?? ''}
                    onChangeText={(t) => setForm((s) => ({ ...s, [f.key]: t }))}
                    keyboardType="numeric"
                    placeholderTextColor={p.mutedForeground}
                    style={{ height: 44, borderRadius: radius.md, borderWidth: 1, borderColor: p.border, backgroundColor: p.muted, color: p.foreground, paddingHorizontal: 12, fontFamily: 'InterTight', fontSize: 15 }}
                  />
                </View>
              ))}
              <View style={{ marginTop: 14 }}>
                <Button label={save.isPending ? 'Saving…' : 'Save'} onPress={onSave} loading={save.isPending} disabled={save.isPending} />
              </View>
            </Card>
          </View>

          <View style={{ paddingHorizontal: space[4] }}><SectionLabel>Analytics</SectionLabel></View>
          <StatGrid>
            <StatTile label="Offered" value={formatCount(a?.offered)} />
            <StatTile label="Reactivated" value={formatCount(a?.reactivated)} tone="success" />
            <StatTile label="Expired" value={formatCount(a?.expired)} />
            <StatTile label="Reactivation" value={a ? formatRatioPct(a.reactivationRate) : '—'} />
          </StatGrid>
          {(a?.byTrigger ?? []).length > 0 ? (
            <View style={{ paddingHorizontal: space[4] }}>
              <Card>
                <View style={{ gap: 8 }}>
                  {(a?.byTrigger ?? []).map((t) => (
                    <View key={t.trigger} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                      <Text style={[text.body, { color: p.foreground }]}>{WINBACK_TRIGGER_LABEL[t.trigger] ?? t.trigger}</Text>
                      <Text style={[text.caption, { color: p.mutedForeground }]}>{formatCount(t.reactivated)} / {formatCount(t.total)}</Text>
                    </View>
                  ))}
                </View>
              </Card>
            </View>
          ) : null}
        </ScrollView>
      )}
    </Screen>
  );
}
