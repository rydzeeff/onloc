import React, { useEffect, useState } from 'react';
import { Button, FlatList, Text, TextInput, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { fetchChats, fetchMessages, sendMessage } from '../lib/messages';
import { useAuth } from '../providers/AuthProvider';
import { supabase } from '../lib/supabase';

export default function MessagesScreen() {
  const { session } = useAuth();
  const userId = session?.user.id!;
  const [chatId, setChatId] = useState<string | null>(null);
  const [text, setText] = useState('');
  const chats = useQuery({ queryKey: ['chats', userId], queryFn: () => fetchChats(userId), enabled: !!userId });
  const messages = useQuery({ queryKey: ['messages', chatId], queryFn: () => fetchMessages(chatId!), enabled: !!chatId });

  useEffect(() => {
    if (!chatId) return;
    const channel = supabase
      .channel(`mobile-chat-${chatId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages', filter: `chat_id=eq.${chatId}` }, () => messages.refetch())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [chatId]);

  if (!chatId) {
    return <FlatList data={chats.data ?? []} keyExtractor={(i: any) => i.id} renderItem={({ item }: any) => (
      <Button title={`${item.title || 'Чат'} (${item.chat_type})`} onPress={() => setChatId(item.id)} />
    )} />;
  }

  return (
    <View style={{ flex: 1, padding: 12 }}>
      <Button title="← Назад к чатам" onPress={() => setChatId(null)} />
      <FlatList data={messages.data ?? []} keyExtractor={(m: any) => String(m.id)} renderItem={({ item }: any) => (
        <Text style={{ paddingVertical: 6 }}>{item.user_id === userId ? 'Вы' : 'Собеседник'}: {item.content}</Text>
      )} />
      <TextInput value={text} onChangeText={setText} placeholder="Сообщение" style={{ borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 10 }} />
      <Button title="Отправить" onPress={async () => { if (!text.trim()) return; await sendMessage(chatId, userId, text.trim()); setText(''); await messages.refetch(); }} />
    </View>
  );
}
