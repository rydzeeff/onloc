import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { supabase } from '../../../lib/supabaseClient';
import styles from '../../../styles/payment-result.module.css';

export default function RefundResult() {
  const router = useRouter();
  const { status, tripId } = router.query;
  const [message, setMessage] = useState('Проверка статуса возврата...');

  useEffect(() => {
    if (!tripId) {
      console.error('tripId не передан в query-параметрах');
      setMessage('Ошибка: ID поездки не передан');
      return;
    }

    const checkRefundStatus = async () => {
      try {
        console.log('Проверка статуса возврата:', { tripId });
        const { data: cancellation, error } = await supabase
          .from('trip_cancellations')
          .select('status')
          .eq('trip_id', tripId)
          .eq('status', 'completed')
          .single();
        if (error && error.code !== 'PGRST116') {
          console.error('Ошибка получения статуса отмены:', { error: error.message });
          setMessage('Ошибка проверки статуса возврата');
          return;
        }
        if (cancellation) {
          setMessage('Возврат успешно выполнен');
        } else {
          setMessage('Возврат ещё в процессе или не выполнен');
        }
      } catch (error) {
        console.error('Ошибка проверки статуса возврата:', { error: error.message });
        setMessage('Ошибка проверки статуса возврата');
      }
    };

    checkRefundStatus();
  }, [tripId]);

  const isSuccess = status === 'success';

  return (
    <div className={styles.container}>
      <div className={styles.resultBox}>
        {isSuccess ? (
          <>
            <h1 className={styles.successTitle}>Возврат успешно выполнен!</h1>
            <p className={styles.message}>{message}</p>
            <button
              className={styles.button}
              onClick={() => router.push('/dashboard?section=myTrips')}
            >
              Вернуться к поездкам
            </button>
          </>
        ) : (
          <>
            <h1 className={styles.errorTitle}>Ошибка при возврате</h1>
            <p className={styles.message}>{message}</p>
            <button
              className={styles.button}
              onClick={() => router.push('/dashboard?section=myTrips')}
            >
              Вернуться к поездкам
            </button>
          </>
        )}
      </div>
    </div>
  );
}