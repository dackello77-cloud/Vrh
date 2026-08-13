-- VRH: Porudzbine (Orders) — lista + detalji, izvor: docs/Orders.xlsx
-- Pokreni ovo u Supabase SQL Editor-u (New query), posle sql/schema.sql i
-- sql/products.sql (device_id/connector_id referenciraju products).
-- Idempotentno je.

create table if not exists orders (
  id uuid primary key default gen_random_uuid(),

  -- lista (kolone koje se prikazuju u glavnoj tabeli)
  order_date date,
  qb_invoice_number text,
  woocommerce_order_number text,
  company_id uuid references companies(id) on delete set null,
  company_name text not null,
  device_id uuid references products(id) on delete set null,
  device_name text,
  device_price numeric,
  device_count numeric,
  connector_id uuid references products(id) on delete set null,
  connector_name text,
  connector_price numeric,
  connector_count numeric,
  amount numeric,
  shipment_type text,
  invoice_status text,

  -- detalji (sve ostalo)
  contact_name text,
  phone text,
  email text,
  customer_type text,
  serial_number text,
  paperwork text,
  address text,
  notes text,
  shipping_department text,
  usps_tracking_number text,
  shipping_date date,
  email_confirmation text,

  source text not null default 'import' check (source in ('import', 'manual')),
  source_sheet text, -- '2026' / '2025' / '2024' — koji tab u Orders.xlsx je ovo doneo
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists orders_date_idx on orders (order_date);
create index if not exists orders_company_idx on orders (company_id);

alter table orders enable row level security;

drop policy if exists "orders_anon_all" on orders;
create policy "orders_anon_all" on orders
  for all
  using (true)
  with check (true);

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on orders to anon, authenticated;
