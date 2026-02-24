import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import AuthPC from './AuthPC';
import AuthMobile from './AuthMobile';
import { useAuth, LoadingOverlay } from './_app'; // Импортируем useAuth и LoadingOverlay

export default function Auth({ initialMode = 'login' }) {
  const router = useRouter();
  const { setProcessing } = useAuth();
  const [isMobile, setIsMobile] = useState(null);

  useEffect(() => {
    setProcessing(true); // Включаем индикатор сразу при монтировании
    const checkMobile = () => {
      setIsMobile(window.innerWidth <= 768);
      setProcessing(false); // Выключаем после определения устройства
    };
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, [setProcessing]);

  // Пока не определено, мобильное устройство или нет, показываем индикатор
  if (isMobile === null) {
    return <LoadingOverlay text="Загрузка..." />;
  }

  return isMobile ? (
    <AuthMobile initialMode={initialMode} router={router} />
  ) : (
    <AuthPC initialMode={initialMode} router={router} />
  );
}

export async function getServerSideProps(context) {
  const { mode } = context.query;
  return {
    props: {
      initialMode: mode || 'login',
    },
  };
}