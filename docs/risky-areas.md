# Risky Areas & Compatibility Constraints / Рискованные зоны и ограничения совместимости

## 1) Critical contract zones / Критичные контрактные зоны

### TBank / payments / webhooks (highest risk) / TBank, платежи и вебхуки (максимальный риск)
- `pages/api/tbank/*` contains payment lifecycle, card lifecycle, payout/cancel/refund callbacks. / `pages/api/tbank/*` содержит жизненный цикл платежей и карт, а также колбэки выплат/отмен/возвратов.
- `pages/api/internal/payout.js` is an internal payout endpoint guarded by secret headers/env. / `pages/api/internal/payout.js` — внутренний endpoint выплат, защищенный секретными заголовками/переменными окружения.
- `supabase/functions/auto-payout` and `supabase/functions/process-disputes` call payout APIs and depend on response contracts. / `supabase/functions/auto-payout` и `supabase/functions/process-disputes` вызывают payout API и зависят от их контрактов ответов.
- Any change in payload shape, status semantics, signature validation, or endpoint URL can break production flows. / Любое изменение формата payload, семантики статусов, проверки подписи или URL endpoint может сломать прод-процессы.

### Custom auth / Кастомная аутентификация
- `pages/api/custom-auth.ts` + `supabase/functions/custom-auth` + `supabase/functions/newtel-webhook` form a multi-step auth contract. / `pages/api/custom-auth.ts` + `supabase/functions/custom-auth` + `supabase/functions/newtel-webhook` образуют многошаговый auth-контракт.
- Request body normalization, callback field names (`callId/call_id/...`) and phone normalization are compatibility-sensitive. / Нормализация тела запроса, имена полей callback (`callId/call_id/...`) и нормализация телефона чувствительны к совместимости.

### Webhook endpoints / Вебхук-эндпоинты
- `pages/api/tbank/payment-notification.js`
- `pages/api/tbank/card-notification.js`
- `supabase/functions/newtel-webhook/index.ts`
- Must preserve method handling, status codes, and idempotent behavior (retries happen). / Нужно сохранять обработку методов, коды статусов и идемпотентность (провайдеры выполняют ретраи).

## 2) URL/endpoint compatibility constraints / Ограничения совместимости URL/эндпоинтов
- Public API paths under `pages/api/*` are external integration contracts. / Публичные пути API в `pages/api/*` являются внешними интеграционными контрактами.
- Callback URLs are env-configured and often pre-registered at payment/provider side. / Callback URL настраиваются через env и часто заранее зарегистрированы у провайдера.
- Renaming/moving routes, changing HTTP methods, or changing expected query/body params is high risk. / Переименование/перенос роутов, смена HTTP-методов или ожидаемых query/body-параметров — высокий риск.

## 3) Secrets / env usage risks (do not leak values) / Риски использования секретов и env

### Supabase secrets / Секреты Supabase
- `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SUPABASE_*`.
- Service-role usage appears in server/edge code; accidental client-side exposure is critical. / Использование service-role встречается в server/edge-коде; случайная утечка на клиент критична.

### TBank secrets / Секреты TBank
- `TBANK_SECRET`, `TBANK_PASSWORD`, `TBANK_TERMINAL_KEY`, `TBANK_*_BASE` and related keys. / `TBANK_SECRET`, `TBANK_PASSWORD`, `TBANK_TERMINAL_KEY`, `TBANK_*_BASE` и связанные ключи.
- Signature/token generation relies on exact field inclusion/sorting rules. / Генерация подписи/токена зависит от точных правил включения и сортировки полей.

### Internal auth secrets / Внутренние auth-секреты
- `INTERNAL_PAYOUT_SECRET`, `TRIP_CRON_SECRET`, `CRON_SECRET`, `API_SECRET`, `CUSTOM_AUTH_SECRET`.
- Missing or inconsistent secrets between cron/edge/API will silently break automation. / Отсутствующие или несогласованные секреты между cron/edge/API могут незаметно сломать автоматизацию.

### External service secrets / Секреты внешних сервисов
- `MAILRU_PASSWORD`, `OPENAI_API_KEY`, `NEW_TEL_API_KEY`, `NEW_TEL_SIGN_KEY`, VK Cloud OAuth/env set. / `MAILRU_PASSWORD`, `OPENAI_API_KEY`, `NEW_TEL_API_KEY`, `NEW_TEL_SIGN_KEY` и набор env для VK Cloud OAuth.

## 4) Backward-compatibility breakpoints / Точки риска обратной совместимости
- Payment status enums/field names in `payments`, `trip_participants`, `trips`. / Enum-значения статусов платежей и имена полей в `payments`, `trip_participants`, `trips`.
- Payout attempt/retry semantics (`payout_attempts`, `payout_logs`). / Семантика попыток и ретраев выплат (`payout_attempts`, `payout_logs`).
- Dispute-period automation timing (`process-disputes`, `auto-payout`). / Тайминги автоматизации dispute-периода (`process-disputes`, `auto-payout`).
- Chat-support lifecycle automation (`support-close-cron`, chat status transitions). / Автоматизация жизненного цикла чатов поддержки (`support-close-cron`, переходы статусов).
- DB schema assumptions in frontend hooks (many direct table calls without API abstraction). / Предположения о схеме БД во frontend-хуках (много прямых вызовов таблиц без API-абстракции).

## 5) Safe change strategy (non-breaking) / Безопасная стратегия изменений
1. Keep endpoint URLs and HTTP methods unchanged. / Сохранять URL endpoint-ов и HTTP-методы без изменений.
2. Keep webhook payload acceptance broad (aliases/idempotency). / Сохранять широкую совместимость webhook-payload (алиасы полей/идемпотентность).
3. Keep payment/auth response JSON fields stable. / Сохранять стабильные JSON-поля ответов payment/auth.
4. Additive DB changes only (avoid destructive rename/remove in critical tables). / Делать только аддитивные изменения БД (избегать destructive rename/remove в критичных таблицах).
5. Validate staging callbacks end-to-end before prod rollout. / Валидировать callback-сценарии на staging end-to-end перед выкладкой в prod.
