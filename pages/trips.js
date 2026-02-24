import { useState, useEffect } from 'react';
import { useAuth } from './_app';
import TripsPagePC from './TripsPagePC';
import TripsPageMobile from './TripsPageMobile';

export default function TripsPage() {
  const { user, loading, geolocation, geolocationLoading } = useAuth();
  const [isMobile, setIsMobile] = useState(null);

  useEffect(() => {
    console.time('checkMobile'); // LOG: Начало проверки мобильного устройства
    const checkMobile = () => {
      const mobile = window.innerWidth <= 768;
      setIsMobile(mobile);
      console.log('[checkMobile] Is mobile:', mobile); // LOG: Результат проверки
    };
    checkMobile();
    window.addEventListener('resize', checkMobile);
    console.timeEnd('checkMobile'); // LOG: Завершение проверки
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  // LOG: Проверка состояния загрузки
  console.log('[TripsPage] Loading states:', {
    loading,
    geolocationLoading,
    isMobile,
  });

  if (loading || geolocationLoading || isMobile === null) {
    return <div className="loadingContainer">Загрузка...</div>;
  }

  return isMobile ? (
    <TripsPageMobile user={user} geolocation={geolocation} />
  ) : (
    <TripsPagePC user={user} geolocation={geolocation} />
  );
}