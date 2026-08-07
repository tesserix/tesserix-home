import { Pressable, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useCashfreeStatus, useStripeStatus } from '../../lib/hooks';
import type { CashfreeGatewayStatus, PaymentGatewayStatus } from '@tesserix/homechef-shared';
import { Badge, Card, LoadingRows, Screen, ScreenHeader, SectionLabel, type Tone } from '../../components/kit';
import { usePalette, space, text } from '../../lib/theme';

function modeMeta(s: PaymentGatewayStatus): { label: string; tone: Tone } {
  if (!s.configured) return { label: 'Not configured', tone: 'neutral' };
  if (s.mode === 'live') return { label: 'LIVE', tone: 'warning' };
  return { label: 'Test mode', tone: 'info' };
}

function StatusRow({ label, ok }: { label: string; ok: boolean }) {
  const p = usePalette();
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4 }}>
      <Text style={[text.body, { color: p.foreground }]}>{label}</Text>
      <Badge label={ok ? 'Set' : 'Missing'} tone={ok ? 'success' : 'neutral'} />
    </View>
  );
}

function GatewayCard({ title, s, secretLabel, extraLabel, extraOk }: {
  title: string; s: PaymentGatewayStatus; secretLabel: string; extraLabel?: string; extraOk?: boolean;
}) {
  const p = usePalette();
  const m = modeMeta(s);
  return (
    <View>
      <SectionLabel>{title}</SectionLabel>
      <Card>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <Text style={[text.title, { color: p.foreground }]}>{title}</Text>
          <Badge label={m.label} tone={m.tone} />
        </View>
        <StatusRow label={secretLabel} ok={s.configured} />
        {extraLabel ? <StatusRow label={extraLabel} ok={!!extraOk} /> : null}
        <StatusRow label="Webhook secret" ok={s.webhookSecretSet} />
        {s.keyPrefix ? <Text style={[text.caption, { color: p.mutedForeground, marginTop: 6 }]}>Key: {s.keyPrefix}…</Text> : null}
        {s.webhookUrl ? <Text style={[text.mono, { color: p.mutedForeground, marginTop: 2 }]} numberOfLines={1}>{s.webhookUrl}</Text> : null}
      </Card>
    </View>
  );
}

// Cashfree splits sandbox from production by HOST, so which environment a slot
// actually resolves to is a separate fact from what the slot is called — and the
// only one that says whether real money can move.
function CashfreeCard({ title, s }: { title: string; s: CashfreeGatewayStatus }) {
  const p = usePalette();
  return (
    <View>
      <GatewayCard title={title} s={s} secretLabel="Secret key" />
      <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]}>
        Environment: {s.environment || '—'}
      </Text>
    </View>
  );
}

export default function PaymentGateway() {
  const p = usePalette();
  const cfLive = useCashfreeStatus('live');
  const cfTest = useCashfreeStatus('test');
  const st = useStripeStatus();

  return (
    <Screen>
      <ScreenHeader
        title="Payment gateway"
        subtitle="Cashfree + Stripe · read-only"
        right={<Pressable onPress={() => router.back()} hitSlop={10} style={{ paddingTop: 4 }}><ChevronLeft size={24} color={p.mutedForeground} /></Pressable>}
      />
      {cfLive.isLoading || cfTest.isLoading || st.isLoading ? (
        <LoadingRows />
      ) : (
        <ScrollView contentContainerStyle={{ paddingHorizontal: space[4], paddingBottom: space[10], gap: space[4] }}>
          {cfLive.data ? <CashfreeCard title="Cashfree — Live" s={cfLive.data} /> : null}
          {cfTest.data ? <CashfreeCard title="Cashfree — Test" s={cfTest.data} /> : null}
          {st.data ? <GatewayCard title="Stripe" s={st.data} secretLabel="Secret key" extraLabel="Publishable key" extraOk={st.data.publishableKeySet} /> : null}
          <Text style={[text.caption, { color: p.mutedForeground }]}>Credentials are managed on the web admin.</Text>
        </ScrollView>
      )}
    </Screen>
  );
}
