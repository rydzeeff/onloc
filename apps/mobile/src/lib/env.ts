const required = ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_ANON_KEY', 'EXPO_PUBLIC_BACKEND_BASE_URL'] as const;

for (const key of required) {
  if (!process.env[key]) {
    console.warn(`[mobile] Missing env: ${key}`);
  }
}

export const env = {
  supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL ?? '',
  supabaseAnonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '',
  backendBaseUrl: (process.env.EXPO_PUBLIC_BACKEND_BASE_URL ?? '').replace(/\/+$/, ''),
  scheme: process.env.EXPO_PUBLIC_DEEPLINK_SCHEME ?? 'onloc'
};
