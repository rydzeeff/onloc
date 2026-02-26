# OnLoc Android оболочка

Это Android-приложение-обёртка (WebView) для текущего Next.js проекта.

## Что внутри
- Kotlin + AndroidX
- Одна `MainActivity` с `WebView`
- URL веб-приложения задаётся через `buildConfigField` (`WEB_APP_URL`)

## Быстрая сборка на сервере (Ubuntu)

Ниже — минимальная рабочая последовательность для CI/сервера.

### 1) Установить системные зависимости
```bash
sudo apt update
sudo apt install -y openjdk-17-jdk wget unzip
```

Проверка Java:
```bash
java -version
```
Нужна Java 17.

### 2) Установить Android SDK Command-line Tools
```bash
mkdir -p "$HOME/android-sdk/cmdline-tools"
cd /tmp
wget -O commandlinetools.zip "https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip"
unzip -q commandlinetools.zip -d "$HOME/android-sdk/cmdline-tools"
mv "$HOME/android-sdk/cmdline-tools/cmdline-tools" "$HOME/android-sdk/cmdline-tools/latest"
```

### 3) Настроить переменные окружения
Добавьте в `~/.bashrc`:
```bash
export ANDROID_SDK_ROOT="$HOME/android-sdk"
export ANDROID_HOME="$ANDROID_SDK_ROOT"
export PATH="$PATH:$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$ANDROID_SDK_ROOT/platform-tools"
```

Применить сразу:
```bash
source ~/.bashrc
```

### 4) Установить SDK компоненты и принять лицензии
```bash
yes | sdkmanager --licenses
sdkmanager \
  "platform-tools" \
  "platforms;android-35" \
  "build-tools;35.0.0"
```

### 5) Собрать APK
```bash
cd /workspace/onloc/android-app
export JAVA_HOME="/usr/lib/jvm/java-17-openjdk-amd64"
export PATH="$JAVA_HOME/bin:$PATH"
gradle assembleDebug
```

Готовый debug APK:
```text
/workspace/onloc/android-app/app/build/outputs/apk/debug/app-debug.apk
```

## Сборка release APK

### 1) Создать keystore
```bash
keytool -genkeypair -v \
  -keystore onloc-release.jks \
  -alias onloc \
  -keyalg RSA -keysize 2048 -validity 10000
```

### 2) Добавить подпись в `app/build.gradle.kts`
Добавьте `signingConfigs` и привяжите его к `buildTypes.release`.
Рекомендуется читать пароли из переменных окружения, например:
- `ONLOC_STORE_PASSWORD`
- `ONLOC_KEY_ALIAS`
- `ONLOC_KEY_PASSWORD`

### 3) Собрать release
```bash
cd /workspace/onloc/android-app
gradle assembleRelease
```

APK:
```text
/workspace/onloc/android-app/app/build/outputs/apk/release/app-release.apk
```

## Изменение адреса веб-приложения
В файле `app/build.gradle.kts` измените:
```kotlin
buildConfigField("String", "WEB_APP_URL", "\"https://onloc.ru\"")
```

## Частые проблемы
- **`Plugin com.android.application not found`**: сервер не может скачать Android Gradle Plugin (доступ к `google()`/`mavenCentral()` закрыт).
- **`sdkmanager: command not found`**: не настроен `PATH` к `cmdline-tools/latest/bin`.
- **Сборка падает на Java**: используйте JDK 17 и корректный `JAVA_HOME`.
- **`defaultConfig contains custom BuildConfig fields, but the feature is disabled`**: добавьте в `app/build.gradle.kts` блок `android { buildFeatures { buildConfig = true } }`.
