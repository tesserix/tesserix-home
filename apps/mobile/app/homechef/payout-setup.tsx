import { Alert, Linking, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useBlockedChefs, useSetPayoutAutomation } from '../../lib/hooks';
import { apiError } from '../../lib/api';
import { useConfirm } from '../../components/prompt';
import { titleCase, parseSettlementRequirements, type BlockedChef, type PayoutAutomationValue } from '@tesserix/homechef-shared';
import { Badge, Card, EmptyState, LoadingRows, Screen, ScreenHeader, type Tone } from '../../components/kit';
import { usePalette, space, radius, text } from '../../lib/theme';

const AUTOMATION_OPTIONS: { value: PayoutAutomationValue; label: string }[] = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
  { value: '', label: 'Default' },
];
function settlementTone(status: string): Tone {
  switch (status) {
    case 'needs_clarification': return 'warning';
    case 'created': return 'info';
    case 'activated': return 'success';
    default: return 'neutral';
  }
}
function settlementLabel(status: string): string {
  return status ? titleCase(status) : 'Not started';
}
function noRequirementsNote(status: string): string {
  switch (status) {
    case 'needs_clarification': return 'Razorpay flagged this account but returned no specific field.';
    case 'created': return 'Awaiting Razorpay review.';
    default: return 'Chef has not submitted bank details.';
  }
}

function Requirements({ chef }: { chef: BlockedChef }) {
  const p = usePalette();
  if (!chef.requirements) return <Text style={[text.caption, { color: p.mutedForeground }]}>{noRequirementsNote(chef.settlementStatus)}</Text>;
  const parsed = parseSettlementRequirements(chef.requirements);
  if (parsed === null) return <Text style={[text.caption, { color: p.mutedForeground }]}>{chef.requirements}</Text>;
  if (parsed.length === 0) return <Text style={[text.caption, { color: p.mutedForeground }]}>{noRequirementsNote(chef.settlementStatus)}</Text>;
  return (
    <View style={{ gap: 6 }}>
      {parsed.map((r, i) => {
        const field = r.field_reference ? titleCase(r.field_reference.replace(/[._]+/g, ' ')) : 'Unspecified field';
        const reason = r.reason_code ? ` — ${titleCase(r.reason_code)}` : '';
        const url = r.resolution_url;
        return (
          <View key={i}>
            <Text style={[text.body, { color: p.foreground }]}>{field}{reason}</Text>
            {url ? (
              <Text onPress={() => Linking.openURL(url)} style={{ fontFamily: 'InterTight-Medium', fontSize: 13, color: p.primary, marginTop: 2 }}>Resolve →</Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
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
                <Badge label={settlementLabel(chef.settlementStatus)} tone={settlementTone(chef.settlementStatus)} />
              </View>
              <Text style={[text.label, { color: p.mutedForeground, marginTop: 12, marginBottom: 4 }]}>What Razorpay needs</Text>
              <Requirements chef={chef} />
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
