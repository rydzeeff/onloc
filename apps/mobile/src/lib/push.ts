import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { supabase } from './supabase';

export async function registerPush(userId: string) {
  const perms = await Notifications.requestPermissionsAsync();
  if (!perms.granted) return null;
  const token = (await Notifications.getExpoPushTokenAsync()).data;

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', { name: 'default', importance: Notifications.AndroidImportance.DEFAULT });
  }

  const { error } = await supabase
    .from('push_subscriptions')
    .insert({ user_id: userId, subscription: { expoPushToken: token, platform: Platform.OS } });

  if (error) {
    return token;
  }
  return token;
}
