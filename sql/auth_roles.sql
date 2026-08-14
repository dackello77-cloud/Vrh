-- VRH: login (Supabase Auth) + role sistem sa dozvolama po stranici
-- (bez pristupa / samo pregled / izmena). Pokreni ovo u Supabase SQL
-- Editor-u (New query) POSLE svih ostalih sql/*.sql fajlova. Idempotentno je.
--
-- Stranice (page key -> naziv u navigaciji):
--   home     = Početna
--   overview = Pregled kamiona
--   reports  = Izveštaj
--   naplata  = Naplata
--   orders   = Porudžbine
--   stock    = Stanje uređaja
--   settings = Podešavanja (uključuje i upravljanje rolama/korisnicima)
--
-- roles.permissions je jsonb oblika {"overview": "edit", "naplata": "view", ...}
-- Dozvoljene vrednosti: "none" (ili izostavljeno) / "view" / "edit".

create table if not exists roles (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  permissions jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  role_id uuid references roles(id) on delete set null,
  created_at timestamptz not null default now()
);

-- ---------- helper funkcije (security definer da izbegnu RLS rekurziju) ----------

create or replace function user_permission(page_key text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select r.permissions ->> page_key
     from profiles p join roles r on r.id = p.role_id
     where p.id = auth.uid()),
    'none'
  );
$$;

create or replace function user_has_view(page_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select user_permission(page_key) in ('view', 'edit');
$$;

create or replace function user_has_edit(page_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select user_permission(page_key) = 'edit';
$$;

-- poziva se sa klijenta posle logina da povuce svoju mapu dozvola odjednom
create or replace function my_permissions()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select r.permissions from profiles p join roles r on r.id = p.role_id where p.id = auth.uid()),
    '{}'::jsonb
  );
$$;

grant execute on function user_permission(text) to authenticated;
grant execute on function user_has_view(text) to authenticated;
grant execute on function user_has_edit(text) to authenticated;
grant execute on function my_permissions() to authenticated;

-- ---------- roles / profiles: samo settings-edit (== admin) upravlja ----------

alter table roles enable row level security;
drop policy if exists "roles_admin_all" on roles;
create policy "roles_admin_all" on roles
  for all
  using (user_has_edit('settings'))
  with check (user_has_edit('settings'));

alter table profiles enable row level security;
drop policy if exists "profiles_select_own_or_admin" on profiles;
create policy "profiles_select_own_or_admin" on profiles
  for select
  using (id = auth.uid() or user_has_edit('settings'));
drop policy if exists "profiles_admin_write" on profiles;
create policy "profiles_admin_write" on profiles
  for all
  using (user_has_edit('settings'))
  with check (user_has_edit('settings'));

revoke all on roles from anon;
revoke all on profiles from anon;
grant select, insert, update, delete on roles to authenticated;
grant select, insert, update, delete on profiles to authenticated;

-- ---------- companies / truck_counts (Pregled kamiona + Izveštaj) ----------

drop policy if exists "companies_anon_all" on companies;
drop policy if exists "companies_select" on companies;
create policy "companies_select" on companies
  for select
  using (auth.uid() is not null);
drop policy if exists "companies_write" on companies;
create policy "companies_write" on companies
  for all
  using (user_has_edit('overview') or user_has_edit('settings'))
  with check (user_has_edit('overview') or user_has_edit('settings'));

drop policy if exists "truck_counts_anon_all" on truck_counts;
drop policy if exists "truck_counts_select" on truck_counts;
create policy "truck_counts_select" on truck_counts
  for select
  using (user_has_view('overview') or user_has_view('reports'));
drop policy if exists "truck_counts_write" on truck_counts;
create policy "truck_counts_write" on truck_counts
  for all
  using (user_has_edit('overview'))
  with check (user_has_edit('overview'));

revoke all on companies from anon;
revoke all on truck_counts from anon;
grant select, insert, update, delete on companies to authenticated;
grant select, insert, update, delete on truck_counts to authenticated;

-- ---------- naplata ----------
-- naplata_auto_state i "source='auto_daily'" upisi ostaju otvoreni svakom
-- ulogovanom korisniku jer runNaplataAutoSync() radi automatski pri svakom
-- otvaranju app-a, bez obzira ko je trenutno ulogovan. Insert sa
-- Porudžbine strane (nova porudžbina automatski otvara stavku naplate) je
-- takođe izuzet — vezan je za orders-edit dozvolu, ne za naplata dozvolu.

drop policy if exists "naplata_anon_all" on naplata;
drop policy if exists "naplata_select" on naplata;
create policy "naplata_select" on naplata
  for select
  using (user_has_view('naplata'));
drop policy if exists "naplata_edit_write" on naplata;
create policy "naplata_edit_write" on naplata
  for all
  using (user_has_edit('naplata'))
  with check (user_has_edit('naplata'));
drop policy if exists "naplata_auto_sync_insert" on naplata;
create policy "naplata_auto_sync_insert" on naplata
  for insert
  with check (source = 'auto_daily');
drop policy if exists "naplata_auto_sync_update" on naplata;
create policy "naplata_auto_sync_update" on naplata
  for update
  using (source = 'auto_daily')
  with check (source = 'auto_daily');
drop policy if exists "naplata_insert_from_orders" on naplata;
create policy "naplata_insert_from_orders" on naplata
  for insert
  with check (user_has_edit('orders'));

drop policy if exists "naplata_auto_state_anon_all" on naplata_auto_state;
drop policy if exists "naplata_auto_state_any_authenticated" on naplata_auto_state;
create policy "naplata_auto_state_any_authenticated" on naplata_auto_state
  for all
  using (auth.uid() is not null)
  with check (auth.uid() is not null);

revoke all on naplata from anon;
revoke all on naplata_auto_state from anon;
grant select, insert, update, delete on naplata to authenticated;
grant select, insert, update, delete on naplata_auto_state to authenticated;

-- ---------- orders / order_items ----------

drop policy if exists "orders_anon_all" on orders;
drop policy if exists "orders_select" on orders;
create policy "orders_select" on orders
  for select
  using (user_has_view('orders'));
drop policy if exists "orders_write" on orders;
create policy "orders_write" on orders
  for all
  using (user_has_edit('orders'))
  with check (user_has_edit('orders'));

drop policy if exists "order_items_anon_all" on order_items;
drop policy if exists "order_items_select" on order_items;
create policy "order_items_select" on order_items
  for select
  using (user_has_view('orders'));
drop policy if exists "order_items_write" on order_items;
create policy "order_items_write" on order_items
  for all
  using (user_has_edit('orders'))
  with check (user_has_edit('orders'));

revoke all on orders from anon;
revoke all on order_items from anon;
grant select, insert, update, delete on orders to authenticated;
grant select, insert, update, delete on order_items to authenticated;

-- ---------- device_units (Stanje uređaja + biranje serijskih u Porudžbine) ----------

drop policy if exists "device_units_anon_all" on device_units;
drop policy if exists "device_units_select" on device_units;
create policy "device_units_select" on device_units
  for select
  using (user_has_view('stock') or user_has_view('orders'));
drop policy if exists "device_units_stock_write" on device_units;
create policy "device_units_stock_write" on device_units
  for all
  using (user_has_edit('stock'))
  with check (user_has_edit('stock'));
drop policy if exists "device_units_order_link_update" on device_units;
create policy "device_units_order_link_update" on device_units
  for update
  using (user_has_edit('orders'))
  with check (user_has_edit('orders'));

revoke all on device_units from anon;
grant select, insert, update, delete on device_units to authenticated;

-- ---------- products (katalog uređaja/konektora + stock_quantity) ----------

drop policy if exists "products_anon_all" on products;
drop policy if exists "products_select" on products;
create policy "products_select" on products
  for select
  using (auth.uid() is not null);
drop policy if exists "products_settings_write" on products;
create policy "products_settings_write" on products
  for all
  using (user_has_edit('settings'))
  with check (user_has_edit('settings'));
drop policy if exists "products_stock_qty_update" on products;
create policy "products_stock_qty_update" on products
  for update
  using (user_has_edit('orders') or user_has_edit('stock'))
  with check (user_has_edit('orders') or user_has_edit('stock'));

revoke all on products from anon;
grant select, insert, update, delete on products to authenticated;

-- ---------- company_product_prices (Settings > Kompanije cene po proizvodu) ----------

drop policy if exists "company_product_prices_anon_all" on company_product_prices;
drop policy if exists "company_product_prices_select" on company_product_prices;
create policy "company_product_prices_select" on company_product_prices
  for select
  using (auth.uid() is not null);
drop policy if exists "company_product_prices_write" on company_product_prices;
create policy "company_product_prices_write" on company_product_prices
  for all
  using (user_has_edit('settings'))
  with check (user_has_edit('settings'));

revoke all on company_product_prices from anon;
grant select, insert, update, delete on company_product_prices to authenticated;

-- ---------- company_price_lookup (auto-upis kad se cena menja kroz Pregled kamiona) ----------

drop policy if exists "company_price_lookup_anon_all" on company_price_lookup;
drop policy if exists "company_price_lookup_select" on company_price_lookup;
create policy "company_price_lookup_select" on company_price_lookup
  for select
  using (auth.uid() is not null);
drop policy if exists "company_price_lookup_write" on company_price_lookup;
create policy "company_price_lookup_write" on company_price_lookup
  for all
  using (user_has_edit('settings') or user_has_edit('overview'))
  with check (user_has_edit('settings') or user_has_edit('overview'));

revoke all on company_price_lookup from anon;
grant select, insert, update, delete on company_price_lookup to authenticated;

-- ---------- napomena: eld_sync_state / holidays namerno nedirnuti ----------
-- kickoff_eld_sync() / collect_eld_sync() / carry_forward_last_working_day()
-- su "security definer" funkcije koje pg_cron zove direktno unutar baze —
-- ne prolaze kroz anon/authenticated RLS ni pre ni posle ove migracije, pa
-- automatska ELD sinhronizacija nastavlja da radi nepromenjeno.

-- ================================================================
-- BOOTSTRAP: prvi administratorski nalog (pokreni RUČNO, jednom)
-- ================================================================
-- 1) Supabase Dashboard > Authentication > Users > "Add user" — unesi svoj
--    email + lozinku, i uključi "Auto Confirm User" (da ne treba potvrda
--    mejlom).
-- 2) Dashboard > Authentication > Providers > Email > isključi
--    "Confirm email" (da app iz Settings može sam da otvara nove naloge bez
--    da čeka potvrdu mejlom).
-- 3) Ovde ispod zameni 'tvoj-email@example.com' svojim mejlom iz koraka 1) i
--    pokreni (samo ovaj deo, posle svega iznad):
--
-- insert into roles (name, permissions) values (
--   'Administrator',
--   '{"home":"edit","overview":"edit","reports":"edit","naplata":"edit","orders":"edit","stock":"edit","settings":"edit"}'::jsonb
-- )
-- on conflict (name) do nothing;
--
-- insert into profiles (id, email, role_id)
-- select u.id, u.email, r.id
-- from auth.users u, roles r
-- where u.email = 'tvoj-email@example.com' and r.name = 'Administrator'
-- on conflict (id) do update set role_id = excluded.role_id;
--
-- Alternativa preko UID-a (ako ti je lakše da kopiraš UID iz
-- Authentication > Users liste umesto da kucaš email — zameni
-- 'PASTE-USER-UID-OVDE' stvarnim UID-om, i 'tvoj-email@example.com' istim
-- mejlom koji ima taj nalog, čisto radi prikaza u Settings > Korisnici):
--
-- insert into roles (name, permissions) values (
--   'Administrator',
--   '{"home":"edit","overview":"edit","reports":"edit","naplata":"edit","orders":"edit","stock":"edit","settings":"edit"}'::jsonb
-- )
-- on conflict (name) do nothing;
--
-- insert into profiles (id, email, role_id)
-- select 'PASTE-USER-UID-OVDE'::uuid, 'tvoj-email@example.com', r.id
-- from roles r
-- where r.name = 'Administrator'
-- on conflict (id) do update set role_id = excluded.role_id;
