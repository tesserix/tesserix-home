import { useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import {
  useOrderIssues,
  useResolveOrderIssue,
  useRejectOrderIssue,
  useTickets,
  useSetTicketStatus,
  useOrderIssueConfig,
  useUpdateOrderIssueConfig,
} from '../../lib/hooks';
import { apiError } from '../../lib/api';
import { formatINR, formatDateTime, titleCase } from '../../lib/format';
import {
  Badge,
  Button,
  EmptyState,
  FilterChips,
  ListRow,
  LoadingRows,
  Screen,
  ScreenHeader,
  type Tone,
} from '../../components/kit';
import { usePalette, space, radius, text } from '../../lib/theme';
import type { OrderIssue, SupportTicket } from '../../lib/contracts';

// Support desk (#262/#618): the Refunds tab resolves customer-reported order
// issues — Resolve (chef_clawback), Goodwill (platform_goodwill, partial-only), or
// Reject — and the Tickets tab moves a support ticket's status. Mirrors the
// tesserix-home web Support page; money movement lives in the Go API.

type Tab = 'issues' | 'tickets';
const TABS: { key: Tab; label: string }[] = [
  { key: 'issues', label: 'Refunds' },
  { key: 'tickets', label: 'Tickets' },
];

export default function Support() {
  const [tab, setTab] = useState<Tab>('issues');
  const p = usePalette();
  return (
    <Screen>
      <ScreenHeader
        title="Support"
        subtitle="Order-issue refunds & tickets"
        right={
          <Pressable onPress={() => router.back()} hitSlop={10} style={{ paddingTop: 4 }}>
            <ChevronLeft size={24} color={p.mutedForeground} />
          </Pressable>
        }
      />
      <View style={{ paddingBottom: space[3] }}>
        <FilterChips options={TABS} value={tab} onChange={setTab} />
      </View>
      {tab === 'issues' ? <RefundsTab /> : <TicketsTab />}
    </Screen>
  );
}

// ---- Refunds (order issues) -------------------------------------------------

const ISSUE_STATUSES = [
  { key: 'pending', label: 'Pending' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'rejected', label: 'Rejected' },
];

function issueTone(s: string): Tone {
  if (s === 'resolved' || s === 'auto_refunded') return 'success';
  if (s === 'rejected') return 'danger';
  return 'warning';
}

// Admin-tunable refund policy (#262): order-issue refunds at or below the cap are
// paid to the customer's wallet automatically; above it they queue for review.
function PolicyCard() {
  const p = usePalette();
  const q = useOrderIssueConfig();
  const update = useUpdateOrderIssueConfig();
  const [editing, setEditing] = useState(false);
  const [cap, setCap] = useState('');
  const cfg = q.data;
  if (!cfg) return null;

  function save() {
    const n = Number(cap);
    if (!Number.isFinite(n) || n < 0) {
      Alert.alert('Enter a cap', 'Enter a valid amount (₹).');
      return;
    }
    update.mutate(
      { autoApproveCap: n },
      { onSuccess: () => setEditing(false), onError: (e) => Alert.alert('Could not update', apiError(e)) },
    );
  }

  return (
    <View style={[styles.card, { marginHorizontal: space[4], marginBottom: space[3], backgroundColor: p.surface, borderColor: p.border }]}>
      <Text style={[text.title, { color: p.foreground }]}>Auto-approve policy</Text>
      <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]}>
        {cfg.enabled ? 'Enabled' : 'Disabled'} · refunds up to {formatINR(cfg.autoApproveCap)} are paid automatically.
      </Text>
      {editing ? (
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, alignItems: 'center' }}>
          <TextInput
            value={cap}
            onChangeText={setCap}
            keyboardType="numeric"
            placeholder="Cap (₹)"
            placeholderTextColor={p.mutedForeground}
            style={[styles.input, { flex: 1, borderColor: p.border, color: p.foreground, backgroundColor: p.muted }]}
          />
          <View style={{ width: 96 }}>
            <Button label="Save" onPress={save} loading={update.isPending} />
          </View>
        </View>
      ) : (
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
          <View style={{ flex: 1 }}>
            <Button
              label={cfg.enabled ? 'Disable' : 'Enable'}
              variant="secondary"
              onPress={() =>
                update.mutate(
                  { enabled: !cfg.enabled },
                  { onError: (e) => Alert.alert('Could not update', apiError(e)) },
                )
              }
              disabled={update.isPending}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Button
              label="Edit cap"
              variant="ghost"
              onPress={() => {
                setCap(String(cfg.autoApproveCap ?? ''));
                setEditing(true);
              }}
            />
          </View>
        </View>
      )}
    </View>
  );
}

function RefundsTab() {
  const [status, setStatus] = useState('pending');
  const q = useOrderIssues(status);
  const rows = q.data?.data ?? [];

  return (
    <>
      <PolicyCard />
      <View style={{ paddingBottom: space[3] }}>
        <FilterChips options={ISSUE_STATUSES} value={status} onChange={setStatus} />
      </View>
      {q.isLoading ? (
        <LoadingRows />
      ) : rows.length === 0 ? (
        <EmptyState title="No issues" body="Nothing matches this filter." />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(i) => i.id}
          contentContainerStyle={{ paddingHorizontal: space[4], gap: 10, paddingBottom: space[10] }}
          refreshing={q.isRefetching}
          onRefresh={() => q.refetch()}
          renderItem={({ item }) => <IssueCard issue={item} />}
        />
      )}
    </>
  );
}

