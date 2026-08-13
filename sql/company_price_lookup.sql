-- VRH: istorijski cenovnik firmi (referenca za auto-popunu cene kad se
-- pojavi "nova" firma iz ELD API-ja koja je zapravo već fakturisana ranije
-- u 2026. — vidi docs/2026 - Billing count control.xlsx).
-- Ova tabela se NE menja ručno: puni se (a) jednokratnim uvozom iz tog
-- Excela (Settings > Kompanije cene) i (b) automatski svaki put kad se
-- companies.price promeni kroz modal za izmenu firme u Pregled kamiona.
-- Pokreni ovo u Supabase SQL Editor-u (New query). Idempotentno je.

create table if not exists company_price_lookup (
  id uuid primary key default gen_random_uuid(),
  name_key text not null unique, -- normalizovano ime (lowercase, trim, bez zagrada) — za poklapanje
  display_name text not null,    -- očišćeno ime, za prikaz u Settings
  price numeric not null,
  source text not null default 'billing_import' check (source in ('billing_import', 'company_edit')),
  updated_at timestamptz not null default now()
);

alter table company_price_lookup enable row level security;

drop policy if exists "company_price_lookup_anon_all" on company_price_lookup;
create policy "company_price_lookup_anon_all" on company_price_lookup
  for all
  using (true)
  with check (true);

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on company_price_lookup to anon, authenticated;
