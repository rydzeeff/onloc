import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { fetchTripsForUser } from '../lib/trips';
import { useAuth } from '../providers/AuthProvider';
import { fetchChats } from '../lib/messages';

const DEFAULT_TRIP_IMAGE = 'https://onloc.space/def/fotoMB.jpg';

type SectionKey = 'myTrips' | 'create-trip' | 'messages' | 'settings' | 'reviews';

const NAV_ITEMS: Array<{ id: SectionKey; label: string }> = [
  { id: 'myTrips', label: 'Мои поездки' },
  { id: 'create-trip', label: 'Создать' },
  { id: 'messages', label: 'Сообщения' },
  { id: 'settings', label: 'Настройки' },
  { id: 'reviews', label: 'Отзывы' },
];

function pickTripImage(item: any) {
  if (Array.isArray(item?.image_urls) && item.image_urls[0]) return item.image_urls[0];
  return DEFAULT_TRIP_IMAGE;
}

/** Parity source: pages/DashboardMobile.js + pages/MyTripsSectionMobile.js */
export default function DashboardScreen({ navigation }: any) {
  const { session } = useAuth();
  const userId = session?.user.id;
  const [activeSection, setActiveSection] = useState<SectionKey>('myTrips');

  const tripsQuery = useQuery({
    queryKey: ['dashboard-trips', userId],
    queryFn: () => fetchTripsForUser(userId!),
    enabled: !!userId,
  });
  const chatsQuery = useQuery({
    queryKey: ['dashboard-chats', userId],
    queryFn: () => fetchChats(userId!),
    enabled: !!userId,
  });

  const myTrips = useMemo(() => {
    const list = tripsQuery.data ?? [];
    return list.filter((trip: any) => {
      const inTrip = (trip.trip_participants ?? []).some((p: any) => p.user_id === userId && p.status !== 'rejected');
      return trip.creator_id === userId || inTrip;
    });
  }, [tripsQuery.data, userId]);

  const unread = chatsQuery.data?.length ?? 0;

  useEffect(() => {
    if (activeSection === 'messages') {
      navigation.navigate('Messages');
      setActiveSection('myTrips');
    } else if (activeSection === 'settings') {
      navigation.navigate('Profile');
      setActiveSection('myTrips');
    } else if (activeSection === 'create-trip') {
      navigation.navigate('Trips');
      setActiveSection('myTrips');
    }
  }, [activeSection, navigation]);

  const renderSection = () => {
    if (activeSection === 'myTrips') {
      if (tripsQuery.isLoading) return <ActivityIndicator style={styles.loader} />;
      return (
        <FlatList
          data={myTrips}
          keyExtractor={(item: any) => item.id}
          contentContainerStyle={styles.listWrap}
          ListEmptyComponent={<Text style={styles.empty}>Поездок пока нет</Text>}
          renderItem={({ item }: any) => (
            <Pressable style={styles.tripCard} onPress={() => navigation.navigate('TripDetails', { tripId: item.id })}>
              <Image source={{ uri: pickTripImage(item) }} style={styles.tripImage} />
              <View style={styles.tripInfo}>
                <Text style={styles.tripTitle}>{item.title}</Text>
                <Text>Начало: {item.date ? new Date(item.date).toLocaleDateString('ru-RU') : '—'}</Text>
                <Text>Конец: {item.arrival_date ? new Date(item.arrival_date).toLocaleDateString('ru-RU') : '—'}</Text>
                <Text>Цена: {item.price ?? '—'} ₽</Text>
              </View>
            </Pressable>
          )}
        />
      );
    }

    return <Text style={styles.empty}>У вас пока нет отзывов.</Text>;
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.logo}>Onloc</Text>
        <Pressable style={styles.mapBtn} onPress={() => navigation.navigate('Trips')}>
          <Text style={styles.mapBtnText}>На карту</Text>
        </Pressable>
      </View>

      <View style={styles.content}>{renderSection()}</View>

      <View style={styles.navRow}>
        {NAV_ITEMS.map((item) => {
          const isActive = activeSection === item.id;
          return (
            <Pressable key={item.id} style={styles.navButton} onPress={() => setActiveSection(item.id)}>
              <Text style={[styles.navText, isActive && styles.navTextActive]}>{item.label}</Text>
              {item.id === 'messages' && unread > 0 && !isActive ? <Text style={styles.badge}>{unread}</Text> : null}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  header: { paddingTop: 16, paddingHorizontal: 16, paddingBottom: 8, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  logo: { fontSize: 20, fontWeight: '700' },
  mapBtn: { backgroundColor: '#111827', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 },
  mapBtnText: { color: '#fff', fontWeight: '600' },
  content: { flex: 1 },
  loader: { marginTop: 30 },
  listWrap: { padding: 12, gap: 8 },
  empty: { textAlign: 'center', marginTop: 24, color: '#6b7280' },
  tripCard: { borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 12, overflow: 'hidden', backgroundColor: '#fff' },
  tripImage: { height: 120, width: '100%' },
  tripInfo: { padding: 10, gap: 2 },
  tripTitle: { fontWeight: '700', fontSize: 16, marginBottom: 6 },
  navRow: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: '#e5e7eb' },
  navButton: { flex: 1, alignItems: 'center', paddingVertical: 10, position: 'relative' },
  navText: { fontSize: 12, color: '#6b7280' },
  navTextActive: { color: '#111827', fontWeight: '700' },
  badge: { position: 'absolute', top: 2, right: 10, minWidth: 18, textAlign: 'center', backgroundColor: '#ef4444', color: '#fff', borderRadius: 9, paddingHorizontal: 4, fontSize: 11 },
});