function IssueCard({ issue }: { issue: OrderIssue }) {
  const p = usePalette();
  const [amount, setAmount] = useState(String(issue.requestedAmount || ''));
  const resolve = useResolveOrderIssue();
  const reject = useRejectOrderIssue();
  const pending = issue.status === 'pending';
  const busy = resolve.isPending || reject.isPending;

  function doResolve(faultPolicy: 'chef_clawback' | 'platform_goodwill') {
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      Alert.alert('Enter an amount', 'Enter a refund amount greater than zero.');
      return;
    }
    const goodwill = faultPolicy === 'platform_goodwill';
    Alert.alert(
      goodwill ? 'Goodwill refund' : 'Resolve & refund',
      goodwill
        ? `Refund ${formatINR(amt)} as platform goodwill — the chef keeps their payout (partial refunds only).`
        : `Refund ${formatINR(amt)} and claw it back from the chef's payout.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: goodwill ? 'Refund as goodwill' : 'Resolve & refund',
          onPress: () =>
            resolve.mutate(
              { id: issue.id, amount: amt, faultPolicy },
              { onError: (e) => Alert.alert('Could not refund', apiError(e)) },
            ),
        },
      ],
    );
  }

  function doReject() {
    Alert.alert('Reject refund request', 'The customer will not be refunded.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Reject',
        style: 'destructive',
        onPress: () => reject.mutate(issue.id, { onError: (e) => Alert.alert('Could not reject', apiError(e)) }),
      },
    ]);
  }

  return (
    <View style={[styles.card, { backgroundColor: p.surface, borderColor: p.border }]}>
      <View style={styles.rowBetween}>
        <Text style={[text.title, { color: p.foreground }]}>{titleCase(issue.reason)}</Text>
        <Badge label={titleCase(issue.status)} tone={issueTone(issue.status)} />
      </View>
      {issue.description ? (
        <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]}>{issue.description}</Text>
      ) : null}
      <Text style={[text.caption, { color: p.mutedForeground, marginTop: 4 }]}>
        Order {issue.orderId.slice(0, 8)} · requested {formatINR(issue.requestedAmount)} · {formatDateTime(issue.createdAt)}
      </Text>
      {!pending && issue.refundAmount > 0 ? (
        <Text style={[text.caption, { color: p.successFg, marginTop: 2 }]}>Refunded {formatINR(issue.refundAmount)}</Text>
      ) : null}

      {pending ? (
        <View style={{ marginTop: 12, gap: 8 }}>
          <TextInput
            value={amount}
            onChangeText={setAmount}
            keyboardType="numeric"
            placeholder="Refund amount (₹)"
            placeholderTextColor={p.mutedForeground}
            style={[styles.input, { borderColor: p.border, color: p.foreground, backgroundColor: p.muted }]}
          />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Button label="Resolve" onPress={() => doResolve('chef_clawback')} loading={busy} />
            </View>
            <View style={{ flex: 1 }}>
              <Button label="Goodwill" variant="secondary" onPress={() => doResolve('platform_goodwill')} disabled={busy} />
            </View>
          </View>
          <Button label="Reject" variant="ghost" tone="danger" onPress={doReject} disabled={busy} />
        </View>
      ) : null}
    </View>
  );
}

// ---- Tickets ----------------------------------------------------------------

const TICKET_STATUSES = ['open', 'in_progress', 'resolved', 'closed'];

function ticketTone(s: string): Tone {
  if (s === 'resolved' || s === 'closed') return 'success';
  if (s === 'open') return 'warning';
  return 'info';
}

function TicketsTab() {
  const [status, setStatus] = useState('');
  const q = useTickets({ status: status || undefined, page: 1, limit: 50 });
  const setStatusM = useSetTicketStatus();
  const rows = q.data?.data ?? [];

  function changeStatus(t: SupportTicket) {
    const opts = TICKET_STATUSES.filter((s) => s !== t.status).map((s) => ({
      text: titleCase(s),
      onPress: () =>
        setStatusM.mutate({ id: t.id, status: s }, { onError: (e) => Alert.alert('Update failed', apiError(e)) }),
    }));
    Alert.alert(t.subject, `#${t.ticketNumber || t.id.slice(0, 8)} · ${titleCase(t.status)}`, [
      ...opts,
      { text: 'Cancel', style: 'cancel' as const },
    ]);
  }

  return (
    <>
      <View style={{ paddingBottom: space[3] }}>
        <FilterChips
          options={[{ key: '', label: 'All' }, ...TICKET_STATUSES.map((s) => ({ key: s, label: titleCase(s) }))]}
          value={status}
          onChange={setStatus}
        />
      </View>
      {q.isLoading ? (
        <LoadingRows />
      ) : rows.length === 0 ? (
        <EmptyState title="No tickets" body="Nothing matches this filter." />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(t) => t.id}
          contentContainerStyle={{ paddingHorizontal: space[4], gap: 8, paddingBottom: space[10] }}
          refreshing={q.isRefetching}
          onRefresh={() => q.refetch()}
          renderItem={({ item }) => (
            <ListRow
              title={item.subject}
              subtitle={`#${item.ticketNumber || item.id.slice(0, 8)} · ${titleCase(item.category)}`}
              trailing={<Badge label={titleCase(item.status)} tone={ticketTone(item.status)} />}
              onPress={() => changeStatus(item)}
            />
          )}
        />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, padding: space[4] },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  input: {
    height: 44,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    fontFamily: 'InterTight',
    fontSize: 15,
  },
});
