-- VRH: stanje uredjaja (po serijskom broju) i konektora (prost broj na stanju)
-- Pokreni ovo u Supabase SQL Editor-u (New query), posle sql/products.sql i
-- sql/orders.sql/sql/order_items.sql. Idempotentno je.

create table if not exists device_units (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  serial_number text not null,
  status text not null default 'in_stock' check (status in ('in_stock', 'shipped')),
  order_id uuid references orders(id) on delete set null,
  order_item_id uuid references order_items(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  shipped_at timestamptz,
  unique (product_id, serial_number)
);

create index if not exists device_units_status_idx on device_units (product_id, status);

alter table products add column if not exists stock_quantity integer not null default 0;

alter table device_units enable row level security;

drop policy if exists "device_units_anon_all" on device_units;
create policy "device_units_anon_all" on device_units
  for all
  using (true)
  with check (true);

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on device_units to anon, authenticated;
