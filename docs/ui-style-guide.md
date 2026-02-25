# UI Style Guide (phase 1)

## Цель
Безопасно ввести единый визуальный фундамент (design foundation) без изменений бизнес-логики, API и поведения критичных контуров (payments/auth/webhooks).

## 1) Краткий аудит текущих стилей
Аудит выполнен по `styles/**/*.css` и `components/**/*.module.css`.

### Наблюдения
- Часто повторяются значения, но с расхождениями:
  - `border-radius`: чаще всего `8px`, `12px`, также встречаются `6px`, `10px`, `14px`, `16px`, `20px`, `999px`.
  - `font-size`: доминируют `14px`, `16px`, `12px`, но есть много точечных отклонений (`11px`, `13px`, `15px`, `18px`, `20px` и т.д.).
  - `spacing`: регулярные шаги есть (`8/10/12/16/20px`), но используются несистемно.
- Визуальные паттерны повторяются в разных модулях:
  - похожие `filter button / dropdown` в mobile и desktop;
  - похожие карточки, инпуты и фокус-состояния в модулях сообщений;
  - отдельные модальные/sheet-компоненты (например ShareButton) имеют близкие паттерны, но со своими локальными значениями.

### Наиболее заметные несоответствия
- Непоследовательные радиусы и тени для одинаковых по роли блоков (карточка/панель/выпадающий блок).
- Разные оттенки одного и того же семантического цвета (text/border/primary) в схожих элементах.
- Непоследовательные focus/hover состояния (где-то есть focus-ring, где-то только смена border-color).

## 2) Foundation-токены
Файл: `styles/foundation.css`

Введены токены:
- `colors`: primary, text, text-secondary, muted, bg, bg-soft, border, border-soft, error, success, overlay.
- `spacing`: `--space-1` ... `--space-6`.
- `radius`: sm/md/lg/xl/pill.
- `shadows`: xs/sm/md/lg.
- `typography`: family, базовые размеры, line-height, веса.
- `borders`: default/strong.
- `interaction`: transition, focus-ring.

## 3) Базовые UI-паттерны
В `styles/foundation.css` добавлены переиспользуемые классы:
- `.ui-button`
- `.ui-input`
- `.ui-card`
- `.ui-section-title`
- `.ui-focus-visible`

Паттерны не меняют логику и предназначены для постепенного rollout.

## 4) Что стандартизовано в phase 1
Точечно и безопасно обновлены:
- Shared foundation + глобальная типографическая база.
- `filters` (desktop/mobile): переход на токены для текстов, бордеров, bg и части отступов/типографики.
- `messages-common`: переход ключевых повторяющихся цветов/бордеров/радиусов на токены.
- `messages` (desktop/mobile): выравнены container/panel/input/button/header/card-паттерны и основные spacing/типографика через foundation-токены без изменения поведения чатов.
- `ShareButton` (UI-only): использование токенов + подключение базовых паттернов (`ui-card`, `ui-focus-visible`).

## 5) Правила добавления новых стилей
1. Сначала использовать токены из `styles/foundation.css`.
2. Новые «сырые» значения (`#hex`, произвольные `px`) добавлять только если:
   - нет подходящего токена,
   - и это реально новый паттерн.
3. При появлении повторения (2+ мест) — вынести в токен/utility-класс.
4. Для интерактивных элементов всегда задавать `hover`, `focus-visible`, `disabled`.
5. Избегать изменений в auth/payments/webhooks при стиле-рефакторинге без отдельной задачи.

## 6) Rollout roadmap
### Этап 2
- ✅ `messages` (desktop/mobile) переведены на foundation-токены для базовых visual primitives.
- В процессе: оставшиеся pages (trips/dashboard/settings variants) и довыравнивание вертикального rhythm.

### Этап 3
- Консолидация дублирующихся модулей и вариантов стилей.
- Вынести повторяющиеся «композитные» паттерны (toolbar, filter-row, modal footer) в shared UI-слой.
