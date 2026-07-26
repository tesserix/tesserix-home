import { useEffect, useState } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useLoyaltyConfig, useLoyaltyAnalytics, useSaveLoyalty } from '../../lib/hooks';
import { apiError } from '../../lib/api';
import { formatCount, type LoyaltyConfig } from '@tesserix/homechef-shared';
import { Banner, Button, Card, LoadingRows, Screen, ScreenHeader, SectionLabel, StatGrid, StatTile } from '../../components/kit';
import { usePalette, space, radius, text } from '../../lib/theme';

const FIELDS: { key: keyof LoyaltyConfig; label: string }[] = [
  { key: 'pointsPerRupee', label: 'Points per ₹' },
  { key: 'redeemRate', label: '₹ per point' },
  { key: 'minRedeem', label: 'Min redeem (points)' },
  { key: 'streakThreshold', label: 'Streak threshold' },
  { key: 'streakBonus', label: 'Streak bonus (points)' },
  { key: 'streakGraceDays', label: 'Streak grace (days)' },
  { key: 'tierSilverAt', label: 'Silver at (points)' },
  { key: 'tierGoldAt', label: 'Gold at (points)' },
];

export default function Loyalty() {
  const p = usePalette();
  const cfg = useLoyaltyConfig();
  const analytics = useLoyaltyAnalytics();
  const save = useSaveLoyalty();
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
    // Guard blank/NaN inputs: Number('') is 0 and 'abc' is NaN — either would
    // silently persist a wrong points/tier value on this live config save.
    if (FIELDS.some((f) => { const v = form[f.key] ?? ''; return v.trim() === '' || !Number.isFinite(Number(v)); })) {
      Alert.alert('Check your numbers', 'Every field must be a valid amount.');
      return;
    }
    const body: LoyaltyConfig = {
      enabled,
      pointsPerRupee: Number(form.pointsPerRupee),
      redeemRate: Number(form.redeemRate),
      minRedeem: Number(form.minRedeem),
      streakThreshold: Number(form.streakThreshold),
      streakBonus: Number(form.streakBonus),
      streakGraceDays: Number(form.streakGraceDays),
      tierSilverAt: Number(form.tierSilverAt),
      tierGoldAt: Number(form.tierGoldAt),
    };
    setNotice(null);
    save.mutate(body, { onSuccess: () => setNotice('Saved.'), onError: (e) => Alert.alert('Save failed', apiError(e)) });
  }

  const a = analytics.data;
  const back = <Pressable onPress={() => router.back()} hitSlop={10} style={{ paddingTop: 4 }}><ChevronLeft size={24} color={p.mutedForeground} /></Pressable>;

  return (
    <Screen>
      <ScreenHeader title="Loyalty" subtitle="Points programme" right={back} />
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
            <StatTile label="Members" value={formatCount(a?.members)} />
            <StatTile label="Outstanding pts" value={formatCount(a?.outstandingPts)} tone="warning" />
            <StatTile label="Earned" value={formatCount(a?.pointsEarned)} />
            <StatTile label="Redeemed" value={formatCount(a?.pointsRedeemed)} />
            <StatTile label="Active streaks" value={formatCount(a?.activeStreaks)} />
            <StatTile label="Longest streak" value={formatCount(a?.longestStreak)} />
          </StatGrid>
        </ScrollView>
      )}
    </Screen>
  );
}
