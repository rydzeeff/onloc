import { supabase } from '../supabaseClient';

const dynamicImport = (moduleName) => new Function('modulePath', 'return import(modulePath)')(moduleName);

const MOBILE_SESSION_KEY = 'onloc-mobile-session';

async function getCapacitor() {
  try {
    return await dynamicImport('@capacitor/core');
  } catch {
    return null;
  }
}

export async function isNativePlatform() {
  const cap = await getCapacitor();
  return !!cap?.Capacitor?.isNativePlatform?.();
}

export async function getCurrentPositionWithPermission() {
  const cap = await getCapacitor();
  if (!cap?.Capacitor?.isNativePlatform?.()) {
    throw new Error('Geolocation via Capacitor доступна только в нативном приложении.');
  }

  const { Geolocation } = await dynamicImport('@capacitor/geolocation');
  const permissions = await Geolocation.checkPermissions();
  if (permissions.location !== 'granted') {
    await Geolocation.requestPermissions();
  }

  return Geolocation.getCurrentPosition({
    enableHighAccuracy: true,
    timeout: 10000,
  });
}

export async function registerPushAndSyncToken(userId) {
  const cap = await getCapacitor();
  if (!cap?.Capacitor?.isNativePlatform?.() || !userId) return null;

  const { PushNotifications } = await dynamicImport('@capacitor/push-notifications');
  const permission = await PushNotifications.requestPermissions();
  if (permission.receive !== 'granted') {
    throw new Error('Пользователь запретил push-уведомления');
  }

  await PushNotifications.register();

  return new Promise((resolve, reject) => {
    const regListener = PushNotifications.addListener('registration', async (token) => {
      try {
        await fetch('/api/mobile/device-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: token.value, platform: cap.Capacitor.getPlatform() }),
        });
        resolve(token.value);
      } catch (error) {
        reject(error);
      } finally {
        regListener.remove();
      }
    });

    const errorListener = PushNotifications.addListener('registrationError', (error) => {
      errorListener.remove();
      reject(error);
    });
  });
}

export async function cacheSessionInPreferences(session) {
  const cap = await getCapacitor();
  if (!cap?.Capacitor?.isNativePlatform?.()) return;

  const { Preferences } = await dynamicImport('@capacitor/preferences');
  await Preferences.set({ key: MOBILE_SESSION_KEY, value: JSON.stringify(session || null) });
}

export async function restoreSessionFromPreferences() {
  const cap = await getCapacitor();
  if (!cap?.Capacitor?.isNativePlatform?.()) return null;

  const { Preferences } = await dynamicImport('@capacitor/preferences');
  const { value } = await Preferences.get({ key: MOBILE_SESSION_KEY });
  if (!value) return null;

  const parsed = JSON.parse(value);
  if (!parsed?.access_token || !parsed?.refresh_token) return null;

  await supabase.auth.setSession({
    access_token: parsed.access_token,
    refresh_token: parsed.refresh_token,
  });

  return parsed;
}

export async function setupAppUrlListener(router) {
  const cap = await getCapacitor();
  if (!cap?.Capacitor?.isNativePlatform?.()) return () => {};

  const { App } = await dynamicImport('@capacitor/app');
  const listener = await App.addListener('appUrlOpen', ({ url }) => {
    if (!url) return;

    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'onlocapp:') return;

      const hash = new URLSearchParams((parsed.hash || '').replace('#', ''));
      const query = parsed.searchParams;
      const accessToken = hash.get('access_token') || query.get('access_token');
      const refreshToken = hash.get('refresh_token') || query.get('refresh_token');
      const type = hash.get('type') || query.get('type');

      if (accessToken && refreshToken) {
        supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
      }

      router.push({ pathname: '/mobile/auth-callback', query: { type: type || 'magiclink' } }).catch(() => {
        window.location.href = '/mobile/auth-callback';
      });
    } catch (error) {
      console.error('[mobile][appUrlOpen] parse error:', error);
    }
  });

  return () => listener.remove();
}

export function getSupabaseRedirectUrl() {
  return 'onlocapp://auth-callback';
}
