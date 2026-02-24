# Smoke Checklist (Staging) / Чеклист смоук-проверки (staging)

Минимальная ручная проверка после деплоя без изменения контрактов. / Minimal manual post-deploy verification without contract changes.

## 1) Auth & profile / Аутентификация и профиль
- [ ] Login/signup flow opens and completes on both desktop/mobile routes. / Поток логина/регистрации открывается и завершается как на desktop, так и на mobile маршрутах.
- [ ] Custom auth call/callback flow confirms phone verification. / Поток custom auth с call/callback подтверждает верификацию телефона.
- [ ] Profile read/update works; no 401/500 in network logs. / Чтение/обновление профиля работает; в сетевых логах нет 401/500.

## 2) Trips core flow / Базовый сценарий поездок
- [ ] Create trip (`/trips/create-trip`) succeeds. / Создание поездки (`/trips/create-trip`) выполняется успешно.
- [ ] Join/participant status transition works. / Работают переходы статусов вступления/участника.
- [ ] Trip details and trip view pages load without missing fields. / Страницы деталей поездки и просмотра поездки загружаются без пропавших полей.

## 3) Payments / TBank / Платежи
- [ ] Payment init/register/check-order path returns expected statuses. / Цепочка init/register/check-order возвращает ожидаемые статусы.
- [ ] Payment notification webhook is accepted (no signature mismatch in logs). / Webhook уведомления о платеже принимается (в логах нет ошибок подписи).
- [ ] Cancel/refund flow works and updates trip/payment state. / Поток отмены/возврата работает и обновляет состояние поездки/платежа.
- [ ] Payout endpoint reachable only with proper secret/header. / Endpoint выплат доступен только с корректным секретом/заголовком.

## 4) Cards & customer / Карты и клиент
- [ ] Add/remove/sync card endpoints return success with valid test data. / Endpoint-ы добавления/удаления/синхронизации карт возвращают успех с валидными тестовыми данными.
- [ ] Card notification webhook updates `user_cards` state correctly. / Webhook уведомления по картам корректно обновляет состояние `user_cards`.

## 5) Disputes / payout automation / Споры и авто-выплаты
- [ ] `process-disputes` runs without errors in function logs. / `process-disputes` выполняется без ошибок в логах функций.
- [ ] `auto-payout` runs and does not produce contract errors when calling payout API. / `auto-payout` выполняется и не вызывает контрактных ошибок при обращении к payout API.
- [ ] No unexpected status transitions in `trips`, `payments`, `payout_attempts`. / Нет неожиданных переходов статусов в `trips`, `payments`, `payout_attempts`.

## 6) Messaging/support / Сообщения и поддержка
- [ ] Chats/messages load on desktop/mobile. / Чаты и сообщения загружаются на desktop/mobile.
- [ ] Support close cron does not archive active chats unexpectedly. / Cron закрытия поддержки не архивирует активные чаты неожиданно.
- [ ] Message read receipts still update (`chat_message_reads`). / Статусы прочтения сообщений продолжают корректно обновляться (`chat_message_reads`).

## 7) Files/storage / Файлы и хранилище
- [ ] Chat file upload/download still works. / Загрузка и скачивание файлов чата работают.
- [ ] Cleanup cron (`cleanup-trip-chat-files`) deletes only expired/eligible files. / Cron очистки (`cleanup-trip-chat-files`) удаляет только просроченные/подходящие файлы.

## 8) Operational checks / Операционные проверки
- [ ] Edge function env vars are present (no "env missing" errors). / Переменные окружения edge-функций заданы (нет ошибок "env missing").
- [ ] API routes do not expose secrets in logs/responses. / API routes не раскрывают секреты в логах/ответах.
- [ ] No new 5xx spikes in server/function logs after deploy. / После деплоя нет новых всплесков 5xx в логах сервера/функций.
