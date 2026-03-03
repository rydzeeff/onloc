alter table if exists public.trip_alerts
  drop constraint if exists trip_alerts_user_id_fkey,
  drop constraint if exists trip_alerts_actor_user_id_fkey;

alter table if exists public.trip_alerts
  add constraint trip_alerts_user_id_fkey
    foreign key (user_id) references public.profiles(user_id) on delete cascade,
  add constraint trip_alerts_actor_user_id_fkey
    foreign key (actor_user_id) references public.profiles(user_id) on delete set null;
