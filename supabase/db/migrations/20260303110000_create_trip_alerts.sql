create table if not exists public.trip_alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  trip_id uuid null references public.trips(id) on delete cascade,
  actor_user_id uuid null references public.users(id) on delete set null,
  type text not null,
  title text not null,
  body text not null,
  metadata jsonb not null default '{}'::jsonb,
  is_read boolean not null default false,
  read_at timestamptz null,
  created_at timestamptz not null default now()
);

create index if not exists trip_alerts_user_created_idx on public.trip_alerts (user_id, created_at desc);
create index if not exists trip_alerts_user_unread_idx on public.trip_alerts (user_id, is_read);
create index if not exists trip_alerts_trip_idx on public.trip_alerts (trip_id);

alter table public.trip_alerts enable row level security;

create policy "trip_alerts_select_own"
  on public.trip_alerts
  for select
  using (auth.uid() = user_id);


create policy "trip_alerts_insert_authenticated"
  on public.trip_alerts
  for insert
  with check (auth.uid() is not null);

create policy "trip_alerts_update_own"
  on public.trip_alerts
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

alter publication supabase_realtime add table public.trip_alerts;
