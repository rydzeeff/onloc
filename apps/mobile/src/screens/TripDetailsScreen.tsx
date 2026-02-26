import React, { useState } from 'react';
import { Button, ScrollView, Text } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchTripDetails, fetchTripParticipants, joinTrip, leaveTrip } from '../lib/trips';
import { useAuth } from '../providers/AuthProvider';
import { getPaymentState, initPayment, openPaymentUrl } from '../lib/payments';
import { buildInitPaymentPayload } from '../lib/paymentPayload';

export default function TripDetailsScreen({ route }: any) {
  const tripId = route.params.tripId as string;
  const { session } = useAuth();
  const qc = useQueryClient();
  const userId = session?.user.id!;
  const [paymentStatus, setPaymentStatus] = useState('');
  const [paymentId, setPaymentId] = useState<string | null>(null);

  const trip = useQuery({ queryKey: ['trip', tripId], queryFn: () => fetchTripDetails(tripId) });
  const participants = useQuery({ queryKey: ['trip-parts', tripId], queryFn: () => fetchTripParticipants(tripId) });

  const self = (participants.data ?? []).find((p: any) => p.user_id === userId);

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
    <ScrollView contentContainerStyle={{ padding: 14, gap: 8 }}>
      <Text style={{ fontSize: 20, fontWeight: '700' }}>{trip.data?.title}</Text>
      <Text>{trip.data?.description}</Text>
      <Text>Статус: {trip.data?.status}</Text>
      <Text>Участников: {(participants.data ?? []).length}</Text>
      {(participants.data ?? []).map((p: any) => (
        <Text key={p.user_id}>{p.last_name} {p.first_name} — {p.status}</Text>
      ))}

      <Button title="Присоединиться" onPress={async () => { await joinTrip(tripId, userId); await qc.invalidateQueries({ queryKey: ['trip-parts', tripId] }); }} />
      <Button title="Выйти из поездки" onPress={async () => { await leaveTrip(tripId, userId); await qc.invalidateQueries({ queryKey: ['trip-parts', tripId] }); }} />
      {self && <Button title="Оплатить через TBank" onPress={onPay} />}
      {paymentId && <Button title="Проверить статус оплаты" onPress={checkState} />}
      {!!paymentStatus && <Text>Payment status: {paymentStatus}</Text>}
    </ScrollView>
  );
}
