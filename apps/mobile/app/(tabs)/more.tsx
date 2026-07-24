import { Alert, ScrollView, Text, View } from 'react-native';
import { Search, Settings } from 'lucide-react-native';
import { useAuth } from '../../lib/auth';
import { Card, ListRow, Screen, ScreenHeader, SectionLabel, Button } from '../../components/kit';
import { usePalette, space, text, radius } from '../../lib/theme';

export default function More() {
  const { user, signOut } = useAuth();
  const p = usePalette();
  const initials = (user?.name || user?.email || '?').trim().slice(0, 1).toUpperCase();

  return (
    <Screen>
      <ScreenHeader title="More" />
      <ScrollView contentContainerStyle={{ paddingHorizontal: space[4], paddingBottom: space[10], gap: space[5] }}>
        <Card style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <View style={{ width: 48, height: 48, borderRadius: radius.pill, backgroundColor: p.primary, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ fontFamily: 'InterTight-SemiBold', fontSize: 18, color: p.primaryForeground }}>{initials}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[text.title, { color: p.foreground }]} numberOfLines={1}>{user?.name ?? 'Admin'}</Text>
            <Text style={[text.caption, { color: p.mutedForeground }]} numberOfLines={1}>{user?.email}</Text>
          </View>
        </Card>

        <View>
          <SectionLabel>Tools</SectionLabel>
          <View style={{ gap: 8 }}>
            <ListRow title="Search" subtitle="Find anything across products" icon={Search} onPress={() => {}} />
            <ListRow title="Settings" subtitle="Preferences" icon={Settings} onPress={() => {}} />
          </View>
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
      </ScrollView>
    </Screen>
  );
}
