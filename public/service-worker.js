self.addEventListener('push', (event) => {
  console.log('Service Worker: Push-сообщение получено', event.data);
  const data = event.data ? event.data.json() : { title: 'Новое сообщение', body: 'У вас новое сообщение' };
  const options = {
    body: data.body,
    icon: '/favicon.ico',
    badge: '/favicon.ico',
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
      .then(() => {
        console.log('Service Worker: Уведомление показано');
        // Отправляем сообщение всем клиентам
        return self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then(clients => {
          console.log('Service Worker: Найдено клиентов:', clients.length);
          if (clients.length === 0) {
            console.log('Service Worker: Нет активных клиентов для отправки звука');
          }
          clients.forEach(client => {
            client.postMessage({ type: 'PLAY_SOUND' });
            console.log('Service Worker: Сообщение PLAY_SOUND отправлено клиенту');
          });
        });
      })
      .catch((err) => console.error('Service Worker: Ошибка показа уведомления:', err))
  );
});

self.addEventListener('notificationclick', (event) => {
  console.log('Service Worker: Уведомление кликнуто');
  event.notification.close();
  event.waitUntil(clients.openWindow('/dashboard'));
});