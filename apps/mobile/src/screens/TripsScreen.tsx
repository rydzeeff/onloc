import React from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { fetchTripsForUser } from '../lib/trips';
import { useAuth } from '../providers/AuthProvider';

export default function TripsScreen({ navigation }: any) {
  const { session } = useAuth();
  const userId = session?.user.id;
  const { data, isLoading } = useQuery({ queryKey: ['trips', userId], queryFn: () => fetchTripsForUser(userId!), enabled: !!userId });

  if (isLoading) return <ActivityIndicator style={{ marginTop: 40 }} />;

  return (
    <FlatList
      data={data ?? []}
      keyExtractor={(item: any) => item.id}
      contentContainerStyle={{ padding: 12, gap: 8 }}
      renderItem={({ item }: any) => (
        <Pressable onPress={() => navigation.navigate('TripDetails', { tripId: item.id })} style={{ borderWidth: 1, borderColor: '#ddd', borderRadius: 10, padding: 12 }}>
          <Text style={{ fontWeight: '700' }}>{item.title}</Text>
          <Text>Статус: {item.status ?? '—'}</Text>
          <Text>Цена: {item.price ?? '—'}</Text>
        </Pressable>
      )}
      ListEmptyComponent={<View><Text>Поездок пока нет</Text></View>}
    />
  );
}
