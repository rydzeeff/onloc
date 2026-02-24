import { serve } from 'https://deno.land/std@0.131.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
// Инициализация Supabase клиента
const supabaseUrl = Deno.env.get('SUPABASE_URL');
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const supabase = createClient(supabaseUrl, supabaseKey);
serve(async (req)=>{
  try {
    console.log('Запуск функции check-trips');
    const now = new Date().toISOString();
    // Получение поездок со статусом 'active', где start_date истёк
    const { data: trips, error: tripsError } = await supabase.from('trips').select('id, title, creator_id').eq('status', 'active').lte('start_date', now);
    if (tripsError) {
      console.error('Ошибка получения поездок:', tripsError);
      throw new Error(`Ошибка получения поездок: ${tripsError.message}`);
    }
    console.log(`Найдено поездок: ${trips.length}`);
    const processedTrips = [];
    const errors = [];
    for (const trip of trips){
      console.log(`Обработка поездки ${trip.id}`);
      // Получение участников поездки
      const { data: participants, error: participantsError } = await supabase.from('trip_participants').select('id, user_id, status').eq('trip_id', trip.id);
      if (participantsError) {
        console.error(`Поездка ${trip.id}: ошибка получения участников:`, participantsError);
        errors.push(`Поездка ${trip.id}: ошибка получения участников - ${participantsError.message}`);
        continue;
      }
      // Исключение неоплаченных участников
      for (const participant of participants){
        if (![
          'confirmed',
          'paid'
        ].includes(participant.status)) {
          // Обновление статуса на 'rejected'
          const { error: updateError } = await supabase.from('trip_participants').update({
            status: 'rejected'
          }).eq('id', participant.id);
          if (updateError) {
            console.error(`Поездка ${trip.id}: ошибка исключения участника ${participant.user_id}:`, updateError);
            errors.push(`Поездка ${trip.id}: ошибка исключения участника ${participant.user_id} - ${updateError.message}`);
            continue;
          }
          // Создание или поиск чата поддержки
          const { data: chat, error: chatError } = await supabase.from('chats').select('id').eq('trip_id', trip.id).eq('user_id_1', trip.creator_id).eq('user_id_2', participant.user_id).eq('chat_type', 'support').single();
          if (chatError && chatError.code !== 'PGRST116') {
            console.error(`Поездка ${trip.id}: ошибка получения чата:`, chatError);
            errors.push(`Поездка ${trip.id}: ошибка получения чата - ${chatError.message}`);
            continue;
          }
          let chatId = chat?.id;
          if (!chat) {
            const { data: newChat, error: newChatError } = await supabase.from('chats').insert({
              title: `Чат по поездке ${trip.title}`,
              user_id_1: trip.creator_id,
              user_id_2: participant.user_id,
              trip_id: trip.id,
              chat_type: 'support',
              created_at: now
            }).select().single();
            if (newChatError) {
              console.error(`Поездка ${trip.id}: ошибка создания чата:`, newChatError);
              errors.push(`Поездка ${trip.id}: ошибка создания чата - ${newChatError.message}`);
              continue;
            }
            chatId = newChat.id;
          }
          // Отправка уведомления об исключении
          const { error: messageError } = await supabase.from('chat_messages').insert({
            chat_id: chatId,
            user_id: trip.creator_id,
            content: `Вы исключены из поездки "${trip.title}" за неоплату. Отзыв невозможен.`,
            created_at: now,
            read: false
          });
          if (messageError) {
            console.error(`Поездка ${trip.id}: ошибка отправки уведомления:`, messageError);
            errors.push(`Поездка ${trip.id}: ошибка отправки уведомления - ${messageError.message}`);
          }
        }
      }
      // Подсчёт оплаченных участников
      const confirmedParticipants = participants.filter((p)=>[
          'confirmed',
          'paid'
        ].includes(p.status));
      if (confirmedParticipants.length === 0) {
        // Установка статуса 'archived', если нет участников
        const { error: updateTripError } = await supabase.from('trips').update({
          status: 'archived'
        }).eq('id', trip.id);
        if (updateTripError) {
          console.error(`Поездка ${trip.id}: ошибка архивирования:`, updateTripError);
          errors.push(`Поездка ${trip.id}: ошибка архивирования - ${updateTripError.message}`);
          continue;
        }
        console.log(`Поездка ${trip.id}: архивирована`);
      } else {
        // Установка статуса 'started', если есть участники
        const { error: updateTripError } = await supabase.from('trips').update({
          status: 'started'
        }).eq('id', trip.id);
        if (updateTripError) {
          console.error(`Поездка ${trip.id}: ошибка установки статуса 'started':`, updateTripError);
          errors.push(`Поездка ${trip.id}: ошибка установки статуса 'started' - ${updateTripError.message}`);
          continue;
        }
        // Отправка уведомлений оплаченным участникам
        for (const participant of confirmedParticipants){
          const { data: chat, error: chatError } = await supabase.from('chats').select('id').eq('trip_id', trip.id).eq('user_id_1', trip.creator_id).eq('user_id_2', participant.user_id).eq('chat_type', 'support').single();
          if (chatError && chatError.code !== 'PGRST116') {
            console.error(`Поездка ${trip.id}: ошибка получения чата:`, chatError);
            errors.push(`Поездка ${trip.id}: ошибка получения чата - ${chatError.message}`);
            continue;
          }
          let chatId = chat?.id;
          if (!chat) {
            const { data: newChat, error: newChatError } = await supabase.from('chats').insert({
              title: `Чат по поездке ${trip.title}`,
              user_id_1: trip.creator_id,
              user_id_2: participant.user_id,
              trip_id: trip.id,
              chat_type: 'support',
              created_at: now
            }).select().single();
            if (newChatError) {
              console.error(`Поездка ${trip.id}: ошибка создания чата:`, newChatError);
              errors.push(`Поездка ${trip.id}: ошибка создания чата - ${newChatError.message}`);
              continue;
            }
            chatId = newChat.id;
          }
          const { error: messageError } = await supabase.from('chat_messages').insert({
            chat_id: chatId,
            user_id: trip.creator_id,
            content: `Поездка "${trip.title}" началась. Подтвердите присутствие.`,
            created_at: now,
            read: false
          });
          if (messageError) {
            console.error(`Поездка ${trip.id}: ошибка отправки уведомления:`, messageError);
            errors.push(`Поездка ${trip.id}: ошибка отправки уведомления - ${messageError.message}`);
          }
        }
        console.log(`Поездка ${trip.id}: установлена как 'started'`);
      }
      processedTrips.push(trip.id);
    }
    console.log('Завершение функции check-trips', {
      processedTrips,
      errors
    });
    return new Response(JSON.stringify({
      success: true,
      processedTrips,
      errors
    }), {
      headers: {
        'Content-Type': 'application/json'
      },
      status: 200
    });
  } catch (error) {
    console.error('Критическая ошибка проверки поездок:', error);
    return new Response(JSON.stringify({
      error: error.message
    }), {
      headers: {
        'Content-Type': 'application/json'
      },
      status: 500
    });
  }
});
