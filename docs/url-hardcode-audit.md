# URL hardcode audit

## Search query
`rg -n -uu "testsupadb1.onloc.ru|supadb.onloc.ru|mytest.onloc.ru|onloc.ru" .`

## Findings and classification

| Path | Type | Match nature | Action |
|---|---|---|---|
| `pages/TripsPageMobile.js` | frontend | hardcoded domain in UI contact text (`support@onloc.ru`) | replaced with `NEXT_PUBLIC_SUPPORT_EMAIL` |
| `pages/api/tbank/register.js` | backend | hardcoded base URL fallback (`https://onloc.ru`) | replaced with `getBaseUrl()` (`BASE_URL`) |
| `components/CompanySettings.jsx` | frontend | hardcoded `site_url` defaults (`https://onloc.ru`) | replaced with `getPublicBaseUrl()` (`NEXT_PUBLIC_BASE_URL`) |
| `components/CompanySettingsMobile.js` | frontend | hardcoded `site_url` defaults (`https://onloc.ru`) | replaced with `getPublicBaseUrl()` (`NEXT_PUBLIC_BASE_URL`) |
| `supabase/functions/process-disputes/process-disputes.ts` | backend/function | hardcoded webhook URL (`https://onloc.ru/api/webhooks/payout-error`) | replaced with `${BASE_URL}/api/webhooks/payout-error` |
| `supabase/functions/process-disputes/index.ts` | backend/function | hardcoded webhook URL (`https://onloc.ru/api/webhooks/payout-error`) | replaced with `${BASE_URL}/api/webhooks/payout-error` |
| `supabase/db/public_schema.sql` | config/db schema | hardcoded default/test URLs in schema snapshot | replaced with neutral `https://example.local` placeholder |
| `.env.example` | config/example | intentional example values | kept (test values + prod comments) |

## Post-refactor status
Direct mentions of listed domains remain only in `.env.example` and nowhere in runtime code.
