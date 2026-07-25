// Platform announcements — broadcast messages to products. A collapsible
// composer creates drafts; each row shows severity + publish state and can be
// published/unpublished inline. Mirrors the tesserix-home web admin page.

import { useState } from 'react';
import { Alert, FlatList, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { useAnnouncements, useCreateAnnouncement, useToggleAnnouncement } from '../../lib/platform-hooks';
import { apiError } from '../../lib/api';
import { formatRelative, titleCase } from '@tesserix/homechef-shared';
import {
  Badge,
  BackButton,
  Button,
  Card,
  EmptyState,
  FilterChips,
  LoadingRows,
  Screen,
  ScreenHeader,
  type Tone,
} from '../../components/kit';
import { usePalette, radius, space, text } from '../../lib/theme';
import type { Announcement, AnnouncementSeverity } from '../../lib/platform-contracts';

const SEVERITIES: { key: AnnouncementSeverity; label: string }[] = [
  { key: 'info', label: 'Info' },
  { key: 'warning', label: 'Warning' },
  { key: 'maintenance', label: 'Maintenance' },
  { key: 'incident', label: 'Incident' },
];

function severityTone(s: string): Tone {
  if (s === 'incident') return 'danger';
  if (s === 'warning') return 'warning';
  return 'info'; // info + maintenance
}

export default function Announcements() {
  const q = useAnnouncements();
  const create = useCreateAnnouncement();
  const rows = q.data?.rows ?? [];

  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [severity, setSeverity] = useState<AnnouncementSeverity>('info');
  const p = usePalette();

  function save() {
    if (!title.trim() || !body.trim()) {
      Alert.alert('Missing fields', 'Enter both a title and a body.');
      return;
    }
    create.mutate(
      { title: title.trim(), body: body.trim(), severity },
      {
        onSuccess: () => {
          setTitle('');
          setBody('');
          setSeverity('info');
          setOpen(false);
        },
        onError: (e) => Alert.alert('Could not create', apiError(e)),
      },
    );
  }

  const composer = (
    <View style={{ paddingHorizontal: space[4], paddingBottom: space[3] }}>
      {open ? (
        <Card>
          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder="Title"
            placeholderTextColor={p.mutedForeground}
            style={[styles.input, { borderColor: p.border, color: p.foreground, backgroundColor: p.muted }]}
          />
          <TextInput
            value={body}
            onChangeText={setBody}
            placeholder="Body"
            placeholderTextColor={p.mutedForeground}
            multiline
            style={[
              styles.input,
              styles.multiline,
              { borderColor: p.border, color: p.foreground, backgroundColor: p.muted, marginTop: 8 },
            ]}
          />
          <View style={{ marginTop: 10, marginHorizontal: -space[4] }}>
            <FilterChips options={SEVERITIES} value={severity} onChange={setSeverity} />
          </View>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
            <View style={{ flex: 1 }}>
              <Button label="Save (draft)" onPress={save} loading={create.isPending} />
            </View>
            <View style={{ flex: 1 }}>
              <Button label="Cancel" variant="ghost" onPress={() => setOpen(false)} disabled={create.isPending} />
            </View>
          </View>
        </Card>
      ) : (
        <Button label="New announcement" variant="secondary" onPress={() => setOpen(true)} />
      )}
    </View>
  );

  return (
    <Screen>
      <ScreenHeader
        title="Announcements"
        subtitle="Broadcast to products"
        right={<BackButton onPress={() => router.back()} />}
      />
      {q.isLoading ? (
        <>
          {composer}
          <LoadingRows />
        </>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(a) => a.id}
          ListHeaderComponent={composer}
          contentContainerStyle={{ paddingHorizontal: space[4], gap: 10, paddingBottom: space[10] }}
          refreshing={q.isRefetching}
          onRefresh={() => q.refetch()}
          ListEmptyComponent={<EmptyState title="No announcements" body="Create one to broadcast." />}
          renderItem={({ item }) => <AnnouncementCard item={item} />}
        />
      )}
    </Screen>
  );
}

function AnnouncementCard({ item }: { item: Announcement }) {
  const p = usePalette();
  const toggle = useToggleAnnouncement();

  function flip() {
    toggle.mutate(
      { id: item.id, isPublished: !item.is_published },
      { onError: (e) => Alert.alert('Could not update', apiError(e)) },
    );
  }

  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Badge label={titleCase(item.severity)} tone={severityTone(item.severity)} />
        <Badge
          label={item.is_published ? 'Published' : 'Draft'}
          tone={item.is_published ? 'success' : 'neutral'}
        />
        <Text style={[text.caption, { color: p.mutedForeground, marginLeft: 'auto' }]}>
          {formatRelative(item.created_at)}
        </Text>
      </View>
      <Text style={[text.title, { color: p.foreground, marginTop: 8 }]} numberOfLines={2}>
        {item.title}
      </Text>
      {item.body ? (
        <Text style={[text.body, { color: p.mutedForeground, marginTop: 4 }]} numberOfLines={3}>
          {item.body}
        </Text>
      ) : null}
      <View style={{ marginTop: 12 }}>
        <Button
          label={item.is_published ? 'Unpublish' : 'Publish'}
          variant="secondary"
          onPress={flip}
          loading={toggle.isPending}
        />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  input: {
    height: 44,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    fontFamily: 'InterTight',
    fontSize: 15,
  },
  multiline: {
    height: 96,
    paddingTop: 12,
    textAlignVertical: 'top',
  },
});
