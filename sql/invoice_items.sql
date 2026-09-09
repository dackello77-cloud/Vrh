-- VRH: stavke ručno unetih faktura (Izveštaj > Behind izveštaj > "Napravi fakturu")
-- Pokreni ovo u Supabase SQL Editor-u (New query), posle sql/invoices.sql.
-- Idempotentno je (safe da ga pokreneš više puta).

-- Ručne (Behind) fakture nemaju jedan opis/qty/rate na samoj invoices koloni
-- (stavke idu u invoice_items ispod) — postojeće automatske (Current) fakture
-- i dalje pune ove kolone direktno, kao do sada.
alter table invoices alter column description drop not null;
alter table invoices alter column qty drop not null;
alter table invoices alter column rate drop not null;
alter table invoices alter column amount set default 0;
alter table invoices add column if not exists manual boolean not null default false;

create table if not exists invoice_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete cascade,
  position int not null default 0,
  description text not null,
  qty numeric not null default 0,
  rate numeric not null default 0,
  amount numeric not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists invoice_items_invoice_idx on invoice_items (invoice_id);

alter table invoice_items enable row level security;

drop policy if exists "invoice_items_select" on invoice_items;
create policy "invoice_items_select" on invoice_items
  for select
  using (user_has_view('reports'));

drop policy if exists "invoice_items_write" on invoice_items;
create policy "invoice_items_write" on invoice_items
  for all
  using (user_has_edit('reports'))
  with check (user_has_edit('reports'));

grant select, insert, update, delete on invoice_items to authenticated;
