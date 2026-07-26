// staff.tsx — HomeChef internal team: staff list (deactivate/reactivate),
// pending invitations (revoke/resend), and an invite form. hc gateway.
import { useState } from 'react';
import { Alert, RefreshControl, ScrollView, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { formatDate, titleCase } from '@tesserix/homechef-shared';
import {
  Badge, BackButton, Banner, Button, Card, EmptyState, FilterChips, LoadingRows, Screen, ScreenHeader, SectionLabel,
} from '../../components/kit';
import { useInviteStaff, useSetStaffActive, useStaff, useStaffInvitations, useStaffInvitationAction, type StaffRow, type StaffInvitation } from '../../lib/hooks';
import { apiError } from '../../lib/api';
import { useConfirm } from '../../components/prompt';
import { usePalette, radius, space, text } from '../../lib/theme';

const ROLES = ['support', 'fleet_manager', 'delivery_ops', 'admin', 'super_admin'];
const ROLE_OPTIONS = ROLES.map((r) => ({ key: r, label: titleCase(r) }));

function staffName(m: StaffRow): string {
  return m.email || `${m.firstName ?? ''} ${m.lastName ?? ''}`.trim() || m.id.slice(0, 8);
}

export default function Staff() {
  const p = usePalette();
  const { confirm } = useConfirm();
  const staff = useStaff({ page: 1, limit: 50 });
  const invitesQ = useStaffInvitations({ page: 1, limit: 50 });
  const invite = useInviteStaff();
  const invAction = useStaffInvitationAction();
  const setActive = useSetStaffActive();

  const [email, setEmail] = useState('');
  const [role, setRole] = useState('support');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const members = staff.data?.data ?? [];
  const invites = (invitesQ.data?.data ?? []).filter((i) => i.status === 'pending');

  function onInvite() {
    setError(null);
    setNotice(null);
    if (!email.includes('@')) return setError('Enter a valid email.');
    invite.mutate(
      { email: email.trim(), staffRole: role },
      { onSuccess: () => { setNotice(`Invitation sent to ${email.trim()}.`); setEmail(''); }, onError: (e) => setError(apiError(e)) },
    );
  }

  async function toggleActive(m: StaffRow) {
    const action = m.isActive ? 'deactivate' : 'reactivate';
    const ok = await confirm({
      title: action === 'deactivate' ? 'Deactivate staff' : 'Reactivate staff',
      message: `${titleCase(action)} ${m.email ?? 'this member'}?`,
      confirmLabel: titleCase(action),
      tone: action === 'deactivate' ? 'destructive' : 'default',
    });
    if (ok) setActive.mutate({ id: m.id, action }, { onError: (e) => Alert.alert('Action failed', apiError(e)) });
  }

  async function revoke(inv: StaffInvitation) {
    const ok = await confirm({ title: 'Revoke invitation', message: `Revoke the pending invitation for ${inv.email}?`, confirmLabel: 'Revoke', tone: 'destructive' });
    if (ok) invAction.mutate({ id: inv.id, action: 'revoke' }, { onError: (e) => Alert.alert('Could not revoke', apiError(e)) });
  }

  return (
    <Screen>
      <ScreenHeader title="Staff" subtitle="Internal team + roles" right={<BackButton onPress={() => router.back()} />} />
      {staff.isLoading ? (
        <LoadingRows />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: space[10], gap: space[3] }}
          refreshControl={<RefreshControl refreshing={staff.isRefetching || invitesQ.isRefetching} onRefresh={() => { staff.refetch(); invitesQ.refetch(); }} />}
        >
          {notice ? <Banner text={notice} tone="success" /> : null}
          {error ? <Banner text={error} tone="danger" /> : null}

          <View style={{ paddingHorizontal: space[4] }}>
            <SectionLabel>Invite staff</SectionLabel>
            <Card>
              <Text style={[text.caption, { color: p.mutedForeground, marginBottom: 4 }]}>Email</Text>
              <TextInput
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="name@example.com"
                placeholderTextColor={p.mutedForeground}
                style={{ height: 44, borderRadius: radius.md, borderWidth: 1, borderColor: p.border, backgroundColor: p.muted, color: p.foreground, paddingHorizontal: 12, fontFamily: 'InterTight', fontSize: 15 }}
              />
              <Text style={[text.caption, { color: p.mutedForeground, marginTop: 12, marginBottom: 6 }]}>Role</Text>
              <FilterChips options={ROLE_OPTIONS} value={role} onChange={setRole} />
              <View style={{ marginTop: 14 }}>
                <Button label={invite.isPending ? 'Sending…' : 'Send invite'} onPress={onInvite} loading={invite.isPending} disabled={invite.isPending} />
              </View>
            </Card>
          </View>

          <View style={{ paddingHorizontal: space[4] }}><SectionLabel>Pending invitations</SectionLabel></View>
          {invites.length === 0 ? (
            <View style={{ paddingHorizontal: space[4] }}><Text style={[text.caption, { color: p.mutedForeground }]}>No pending invitations.</Text></View>
          ) : (
            <View style={{ paddingHorizontal: space[4], gap: 10 }}>
              {invites.map((inv) => (
                <Card key={inv.id}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text style={[text.title, { color: p.foreground, flex: 1 }]} numberOfLines={1}>{inv.email}</Text>
                    <Badge label="Pending" tone="warning" />
                  </View>
                  <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]}>{titleCase(inv.staffRole)} · invited {formatDate(inv.createdAt)}</Text>
                  <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                    <Button label="Resend" variant="secondary" onPress={() => invAction.mutate({ id: inv.id, action: 'resend' }, { onSuccess: () => setNotice(`Invitation to ${inv.email} resent.`), onError: (e) => Alert.alert('Could not resend', apiError(e)) })} />
                    <Button label="Revoke" variant="secondary" tone="danger" onPress={() => revoke(inv)} />
                  </View>
                </Card>
              ))}
            </View>
          )}

          <View style={{ paddingHorizontal: space[4] }}><SectionLabel>Team ({members.length})</SectionLabel></View>
          {members.length === 0 ? (
            <EmptyState title="No staff" body="Invite your first team member above." />
          ) : (
            <View style={{ paddingHorizontal: space[4], gap: 10 }}>
              {members.map((m) => (
                <Card key={m.id}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text style={[text.title, { color: p.foreground, flex: 1 }]} numberOfLines={1}>{staffName(m)}</Text>
                    <Badge label={m.isActive ? 'Active' : 'Inactive'} tone={m.isActive ? 'success' : 'neutral'} />
                  </View>
                  <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]}>{titleCase(m.staffRole)}{m.joinedAt ? ` · joined ${formatDate(m.joinedAt)}` : ''}</Text>
                  <View style={{ marginTop: 10 }}>
                    <Button label={m.isActive ? 'Deactivate' : 'Reactivate'} variant="secondary" tone={m.isActive ? 'danger' : 'default'} onPress={() => toggleActive(m)} />
                  </View>
                </Card>
              ))}
            </View>
          )}
        </ScrollView>
      )}
    </Screen>
  );
}
