# Supabase Edge Functions (Onloc)

Этот каталог содержит **исходный код Supabase Edge Functions** для проекта Onloc.

## Зачем этот каталог нужен

Код edge-функций вынесен в Git-репозиторий (внутрь основного репозитория проекта), чтобы:

- хранить функции в Git (история изменений, rollback, code review)
- дать Codex/ChatGPT полный контекст (фронт + функции)
- деплоить функции на self-hosted Supabase сервер **предсказуемо и повторяемо**
- не редактировать код напрямую в runtime-папке `/opt/.../volumes/functions`

---

## Где находится source-код и куда деплоится

### Source of truth (Git)
Исходный код функций хранится в этом репозитории:

- **Фронт-сервер**: `192.168.3.23`
- Путь: `/home/useradmin/onloc/supabase`

Основные файлы и папки:

- `functions/` — все edge functions
- `deno.json` — общий Deno config для функций
- `.env.example` — шаблон переменных окружения (без секретов)

### Runtime (self-hosted Supabase)
Рабочая папка, из которой функции подхватываются в self-hosted Supabase:

- **Supabase-сервер**: `192.168.3.24`
- Путь: `/opt/supabase-test/supabase/docker/volumes/functions`

> Важно: папка `volumes/functions` считается **runtime-копией**, а не источником истины.
> Все изменения сначала вносятся в Git (`/home/useradmin/onloc/supabase`), затем синхронизируются на сервер `192.168.3.24`.

---

## Структура каталога

Пример структуры:

```text
supabase/
├─ functions/
│  ├─ auto-payout/
│  ├─ check-trips/
│  ├─ cleanup-trip-chat-files/
│  ├─ common/
│  ├─ custom-auth/
│  ├─ hello/
│  ├─ main/
│  ├─ newtel-webhook/
│  ├─ og-images/
│  ├─ process-disputes/
│  ├─ search-embeddings/
│  └─ support-close-cron/
├─ deno.json
├─ .env.example
└─ README.md
