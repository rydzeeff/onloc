# TBank API: static usage analysis (internal repository references)

## Scope
- Folder analyzed: `pages/api/tbank/*.js`.
- Goal: identify API files that have **no inbound references in repository code** (frontend/hooks/api/edge).

## Method
Static search over source files (`*.js`, `*.jsx`, `*.ts`, `*.tsx`, excluding `node_modules`, `.git`, `.next`) for each route file by patterns:
- direct route call: `/api/tbank/<route>`
- direct path mention: `pages/api/tbank/<route>.js`
- local API-to-API imports: `from './<route>'`, `require('./<route>')`

> Important: zero internal references does **not** mean endpoint is unused in production; webhook/provider/external callers may use it.

## Original files with zero internal references
- `pages/api/tbank/card-notification.js`
- `pages/api/tbank/close-spdeal.js`
- `pages/api/tbank/payment.js`
- `pages/api/tbank/refund-result.js`

## Cleanup performed
Removed from repository on this branch (per request):
- `pages/api/tbank/close-spdeal.js`
- `pages/api/tbank/payment.js`
- `pages/api/tbank/refund-result.js`

Kept in repository:
- `pages/api/tbank/card-notification.js` (possible external webhook usage)

## Notes / risk context
- `card-notification.js` is webhook-like and can be called externally.
- `refund-result.js` may also be callback/provider driven; remove only if runtime logs confirm no usage.
- For deleted files, verify production/staging access logs and provider callback configuration before permanent cleanup in long-lived branches.
