# Onloc Mobile (Expo + React Native)

Android MVP app for existing Onloc backend contracts.

## Setup

1. Copy env:
   ```bash
   cp .env.example .env
   ```
2. Fill:
   - `EXPO_PUBLIC_SUPABASE_URL`
   - `EXPO_PUBLIC_SUPABASE_ANON_KEY`
   - `EXPO_PUBLIC_BACKEND_BASE_URL` (Next.js base URL for `/api/*`)
   - `EXPO_PUBLIC_DEEPLINK_SCHEME` (default: `onloc`)

3. Install and run:
   ```bash
   npm install
   npm run start
   ```

## Android run

- Emulator: start Android Studio emulator, then press `a` in Expo terminal.
- Device: use Expo Go or development build.

## EAS build

If EAS is configured:

```bash
npm i -g eas-cli
eas login
eas build -p android --profile preview
```

For Play Store AAB:
```bash
eas build -p android --profile production
```

## Deep links

Configured in `app.config.ts`:
- scheme: `EXPO_PUBLIC_DEEPLINK_SCHEME`
- examples:
  - `onloc://trips`
  - `onloc://messages`
  - `onloc://profile`

## Architecture

- `src/screens` — app screens
- `src/components` — reusable UI
- `src/lib` — api/supabase/auth/payments/chat/profile
- `src/navigation` — React Navigation setup

## Notes

- Custom auth is implemented against `/api/custom-auth` with modes used by web (`login`, `verify`, `verify_otp`, `recover`, `recover_complete`).
- TBank payment init/state go through existing backend endpoints (`/api/tbank/init-payment`, `/api/tbank/get-state`).
- Push registration tries to persist in `push_subscriptions`; if insert blocked by backend policy it still returns local token.
