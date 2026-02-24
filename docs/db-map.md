# DB Map / Карта БД (from `supabase/db/public_schema.sql` + `external_tables_schema.sql`)

## 1) Core `public` tables (domain clusters) / Ключевые таблицы `public`

### Trips & participation / Поездки и участие
- `trips`
- `trip_participants`
- `trip_cancellations`
- `travels`

### Payments & payouts / Платежи и выплаты
- `payments`
- `payment_refunds`
- `payout_attempts`
- `payout_logs`
- `user_cards`
- `bank_cards`

### Chat/messaging/support / Чаты и поддержка
- `chats`
- `chat_participants`
- `chat_messages`
- `chat_message_reads`
- `chat_message_files`
- `messages` (legacy/direct messaging-style table) / `messages` (legacy-таблица для прямых сообщений)

### Disputes/reviews/company / Споры, отзывы, компании
- `disputes`
- `dispute_evidences`
- `dispute_close_proposals`
- `reviews`
- `company_reviews`
- `mycompany`

### Identity/admin/utility / Профили, админка, служебные сущности
- `profiles`
- `users` (project-local) / `users` (локальная таблица проекта)
- `user_admin_access`
- `push_subscriptions`
- `realtime_subscriptions`
- `temp_otps`
- `temp_verifications`
- `map_search`

## 2) Key FK relationships / Ключевые связи FK

### Trip-centered / Связи вокруг поездок
- `trip_participants.trip_id -> trips.id`
- `trip_cancellations.trip_id -> trips.id`
- `payments.trip_id -> trips.id`
- `payment_refunds.trip_id -> trips.id`
- `payout_attempts.trip_id -> trips.id`
- `payout_logs.trip_id -> trips.id`
- `disputes.trip_id -> trips.id`
- `dispute_close_proposals.trip_id -> trips.id`
- `reviews.trip_id -> trips.id`
- `company_reviews.trip_id -> trips.id`
- `chats.trip_id -> trips.id`

### User/profile-centered / Связи вокруг профилей пользователей
- `trips.creator_id -> profiles.user_id`
- `trip_participants.user_id -> profiles.user_id`
- `payments.participant_id -> profiles.user_id`
- `payment_refunds.participant_id -> profiles.user_id`
- `user_cards.user_id -> profiles.user_id`
- `chat_messages.user_id -> profiles.user_id`
- `chat_message_reads.user_id -> profiles.user_id`
- `chat_participants.user_id -> profiles.user_id`
- `disputes.initiator_id/respondent_id -> profiles.user_id`
- `company_reviews.organizer_id/reviewer_id -> profiles.user_id`
- `reviews.organizer_id/reviewer_id -> profiles.user_id`

### Chat-centered / Связи вокруг чатов
- `chat_messages.chat_id -> chats.id`
- `chat_participants.chat_id -> chats.id`
- `chat_message_reads.message_id -> chat_messages.id`
- `chat_message_files.message_id -> chat_messages.id`

### Payout/refund mechanics / Механика выплат и возвратов
- `payment_refunds.payment_id -> payments.id`
- `payout_attempts.source_payment_id -> payments.id`
- `payout_attempts.participant_id -> trip_participants.id`

## 3) External schemas (`external_tables_schema.sql`) / Внешние схемы
- `auth.users` is present (Supabase Auth schema). / Присутствует `auth.users` (схема аутентификации Supabase).
- `storage.buckets`, `storage.objects` are present (Supabase Storage schema). / Присутствуют `storage.buckets`, `storage.objects` (схема хранилища Supabase).
- This matches app usage of profile/auth identity + stored files (e.g., chat file cleanup function). / Это соответствует использованию в проекте: профили/аутентификация + файлы в storage (например, очистка файлов чата).

## 4) Probable table usage by runtime layer / Вероятное использование таблиц по слоям

### Frontend (pages/lib/features) / Фронтенд
- Core reads/writes around: `profiles`, `trips`, `trip_participants`, `chats`, `chat_messages`, `disputes`, `reviews`, `company_reviews`, `payments`, `user_cards`. / Основные чтения/записи: `profiles`, `trips`, `trip_participants`, `chats`, `chat_messages`, `disputes`, `reviews`, `company_reviews`, `payments`, `user_cards`.

### API routes (`pages/api/*`) / API-маршруты
- Heavy payment impact: `payments`, `payment_refunds`, `payout_attempts`, `payout_logs`, `trip_cancellations`, `trip_participants`, `trips`, `user_cards`. / Наиболее критичные платежные таблицы: `payments`, `payment_refunds`, `payout_attempts`, `payout_logs`, `trip_cancellations`, `trip_participants`, `trips`, `user_cards`.
- Also support/admin data in: `chats`, `chat_messages`, `profiles`, `user_admin_access`, `mycompany`. / Также используются данные поддержки/админки: `chats`, `chat_messages`, `profiles`, `user_admin_access`, `mycompany`.

### Edge Functions (`supabase/functions/*`) / Edge-функции
- Automation/cron: `trips`, `trip_participants`, `payments`, `payout_attempts`, `disputes`, `payout_logs`. / Автоматизация/cron: `trips`, `trip_participants`, `payments`, `payout_attempts`, `disputes`, `payout_logs`.
- Auth/webhook flow: `temp_verifications`, `profiles`. / Поток auth/webhook: `temp_verifications`, `profiles`.
- Chat maintenance: `chats`, `chat_messages`, `chat_message_files`. / Поддержка чатов: `chats`, `chat_messages`, `chat_message_files`.

## 5) Important note / Важное примечание
- In code there are references like `photos`, `document`, `evidence`; these may map to storage/RPC/view abstractions and should be verified before schema refactoring. / В коде встречаются ссылки вида `photos`, `document`, `evidence`; они могут соответствовать storage/RPC/view-абстракциям и требуют проверки перед рефакторингом схемы.

## 6) Tables with no direct references in application code / Таблицы без прямых ссылок в коде приложения
- `dispute_close_proposals`
- `map_search`
- `push_subscriptions`
- `realtime_subscriptions`
- `travels`

### DB-level usage found in schema objects / Использование на уровне БД, найденное в объектах схемы
- `temp_otps` is referenced by DB routine/trigger chain: `verify_phone_otp()` reads/deletes OTP rows and trigger `trigger_confirm_email_after_otp` is attached to `temp_otps`. / `temp_otps` используется цепочкой DB-логики: функция `verify_phone_otp()` читает/удаляет OTP-записи, а триггер `trigger_confirm_email_after_otp` навешан на `temp_otps`.

Notes / Примечания:
- Application-code scan is based on static table-reference search in repository sources (`.from("table")`, SQL `from/join/update/into public.table`). / По коду приложения использован статический поиск ссылок на таблицы в исходниках репозитория (`.from("table")`, SQL `from/join/update/into public.table`).
- DB-level check additionally reviews `public_schema.sql` for routines/triggers (`CREATE FUNCTION`, `CREATE TRIGGER`) that reference tables. / Проверка уровня БД дополнительно анализирует `public_schema.sql` на процедуры/триггеры (`CREATE FUNCTION`, `CREATE TRIGGER`), ссылающиеся на таблицы.
- Absence of direct app references does not guarantee a table is unused at runtime: RPC/functions/triggers/external services may still depend on it. / Отсутствие прямых ссылок в коде приложения не гарантирует, что таблица не используется в runtime: она может требоваться RPC/функциям/триггерам/внешним сервисам.
