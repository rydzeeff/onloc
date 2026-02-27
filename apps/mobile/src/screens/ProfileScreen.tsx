import React, { useEffect, useState } from 'react';
import { Button, ScrollView, Text } from 'react-native';
import { Field } from '../components/Field';
import { useAuth } from '../providers/AuthProvider';
import { getProfile, upsertProfile } from '../lib/profile';
import { registerPush } from '../lib/push';

export default function ProfileScreen() {
  const { session, signOut } = useAuth();
  const userId = session?.user.id!;
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    getProfile(userId).then((p) => {
      setFirstName(p?.first_name ?? '');
      setLastName(p?.last_name ?? '');
      setPhone(p?.phone ?? '');
    });
  }, [userId]);

  return (
    <ScrollView contentContainerStyle={{ padding: 14 }}>
      <Text style={{ fontSize: 20, fontWeight: '700', marginBottom: 10 }}>Профиль</Text>
      <Field label="Имя" value={firstName} onChangeText={setFirstName} />
      <Field label="Фамилия" value={lastName} onChangeText={setLastName} />
      <Field label="Телефон" value={phone} onChangeText={setPhone} />
      <Button title="Сохранить" onPress={async () => {
        await upsertProfile(userId, { first_name: firstName, last_name: lastName, phone });
        setStatus('Сохранено');
      }} />
      <Button title="Зарегистрировать push" onPress={async () => {
        const token = await registerPush(userId);
        setStatus(token ? `Push token: ${token}` : 'Push недоступен');
      }} />
      <Button title="Выйти" onPress={signOut} />
      {!!status && <Text style={{ marginTop: 10 }}>{status}</Text>}
    </ScrollView>
  );
}
