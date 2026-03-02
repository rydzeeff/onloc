alter table public.user_admin_access
  add column if not exists tbank_tools boolean not null default false;
