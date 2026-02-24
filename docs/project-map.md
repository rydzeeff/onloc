# Project Map / Карта проекта

## 1) High-level architecture / Архитектура верхнего уровня
- Monorepo-style Next.js app (`pages` router) + Supabase Edge Functions + DB schema snapshots. / Монорепо-подход: Next.js-приложение (роутер `pages`) + Supabase Edge Functions + snapshot схемы БД.
- Frontend/business APIs live in this repo (`pages`, `lib`, `features`, `components`). / Фронтенд и бизнес-API расположены в этом же репозитории (`pages`, `lib`, `features`, `components`).
- Supabase Edge Functions are maintained under `supabase/functions/*` and deployed to self-hosted Supabase runtime. / Supabase Edge Functions поддерживаются в `supabase/functions/*` и деплоятся в self-hosted Supabase runtime.

## 2) Frontend map / Карта frontend
### Core folders / Ключевые папки
- `pages/` — app entrypoints (web routes + API routes). / `pages/` — точки входа приложения (веб-маршруты + API-маршруты).
- `features/messages/` — chat/message feature module (desktop components + hooks). / `features/messages/` — функциональный модуль чатов/сообщений (desktop-компоненты + hooks).
- `components/` — reusable UI components. / `components/` — переиспользуемые UI-компоненты.
- `lib/` — domain hooks/services (trip lifecycle, payments, disputes, VK Cloud NSFW, realtime, Supabase client). / `lib/` — доменные hooks/сервисы (жизненный цикл поездок, платежи, споры, VK Cloud NSFW, realtime, Supabase client).
- `styles/` — CSS modules and shared styles. / `styles/` — CSS-модули и общие стили.
- `public/` — static assets. / `public/` — статические ассеты.

### Key page entrypoints (selected) / Ключевые точки входа страниц
- Auth/Profile: `pages/auth.js`, `pages/AuthPC.js`, `pages/AuthMobile.js`, `pages/profile/*`. / Аутентификация/профиль: `pages/auth.js`, `pages/AuthPC.js`, `pages/AuthMobile.js`, `pages/profile/*`.
- Dashboard: `pages/dashboard.js`, `pages/DashboardPC.js`, `pages/DashboardMobile.js`. / Дашборд: `pages/dashboard.js`, `pages/DashboardPC.js`, `pages/DashboardMobile.js`.
- Trips: `pages/trips.js`, `pages/TripsPage*`, `pages/trips/*`, `pages/trip/[id].js`, `pages/view/[id].js`. / Поездки: `pages/trips.js`, `pages/TripsPage*`, `pages/trips/*`, `pages/trip/[id].js`, `pages/view/[id].js`.
- Messages: `pages/messages.js`, `pages/DesktopMessagesPage.jsx`, `pages/MobileMessagesPage.jsx`. / Сообщения: `pages/messages.js`, `pages/DesktopMessagesPage.jsx`, `pages/MobileMessagesPage.jsx`.
- Admin: `pages/admindashboard/*`. / Админка: `pages/admindashboard/*`.
- System wrappers: `pages/_app.jsx`, `pages/_error.js`. / Системные обертки: `pages/_app.jsx`, `pages/_error.js`.

## 3) API routes map (`pages/api/*`) / Карта API routes

### A. Auth / notifications / service / Аутентификация и сервисные уведомления
- `custom-auth.ts` — server API endpoint for custom auth flow. / `custom-auth.ts` — серверный API endpoint для кастомного auth-процесса.
- `send-email.js` — e-mail sender endpoint. / `send-email.js` — endpoint отправки e-mail.

### B. TBank payments domain (`pages/api/tbank/*`) / Платежный контур TBank
- Customer/card lifecycle: `add-customer`, `remove-customer`, `add-card`, `remove-card`, `remove-card-payment`, `sync-cards`, `sync-cards-payment`, `card-notification`. / Жизненный цикл клиента и карт: `add-customer`, `remove-customer`, `add-card`, `remove-card`, `remove-card-payment`, `sync-cards`, `sync-cards-payment`, `card-notification`.
- Payment lifecycle: `register`, `payment`, `init-payment`, `check-order`, `get-state`, `get-statev`, `payment-notification`, `refund-result`. / Жизненный цикл платежа: `register`, `payment`, `init-payment`, `check-order`, `get-state`, `get-statev`, `payment-notification`, `refund-result`.
- Trip/deal control: `cancel`, `canceltrip`, `close-spdeal`, `payout`, `shop`, `company`, `update`. / Управление поездкой/сделкой: `cancel`, `canceltrip`, `close-spdeal`, `payout`, `shop`, `company`, `update`.
- Infra helpers: `_client.js`, `supabaseClient.js`. / Инфраструктурные helper-модули: `_client.js`, `supabaseClient.js`.

