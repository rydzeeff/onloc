// pages/payment-result.js
import { useRouter } from 'next/router';
import styles from '../styles/payment-result.module.css';

export default function PaymentResult() {
  const router = useRouter();
  const { status } = router.query;

  const isSuccess = status === 'success';

  return (
    <div className={styles.container}>
      <div className={styles.resultBox}>
        {isSuccess ? (
          <>
            <h1 className={styles.successTitle}>Оплата прошла успешно!</h1>
            <p className={styles.message}>Ваш платеж успешно обработан. Теперь вы можете вернуться к поездке.</p>
            <button
              className={styles.button}
              onClick={() => router.push('/dashboard?section=myTrips')}
            >
              Вернуться к поездкам
            </button>
          </>
        ) : (
          <>
            <h1 className={styles.errorTitle}>Ошибка при оплате</h1>
            <p className={styles.message}>
              К сожалению, произошла ошибка при обработке платежа. Пожалуйста, попробуйте снова или обратитесь в поддержку.
            </p>
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