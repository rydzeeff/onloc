-- Restrict direct client inserts into trip_alerts to own alerts only.
-- Cross-user/system alerts should be created by trusted server-side code.

drop policy if exists "trip_alerts_insert_authenticated" on public.trip_alerts;

drop policy if exists "trip_alerts_insert_own" on public.trip_alerts;
create policy "trip_alerts_insert_own"
  on public.trip_alerts
  for insert
  with check (
    auth.uid() is not null
    and auth.uid() = user_id
    and (actor_user_id is null or actor_user_id = auth.uid())
  );
