import React from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { acceptParticipant, fetchTripParticipants, rejectParticipant } from '../lib/trips';
import { useAuth } from '../providers/AuthProvider';

/** Parity source: pages/TripParticipantsPageMobile.js + components/trip-participants/ParticipantsTable.jsx */
export default function TripParticipantsScreen({ route }: any) {
  const tripId = route.params.tripId as string;
  const organizerId = route.params.organizerId as string | undefined;
  const { session } = useAuth();
  const userId = session?.user.id;
  const qc = useQueryClient();

  const participants = useQuery({
    queryKey: ['trip-parts', tripId],
    queryFn: () => fetchTripParticipants(tripId),
    enabled: !!tripId,
  });

  const isOrganizer = !!userId && !!organizerId && userId === organizerId;

  const onAccept = async (participantUserId: string) => {
    try {
      await acceptParticipant(tripId, participantUserId);
      await qc.invalidateQueries({ queryKey: ['trip-parts', tripId] });
    } catch {
      Alert.alert('Ошибка', 'Не удалось принять участника');
    }
  };

  const onReject = async (participantUserId: string) => {
    try {
      await rejectParticipant(tripId, participantUserId);
      await qc.invalidateQueries({ queryKey: ['trip-parts', tripId] });
    } catch {
      Alert.alert('Ошибка', 'Не удалось отклонить участника');
    }
  };

  if (participants.isLoading) {
    return <ActivityIndicator style={{ marginTop: 36 }} />;
  }

  return (
    <View style={styles.container}>
      <Text style={styles.heading}>Участники поездки</Text>
      <FlatList
        data={participants.data ?? []}
        keyExtractor={(item: any) => `${item.user_id}`}
        contentContainerStyle={{ padding: 12, gap: 8 }}
        ListEmptyComponent={<Text style={styles.empty}>Нет участников</Text>}
        renderItem={({ item }: any) => (
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{[item.last_name, item.first_name].filter(Boolean).join(' ') || 'Без имени'}</Text>
              <Text style={styles.status}>Статус: {item.status || '—'}</Text>
            </View>
            {isOrganizer && item.status === 'waiting' ? (
              <View style={styles.actions}>
                <Pressable style={[styles.btn, styles.accept]} onPress={() => onAccept(item.user_id)}>
                  <Text style={styles.btnText}>Принять</Text>
                </Pressable>
                <Pressable style={[styles.btn, styles.reject]} onPress={() => onReject(item.user_id)}>
                  <Text style={styles.btnText}>Отклонить</Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  heading: { fontSize: 20, fontWeight: '700', paddingHorizontal: 12, paddingTop: 12 },
  row: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 10,
    padding: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  name: { fontWeight: '700', fontSize: 14 },
  status: { color: '#4b5563', marginTop: 4 },
  actions: { flexDirection: 'row', gap: 6 },
  btn: { paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8 },
  accept: { backgroundColor: '#16a34a' },
  reject: { backgroundColor: '#dc2626' },
  btnText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  empty: { textAlign: 'center', color: '#6b7280', marginTop: 24 },
});
