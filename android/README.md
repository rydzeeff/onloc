# Android Capacitor project placeholder

В этом окружении npm registry недоступен для установки `@capacitor/*`, поэтому проект Android не был сгенерирован автоматически (`npx cap add android`).

После восстановления доступа к npm выполните:

```bash
npm install
npx cap add android
npx cap sync
```

## Intent filter для deep link

Добавьте в `android/app/src/main/AndroidManifest.xml`:

```xml
<intent-filter android:autoVerify="true">
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="onlocapp" android:host="auth-callback" />
</intent-filter>
```
