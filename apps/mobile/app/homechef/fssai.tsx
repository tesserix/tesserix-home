import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import {
  useFssaiLocked, useNotifyFssaiBackfill, fetchFssaiBackfill, useAdminAction, type BackfillChef,
} from '../../lib/hooks';
import { apiError } from '../../lib/api';
import { useConfirm } from '../../components/prompt';
import { formatDate, type FSSAILockedChef } from '@tesserix/homechef-shared';
import {
  Badge, Banner, Button, Card, LoadingRows, Screen, ScreenHeader, SectionLabel,
} from '../../components/kit';
import { usePalette, space, radius, text } from '../../lib/theme';

export default function Fssai() {
  const p = usePalette();
  const q = useFssaiLocked();
  const notify = useNotifyFssaiBackfill();
  const override = useAdminAction(['hc', 'fssai-locked']);
  const { confirm, prompt } = useConfirm();

  const [notice, setNotice] = useState<string | null>(null);
  const [backfillOpen, setBackfillOpen] = useState(false);
  const [backfill, setBackfill] = useState<BackfillChef[] | null>(null);
  const [backfillLoading, setBackfillLoading] = useState(false);

  const data = q.data;

  async function viewBackfill() {
    if (backfillOpen) {
      setBackfillOpen(false);
      return;
    }
    setBackfillOpen(true);
    if (backfill) return;
    setBackfillLoading(true);
    try {
      const res = await fetchFssaiBackfill();
      setBackfill(res.chefs);
    } catch (e) {
      Alert.alert('Could not load list', apiError(e));
      setBackfillOpen(false);
    } finally {
      setBackfillLoading(false);
    }
  }
  async function notifyBackfill() {
    const ok = await confirm({
      title: 'Send confirm-licence push',
      message: 'Send a one-time push asking every chef with a missing FSSAI expiry to confirm their licence?',
      confirmLabel: 'Send push',
    });
    if (!ok) return;
    setNotice(null);
    notify.mutate(undefined, {
      onSuccess: (res) => {
        setBackfill(res.chefs);
        setNotice(`Confirm-licence push sent to ${res.notified} chef(s).`);
      },
      onError: (e) => Alert.alert('Notify failed', apiError(e)),
    });
  }

  async function grant(ch: FSSAILockedChef) {
    const reason = await prompt({
      title: `Grant FSSAI override — ${ch.businessName}`,
      message: 'Temporarily lift the FSSAI lock so this kitchen can keep operating.',
      label: 'Reason (min 10 characters)',
      placeholder: 'Why is this override justified?',
      multiline: true,
      required: true,
      minLength: 10,
      confirmLabel: 'Next',
    });
    if (reason === null) return;
    const daysStr = await prompt({
      title: 'Override duration',
      message: 'How long should the override last?',
      label: 'Days (1–30)',
      placeholder: '7',
      defaultValue: '7',
      numeric: true,
      required: true,
      confirmLabel: 'Grant override',
    });
    if (daysStr === null) return;
    const days = Number(daysStr);
    if (!Number.isInteger(days) || days < 1 || days > 30) {
      Alert.alert('Invalid duration', 'Days must be a whole number between 1 and 30.');
      return;
    }
    override.mutate(
      { method: 'post', path: `/chefs/${ch.chefId}/fssai-override`, body: { reason, days } },
      { onError: (e) => Alert.alert('Override failed', apiError(e)) },
    );
  }
  async function clear(ch: FSSAILockedChef) {
    const ok = await confirm({
      title: 'Clear override',
      message: `Re-lock ${ch.businessName}? It will be blocked until its FSSAI licence is renewed.`,
      confirmLabel: 'Clear override',
      tone: 'destructive',
    });
    if (!ok) return;
    override.mutate(
      { method: 'del', path: `/chefs/${ch.chefId}/fssai-override` },
      { onError: (e) => Alert.alert('Clear failed', apiError(e)) },
    );
  }

  return (
    <Screen>
      <ScreenHeader
        title="FSSAI Lockouts"
        subtitle={data ? `${data.lockedCount} locked · ${data.overriddenCount} overridden` : 'Expired licences'}
        right={
          <Pressable onPress={() => router.back()} hitSlop={10} style={{ paddingTop: 4 }}>
            <ChevronLeft size={24} color={p.mutedForeground} />
          </Pressable>
        }
      />
      {notice ? <Banner text={notice} tone="success" /> : null}
      {q.isLoading || !data ? (
        <LoadingRows />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: space[4], paddingBottom: space[10], gap: space[4] }}
        >
          {data.missingExpiryCount > 0 ? (
            <Card>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <Text style={[text.caption, { color: p.mutedForeground, flex: 1 }]}>
                  {data.missingExpiryCount} chef(s) have no FSSAI expiry on record.
                </Text>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Button label={backfillOpen ? 'Hide' : 'View'} variant="secondary" onPress={viewBackfill} />
                  <Button label={notify.isPending ? 'Notifying…' : 'Notify'} disabled={notify.isPending} onPress={notifyBackfill} />
                </View>
              </View>
              {backfillOpen ? (
                backfillLoading ? (
                  <Text style={[text.caption, { color: p.mutedForeground, marginTop: 10 }]}>Loading…</Text>
                ) : backfill && backfill.length > 0 ? (
                  <View style={{ marginTop: 10, gap: 4 }}>
                    {backfill.map((ch) => (
                      <Text key={ch.chefId} style={[text.body, { color: p.foreground }]}>{ch.businessName}</Text>
                    ))}
                  </View>
                ) : (
                  <Text style={[text.caption, { color: p.mutedForeground, marginTop: 10 }]}>
                    No chefs pending an expiry confirmation.
                  </Text>
                )
              ) : null}
            </Card>
          ) : null}

          <View>
            <SectionLabel>Locked ({data.lockedCount})</SectionLabel>
            {data.locked.length === 0 ? (
              <Text style={[text.caption, { color: p.mutedForeground }]}>None locked.</Text>
            ) : (
              <View style={{ gap: 8 }}>
                {data.locked.map((ch) => (
                  <View key={ch.chefId} style={[styles.row, { borderColor: p.border, backgroundColor: p.surface }]}>
                    <View style={{ flex: 1 }}>
                      <Text style={[text.title, { color: p.foreground }]}>{ch.businessName}</Text>
                      <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]}>
                        Expiry {ch.fssaiExpiry ? formatDate(ch.fssaiExpiry) : 'unknown'} · {ch.daysSinceExpiry}d expired
                      </Text>
                    </View>
                    <View style={{ alignItems: 'flex-end', gap: 8 }}>
                      <Badge label="Locked" tone="danger" />
                      <Button label="Grant override" variant="secondary" disabled={override.isPending} onPress={() => grant(ch)} />
                    </View>
                  </View>
                ))}
              </View>
            )}
          </View>

          <View>
            <SectionLabel>Overridden ({data.overriddenCount})</SectionLabel>
            {data.overridden.length === 0 ? (
              <Text style={[text.caption, { color: p.mutedForeground }]}>No active overrides.</Text>
            ) : (
              <View style={{ gap: 8 }}>
                {data.overridden.map((ch) => (
                  <View key={ch.chefId} style={[styles.row, { borderColor: p.border, backgroundColor: p.surface }]}>
                    <View style={{ flex: 1 }}>
                      <Text style={[text.title, { color: p.foreground }]}>{ch.businessName}</Text>
                      <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]}>
                        Until {ch.overrideUntil ? formatDate(ch.overrideUntil) : '—'}
                        {ch.overrideReason ? ` · ${ch.overrideReason}` : ''}
                      </Text>
                    </View>
                    <View style={{ alignItems: 'flex-end', gap: 8 }}>
                      <Badge label="Override active" tone="info" />
                      <Button label="Clear" variant="secondary" tone="danger" disabled={override.isPending} onPress={() => clear(ch)} />
                    </View>
                  </View>
                ))}
              </View>
            )}
          </View>
        </ScrollView>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: space[3],
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
