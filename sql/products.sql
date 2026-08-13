-- VRH: Podesavanja > Proizvodi (uredjaji i konektori, bez cena)
-- Pokreni ovo u Supabase SQL Editor-u (New query). Idempotentno je.

create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('device', 'connector')),
  name text not null,
  created_at timestamptz not null default now(),
  unique (type, name)
);

alter table products enable row level security;

drop policy if exists "products_anon_all" on products;
create policy "products_anon_all" on products
  for all
  using (true)
  with check (true);

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on products to anon, authenticated;

-- Pocetni katalog, izvucen iz docs/Orders.xlsx (tabovi 2026/2025/2024,
-- kolone Device i Connector). Bezbedno za ponovno pokretanje.
insert into products (type, name) values
  ('device', 'PT30'),
  ('device', 'PT40'),
  ('connector', '6PIN'),
  ('connector', '9PIN'),
  ('connector', '14PIN'),
  ('connector', '16PIN'),
  ('connector', '16PIN LD'),
  ('connector', '16PIN HD')
on conflict (type, name) do nothing;
