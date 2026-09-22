-- VRH: Informacije (beleške/napomene, grupisane isto kao Šifrarnik) — nova
-- stranica koja se koristi SAMO iz keys.html (nema tab u glavnoj app).
-- Pokreni ovo u Supabase SQL Editor-u POSLE sql/auth_roles.sql (koristi
-- user_has_view()/user_has_edit() odatle). Idempotentno je.
--
-- Za razliku od Šifrarnika, ovde nema šifrovanja/reveal RPC-a — Naslov i
-- Tekst nisu tajni podaci, samo obična beleška.

create table if not exists informacije_grupe (
  id uuid primary key default gen_random_uuid(),
  naziv text not null unique,
  created_at timestamptz not null default now()
);

alter table informacije_grupe enable row level security;
drop policy if exists "informacije_grupe_select" on informacije_grupe;
create policy "informacije_grupe_select" on informacije_grupe
  for select
  using (user_has_view('informacije'));
drop policy if exists "informacije_grupe_write" on informacije_grupe;
create policy "informacije_grupe_write" on informacije_grupe
  for all
  using (user_has_edit('informacije'))
  with check (user_has_edit('informacije'));

revoke all on informacije_grupe from anon;
grant select, insert, update, delete on informacije_grupe to authenticated;

create table if not exists informacije (
  id uuid primary key default gen_random_uuid(),
  -- Bez "on delete set null" (namerno, isto kao sifrarnik.grupa_id) —
  -- brisanje grupe koja je još dodeljena bar jednoj belešci mora biti
  -- ZABRANJENO na nivou baze; frontend (js/keys.js) proverava isto pre
  -- brisanja da korisniku odmah jasno kaže zašto.
  grupa_id uuid references informacije_grupe(id),
  naslov text not null,
  tekst text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id)
);

create or replace function informacije_set_meta()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  NEW.updated_at := now();
  NEW.updated_by := auth.uid();
  if TG_OP = 'INSERT' then
    NEW.created_by := auth.uid();
  end if;
  return NEW;
end;
$$;

drop trigger if exists informacije_set_meta_trigger on informacije;
create trigger informacije_set_meta_trigger
before insert or update on informacije
for each row execute function informacije_set_meta();

alter table informacije enable row level security;
drop policy if exists "informacije_select" on informacije;
create policy "informacije_select" on informacije
  for select
  using (user_has_view('informacije'));
drop policy if exists "informacije_write" on informacije;
create policy "informacije_write" on informacije
  for all
  using (user_has_edit('informacije'))
  with check (user_has_edit('informacije'));

revoke all on informacije from anon;
grant select, insert, update, delete on informacije to authenticated;

-- ================================================================
-- Posle ovoga: Glavna app > Podešavanja > Role > izmeni (ili napravi) rolu i
-- uključi "Informacije (u keys.html)" na Pregled ili Izmena — isto mesto gde
-- se podešava i dozvola za Šifrarnik.
-- ================================================================
