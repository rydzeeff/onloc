# Mobile build guide (Capacitor)

## 1) Почему выбран `server.url`, а не `webDir`

Текущий проект — Next.js с SSR/API-роутами (`next build` + `next start`, папка `pages/api/*`), поэтому полностью статический export для `webDir` не покрывает текущий runtime.

Выбран подход **Capacitor + server.url**:
- WebView открывает production/staging HTTPS-домен.
- Веб-деплой не ломается, используем ту же инфраструктуру.
- Нативные функции (push, geolocation, deep links) добавляются через Capacitor plugins.

### Риски и смягчения
- Риск: зависимость от сети/доступности домена.
  - Смягчение: uptime мониторинг + fallback экран ошибок.
- Риск: рассинхрон web/native релиза.
  - Смягчение: фиксировать `NEXT_PUBLIC_CAP_SERVER_URL` по окружениям.
- Риск: deep-link ошибки в auth-flow.
  - Смягчение: отдельный callback `onlocapp://auth-callback` + страница `/mobile/auth-callback`.

## 2) Требования окружения

### Общие
- Node.js 20+
- npm 10+
- Java 17

### Android
- Android Studio Hedgehog+
- Android SDK Platform 34
- Build-tools 34+

### iOS
- macOS + Xcode 15+
- CocoaPods
- Apple Developer account для signing

## 3) Установка и синхронизация

```bash
npm install
npm run build:web
npm run cap:sync
```

Если `ios/` и `android/` ещё не созданы:

```bash
npx cap add ios
npx cap add android
npm run cap:sync
```

## 4) Android build

```bash
npm run android:open
```

Дальше в Android Studio:
1. Build Variant: `release`
2. `Build > Generate Signed Bundle / APK`
3. Выбрать `Android App Bundle (AAB)`
4. Подписать upload key

CLI вариант (после генерации проекта):

```bash
cd android
./gradlew bundleRelease
./gradlew assembleRelease
```

## 5) iOS build

```bash
npm run ios:open
```

Дальше в Xcode:
1. Открыть `ios/App/App.xcworkspace`
2. Signing & Capabilities: Team, Bundle Identifier
3. Product > Archive
4. Отправка через Organizer/TestFlight

## 6) Push notifications

- Клиент регистрирует push token и отправляет в `public.device_tokens`.
- Реальная отправка делается сервером/edge function через:
  - **FCM** (Android)
  - **APNs** (iOS)

Рекомендуется сделать Supabase Edge Function `send-push` с провайдерами FCM/APNs.

## 7) Deep links и Supabase Auth

Приложение использует схему:
- `onlocapp://auth-callback`

Нужно добавить:
- Android `intent-filter` для схемы `onlocapp`
- iOS URL Types (`onlocapp`) + Associated Domains (placeholder)

### Redirect URLs для Supabase
Добавить в Supabase Auth -> URL Configuration:
- `onlocapp://auth-callback`
- `https://onloc.ru/mobile/auth-callback`
- `https://staging.onloc.ru/mobile/auth-callback`
- `https://onloc.ru/auth`
- `https://staging.onloc.ru/auth`

## 8) Pre-release checklist

- [ ] `NEXT_PUBLIC_CAP_SERVER_URL` указывает на нужное окружение (prod/stage)
- [ ] Deep links открываются в app на iOS/Android
- [ ] Push token сохраняется в `device_tokens`
- [ ] Геолокация запрашивает permissions и возвращает координаты
- [ ] Splash/icon заменены бренд-ассетами
- [ ] Privacy policy URL добавлен в Store listing
- [ ] App Transport Security/Network Security config проверены
- [ ] Release signing сертификаты и keystore сохранены
