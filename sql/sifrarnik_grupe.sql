-- VRH: Šifrarnik grupe — "Grupa" postaje izbor iz spiska (dropdown) umesto
-- slobodnog teksta, da se redovi u tabeli mogu pouzdano grupisati/sortirati
-- (bez razlika u kucanju kao "VRH" / "vrh " / "Vrh"). Pokreni ovo u Supabase
-- SQL Editor-u POSLE sql/sifrarnik.sql. Idempotentno je — bezbedno da se
-- pokrene i više puta (backfill ispod ne dira redove koji već imaju grupa_id).

create table if not exists sifrarnik_grupe (
  id uuid primary key default gen_random_uuid(),
  naziv text not null unique,
  created_at timestamptz not null default now()
);

alter table sifrarnik_grupe enable row level security;
drop policy if exists "sifrarnik_grupe_select" on sifrarnik_grupe;
create policy "sifrarnik_grupe_select" on sifrarnik_grupe
  for select
  using (user_has_view('sifrarnik'));
drop policy if exists "sifrarnik_grupe_write" on sifrarnik_grupe;
create policy "sifrarnik_grupe_write" on sifrarnik_grupe
  for all
  using (user_has_edit('sifrarnik'))
  with check (user_has_edit('sifrarnik'));

revoke all on sifrarnik_grupe from anon;
grant select, insert, update, delete on sifrarnik_grupe to authenticated;

-- ---------- migracija: sifrarnik.grupa (tekst) -> sifrarnik.grupa_id (FK) ----------
-- "on delete set null" umesto podrazumevanog RESTRICT — ako se grupa ikad
-- ručno obriše u SQL Editor-u, šifre koje su je koristile samo ostanu bez
-- grupe umesto da blokiraju brisanje.

alter table sifrarnik add column if not exists grupa_id uuid references sifrarnik_grupe(id) on delete set null;

-- Napravi grupu za svaku postojeću različitu vrednost teksta koja još nema par.
insert into sifrarnik_grupe (naziv)
select distinct btrim(grupa)
from sifrarnik
where grupa is not null and btrim(grupa) <> ''
  and grupa_id is null
on conflict (naziv) do nothing;

update sifrarnik s
set grupa_id = g.id
from sifrarnik_grupe g
where s.grupa_id is null
  and s.grupa is not null and btrim(s.grupa) = g.naziv;

alter table sifrarnik drop column if exists grupa;