### C. Internal/system / Внутренние системные маршруты
- `internal/payout.js` — internal payout orchestration with secret-based access. / `internal/payout.js` — внутренняя оркестрация выплат с доступом по секрету.
- `datanewton/counterparty.js` — external integration endpoint. / `datanewton/counterparty.js` — endpoint внешней интеграции.
- `vkcloud/*` — NSFW/selftest service endpoints. / `vkcloud/*` — сервисные endpoint-ы NSFW/selftest.

## 4) Supabase Edge Functions map (`supabase/functions/*`) / Карта Edge Functions
- `hello` — minimal test/health function. / `hello` — минимальная тестовая health-функция.
- `main` — function gateway/router with optional JWT verification (`JWT_SECRET`, `VERIFY_JWT`). / `main` — gateway/router функций с опциональной JWT-проверкой (`JWT_SECRET`, `VERIFY_JWT`).
- `custom-auth` — phone/call-based custom auth + temp verification records. / `custom-auth` — кастомная auth-логика по телефону/звонку + временные записи верификации.
- `newtel-webhook` — webhook endpoint updating `temp_verifications` status. / `newtel-webhook` — webhook endpoint для обновления статуса `temp_verifications`.
- `check-trips` — scheduled trip status/participant cleanup around start dates. / `check-trips` — плановая обработка статусов поездок и участников вокруг даты старта.
- `process-disputes` — scheduled dispute-period processing + payout workflow trigger. / `process-disputes` — плановая обработка периода споров + триггер payout-процесса.
- `auto-payout` — cron payout flow for expired dispute windows (calls payout API). / `auto-payout` — cron-процесс выплат при истекшем окне споров (вызывает payout API).
- `support-close-cron` — auto-archive support chats after timeout. / `support-close-cron` — автоархивация чатов поддержки по таймауту.
- `cleanup-trip-chat-files` — cleanup files in `trip_chat_files` storage bucket after trip lifecycle events. / `cleanup-trip-chat-files` — очистка файлов в бакете `trip_chat_files` после событий жизненного цикла поездки.
- `search-embeddings` — embeddings search/OpenAI-assisted function. / `search-embeddings` — функция поиска по эмбеддингам с использованием OpenAI.
- `common/*` — shared helper/types/errors/tokenizer for functions. / `common/*` — общие helper-модули, типы, ошибки и токенайзер для функций.

## 5) Data touchpoints by layer (probable) / Точки доступа к данным по слоям
- Frontend hooks/pages heavily touch: `trips`, `trip_participants`, `profiles`, `chats`, `chat_messages`, `payments`, `disputes`, `reviews`, `company_reviews`, `user_cards`. / Frontend hooks/pages активно работают с: `trips`, `trip_participants`, `profiles`, `chats`, `chat_messages`, `payments`, `disputes`, `reviews`, `company_reviews`, `user_cards`.
- API routes (especially TBank/internal payout) touch financial tables: `payments`, `payment_refunds`, `payout_attempts`, `payout_logs`, `trip_cancellations`. / API routes (особенно TBank/internal payout) используют финансовые таблицы: `payments`, `payment_refunds`, `payout_attempts`, `payout_logs`, `trip_cancellations`.
- Edge functions handle automation: `trips`, `trip_participants`, `payments`, `disputes`, `chats`, `chat_messages`, `temp_verifications`, `chat_message_files`. / Edge-функции автоматизации работают с: `trips`, `trip_participants`, `payments`, `disputes`, `chats`, `chat_messages`, `temp_verifications`, `chat_message_files`.

## 6) Contracts that should be treated as stable / Стабильные контракты
- TBank callbacks + signature/notification flows. / Callback-потоки TBank и проверка подписей/уведомлений.
- Payment/payout/cancel routes under `/api/tbank/*` and `/api/internal/payout`. / Маршруты payment/payout/cancel в `/api/tbank/*` и `/api/internal/payout`.
- Custom auth handshake (`pages/api/custom-auth.ts` + `supabase/functions/custom-auth` + `supabase/functions/newtel-webhook`). / Handshake кастомной аутентификации (`pages/api/custom-auth.ts` + `supabase/functions/custom-auth` + `supabase/functions/newtel-webhook`).
- Public endpoint paths and callback URLs configured via env. / Публичные пути endpoint-ов и callback URL, сконфигурированные через env.
