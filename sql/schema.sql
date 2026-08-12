-- VRH Faza 1: tabele za firme i dnevni broj kamiona
-- Pokreni ovo u Supabase SQL Editor-u (Project > SQL Editor > New query)

create extension if not exists pgcrypto;

create table if not exists companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  price numeric,
  tax numeric,
  status text not null default 'current' check (status in ('current', 'behind')),
  billing_starts_on date,
  notes text,
  entry_column text not null default 'advanced' check (entry_column in ('start', 'basic', 'advanced')),
  created_at timestamptz not null default now()
);

-- which of S/B/A a company's new daily entries get written into
alter table companies add column if not exists entry_column text not null default 'advanced';
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'companies_entry_column_check'
  ) then
    alter table companies add constraint companies_entry_column_check
      check (entry_column in ('start', 'basic', 'advanced'));
  end if;
end $$;

-- billing_starts_on replaces the earlier trial_until column (same idea,
-- clearer name: the date free/trial usage ends and billing starts).
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'companies' and column_name = 'trial_until'
  ) and not exists (
    select 1 from information_schema.columns
    where table_name = 'companies' and column_name = 'billing_starts_on'
  ) then
    alter table companies rename column trial_until to billing_starts_on;
  end if;
end $$;

alter table companies add column if not exists tax numeric;
alter table companies add column if not exists notes text;

-- external_id: the API's stable "Company:xxxx" key, used to match a company
-- to its daily ELD sync record without depending on exact name spelling.
-- eld_group: which ELD account the company is billed under (VRH or RST),
-- matching the two sections in the source Excel. Null = not on ELD sync,
-- stays a manually managed company.
alter table companies add column if not exists external_id text;
alter table companies add column if not exists eld_group text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'companies_external_id_key'
  ) then
    alter table companies add constraint companies_external_id_key unique (external_id);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'companies_eld_group_check'
  ) then
    alter table companies add constraint companies_eld_group_check
      check (eld_group is null or eld_group in ('VRH', 'RST'));
  end if;
end $$;

create table if not exists truck_counts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  date date not null,
  total integer not null check (total >= 0),
  created_at timestamptz not null default now(),
  unique (company_id, date)
);

-- T (total) / S (start) / B (basic) / A (advanced), matching the source
-- Excel's per-day breakdown. New manual entries always write to `advanced`;
-- `total` is kept in sync as start+basic+advanced and drives the
-- orange/green highlight rule.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'truck_counts' and column_name = 'count'
  ) then
    alter table truck_counts rename column count to total;
  end if;
end $$;

alter table truck_counts add column if not exists start integer;
alter table truck_counts add column if not exists basic integer;
alter table truck_counts add column if not exists advanced integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'truck_counts_start_check'
  ) then
    alter table truck_counts add constraint truck_counts_start_check check (start is null or start >= 0);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'truck_counts_basic_check'
  ) then
    alter table truck_counts add constraint truck_counts_basic_check check (basic is null or basic >= 0);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'truck_counts_advanced_check'
  ) then
    alter table truck_counts add constraint truck_counts_advanced_check check (advanced is null or advanced >= 0);
  end if;
end $$;

create index if not exists truck_counts_company_date_idx
  on truck_counts (company_id, date);

-- unique constraint on name so imports can upsert companies by name
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'companies_name_key'
  ) then
    alter table companies add constraint companies_name_key unique (name);
  end if;
end $$;

-- RLS: aplikacija radi sa anon (public) kljucem, bez logina u Fazi 1.
-- Ovo dozvoljava svima sa anon kljucem citanje i pisanje.
-- Kada se doda login/auth (SUPABASE_SETUP.md), ove politike treba pooštriti.
alter table companies enable row level security;
alter table truck_counts enable row level security;

drop policy if exists "companies_anon_all" on companies;
create policy "companies_anon_all" on companies
  for all
  using (true)
  with check (true);

drop policy if exists "truck_counts_anon_all" on truck_counts;
create policy "truck_counts_anon_all" on truck_counts
  for all
  using (true)
  with check (true);

-- RLS policies alone are not enough: Supabase does not auto-grant table
-- privileges to anon/authenticated for tables created via SQL Editor
-- (only tables created through the Table Editor UI get that by default).
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on companies to anon, authenticated;
grant select, insert, update, delete on truck_counts to anon, authenticated;
