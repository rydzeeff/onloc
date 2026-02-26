import { supabase } from './supabase';

export async function fetchChats(userId: string) {
  const { data, error } = await supabase
    .from('chats')
    .select('id,title,chat_type,trip_id,chat_participants!inner(user_id)')
    .eq('chat_participants.user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function fetchMessages(chatId: string) {
  const { data, error } = await supabase
    .from('chat_messages')
    .select('id,chat_id,user_id,content,created_at,chat_message_files(*),chat_message_reads(user_id,read_at)')
    .eq('chat_id', chatId)
    .order('created_at', { ascending: true })
    .limit(50);
  if (error) throw error;
  return data ?? [];
}

export async function sendMessage(chatId: string, userId: string, content: string) {
  const { data, error } = await supabase
    .from('chat_messages')
    .insert({ chat_id: chatId, user_id: userId, content, read: false })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function uploadChatFile(chatId: string, tripId: string | null, messageId: number, uri: string, name: string, type: string) {
  const path = `${tripId || 'no_trip'}/${chatId}/${messageId}/${Date.now()}-${name}`;
  const fileData = await fetch(uri).then((r) => r.blob());
  const { error: uploadError } = await supabase.storage.from('trip_chat_files').upload(path, fileData, { contentType: type });
  if (uploadError) throw uploadError;

  const { data, error } = await supabase
    .from('chat_message_files')
    .insert({ message_id: messageId, bucket: 'trip_chat_files', path, mime: type, size: fileData.size })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}
