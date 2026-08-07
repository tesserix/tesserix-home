import { Alert, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useBlockedChefs, useSetPayoutAutomation } from '../../lib/hooks';
import { apiError } from '../../lib/api';
import { useConfirm } from '../../components/prompt';
import { titleCase, type BlockedChef, type PayoutAutomationValue, type PayoutRegistrationState } from '@tesserix/homechef-shared';
import { Badge, Card, EmptyState, LoadingRows, Screen, ScreenHeader, type Tone } from '../../components/kit';
import { usePalette, space, radius, text } from '../../lib/theme';

const AUTOMATION_OPTIONS: { value: PayoutAutomationValue; label: string }[] = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
  { value: '', label: 'Default' },
];
function registrationTone(state: PayoutRegistrationState): Tone {
  switch (state) {
    case 'verified': return 'success';
    case 'failed': return 'warning';
    case 'pending': return 'info';
    default: return 'neutral';
  }
}

export default function PayoutSetup() {
  const p = usePalette();
  const q = useBlockedChefs();
  const setAuto = useSetPayoutAutomation();
  const { confirm } = useConfirm();
  const chefs = q.data?.chefs ?? [];

  async function pick(chef: BlockedChef, value: PayoutAutomationValue) {
    if (value === chef.payoutAutoRelease) return;
    if (value === 'off') {
      const ok = await confirm({
        title: 'Turn off automation',
        message: `${chef.businessName} will need manual release via the queue until re-enabled. Continue?`,
        confirmLabel: 'Turn off', tone: 'destructive',
      });
      if (!ok) return;
    }
    setAuto.mutate({ chefId: chef.chefId, value }, { onError: (e) => Alert.alert('Update failed', apiError(e)) });
  }

  return (
    <Screen>
      <ScreenHeader
        title="Payout setup"
        subtitle={q.data ? `${chefs.length} blocked` : 'Blocked chefs'}
        right={<Pressable onPress={() => router.back()} hitSlop={10} style={{ paddingTop: 4 }}><ChevronLeft size={24} color={p.mutedForeground} /></Pressable>}
      />
      {q.isLoading ? (
        <LoadingRows />
      ) : chefs.length === 0 ? (
        <EmptyState title="No blocked chefs" body="Everyone can receive payouts." />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: space[4], paddingBottom: space[10], gap: 12 }}
          refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => q.refetch()} />}
        >
          {chefs.map((chef) => (
            <Card key={chef.chefId}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <Text style={[text.title, { color: p.foreground, flex: 1 }]}>{chef.businessName}</Text>
                <Badge label={titleCase(chef.registration.state)} tone={registrationTone(chef.registration.state)} />
              </View>
              <Text style={[text.label, { color: p.mutedForeground, marginTop: 12, marginBottom: 4 }]}>Why they're blocked</Text>
              <Text style={[text.body, { color: p.foreground }]}>{chef.registration.message}</Text>
              {chef.settlementStatus ? (
                <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]}>Cashfree: {chef.settlementStatus}</Text>
              ) : null}
              <Text style={[text.label, { color: p.mutedForeground, marginTop: 12, marginBottom: 6 }]}>Payout automation</Text>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {AUTOMATION_OPTIONS.map((o) => {
                  const on = chef.payoutAutoRelease === o.value;
                  return (
                    <Pressable
                      key={o.value || 'default'}
                      onPress={() => pick(chef, o.value)}
                      disabled={setAuto.isPending}
                      style={{ flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: radius.md, borderWidth: 1, borderColor: on ? p.primary : p.border, backgroundColor: on ? p.primary : 'transparent' }}
                    >
                      <Text style={{ fontFamily: 'InterTight-Medium', fontSize: 13, color: on ? p.primaryForeground : p.mutedForeground }}>{o.label}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </Card>
          ))}
        </ScrollView>
      )}
    </Screen>
  );
}
