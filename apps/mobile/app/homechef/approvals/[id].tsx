import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import {
  useApproval, useApprovalHistory, useDecideApproval, openApprovalDocument, type ReviewerRef,
} from '../../../lib/hooks';
import { apiError } from '../../../lib/api';
import { useConfirm } from '../../../components/prompt';
import { titleCase, formatDateTime } from '@tesserix/homechef-shared';
import {
  Badge, Banner, Button, Card, LoadingRows, Screen, ScreenHeader, SectionLabel, type Tone,
} from '../../../components/kit';
import { usePalette, space, text } from '../../../lib/theme';

function statusTone(s: string): Tone {
  if (s === 'approved') return 'success';
  if (s === 'rejected') return 'danger';
  return 'warning';
}
function personName(r: ReviewerRef | null | undefined): string {
  if (!r) return '';
  const name = `${r.firstName ?? ''} ${r.lastName ?? ''}`.trim();
  return name || r.email || '';
}
// submittedData may arrive as a raw JSON *string*; normalize to an object so we
// don't render a character grid.
function asObject(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return {};
}
function renderValue(v: unknown): string {
  if (v == null || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number' || typeof v === 'string') return String(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return '—';
    if (v.every((x) => typeof x === 'string' || typeof x === 'number')) return v.join(', ');
    return v.map((x) => renderValue(x)).join('; ');
  }
  if (typeof v === 'object') {
    const parts = Object.entries(v as Record<string, unknown>)
      .filter(([, val]) => val != null && val !== '')
      .map(([k, val]) => `${titleCase(k)}: ${renderValue(val)}`);
    return parts.length > 0 ? parts.join(' · ') : '—';
  }
  return String(v);
}

function Field({ label, value }: { label: string; value: string }) {
  const p = usePalette();
  return (
    <View style={{ minWidth: 120, flexGrow: 1, flexBasis: '40%' }}>
      <Text style={[text.caption, { color: p.mutedForeground }]}>{label}</Text>
      <Text style={[text.body, { color: p.foreground, marginTop: 2 }]}>{value}</Text>
    </View>
  );
}

