-- VRH: fakture (Izveštaj > Detaljan prikaz > "Napravi fakturu")
-- Pokreni ovo u Supabase SQL Editor-u (New query), posle sql/schema.sql,
-- sql/company_pricing.sql i sql/auth_roles.sql (koristi user_has_view/edit).
-- Idempotentno je (safe da ga pokreneš više puta).

alter table companies add column if not exists email text;

-- Nastavlja postojeći QuickBooks niz brojeva faktura (poslednja izdata
-- tamo je bila 5252) — sledeća iz VRH aplikacije kreće od 5253.
create sequence if not exists invoice_number_seq start with 5253;

create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  invoice_number bigint not null default nextval('invoice_number_seq') unique,
  company_id uuid not null references companies(id) on delete cascade,
  invoice_date date not null,
  description text not null,
  qty numeric not null,
  rate numeric not null,
  amount numeric not null,
  sent_to text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  -- jedna faktura po firmi po danu (isti dan = isti "Detaljan prikaz" red u
  -- dnevnom izveštaju) — ponovni klik na "Napravi fakturu" istog reda
  -- ponovo otvara istu fakturu/broj, ne pravi duplikat.
  unique (company_id, invoice_date)
);

alter table invoices enable row level security;

drop policy if exists "invoices_select" on invoices;
create policy "invoices_select" on invoices
  for select
  using (user_has_view('reports'));

drop policy if exists "invoices_write" on invoices;
create policy "invoices_write" on invoices
  for all
  using (user_has_edit('reports'))
  with check (user_has_edit('reports'));

grant select, insert, update on invoices to authenticated;
grant usage, select on sequence invoice_number_seq to authenticated;
