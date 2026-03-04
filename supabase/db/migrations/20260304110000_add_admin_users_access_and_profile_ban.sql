alter table public.user_admin_access
  add column if not exists users boolean not null default false;

alter table public.profiles
  add column if not exists is_banned boolean not null default false,
  add column if not exists ban_reason text,
  add column if not exists banned_at timestamptz;
