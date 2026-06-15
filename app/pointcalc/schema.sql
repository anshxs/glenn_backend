create table if not exists public.userdata (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  name text,
  aadhar_card text,
  phone text,
  has_access boolean not null default false,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.userdata
add column if not exists phone text;

create or replace function public.set_userdata_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists userdata_set_updated_at on public.userdata;
create trigger userdata_set_updated_at
before update on public.userdata
for each row
execute function public.set_userdata_updated_at();

create or replace function public.handle_new_pointcalc_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.userdata (id, email, name, aadhar_card, phone, has_access)
  values (
    new.id,
    coalesce(new.email, ''),
    nullif(trim(coalesce(new.raw_user_meta_data->>'name', '')), ''),
    null,
    nullif(trim(coalesce(new.raw_user_meta_data->>'phone', '')), ''),
    false
  )
  on conflict (id) do update
  set email = excluded.email;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created_pointcalc on auth.users;
create trigger on_auth_user_created_pointcalc
after insert on auth.users
for each row
execute function public.handle_new_pointcalc_user();

alter table public.userdata enable row level security;

drop policy if exists "userdata_select_own_row" on public.userdata;
create policy "userdata_select_own_row"
on public.userdata
for select
to authenticated
using (auth.uid() = id);

drop policy if exists "userdata_insert_own_row" on public.userdata;
drop policy if exists "userdata_update_own_safe_fields" on public.userdata;
revoke delete on public.userdata from anon, authenticated;
drop policy if exists "userdata_delete_own_row" on public.userdata;

revoke insert on public.userdata from anon, authenticated;
revoke update on public.userdata from anon, authenticated;
revoke delete on public.userdata from anon, authenticated;

create table if not exists public.pointcalc_final_standings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  tournament_local_id text not null,
  tournament_name text not null,
  match_label text not null,
  match_count integer not null default 0,
  message_text text not null default '',
  standings jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id, tournament_local_id, match_label)
);

create or replace function public.set_pointcalc_final_standings_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists pointcalc_final_standings_set_updated_at on public.pointcalc_final_standings;
create trigger pointcalc_final_standings_set_updated_at
before update on public.pointcalc_final_standings
for each row
execute function public.set_pointcalc_final_standings_updated_at();

alter table public.pointcalc_final_standings enable row level security;

drop policy if exists "pointcalc_final_standings_select_own_rows" on public.pointcalc_final_standings;
create policy "pointcalc_final_standings_select_own_rows"
on public.pointcalc_final_standings
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "pointcalc_final_standings_insert_own_rows" on public.pointcalc_final_standings;
create policy "pointcalc_final_standings_insert_own_rows"
on public.pointcalc_final_standings
for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "pointcalc_final_standings_update_own_rows" on public.pointcalc_final_standings;
create policy "pointcalc_final_standings_update_own_rows"
on public.pointcalc_final_standings
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

revoke delete on public.pointcalc_final_standings from anon, authenticated;
