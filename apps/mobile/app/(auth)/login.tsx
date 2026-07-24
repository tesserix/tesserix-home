import { useEffect } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Google from 'expo-auth-session/providers/google';
import { ShieldCheck } from 'lucide-react-native';
import { useAuth, devBypassEnabled } from '../../lib/auth';
import { apiError } from '../../lib/api';
import { Button } from '../../components/kit';
import { palettes, radius, space, text } from '../../lib/theme';

// Login always renders on the dark navy brand surface (the admin's signature look),
// regardless of OS theme.
const p = palettes.dark;

export default function Login() {
  const { signInWithGoogle, signInDev, busy } = useAuth();

  const [request, response, promptAsync] = Google.useIdTokenAuthRequest({
    iosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
    webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
  });

  useEffect(() => {
    if (response?.type === 'success' && response.params?.id_token) {
      signInWithGoogle(response.params.id_token).catch((e) =>
        Alert.alert('Sign-in failed', apiError(e, 'Your Google account is not on the admin allowlist.')),
      );
    }
  }, [response, signInWithGoogle]);

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.center}>
        <View style={styles.badge}>
          <ShieldCheck size={28} color={p.sidebar} />
        </View>
        <Text style={styles.wordmark}>Tesserix</Text>
        <Text style={styles.tagline}>Platform admin console</Text>
      </View>

      <View style={styles.actions}>
        <Button
          label="Continue with Google"
          loading={busy}
          disabled={!request}
          onPress={() => promptAsync().catch(() => {})}
        />
        {devBypassEnabled ? (
          <Button
            label="Continue in dev mode"
            variant="secondary"
            onPress={() => signInDev().catch((e) => Alert.alert('Dev sign-in failed', apiError(e)))}
          />
        ) : null}
        <Text style={styles.fine}>Access is limited to allow-listed Tesserix admins.</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: p.sidebar, justifyContent: 'space-between', paddingHorizontal: space[6], paddingBottom: space[8] },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  badge: { width: 64, height: 64, borderRadius: radius.xl, backgroundColor: p.foreground, alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  wordmark: { fontFamily: 'InterTight-SemiBold', fontSize: 30, color: p.sidebarForeground, letterSpacing: -0.5 },
  tagline: { ...text.body, color: p.sidebarMuted },
  actions: { gap: 12 },
  fine: { ...text.caption, color: p.sidebarMuted, textAlign: 'center', marginTop: 6 },
});
