// components/YandexMap.js
import { useEffect, useRef } from 'react';

const YandexMap = ({ trips }) => {
  const mapRef = useRef(null);

  useEffect(() => {
    if (typeof window !== 'undefined' && window.ymaps && mapRef.current) {
      const ymaps = window.ymaps;

      // Инициализация карты
      ymaps.ready(() => {
        const map = new ymaps.Map(mapRef.current, {
          center: [55.7558, 37.6176], // Центрируем по Москве по умолчанию
          zoom: 10,
          controls: ['zoomControl', 'geolocationControl'],
        });

        // Добавляем маркеры для поездок
        trips.forEach((trip) => {
          const { lat, lon, name, description } = trip;
          const placemark = new ymaps.Placemark([lat, lon], {
            balloonContentHeader: name,
            balloonContentBody: description,
          });

          map.geoObjects.add(placemark);
        });

        // Настройка изменения центра карты при перемещении или изменении масштаба
        map.events.add('boundschange', function () {
          // Можно добавить логику для обновления маркеров, когда карта изменит область
        });
      });

      // Очистка карты при удалении компонента
      return () => {
        if (mapRef.current) {
          mapRef.current.innerHTML = '';
        }
      };
    }
  }, [trips]);

  return <div ref={mapRef} style={{ width: '100%', height: '400px' }} />;
};

export default YandexMap;
