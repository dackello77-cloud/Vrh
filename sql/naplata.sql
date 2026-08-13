-- VRH: tabele za Naplatu (billing/collections)
-- Pokreni ovo u Supabase SQL Editor-u (New query), posle sql/schema.sql
-- Idempotentno je (safe da ga pokrenes vise puta).

create table if not exists naplata (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete set null,
  company_name text not null,
  invoice_date date not null,
  invoice_number text,
  cycle text not null check (cycle in ('current', 'behind')),
  amount numeric not null,
  prorated_wo_ord numeric,
  payment_method text,
  collected boolean,
  collection_date date,
  all_checked boolean not null default false,
  closed boolean not null default false,
  comment text,
  source text not null default 'manual' check (source in ('manual', 'auto_daily', 'import')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- sprecava duplikate kad auto-sync ponovo obradjuje isti dan za istu firmu
create unique index if not exists naplata_auto_daily_unique
  on naplata (company_id, invoice_date)
  where source = 'auto_daily';

create table if not exists naplata_auto_state (
  id int primary key default 1,
  last_processed_date date,
  check (id = 1)
);

insert into naplata_auto_state (id) values (1)
  on conflict (id) do nothing;

alter table naplata enable row level security;
alter table naplata_auto_state enable row level security;

drop policy if exists "naplata_anon_all" on naplata;
create policy "naplata_anon_all" on naplata
  for all
  using (true)
  with check (true);

drop policy if exists "naplata_auto_state_anon_all" on naplata_auto_state;
create policy "naplata_auto_state_anon_all" on naplata_auto_state
  for all
  using (true)
  with check (true);

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on naplata to anon, authenticated;
grant select, insert, update, delete on naplata_auto_state to anon, authenticated;
