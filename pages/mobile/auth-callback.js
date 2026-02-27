import { useEffect } from 'react';
import { useRouter } from 'next/router';

export default function MobileAuthCallbackPage() {
  const router = useRouter();

  useEffect(() => {
    const timer = setTimeout(() => {
      router.replace('/dashboard?section=myTrips').catch(() => {
        window.location.href = '/dashboard?section=myTrips';
      });
    }, 1200);
    return () => clearTimeout(timer);
  }, [router]);

  return (
    <main style={{ padding: '32px 20px', fontFamily: 'sans-serif' }}>
      <h1>Вход подтверждён</h1>
      <p>Возвращаем вас в приложение Onloc…</p>
    </main>
  );
}
