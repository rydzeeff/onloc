import { supabase } from './supabaseClient';

let subscription = null;

export const initializeRealtime = (userId, onNewMessage) => {
  if (subscription) {
    console.log('Подписка уже инициализирована');
    return;
  }

  subscription = supabase
    .channel('public:chat_messages')
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'chat_messages',
      },
      (payload) => {
        const newMessage = payload.new;
        if (newMessage.user_id !== userId) {
          console.log('Realtime: Новое сообщение для пользователя', userId, newMessage);
          onNewMessage(newMessage);
        }
      }
    )
    .subscribe();

  console.log('Подписка на realtime инициализирована для пользователя', userId);
};

export const cleanupRealtime = () => {
  if (subscription) {
    supabase.removeChannel(subscription);
    subscription = null;
    console.log('Подписка на realtime очищена');
  }
};