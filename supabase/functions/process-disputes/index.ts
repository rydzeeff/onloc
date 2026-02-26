import { serve } from 'https://deno.land/std@0.131.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { retry } from 'https://deno.land/x/retry@v2.0.0/mod.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL');
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const supabase = createClient(supabaseUrl, supabaseKey);
const baseUrl = Deno.env.get('NEXT_PUBLIC_BASE_URL');
if (!baseUrl) throw new Error('Missing NEXT_PUBLIC_BASE_URL env variable');

serve(async (req) => {
  try {
    console.log('Запуск функции process-disputes');
    const now = new Date().toISOString();

    // Получение поездок со статусом 'finished'
    const { data: trips, error: tripsError } = await supabase
      .from('trips')
      .select('id, title, dispute_period_ends_at, deal_id, creator_id, phone, is_company_trip, platform_fee, tbank_fee, net_amount')
      .eq('status', 'finished');

    if (tripsError) {
      console.error('Ошибка получения поездок:', tripsError);
      throw new Error(`Ошибка получения поездок: ${tripsError.message}`);
    }

    console.log(`Найдено поездок: ${trips.length}`);
    const processedTrips = [];
    const errors = [];

    for (const trip of trips) {
      console.log(`Обработка поездки ${trip.id}`);

      // Проверка предыдущих попыток выплаты
      const { data: attempt, error: attemptError } = await supabase
        .from('payout_attempts')
        .select('status, attempt_count')
        .eq('trip_id', trip.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (attemptError && attemptError.code !== 'PGRST116') {
        console.error(`Поездка ${trip.id}: ошибка проверки попыток:`, attemptError);
        errors.push(`Поездка ${trip.id}: ошибка проверки попыток - ${attemptError.message}`);
        continue;
      }

      if (attempt && attempt.status === 'completed') {
        console.log(`Поездка ${trip.id}: выплата уже выполнена`);
        errors.push(`Поездка ${trip.id}: выплата уже выполнена`);
        continue;
      }

      if (attempt && attempt.attempt_count >= 3) {
        console.log(`Поездка ${trip.id}: превышено количество попыток`);
        errors.push(`Поездка ${trip.id}: превышено количество попыток`);

        // Отправляем уведомление организатору
        const { data: organizerChat } = await supabase
          .from('chats')
          .select('id')
          .eq('trip_id', trip.id)
          .eq('user_id_1', trip.creator_id)
          .eq('user_id_2', trip.creator_id)
          .eq('chat_type', 'support')
          .single();

        if (organizerChat) {
          await supabase.from('chat_messages').insert({
            chat_id: organizerChat.id,
            user_id: trip.creator_id,
            content: `Не удалось выполнить выплату за поездку "${trip.title}": превышено количество попыток`,
            created_at: new Date().toISOString(),
            read: false
          });
        }

        continue;
      }

      // Проверка участников поездки
      const { data: participants, error: participantsError } = await supabase
        .from('trip_participants')
        .select('user_id, status, approved_trip')
        .eq('trip_id', trip.id)
        .in('status', ['confirmed', 'paid']);

      if (participantsError) {
        console.error(`Поездка ${trip.id}: ошибка проверки участников:`, participantsError);
        errors.push(`Поездка ${trip.id}: ошибка проверки участников - ${participantsError.message}`);
        continue;
      }

      // Проверка одобрения всеми участниками
      const allApproved = participants.every((p) => p.approved_trip === true);
      const disputePeriodEnded = new Date(trip.dispute_period_ends_at) <= new Date(now);

      // Проверка споров
      const { data: disputes, error: disputesError } = await supabase
        .from('disputes')
        .select('id, user_id, status, resolution, refund_amount')
        .eq('trip_id', trip.id);

      if (disputesError) {
        console.error(`Поездка ${trip.id}: ошибка проверки споров:`, disputesError);
        errors.push(`Поездка ${trip.id}: ошибка проверки споров - ${disputesError.message}`);
        continue;
      }

      // Пропуск, если не все одобрили и период споров не истёк
      if (!allApproved && !disputePeriodEnded) {
        console.log(`Поездка ${trip.id}: не все одобрили и период споров не истёк`);
        errors.push(`Поездка ${trip.id}: не все одобрили и период споров не истёк`);
        await supabase.from('payout_logs').insert({
          trip_id: trip.id,
          action: 'payout_skipped',
          details: { reason: 'not all approved and dispute period not ended' }
        });
        continue;
      }

      // Определение участников для выплаты
      let participantsToPay = participants.filter((p) => p.approved_trip === true);
      let totalRefund = 0;
      const disputeUserIds = [];

      // Учет активных и разрешенных споров
      const activeDisputes = disputes.filter((d) => ['awaiting_moderator', 'in_progress'].includes(d.status));
      const resolvedDisputes = disputes.filter((d) => d.status === 'resolved');

      activeDisputes.forEach((d) => disputeUserIds.push(d.user_id));
      resolvedDisputes.forEach((d) => {
        if (d.resolution === 'refund' && d.refund_amount) {
          totalRefund += d.refund_amount;
          disputeUserIds.push(d.user_id);
        }
      });

      participantsToPay = participantsToPay.filter((p) => !disputeUserIds.includes(p.user_id));
      console.log(`Поездка ${trip.id}: исключены участники с диспутами: ${disputeUserIds.join(', ')}`);

      if (participantsToPay.length === 0) {
        console.log(`Поездка ${trip.id}: нет участников для выплаты`);
        errors.push(`Поездка ${trip.id}: нет участников для выплаты`);
        await supabase.from('payout_logs').insert({
          trip_id: trip.id,
          action: 'payout_skipped',
          details: { reason: 'no participants to pay' }
        });
        continue;
      }

      // Проверка суммы с учетом возвратов
      const totalAmountAfterRefunds = trip.net_amount - totalRefund;
      if (totalAmountAfterRefunds <= 0) {
        console.log(`Поездка ${trip.id}: сумма после возвратов равна нулю`);
        errors.push(`Поездка ${trip.id}: сумма после возвратов равна нулю`);
        await supabase.from('payout_logs').insert({
          trip_id: trip.id,
          action: 'payout_skipped',
          details: { reason: 'zero amount after refunds' }
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
          amount: totalAmountAfterRefunds,
          recipient_id: trip.is_company_trip ? `+${trip.phone}` : `+${trip.phone}`
        })
        .select()
        .single();

      if (newAttemptError) {
        console.error(`Поездка ${trip.id}: ошибка создания попытки:`, newAttemptError);
        errors.push(`Поездка ${trip.id}: ошибка создания попытки - ${newAttemptError.message}`);
        continue;
      }

      let attemptId = newAttempt.id;
      if (attempt && attempt.status === 'failed') {
        const { data: retryAttempt, error: retryAttemptError } = await supabase
          .from('payout_attempts')
          .insert({
            trip_id: trip.id,
            status: 'pending',
            last_attempt_at: now,
            amount: totalAmountAfterRefunds,
            recipient_id: trip.is_company_trip ? `+${trip.phone}` : `+${trip.phone}`
          })
          .select()
          .single();
        if (retryAttemptError) {
          console.error(`Поездка ${trip.id}: ошибка создания повторной попытки:`, retryAttemptError);
          errors.push(`Поездка ${trip.id}: ошибка создания повторной попытки - ${retryAttemptError.message}`);
          continue;
        }
        attemptId = retryAttempt.id;
      }

      try {
        console.log(`Поездка ${trip.id}: вызов API /api/tbank/payout`);
        // Валидация телефона
        const phoneRegex = /^\+?[1-9]\d{10,14}$/;
        const recipientPhone = trip.is_company_trip ? `+${trip.phone}` : `+${trip.phone}`;
        if (!phoneRegex.test(recipientPhone)) {
          throw new Error(`Неверный формат телефона для поездки ${trip.id}: ${recipientPhone}`);
        }

        // Вызов API с повторными попытками
        const response = await retry(async () => {
          const res = await fetch(`${Deno.env.get('NEXT_PUBLIC_BASE_URL')}/api/tbank/payout`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${supabaseKey}`
            },
            body: JSON.stringify({
              tripId: trip.id,
              amount: totalAmountAfterRefunds,
              dealId: trip.deal_id,
              recipientId: recipientPhone
            })
          });
          if (!res.ok) throw new Error(`HTTP ошибка: ${res.status}`);
          return res.json();
        }, { maxAttempts: 3, delay: 1000 });

        if (!response.success) {
          throw new Error(response.error || 'Ошибка выплаты');
        }

        console.log(`Поездка ${trip.id}: выплата успешна, paymentId: ${response.paymentId}`);

        // Обновление попытки
        const { error: updateAttemptError } = await supabase
          .from('payout_attempts')
          .update({
            status: 'completed',
            last_attempt_at: now
          })
          .eq('id', attemptId);

        if (updateAttemptError) {
          throw new Error(`Ошибка обновления попытки: ${updateAttemptError.message}`);
        }

        // Сохранение выплаты
        const { error: paymentError } = await supabase
          .from('payments')
          .insert({
            trip_id: trip.id,
            participant_id: trip.creator_id,
            amount: totalAmountAfterRefunds,
            status: 'confirmed',
            payment_id: response.paymentId,
            payment_type: 'organizer_payout'
          });

        if (paymentError) {
          throw new Error(`Ошибка сохранения выплаты: ${paymentError.message}`);
        }

        // Отправка уведомлений
        const participantIds = participantsToPay.map((p) => p.user_id);
        for (const participant of participantsToPay) {
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
                read: false
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
          details: {
            attempt_id: attemptId,
            paymentId: response.paymentId,
            amount: totalAmountAfterRefunds,
            participants: participantIds
          }
        });

        processedTrips.push(trip.id);
      } catch (error) {
        console.error(`Поездка ${trip.id}: ошибка:`, error);

        // Обработка ошибки
        const { data: currentAttempt } = await supabase
          .from('payout_attempts')
          .select('attempt_count')
          .eq('id', attemptId)
          .single();

        const attemptCount = (currentAttempt ? currentAttempt.attempt_count : 0) + 1;
        const maxAttemptsReached = attemptCount >= 3;

        const { error: updateAttemptError } = await supabase
          .from('payout_attempts')
          .update({
            status: 'failed',
            attempt_count: attemptCount,
            last_attempt_at: now,
            error_message: error.message
          })
          .eq('id', attemptId);

        if (updateAttemptError) {
          errors.push(`Поездка ${trip.id}: ошибка обновления попытки - ${updateAttemptError.message}`);
        }

        await supabase.from('payout_logs').insert({
          trip_id: trip.id,
          action: 'payout_failed',
          details: {
            attempt_id: attemptId,
            error: error.message,
            max_attempts_reached: maxAttemptsReached
          }
        });

        // Уведомление организатору при достижении максимального количества попыток
        if (maxAttemptsReached) {
          const { data: organizerChat } = await supabase
            .from('chats')
            .select('id')
            .eq('trip_id', trip.id)
            .eq('user_id_1', trip.creator_id)
            .eq('user_id_2', trip.creator_id)
            .eq('chat_type', 'support')
            .single();

          if (organizerChat) {
            await supabase.from('chat_messages').insert({
              chat_id: organizerChat.id,
              user_id: trip.creator_id,
              content: `Не удалось выполнить выплату за поездку "${trip.title}": ${error.message}`,
              created_at: new Date().toISOString(),
              read: false
            });
          }
        }

        // Уведомление об ошибке через вебхук
        await fetch(`${baseUrl}/api/webhooks/payout-error`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            trip_id: trip.id,
            error: error.message
          })
        }).catch((err) => console.error(`Ошибка вебхука для поездки ${trip.id}:`, err));

        errors.push(`Поездка ${trip.id}: ошибка выплаты - ${error.message}`);
      }
    }

    console.log('Завершение функции process-disputes', {
      processedTrips,
      errors
    });

    return new Response(JSON.stringify({
      success: true,
      processedTrips,
      errors
    }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200
    });
  } catch (error) {
    console.error('Критическая ошибка обработки выплат:', error);
    return new Response(JSON.stringify({
      error: error.message
    }), {
      headers: { 'Content-Type': 'application/json' },
      status: 500
    });
  }
});
