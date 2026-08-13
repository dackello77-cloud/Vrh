-- VRH: stavke porudzbine (za rucno unete porudzbine sa proizvoljnim brojem
-- artikala — istorijski uvoz iz Orders.xlsx i dalje koristi
-- device_*/connector_* kolone direktno na orders, ovo je samo za nove).
-- Pokreni ovo u Supabase SQL Editor-u (New query), posle sql/orders.sql i
-- sql/products.sql. Idempotentno je.

create table if not exists order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  product_id uuid references products(id) on delete set null,
  product_name text not null,
  price numeric not null,
  count numeric not null default 1,
  created_at timestamptz not null default now()
);

create index if not exists order_items_order_idx on order_items (order_id);

alter table order_items enable row level security;

drop policy if exists "order_items_anon_all" on order_items;
create policy "order_items_anon_all" on order_items
  for all
  using (true)
  with check (true);

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on order_items to anon, authenticated;
