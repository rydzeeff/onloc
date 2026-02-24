import { serve } from 'https://deno.land/std@0.131.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { retry } from 'https://deno.land/x/retry@v2.0.0/mod.ts';

// Инициализация Supabase клиента с переменными окружения
const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabase = createClient(supabaseUrl, supabaseKey);

serve(async (req: Request) => {
  try {
    console.log('Запуск функции process-disputes');
    const now = new Date().toISOString();

    // Получение поездок со статусом 'finished' и истёкшим dispute_period_ends_at
    const { data: trips, error: tripsError } = await supabase
      .from('trips')
      .select('id, title, dispute_period_ends_at, deal_id, creator_id, phone, is_company_trip')
      .eq('status', 'finished')
      .lte('dispute_period_ends_at', now);

    if (tripsError) {
      console.error('Ошибка получения поездок:', tripsError);
      throw new Error(`Ошибка получения поездок: ${tripsError.message}`);
    }

    console.log(`Найдено поездок: ${trips.length}`);
    const processedTrips: string[] = [];
    const errors: string[] = [];

    for (const trip of trips) {
      console.log(`Обработка поездки ${trip.id}`);

      // Проверка предыдущих попыток выплаты
      const { data: attempt, error: attemptError } = await supabase
        .from('payout_attempts')
        .select('status, attempt_count')
        .eq('trip_id', trip.id)
        .single();

      if (attemptError && attemptError.code !== 'PGRST116') {
        console.error(`Поездка ${trip.id}: ошибка проверки попыток:`, attemptError);
        errors.push(`Поездка ${trip.id}: ошибка проверки попыток - ${attemptError.message}`);
        continue;
      }

      if (attempt && (attempt.status === 'completed' || attempt.attempt_count >= 3)) {
        console.log(`Поездка ${trip.id}: выплата уже выполнена или превышено попыток`);
        errors.push(`Поездка ${trip.id}: выплата уже выполнена или превышено количество попыток`);
        continue;
      }

      // Проверка наличия активных споров
      const { data: disputes, error: disputesError } = await supabase
        .from('disputes')
        .select('id')
        .eq('trip_id', trip.id)
        .in('status', ['awaiting_moderator', 'in_progress']);

      if (disputesError) {
        console.error(`Поездка ${trip.id}: ошибка проверки споров:`, disputesError);
        errors.push(`Поездка ${trip.id}: ошибка проверки споров - ${disputesError.message}`);
        continue;
      }

      if (disputes.length > 0) {
        console.log(`Поездка ${trip.id}: есть открытые споры`);
        errors.push(`Поездка ${trip.id}: есть открытые споры`);
        await supabase.from('payout_logs').insert({
          trip_id: trip.id,
          action: 'payout_skipped',
          details: { reason: 'open disputes' },
        });
        continue;
      }

      // Проверка одобрения всеми участниками
      const { data: participants, error: participantsError } = await supabase
        .from('trip_participants')
        .select('approved_trip')
        .eq('trip_id', trip.id)
        .in('status', ['confirmed', 'paid']);

      if (participantsError) {
        console.error(`Поездка ${trip.id}: ошибка проверки участников:`, participantsError);
        errors.push(`Поездка ${trip.id}: ошибка проверки участников - ${participantsError.message}`);
        continue;
      }

      const allApproved = participants.every(p => p.approved_trip === true);
      if (!allApproved) {
        console.log(`Поездка ${trip.id}: не все участники одобрили`);
        errors.push(`Поездка ${trip.id}: не все участники одобрили`);
        await supabase.from('payout_logs').insert({
          trip_id: trip.id,
          action: 'payout_skipped',
          details: { reason: 'not all approved' },
        });
        continue;
      }

      // Подсчёт суммы выплат
      const { data: payments, error: paymentsError } = await supabase
        .from('payments')
        .select('amount')
        .eq('trip_id', trip.id)
        .eq('status', 'confirmed')
        .eq('payment_type', 'participant_payment');

      if (paymentsError) {
        console.error(`Поездка ${trip.id}: ошибка проверки платежей:`, paymentsError);
        errors.push(`Поездка ${trip.id}: ошибка проверки платежей - ${paymentsError.message}`);
        continue;
      }

      const totalAmount = payments.reduce((sum: number, p: any) => sum + p.amount, 0);
      if (totalAmount <= 0) {
        console.log(`Поездка ${trip.id}: нет средств для выплаты`);
        errors.push(`Поездка ${trip.id}: нет средств для выплаты`);
        await supabase.from('payout_logs').insert({
          trip_id: trip.id,
          action: 'payout_skipped',
          details: { reason: 'no funds' },
        });
        continue;
      }

      // Создание попытки выплаты
      const { data: newAttempt, error: newAttemptError } = await supabase
        .from('payout_attempts')
        .insert({
          trip_id: trip.id,
          status: 'pending',
          last_attempt_at: now,
        })
        .select()
        .single();

      if (newAttemptError) {
        console.error(`Поездка ${trip.id}: ошибка создания попытки:`, newAttemptError);
        errors.push(`Поездка ${trip.id}: ошибка создания попытки - ${newAttemptError.message}`);
        continue;
      }

      try {
        console.log(`Поездка ${trip.id}: вызов API /api/tbank/payout`);
        // Вызов API с повторными попытками
        const response = await retry(
          async () => {
            const res = await fetch(`${Deno.env.get('NEXT_PUBLIC_BASE_URL')}/api/tbank/payout`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${supabaseKey}`,
              },
              body: JSON.stringify({
                tripId: trip.id,
                amount: totalAmount,
                dealId: trip.deal_id,
                recipientId: trip.is_company_trip ? `+${trip.phone}` : `+${trip.phone}`,
              }),
            });
            if (!res.ok) throw new Error(`HTTP ошибка: ${res.status}`);
            return res.json();
          },
          { maxAttempts: 3, delay: 1000 }
        );

        if (!response.success) {
          throw new Error(response.error || 'Ошибка выплаты');
        }

        console.log(`Поездка ${trip.id}: выплата успешна, paymentId: ${response.paymentId}`);
        // Обновление попытки
        const { error: updateAttemptError } = await supabase
          .from('payout_attempts')
          .update({ status: 'completed', last_attempt_at: now })
          .eq('id', newAttempt.id);

        if (updateAttemptError) {
          throw new Error(`Ошибка обновления попытки: ${updateAttemptError.message}`);
        }

        // Сохранение выплаты
        const { error: paymentError } = await supabase
          .from('payments')
          .insert({
            trip_id: trip.id,
            participant_id: trip.creator_id,
            amount: totalAmount,
            status: 'confirmed',
            payment_id: response.paymentId,
            payment_type: 'organizer_payout',
          });

        if (paymentError) {
          throw new Error(`Ошибка сохранения выплаты: ${paymentError.message}`);
        }

        // Отправка уведомлений
        const { data: confirmedParticipants, error: participantsFetchError } = await supabase
          .from('trip_participants')
          .select('user_id')
          .eq('trip_id', trip.id)
          .in('status', ['confirmed', 'paid']);

        if (participantsFetchError) {
          throw new Error(`Ошибка получения участников: ${participantsFetchError.message}`);
        }

        for (const participant of confirmedParticipants) {
          const { data: chat, error: chatError } = await supabase
            .from('chats')
            .select('id')
            .eq('trip_id', trip.id)
            .eq('user_id_1', trip.creator_id)
            .eq('user_id_2', participant.user_id)
            .eq('chat_type', 'support')
            .single();

          if (chatError && chatError.code !== 'PGRST116') {
            console.error(`Поездка ${trip.id}: ошибка получения чата:`, chatError);
            errors.push(`Поездка ${trip.id}: ошибка получения чата - ${chatError.message}`);
            continue;
          }

          if (chat) {
            const { error: messageError } = await supabase
              .from('chat_messages')
              .insert({
                chat_id: chat.id,
                user_id: trip.creator_id,
                content: `Организатор получил выплату за поездку "${trip.title}"`,
                created_at: new Date().toISOString(),
                read: false,
              });

            if (messageError) {
              console.error(`Поездка ${trip.id}: ошибка отправки уведомления:`, messageError);
              errors.push(`Поездка ${trip.id}: ошибка отправки уведомления - ${messageError.message}`);
            }
          }
        }

        // Логирование успеха
        await supabase.from('payout_logs').insert({
          trip_id: trip.id,
          action: 'payout_completed',
          details: { paymentId: response.paymentId, amount: totalAmount },
        });

        processedTrips.push(trip.id);
      } catch (error) {
        console.error(`Поездка ${trip.id}: ошибка:`, error);
        // Обработка ошибки
        const { error: updateAttemptError } = await supabase
          .from('payout_attempts')
          .update({
            status: 'failed',
            attempt_count: (attempt ? attempt.attempt_count : 0) + 1,
            last_attempt_at: now,
            error_message: error.message,
          })
          .eq('id', newAttempt.id);

        if (updateAttemptError) {
          errors.push(`Поездка ${trip.id}: ошибка обновления попытки - ${updateAttemptError.message}`);
        }

        await supabase.from('payout_logs').insert({
          trip_id: trip.id,
          action: 'payout_failed',
          details: { error: error.message },
        });

        // Уведомление об ошибке (например, через вебхук)
        await fetch('https://onloc.ru/api/webhooks/payout-error', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ trip_id: trip.id, error: error.message }),
        }).catch(err => console.error(`Ошибка вебхука для поездки ${trip.id}:`, err));

        errors.push(`Поездка ${trip.id}: ошибка выплаты - ${error.message}`);
      }
    }

    console.log('Завершение функции process-disputes', { processedTrips, errors });
    return new Response(JSON.stringify({ success: true, processedTrips, errors }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    });
  } catch (error) {
    console.error('Критическая ошибка обработки выплат:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});