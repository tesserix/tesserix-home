// Settings — session identity, appearance (OS-driven), the API endpoint the app
// is bound to, app version, and sign-out. Read-mostly; the admin console keeps
// its knobs server-side, so this stays intentionally small.

import Constants from 'expo-constants';
import { Alert, ScrollView, Text, useColorScheme, View } from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '../lib/auth';
import { Screen, ScreenHeader, BackButton, Card, SectionLabel, Metric, Button, Badge } from '../components/kit';
import { usePalette, space, text, radius } from '../lib/theme';

const API_BASE = process.env.EXPO_PUBLIC_API_BASE ?? 'https://home.tesserix.app';

export default function Settings() {
  const { user, signOut } = useAuth();
  const p = usePalette();
  const scheme = useColorScheme();
  const initials = (user?.name || user?.email || '?').trim().slice(0, 1).toUpperCase();
  const version = Constants.expoConfig?.version ?? '1.0.0';

  return (
    <Screen>
      <ScreenHeader title="Settings" right={<BackButton onPress={() => router.back()} />} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: space[4], paddingBottom: space[10], gap: space[5] }}>
        <Card style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <View style={{ width: 48, height: 48, borderRadius: radius.pill, backgroundColor: p.primary, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ fontFamily: 'InterTight-SemiBold', fontSize: 18, color: p.primaryForeground }}>{initials}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[text.title, { color: p.foreground }]} numberOfLines={1}>{user?.name ?? 'Admin'}</Text>
            <Text style={[text.caption, { color: p.mutedForeground }]} numberOfLines={1}>{user?.email}</Text>
          </View>
          <Badge label="Admin" tone="info" />
        </Card>

        <View>
          <SectionLabel>Appearance</SectionLabel>
          <Card>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <View style={{ flex: 1 }}>
                <Text style={[text.body, { color: p.foreground }]}>Theme</Text>
                <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]}>Follows your device appearance.</Text>
              </View>
              <Badge label={scheme === 'dark' ? 'Dark' : 'Light'} tone="neutral" />
            </View>
          </Card>
        </View>

        <View>
          <SectionLabel>Connection</SectionLabel>
          <Card>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 20 }}>
              <Metric label="API endpoint" value={API_BASE.replace(/^https?:\/\//, '')} />
              <Metric label="App version" value={version} />
            </View>
          </Card>
        </View>

        <Button
          label="Sign out"
          variant="secondary"
          tone="danger"
          onPress={() =>
            Alert.alert('Sign out?', 'You can sign back in any time.', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Sign out', style: 'destructive', onPress: () => signOut() },
            ])
          }
        />

        <Text style={[text.caption, { color: p.mutedForeground, textAlign: 'center' }]}>
          Tesserix Admin · access limited to allow-listed admins
        </Text>
      </ScrollView>
    </Screen>
  );
}
