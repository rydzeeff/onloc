import 'dotenv/config';

export default {
  expo: {
    name: 'Onloc Mobile',
    slug: 'onloc-mobile',
    scheme: process.env.EXPO_PUBLIC_DEEPLINK_SCHEME || 'onloc',
    version: '1.0.0',
    orientation: 'portrait',
    userInterfaceStyle: 'light',
    assetBundlePatterns: ['**/*'],
    android: {
      package: 'com.onloc.mobile'
    },
    extra: {
      supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL,
      supabaseAnonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
      backendBaseUrl: process.env.EXPO_PUBLIC_BACKEND_BASE_URL
    }
  }
};
