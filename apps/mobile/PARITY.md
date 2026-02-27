# Mobile parity inventory

## Discovery inventory (non-admin mobile variants)
- pages/AuthMobile.js
- pages/DashboardMobile.js
- pages/MyTripsSectionMobile.js
- pages/MobileMessagesPage.jsx
- pages/SettingsPageMobile.js
- pages/TripsPageMobile.js
- pages/TripParticipantsPageMobile.js
- pages/trip/TripDetailsPageMobile.js
- pages/view/TripViewPageMobile.js
- pages/trips/CreateTripMobile.js
- pages/trips/EditTripMobile.js
- pages/profile/ProfileSetupMobile.js
- pages/messages.js (mobile runtime split)
- pages/participants.js (mobile runtime split)
- pages/view/[id].js (mobile runtime split)
- pages/trips.js (mobile runtime split)
- pages/auth.js (mobile runtime split)
- pages/profile/setup.js (mobile runtime split)
- components/FiltersMobile.js
- components/AvatarEditorMobile.js
- components/CompanySettingsMobile.js

## Implemented this pass
- Dashboard parity baseline (hub sections and ordering):
  - `apps/mobile/src/screens/DashboardScreen.tsx` mirrors nav order and section strings from `pages/DashboardMobile.js`.
  - Includes `Мои поездки`, `Создать`, `Сообщения`, `Настройки`, `Отзывы` + unread badge placeholder based on chat count.
- Trips parity baseline:
  - `apps/mobile/src/screens/TripsScreen.tsx` ports visible filter groups from `pages/TripsPageMobile.js` + `components/FiltersMobile.js`: `Цена`, `Вид отдыха`, `Сложность`.
  - Trip cards include image/placeholder + status/date/price text and navigate to details.

## Known deviations
- Dashboard unread badge currently uses chat count instead of exact web unread aggregator (`get_unread_counts_for_chats` flow in `pages/_app.jsx`).
- Dashboard sections `Создать` and `Отзывы` currently route to Trips list / placeholder state; full create/reviews flows will be ported in later steps.
- Trips screen currently omits map and date range picker from web mobile (`TripsPageMobile.js`) pending dedicated parity pass.

## Update after feedback (map parity)
- `TripsScreen` now consumes `get_active_trips_geojson` (same source family as web) and renders a Yandex static map preview with trip points.
- Tap on map opens `${EXPO_PUBLIC_BACKEND_BASE_URL}/trips` for full interactive Yandex map while native in-screen interactive map is pending dedicated RN map integration.
- Tabs now start from `Trips` after auth (`initialRouteName="Trips"`) to mirror current web entry expectation.


## Implemented this pass (Trip details + Participants)
- `apps/mobile/src/screens/TripDetailsScreen.tsx` now follows mobile web section order with trip status/dates/description, CTA set (`Присоединиться`, `Выйти из поездки`, `Участники поездки`, `Сообщения`) and TBank payment actions.
- Added `apps/mobile/src/screens/TripParticipantsScreen.tsx` with participant list, status labels, organizer actions (`Принять`, `Отклонить`) and empty/loading states.
- `apps/mobile/src/navigation/AppNavigator.tsx` now includes `TripParticipants` route in Trips stack for details -> participants flow parity.

## Known deviations (details/participants)
- Trip details still does not include full web info-menu/documents/share/photo-viewer blocks and all conditional CTA states from `useTripDetails`; these will be ported in next iterations.
- Participants screen currently ports core list/actions only; disputes, evidence uploads, refund-policy modals and payout flows from `useTripParticipants` are pending.
