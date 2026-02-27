# iOS Capacitor project placeholder

В этом окружении npm registry недоступен для установки `@capacitor/*`, поэтому iOS-проект не был сгенерирован автоматически (`npx cap add ios`).

После восстановления доступа к npm выполните:

```bash
npm install
npx cap add ios
npx cap sync
```

## Deep links / Associated Domains

1. В `Info.plist` добавить URL Type: `onlocapp`.
2. В Signing & Capabilities добавить `Associated Domains`:
   - `applinks:onloc.ru`
   - `applinks:staging.onloc.ru`
3. Убедиться что `apple-app-site-association` опубликован на домене.
