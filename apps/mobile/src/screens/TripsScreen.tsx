import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { env } from '../lib/env';

const DEFAULT_TRIP_IMAGE = 'https://onloc.space/def/fotoMB.jpg';

const leisureTypeLabels: Record<string, string> = {
  beach: 'Пляжный',
  excursion: 'Экскурсионный',
  camping: 'Кемпинг',
  cruise: 'Круиз',
  ski: 'Горнолыжный',
};

const difficultyLabels: Record<string, string> = {
  easy: 'Легкий',
  medium: 'Средний',
  hard: 'Сложный',
};

function getCoordsFromTrip(trip: any): [number, number] | null {
  const raw = trip?.to_location;
  if (!raw) return null;
  const geo = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!geo?.coordinates || !Array.isArray(geo.coordinates)) return null;
  return [Number(geo.coordinates[1]), Number(geo.coordinates[0])];
}

function buildStaticMapUrl(trips: any[]) {
  const withCoords = trips
    .map((trip) => ({ trip, coords: getCoordsFromTrip(trip) }))
    .filter((x) => !!x.coords)
    .slice(0, 20);

  if (!withCoords.length) return null;

  const [lat, lon] = withCoords[0].coords as [number, number];
  const points = withCoords
    .map((x) => {
      const [pLat, pLon] = x.coords as [number, number];
      return `${pLon},${pLat},pm2rdm`;
    })
    .join('~');

  return `https://static-maps.yandex.ru/1.x/?lang=ru_RU&size=650,300&l=map&z=5&ll=${lon},${lat}&pt=${points}`;
}

/** Parity source: pages/TripsPageMobile.js + components/FiltersMobile.js + pages/trips.js */
export default function TripsScreen({ navigation }: any) {
  const [priceFrom, setPriceFrom] = useState('');
  const [priceTo, setPriceTo] = useState('');
  const [leisureType, setLeisureType] = useState('');
  const [difficulty, setDifficulty] = useState('');

  const query = useQuery({
    queryKey: ['active-trips-mobile-map'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_active_trips_geojson');
      if (error) throw error;
      return data ?? [];
    },
  });

  const filtered = useMemo(() => {
    return (query.data ?? []).filter((trip: any) => {
      const price = Number(trip.price || 0);
      if (priceFrom && price < Number(priceFrom)) return false;
      if (priceTo && price > Number(priceTo)) return false;
      if (leisureType && trip.leisure_type !== leisureType) return false;
      if (difficulty && trip.difficulty !== difficulty) return false;
      return true;
    });
  }, [query.data, priceFrom, priceTo, leisureType, difficulty]);

  const staticMapUrl = useMemo(() => buildStaticMapUrl(filtered), [filtered]);

  if (query.isLoading) return <ActivityIndicator style={{ marginTop: 40 }} />;

  return (
    <View style={styles.container}>
      <Pressable
        style={styles.mapBlock}
        onPress={() => Linking.openURL(`${env.backendBaseUrl}/trips`).catch(() => null)}
      >
        {staticMapUrl ? (
          <Image source={{ uri: staticMapUrl }} style={styles.mapImage} />
        ) : (
          <View style={[styles.mapImage, styles.mapFallback]}>
            <Text style={styles.mapFallbackText}>Карта недоступна: нет координат поездок</Text>
          </View>
        )}
        <View style={styles.mapOverlay}>
          <Text style={styles.mapTitle}>Карта поездок</Text>
          <Text style={styles.mapSubtitle}>Нажмите, чтобы открыть интерактивную карту</Text>
        </View>
      </Pressable>

      <View style={styles.filtersWrap}>
        <Text style={styles.filterTitle}>Цена</Text>
        <View style={styles.row}>
          <TextInput value={priceFrom} onChangeText={setPriceFrom} placeholder='от' keyboardType='numeric' style={styles.input} />
          <TextInput value={priceTo} onChangeText={setPriceTo} placeholder='до' keyboardType='numeric' style={styles.input} />
        </View>

        <Text style={styles.filterTitle}>Вид отдыха</Text>
        <View style={styles.rowWrap}>
          {Object.entries(leisureTypeLabels).map(([k, label]) => (
            <Pressable key={k} onPress={() => setLeisureType(leisureType === k ? '' : k)} style={[styles.chip, leisureType === k && styles.chipActive]}>
              <Text style={styles.chipText}>{label}</Text>
            </Pressable>
          ))}
        </View>

        <Text style={styles.filterTitle}>Сложность</Text>
        <View style={styles.rowWrap}>
          {Object.entries(difficultyLabels).map(([k, label]) => (
            <Pressable key={k} onPress={() => setDifficulty(difficulty === k ? '' : k)} style={[styles.chip, difficulty === k && styles.chipActive]}>
              <Text style={styles.chipText}>{label}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(item: any) => item.id}
        contentContainerStyle={{ padding: 12, gap: 8 }}
        ListEmptyComponent={<Text style={styles.empty}>Поездок пока нет</Text>}
        renderItem={({ item }: any) => {
          const image = Array.isArray(item.image_urls) && item.image_urls[0] ? item.image_urls[0] : DEFAULT_TRIP_IMAGE;
          return (
            <Pressable onPress={() => navigation.navigate('TripDetails', { tripId: item.id })} style={styles.card}>
              <Image source={{ uri: image }} style={styles.image} />
              <View style={styles.info}>
                <Text style={styles.title}>{item.title}</Text>
                <Text>Статус: {item.status ?? '—'}</Text>
                <Text>Начало: {item.date ? new Date(item.date).toLocaleDateString('ru-RU') : '—'}</Text>
                <Text>Цена: {item.price ?? '—'} ₽</Text>
              </View>
            </Pressable>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  mapBlock: { margin: 12, borderRadius: 12, overflow: 'hidden', borderWidth: 1, borderColor: '#e5e7eb' },
  mapImage: { width: '100%', height: 180 },
  mapFallback: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#f3f4f6' },
  mapFallbackText: { color: '#6b7280', fontSize: 12 },
  mapOverlay: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.45)', padding: 10 },
  mapTitle: { color: '#fff', fontSize: 16, fontWeight: '700' },
  mapSubtitle: { color: '#fff', fontSize: 12 },
  filtersWrap: { paddingHorizontal: 12, paddingTop: 0, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: '#e5e7eb' },
  filterTitle: { fontWeight: '700', marginBottom: 8, marginTop: 6 },
  row: { flexDirection: 'row', gap: 8 },
  rowWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  input: { borderWidth: 1, borderColor: '#d1d5db', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, flex: 1 },
  chip: { borderWidth: 1, borderColor: '#d1d5db', borderRadius: 16, paddingHorizontal: 10, paddingVertical: 6 },
  chipActive: { backgroundColor: '#e5e7eb' },
  chipText: { fontSize: 12 },
  card: { borderWidth: 1, borderColor: '#ddd', borderRadius: 10, overflow: 'hidden', backgroundColor: '#fff' },
  image: { width: '100%', height: 120 },
  info: { padding: 10 },
  title: { fontWeight: '700', marginBottom: 4 },
  empty: { textAlign: 'center', color: '#6b7280', marginTop: 24 },
});
