alter table public.user_admin_access
  add column if not exists news boolean not null default false;
