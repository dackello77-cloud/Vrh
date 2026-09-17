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

-- Broj računa se sad ručno unosi/potvrđuje u appu (QuickBooks broj), ne
-- automatski dodeljuje čim se red napravi (vidi js/app.js openInvoiceModal /
-- saveInvoiceNumberBtn) — inače bi samo OTVARANJE "Napravi fakturu" (i pre
-- nego što je iko potvrdio broj) odmah trošilo sledeći broj iz niza, pa bi
-- operater posle dobijao lažan "broj već iskorišćen" kad pokuša da unese
-- pravi (veći) broj koji misli da je slobodan. Više redova bez broja
-- (null) je u redu — unique ograničenje ne važi između null vrednosti.
alter table invoices alter column invoice_number drop not null;
alter table invoices alter column invoice_number drop default;

-- I dalje ima starih redova koji su broj dobili automatski pre ove izmene
-- (nikad potvrđenih u Naplati) i koji bi zbog "unique" i dalje lažno
-- blokirali unos istog broja na drugu fakturu. Stvarna evidencija zauzetih
-- brojeva je Naplata (naplata.invoice_number), ne ova tabela — provera "da
-- li je broj slobodan" se sad radi u appu protiv Naplate (vidi
-- saveInvoiceNumberBtn/saveBehindInvoiceBtn u js/app.js), pa ovo
-- ograničenje više nije potrebno niti ispravno.
alter table invoices drop constraint if exists invoices_invoice_number_key;