export default function ApprovalDetail() {
  const p = usePalette();
  const { id } = useLocalSearchParams<{ id: string }>();
  const q = useApproval(id);
  const historyQ = useApprovalHistory(id);
  const decide = useDecideApproval(id);
  const { confirm, prompt } = useConfirm();
  const [docBusy, setDocBusy] = useState<string | null>(null);

  const a = q.data;
  const history = historyQ.data?.data ?? [];

  async function openDoc(docId: string) {
    setDocBusy(docId);
    try {
      await openApprovalDocument(id, docId);
    } catch (e) {
      Alert.alert('Could not open document', apiError(e));
    } finally {
      setDocBusy(null);
    }
  }

  async function act(action: 'approve' | 'reject' | 'request-info') {
    let notes = '';
    if (action === 'approve') {
      const ok = await confirm({
        title: 'Approve request',
        message: 'Approve this request? This triggers the related workflow.',
        confirmLabel: 'Approve',
      });
      if (!ok) return;
    } else {
      const r = await prompt({
        title: action === 'reject' ? 'Reject request' : 'Request more info',
        message:
          action === 'reject'
            ? 'Add a note explaining the rejection (shared with the applicant).'
            : "Tell the applicant what's missing.",
        label: 'Note',
        placeholder: action === 'reject' ? 'Reason for rejection…' : 'What do you need?',
        multiline: true,
        required: true,
        confirmLabel: action === 'reject' ? 'Reject' : 'Send request',
        tone: action === 'reject' ? 'destructive' : 'default',
      });
      if (r === null) return;
      notes = r;
    }
    decide.mutate({ action, notes }, { onError: (e) => Alert.alert('Action failed', apiError(e)) });
  }

  const back = (
    <Pressable onPress={() => router.back()} hitSlop={10} style={{ paddingTop: 4 }}>
      <ChevronLeft size={24} color={p.mutedForeground} />
    </Pressable>
  );

  if (q.isLoading) {
    return (
      <Screen>
        <ScreenHeader title="Approval" right={back} />
        <LoadingRows />
      </Screen>
    );
  }
  if (!a) {
    return (
      <Screen>
        <ScreenHeader title="Approval" right={back} />
        <Text style={[text.body, { color: p.mutedForeground, padding: space[4] }]}>Request not found.</Text>
      </Screen>
    );
  }

  const submitted = Object.entries(asObject(a.submittedData));
  const pending = a.status === 'pending' || a.status === 'info_requested';

  return (
    <Screen>
      <ScreenHeader title={a.title || titleCase(a.type)} subtitle={titleCase(a.type)} right={back} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: space[4], paddingBottom: space[10], gap: space[4] }}>
        <View style={{ alignSelf: 'flex-start' }}>
          <Badge label={titleCase(a.status)} tone={statusTone(a.status)} />
        </View>

        {a.kitchenTypeNonHome ? (
          <Banner text="Submitted kitchen type is NOT a home kitchen — HomeChef onboards home cooks only." />
        ) : null}
        {a.fssaiLooksCommercial ? (
          <Banner text="FSSAI licence looks like a commercial (State/Central) registration — verify this is a home kitchen." />
        ) : null}

        {a.description ? <Text style={[text.body, { color: p.foreground }]}>{a.description}</Text> : null}

        <Card>
          <View style={styles.grid}>
            {a.kitchenName ? <Field label="Kitchen" value={a.kitchenName} /> : null}
            {a.requestedByName || a.requestedByEmail ? (
              <Field label="Requested by" value={a.requestedByName || a.requestedByEmail || '—'} />
            ) : null}
            <Field label="Priority" value={titleCase(a.priority)} />
            <Field label="Submitted" value={formatDateTime(a.createdAt)} />
            {a.reviewedAt ? <Field label="Reviewed" value={formatDateTime(a.reviewedAt)} /> : null}
            {personName(a.reviewedBy) ? <Field label="Reviewed by" value={personName(a.reviewedBy)} /> : null}
          </View>
          {a.adminNotes ? (
            <View style={{ marginTop: 12 }}>
              <Text style={[text.caption, { color: p.mutedForeground }]}>Admin notes</Text>
              <Text style={[text.body, { color: p.foreground, marginTop: 2 }]}>{a.adminNotes}</Text>
            </View>
          ) : null}
        </Card>

        {submitted.length > 0 ? (
          <View>
            <SectionLabel>Submitted details</SectionLabel>
            <Card>
              <View style={{ gap: 12 }}>
                {submitted.map(([k, v]) => (
                  <View key={k}>
                    <Text style={[text.caption, { color: p.mutedForeground }]}>{titleCase(k)}</Text>
                    <Text style={[text.body, { color: p.foreground, marginTop: 2 }]}>{renderValue(v)}</Text>
                  </View>
                ))}
              </View>
            </Card>
          </View>
        ) : null}

        {a.documents && a.documents.length > 0 ? (
          <View>
            <SectionLabel>Documents ({a.documents.length})</SectionLabel>
            <Card>
              <View style={{ gap: 12 }}>
                {a.documents.map((d) => (
                  <View key={d.id} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                    <Text style={[text.body, { color: p.foreground, flex: 1 }]} numberOfLines={1}>
                      {titleCase(d.type ?? 'Document')}{d.fileName ? ` · ${d.fileName}` : ''}
                    </Text>
                    <Button
                      label={docBusy === d.id ? 'Opening…' : 'View'}
                      variant="secondary"
                      disabled={docBusy === d.id}
                      onPress={() => openDoc(d.id)}
                    />
                  </View>
                ))}
              </View>
            </Card>
          </View>
        ) : null}

        {history.length > 0 ? (
          <View>
            <SectionLabel>History</SectionLabel>
            <Card>
              <View style={{ gap: 12 }}>
                {history.map((h) => {
                  const actor = personName(h.changedBy);
                  return (
                    <View key={h.id} style={{ borderLeftWidth: 2, borderLeftColor: p.border, paddingLeft: 10 }}>
                      <Text style={[text.title, { color: p.foreground }]}>
                        {h.fromStatus ? `${titleCase(h.fromStatus)} → ` : ''}{titleCase(h.toStatus)}
                      </Text>
                      <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]}>
                        {formatDateTime(h.createdAt)}{actor ? ` · ${actor}` : ''}
                      </Text>
                      {h.notes ? <Text style={[text.body, { color: p.foreground, marginTop: 4 }]}>{h.notes}</Text> : null}
                    </View>
                  );
                })}
              </View>
            </Card>
          </View>
        ) : null}

        {pending ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
            <View style={{ flexGrow: 1, flexBasis: '30%' }}>
              <Button label="Approve" disabled={decide.isPending} onPress={() => act('approve')} />
            </View>
            <View style={{ flexGrow: 1, flexBasis: '30%' }}>
              <Button label="Request info" variant="secondary" disabled={decide.isPending} onPress={() => act('request-info')} />
            </View>
            <View style={{ flexGrow: 1, flexBasis: '30%' }}>
              <Button label="Reject" variant="secondary" tone="danger" disabled={decide.isPending} onPress={() => act('reject')} />
            </View>
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
});
