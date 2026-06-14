create table if not exists public.userdata (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  name text,
  aadhar_card text,
  has_access boolean not null default false,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

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
  insert into public.userdata (id, email, name, aadhar_card, has_access)
  values (
    new.id,
    coalesce(new.email, ''),
    nullif(trim(coalesce(new.raw_user_meta_data->>'name', '')), ''),
    null,
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
