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

    splash: {
      resizeMode: 'contain',
      backgroundColor: '#ffffff'
    },

    plugins: [
      'expo-font',
      [
        'expo-splash-screen',
        {
          backgroundColor: '#ffffff'
        }
      ]
    ],

    android: {
      package: 'com.onloc.mobile'
    },
    extra: {
      eas: {
        projectId: '1a6f7fad-c434-43ea-90e6-173067e038e8'
      },
      supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL,
      supabaseAnonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
      backendBaseUrl: process.env.EXPO_PUBLIC_BACKEND_BASE_URL
    }
  }
};
