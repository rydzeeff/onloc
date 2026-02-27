import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { env } from '../lib/env';
import { useAuth } from '../providers/AuthProvider';

export default function DiagnosticsScreen() {
  const { session } = useAuth();

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Diagnostics (dev only)</Text>
      <Text>API_BASE_URL: {env.backendBaseUrl || '—'}</Text>
      <Text>SUPABASE_URL: {env.supabaseUrl ? 'present' : 'missing'}</Text>
      <Text>SUPABASE_ANON_KEY: {env.supabaseAnonKey ? 'present' : 'missing'}</Text>
      <Text>SESSION: {session?.user?.id ? `active (${session.user.id})` : 'none'}</Text>
      <Text>SCHEME: {env.scheme}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, backgroundColor: '#fff', gap: 8 },
  title: { fontWeight: '700', fontSize: 18, marginBottom: 8 },
});
