-- VRH: Podesavanja > Kompanije (ovlasceno lice, adresa, cena po proizvodu)
-- Pokreni ovo u Supabase SQL Editor-u (New query), posle sql/schema.sql i
-- sql/products.sql (company_product_prices referencira obe tabele).
-- Idempotentno je.

alter table companies add column if not exists contact_name text;
alter table companies add column if not exists address text;

create table if not exists company_product_prices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  product_id uuid not null references products(id) on delete cascade,
  price numeric not null,
  updated_at timestamptz not null default now(),
  unique (company_id, product_id)
);

alter table company_product_prices enable row level security;

drop policy if exists "company_product_prices_anon_all" on company_product_prices;
create policy "company_product_prices_anon_all" on company_product_prices
  for all
  using (true)
  with check (true);

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on company_product_prices to anon, authenticated;
