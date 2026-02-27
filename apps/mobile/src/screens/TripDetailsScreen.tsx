import React, { useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchTripDetails, fetchTripParticipants, joinTrip, leaveTrip } from '../lib/trips';
import { useAuth } from '../providers/AuthProvider';
import { getPaymentState, initPayment, openPaymentUrl } from '../lib/payments';
import { buildInitPaymentPayload } from '../lib/paymentPayload';

/** Parity source: pages/trip/TripDetailsPageMobile.js */
export default function TripDetailsScreen({ route, navigation }: any) {
  const tripId = route.params.tripId as string;
  const { session } = useAuth();
  const qc = useQueryClient();
  const userId = session?.user.id!;
  const [paymentStatus, setPaymentStatus] = useState('');
  const [paymentId, setPaymentId] = useState<string | null>(null);

  const trip = useQuery({ queryKey: ['trip', tripId], queryFn: () => fetchTripDetails(tripId) });
  const participants = useQuery({ queryKey: ['trip-parts', tripId], queryFn: () => fetchTripParticipants(tripId) });

  const self = (participants.data ?? []).find((p: any) => p.user_id === userId);

  const joinedCount = useMemo(
    () => (participants.data ?? []).filter((p: any) => p.status === 'confirmed' || p.status === 'waiting').length,
    [participants.data]
  );

  const onPay = async () => {
    if (!self || !trip.data?.price) return;
    const payload = buildInitPaymentPayload(tripId, self.id, Number(trip.data.price));
    const payment = await initPayment(payload);
    setPaymentId(payment.paymentId);
    await openPaymentUrl(payment.paymentUrl);
  };

  const checkState = async () => {
    if (!paymentId) return;
    const state = await getPaymentState(paymentId);
    setPaymentStatus(String(state.paymentStatus || state.status || state.Success));
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>{trip.data?.title || 'Поездка'}</Text>
      <Text style={styles.muted}>Статус: {trip.data?.status || '—'}</Text>
      <Text style={styles.muted}>Даты: {trip.data?.date ? new Date(trip.data.date).toLocaleDateString('ru-RU') : '—'}</Text>
      <Text style={styles.muted}>Участники: {joinedCount}</Text>

      <Text style={styles.sectionTitle}>Описание</Text>
      <Text style={styles.body}>{trip.data?.description || 'Описание отсутствует'}</Text>

      <View style={styles.buttons}>
        <Pressable
          style={[styles.actionBtn, styles.primary]}
          onPress={async () => {
            try {
              await joinTrip(tripId, userId);
              await qc.invalidateQueries({ queryKey: ['trip-parts', tripId] });
            } catch {
              Alert.alert('Ошибка', 'Не удалось присоединиться');
            }
          }}
        >
          <Text style={styles.btnText}>Присоединиться</Text>
        </Pressable>

        <Pressable
          style={[styles.actionBtn, styles.danger]}
          onPress={async () => {
            try {
              await leaveTrip(tripId, userId);
              await qc.invalidateQueries({ queryKey: ['trip-parts', tripId] });
            } catch {
              Alert.alert('Ошибка', 'Не удалось выйти из поездки');
            }
          }}
        >
          <Text style={styles.btnText}>Выйти из поездки</Text>
        </Pressable>

        <Pressable
          style={[styles.actionBtn, styles.neutral]}
          onPress={() => navigation.navigate('TripParticipants', { tripId, organizerId: trip.data?.creator_id })}
        >
          <Text style={styles.btnTextDark}>Участники поездки</Text>
        </Pressable>

        <Pressable style={[styles.actionBtn, styles.neutral]} onPress={() => navigation.navigate('Messages')}>
          <Text style={styles.btnTextDark}>Сообщения</Text>
        </Pressable>

        {self ? (
          <Pressable style={[styles.actionBtn, styles.primary]} onPress={onPay}>
            <Text style={styles.btnText}>Оплатить через TBank</Text>
          </Pressable>
        ) : null}

        {paymentId ? (
          <Pressable style={[styles.actionBtn, styles.neutral]} onPress={checkState}>
            <Text style={styles.btnTextDark}>Проверить статус оплаты</Text>
          </Pressable>
        ) : null}
      </View>

      {paymentStatus ? <Text style={styles.statusLine}>Payment status: {paymentStatus}</Text> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 14, gap: 8 },
  title: { fontSize: 22, fontWeight: '700' },
  muted: { color: '#4b5563' },
  sectionTitle: { marginTop: 8, fontWeight: '700', fontSize: 16 },
  body: { color: '#111827' },
  buttons: { marginTop: 8, gap: 8 },
  actionBtn: { borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, alignItems: 'center' },
  primary: { backgroundColor: '#111827' },
  danger: { backgroundColor: '#dc2626' },
  neutral: { backgroundColor: '#e5e7eb' },
  btnText: { color: '#fff', fontWeight: '700' },
  btnTextDark: { color: '#111827', fontWeight: '700' },
  statusLine: { marginTop: 8, color: '#111827' },
});
