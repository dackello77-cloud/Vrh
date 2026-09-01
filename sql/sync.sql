-- VRH: automatska sinhronizacija sa ELD API-jem
-- Pokreni ovo u Supabase SQL Editor-u nakon sto je sql/schema.sql vec pokrenut
-- (treba mu companies.external_id / eld_group / entry_column da vec postoje).
--
-- Sinhronizacija je podeljena na dve funkcije jer pg_net radi async: jedna
-- posalje HTTP zahtev, druga (pokrenuta minut kasnije, kao poseban cron
-- posao) pokupi odgovor. Cekanje u petlji unutar iste funkcije/transakcije
-- se pokazalo nepouzdano.

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- cleanup from the earlier single-function attempt
do $$
begin
  if exists (select 1 from cron.job where jobname = 'sync-eld-data-daily') then
    perform cron.unschedule('sync-eld-data-daily');
  end if;
end $$;
drop function if exists sync_eld_data();

create table if not exists eld_sync_state (
  id int primary key default 1,
  last_request_id bigint,
  updated_at timestamptz,
  check (id = 1)
);
insert into eld_sync_state (id) values (1) on conflict (id) do nothing;

-- last_collect_at/last_collect_summary: kad se collect_eld_sync() zadnji put
-- POKUSAO (uspesno, preskoceno zbog neradnog dana, ili sa greskom) - za
-- "Poslednja sinhronizacija u HH:MM" prikaz u UI (Pregled kamiona/Izvestaj).
-- Odvojeno od last_request_id/updated_at gore, koje kickoff_eld_sync() upisuje
-- kad zahtev POSALJE, ne kad odgovor stvarno stigne i upise se.
alter table eld_sync_state add column if not exists last_collect_at timestamptz;
alter table eld_sync_state add column if not exists last_collect_summary jsonb;

alter table eld_sync_state enable row level security;
drop policy if exists "eld_sync_state_select" on eld_sync_state;
create policy "eld_sync_state_select" on eld_sync_state
  for select
  using (auth.uid() is not null);
grant select on eld_sync_state to authenticated;

-- ---------- neradni dani: vikendi + drzavni praznici ----------
-- Praznici se ne mogu izracunati iz dana u nedelji (Uskrs je pokretan, a
-- praznik moze pasti i radnim danom pon-pet), pa se drze u tabeli koju
-- treba rucno popuniti/azurirati za svaku godinu:
--   insert into holidays (date, name) values ('2026-01-01', 'Nova godina');
-- Primer srpskih drzavnih praznika za 2026 (proveri pre unosa - Uskrs je
-- pokretan i ovde je samo orijentacioni datum):
--   insert into holidays (date, name) values
--     ('2026-01-01', 'Nova godina'), ('2026-01-02', 'Nova godina'),
--     ('2026-01-07', 'Bozic'),
--     ('2026-02-15', 'Dan drzavnosti'), ('2026-02-16', 'Dan drzavnosti'),
--     ('2026-04-10', 'Veliki petak'), ('2026-04-11', 'Velika subota'),
--     ('2026-04-12', 'Uskrs'), ('2026-04-13', 'Uskrsnji ponedeljak'),
--     ('2026-05-01', 'Praznik rada'), ('2026-05-02', 'Praznik rada');

create table if not exists holidays (
  date date primary key,
  name text
);

alter table holidays enable row level security;

drop policy if exists "holidays_anon_all" on holidays;
create policy "holidays_anon_all" on holidays
  for all
  using (true)
  with check (true);

grant select, insert, update, delete on holidays to anon, authenticated;

create or replace function is_non_working_day(d date)
returns boolean
language sql
stable
as $$
  select extract(dow from d)::int in (0, 6)
    or exists (select 1 from holidays h where h.date = d);
$$;

-- ---------- korak 1: posalji zahtev ----------

create or replace function kickoff_eld_sync()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  req_id bigint;
begin
  if is_non_working_day(current_date) then
    return null;
  end if;

  req_id := net.http_get(url => 'https://royal-paper-656b.dackello77.workers.dev/');
  update eld_sync_state set last_request_id = req_id, updated_at = now() where id = 1;
  return req_id;
end;
$$;

grant execute on function kickoff_eld_sync() to anon, authenticated, service_role;
alter function kickoff_eld_sync() set statement_timeout = '15s';

-- ---------- retry u 13:05 i 13:10 UTC ako 13h pokusaj nije upisao nista ----------
-- Redovan 13:00/13:01 pokusaj moze da "uspe" (HTTP 200, bez greske) a da
-- ipak ne upise nijedan red - npr. ako ELD worker tog trenutka vrati prazan
-- odgovor bez firmi (desilo se 31.8.2026, vidi last_collect_summary tog
-- dana). To collect_eld_sync() ne tretira kao gresku (nema exception), pa
-- obican retry-na-gresku ne bi ni pokusao ponovo. Ova funkcija umesto toga
-- gleda da li je DANAS vec upisan bar 1 red (last_collect_summary.rows_written
-- > 0) - ako nije, salje nov HTTP zahtev; ako jeste, ne radi nista (ne salje
-- nepotreban zahtev). Zove je kickoff_eld_sync_retry_if_needed() cron posao
-- u 13:05 i 13:10 UTC, minut pre odgovarajuceg collect_eld_sync() poziva
-- (isti dvokorani obrazac kao redovan sync - pg_net je async).
-- Rucno dugme "Sinhronizuj sada" i dalje zove obican kickoff_eld_sync()
-- (uvek salje zahtev kad se klikne) - ova funkcija je samo za automatski
-- retry, ne dira to ponasanje.
create or replace function kickoff_eld_sync_retry_if_needed()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  req_id bigint;
  last_at timestamptz;
  last_summary jsonb;
  already_ok boolean;
begin
  if is_non_working_day(current_date) then
    return null;
  end if;

  select last_collect_at, last_collect_summary into last_at, last_summary
  from eld_sync_state where id = 1;

  already_ok := last_at is not null
    and last_at::date = current_date
    and coalesce((last_summary->>'rows_written')::int, 0) > 0;

  if already_ok then
    return null;
  end if;

  req_id := net.http_get(url => 'https://royal-paper-656b.dackello77.workers.dev/');
  update eld_sync_state set last_request_id = req_id, updated_at = now() where id = 1;
  return req_id;
end;
$$;

grant execute on function kickoff_eld_sync_retry_if_needed() to anon, authenticated, service_role;
alter function kickoff_eld_sync_retry_if_needed() set statement_timeout = '15s';

-- ---------- korak 1.5: automatski upis novih firmi iz ELD API-ja ----------
-- Kad se u ELD API odgovoru pojavi firma (external_id) koje još nema u
-- companies, upisuje se automatski, bez ljudske potvrde:
--  - ako firma sa istim imenom već postoji u companies (ELD ume da dodeli
--    nov external_id istoj firmi posle reseta naloga) -> samo se povezuje
--    novi external_id na taj postojeći red, ne pravi se duplikat
--    (companies.name je unique).
--  - inače, ako je ime prepoznato u company_price_lookup (već je ranije
--    fakturisana pod tim imenom) -> zadržava tu poznatu cenu, bez trial
--    perioda (billing_starts_on ostaje null - naplaćuje se odmah).
--  - inače je stvarno nova firma -> cena 0, besplatnih 14 dana
--    (billing_starts_on = danas + 14). Tokom tih 14 dana ne ulazi u
--    izveštaj/naplatu (isFreeDay u app.js); 14. dana počinje da se
--    naplaćuje - vidi computeAddedItems (app.js), koji tog dana računa ceo
--    trenutni broj kamiona, ne samo dnevnu promenu.
-- Imena test/trening naloga se preskaču, isto kao checkForNewCompanies() u
-- app.js (ostavljen tamo i dalje kao ručna rezerva - u normalnom slučaju
-- firma je već upisana ovde pre nego što iko otvori aplikaciju).
-- Greška pri upisu jedne firme (npr. neočekivan sukob imena) se hvata i
-- preskače, da ne obori ceo dnevni sync brojeva kamiona za ostale firme.

create or replace function provision_new_eld_companies(body jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  co record;
  api_name text;
  api_group text;
  v_name_key text;
  existing_id uuid;
  known_price numeric;
  skip_names text[] := array['test_vrh', 'vrh training'];
  created_count int := 0;
  relinked_count int := 0;
  skipped_errors int := 0;
begin
  for co in
    select kv.key as external_id, kv.value as val
    from jsonb_each(coalesce(body->'data'->'companies', '{}'::jsonb)) as kv
  loop
    if exists (select 1 from companies where external_id = co.external_id) then
      continue;
    end if;

    api_name := btrim(coalesce(co.val->>'name', ''));
    if api_name = '' or lower(api_name) = any (skip_names) then
      continue;
    end if;

    api_group := case when co.val->>'account_name' = 'VRHELD' then 'VRH' else 'RST' end;

    begin
      -- ELD ume da dodeli nov external_id istoj firmi (reset naloga) -
      -- poveži na postojeći red po imenu umesto da praviš duplikat.
      select id into existing_id from companies
      where lower(btrim(name)) = lower(api_name)
      limit 1;

      if existing_id is not null then
        update companies set external_id = co.external_id, eld_group = api_group
          where id = existing_id;
        relinked_count := relinked_count + 1;
        continue;
      end if;

      v_name_key := lower(regexp_replace(regexp_replace(api_name, '\s*\([^)]*\)\s*$', ''), '\s+', ' ', 'g'));
      select price into known_price from company_price_lookup where name_key = v_name_key;

      if known_price is not null then
        insert into companies (name, external_id, eld_group, price, status, entry_column, billing_starts_on)
        values (api_name, co.external_id, api_group, known_price, 'current', 'advanced', null);
      else
        insert into companies (name, external_id, eld_group, price, status, entry_column, billing_starts_on)
        values (api_name, co.external_id, api_group, 0, 'current', 'advanced', current_date + 14);
      end if;
      created_count := created_count + 1;
    exception when others then
      skipped_errors := skipped_errors + 1;
    end;
  end loop;

  return jsonb_build_object(
    'created', created_count,
    'relinked', relinked_count,
    'errors', skipped_errors
  );
end;
$$;

grant execute on function provision_new_eld_companies(jsonb) to anon, authenticated, service_role;
alter function provision_new_eld_companies(jsonb) set statement_timeout = '15s';

-- ---------- korak 2: pokupi odgovor i upisi podatke ----------

create or replace function collect_eld_sync()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  req_id bigint;
  resp net._http_response;
  body jsonb;
  company_rec record;
  d record;
  eld_count int;
  prev_count int;
  prev_date text;
  delta int;
  cur_start int;
  cur_basic int;
  cur_advanced int;
  synced_companies int := 0;
  synced_rows int := 0;
  -- 4 dana umesto 2: 21.8.2026 je izvor (ELD API) taj dan i dalje vracao
  -- eld_count = 0 (placeholder) jos i 2 dana kasnije, pa ga je stariji
  -- 2-dnevni prozor trajno preskocio iako je izvor kasnije ipak popunio
  -- pravu vrednost - do tada je prozor vec bio pomeren dalje. Vidi i
  -- backfill_eld_date() ispod za rucno popunjavanje ako se ovo opet desi.
  window_start date := current_date - 4;
  provision_result jsonb;
  result jsonb;
begin
  if is_non_working_day(current_date) then
    result := jsonb_build_object('skipped', true, 'reason', 'neradni dan');
    update eld_sync_state set last_collect_at = now(), last_collect_summary = result where id = 1;
    return result;
  end if;

  begin

  select last_request_id into req_id from eld_sync_state where id = 1;
  if req_id is null then
    raise exception 'Nema zakazanog ELD zahteva - pozovi kickoff_eld_sync() prvo';
  end if;

  select * into resp from net._http_response where id = req_id;
  if resp.id is null then
    raise exception 'Odgovor za zahtev % jos nije stigao', req_id;
  end if;

  if resp.status_code is distinct from 200 then
    raise exception 'ELD API vratio status %: %', resp.status_code, resp.content;
  end if;

  body := resp.content::jsonb;

  -- upiši nove firme (ako ih ima) PRE glavne petlje, da ista ova sinhronizacija
  -- odmah upiše i njihov prvi dnevni broj kamiona, ne tek sutra.
  begin
    provision_result := provision_new_eld_companies(body);
  exception when others then
    provision_result := jsonb_build_object('error', sqlerrm);
  end;

  for company_rec in
    select c.id as company_id, c.entry_column, c.external_id,
           (body->'data'->'companies'->c.external_id->'dates') as dates
    from companies c
    where c.external_id is not null
      and (body->'data'->'companies') ? c.external_id
  loop
    synced_companies := synced_companies + 1;

    for d in
      select kv.key as date_key, (kv.value->>'eld_count')::int as eld_count
      from jsonb_each(company_rec.dates) as kv
      where kv.key::date >= window_start and kv.key::date <= current_date
      order by kv.key asc
    loop
      -- Vikend/praznik: nikad se ne izvlaci iz API-ja, cak i ako izvor vrati
      -- stvarnu (nenultu) vrednost za taj dan. Subota i nedelja se uvek samo
      -- preslikavaju iz petka (carry_forward_last_working_day), a stvarna
      -- promena se registruje tek u ponedeljak kad se uporedi sa petkom.
      if is_non_working_day(d.date_key::date) then
        continue;
      end if;

      eld_count := d.eld_count;
      -- eld_count = 0 znaci da izvor jos nije azurirao taj dan (placeholder).
      -- Preskacemo da ne bismo obrisali stvarne podatke nulom.
      if eld_count is null or eld_count = 0 then
        continue;
      end if;

      prev_date := (d.date_key::date - interval '1 day')::date::text;
      -- Ako je prethodni dan vikend/praznik, njegova "prava" vrednost je
      -- preslikana iz petka (carry_forward_last_working_day), ne stvarna API
      -- vrednost za taj dan (izvor je i dalje moze imati realan broj za
      -- subotu/nedelju, ali se on namerno ne koristi - isto pravilo kao gore).
      -- Zato se za vikend prethodni dan uvek ide direktno na truck_counts.
      if is_non_working_day(prev_date::date) then
        prev_count := null;
      else
        prev_count := (company_rec.dates -> prev_date ->> 'eld_count')::int;
      end if;
      if prev_count is null or prev_count = 0 then
        select total into prev_count
        from truck_counts
        where company_id = company_rec.company_id and date = prev_date::date;
      end if;

      -- Nema podatka za tacno prethodni dan (rupa u sync-u — npr. firma tek
      -- povezana pa je jedan dan u sredini nedostajao). Umesto da odustanemo
      -- (sto bi ostavilo start/basic/advanced prazno za citav ostatak dana i
      -- tiho izgubilo naplatu za tu aktivaciju), vrati se na POSLEDNJI redak
      -- koji stvarno postoji pre ovog dana — to je i dalje ispravna "prethodna
      -- poznata vrednost" za racunanje delte, isti princip kao "carried
      -- forward" u frontend-u. Ako firma uopste nema nijedan raniji red (ovo
      -- joj je prvi dan ikad), prava prethodna vrednost je 0.
      if prev_count is null then
        select total into prev_count
        from truck_counts
        where company_id = company_rec.company_id and date < d.date_key::date
        order by date desc
        limit 1;
      end if;
      if prev_count is null then
        prev_count := 0;
      end if;

      delta := case when prev_count is not null then eld_count - prev_count else null end;

      select start, basic, advanced into cur_start, cur_basic, cur_advanced
      from truck_counts
      where company_id = company_rec.company_id and date = d.date_key::date;

      if delta is not null and delta > 0 then
        if company_rec.entry_column = 'start' then cur_start := delta;
        elsif company_rec.entry_column = 'basic' then cur_basic := delta;
        else cur_advanced := delta;
        end if;
      end if;

      insert into truck_counts (company_id, date, total, start, basic, advanced)
      values (company_rec.company_id, d.date_key::date, eld_count, cur_start, cur_basic, cur_advanced)
      on conflict (company_id, date) do update
        set total = excluded.total,
            start = excluded.start,
            basic = excluded.basic,
            advanced = excluded.advanced;

      synced_rows := synced_rows + 1;
    end loop;
  end loop;

  result := jsonb_build_object(
    'companies_synced', synced_companies,
    'rows_written', synced_rows,
    'provisioning', provision_result,
    'ran_at', now()
  );
  update eld_sync_state set last_collect_at = now(), last_collect_summary = result where id = 1;
  return result;

  exception when others then
    update eld_sync_state
      set last_collect_at = now(),
          last_collect_summary = jsonb_build_object('error', sqlerrm)
      where id = 1;
    raise;
  end;
end;
$$;

grant execute on function collect_eld_sync() to anon, authenticated, service_role;
alter function collect_eld_sync() set statement_timeout = '25s';

-- ---------- neradni dan: bez API poziva, samo prenesi poslednji radni dan ----------
-- Kada je tekuci datum vikend ili praznik, ELD API se ne zove. Umesto toga
-- se `total` sa poslednjeg radnog dana (moze biti i vise dana unazad, npr.
-- posle visednevnog praznika) upisuje na tekuci datum, tako da tabela i
-- dalje ima vrednost za taj dan (ne ostaje prazno). start/basic/advanced se
-- namerno ostavljaju na null - neradni dan ne predstavlja novo "dodavanje"
-- kamiona, pa ne sme da se oboji zeleno/narandzasto niti da udje u obracun
-- kao aktivacija.

create or replace function carry_forward_last_working_day()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  source_date date;
  rows_copied int := 0;
begin
  if not is_non_working_day(current_date) then
    return jsonb_build_object('skipped', true, 'reason', 'radni dan');
  end if;

  source_date := current_date - 1;
  while is_non_working_day(source_date) loop
    source_date := source_date - 1;
  end loop;

  insert into truck_counts (company_id, date, total, start, basic, advanced)
  select company_id, current_date, total, null, null, null
  from truck_counts
  where date = source_date
  on conflict (company_id, date) do update
    set total = excluded.total,
        start = excluded.start,
        basic = excluded.basic,
        advanced = excluded.advanced;

  get diagnostics rows_copied = row_count;

  return jsonb_build_object(
    'source_date', source_date,
    'rows_copied', rows_copied,
    'ran_at', now()
  );
end;
$$;

grant execute on function carry_forward_last_working_day() to anon, authenticated, service_role;
alter function carry_forward_last_working_day() set statement_timeout = '15s';

-- ---------- rucni backfill konkretnog datuma (van uobicajenog prozora) ----------
-- Za slucaj da izvor (ELD API) zavrsi racunanje dnevnog broja kasnije nego
-- sto redovni prozor pokriva (vidi napomenu kod window_start u
-- collect_eld_sync) - taj dan ostane trajno prazan u truck_counts iako
-- izvor kasnije ipak ima ispravnu vrednost. Rucna popravka u SQL Editor-u:
--   select kickoff_eld_sync();
--   -- sacekaj ~10-20 sekundi da pg_net dobije odgovor --
--   select backfill_eld_date('2026-08-21');
-- Sigurno je pozvati vise puta (upsert po (company_id, date)).

create or replace function backfill_eld_date(target_date date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  req_id bigint;
  resp net._http_response;
  body jsonb;
  company_rec record;
  eld_count int;
  prev_count int;
  delta int;
  cur_start int;
  cur_basic int;
  cur_advanced int;
  synced_rows int := 0;
begin
  select last_request_id into req_id from eld_sync_state where id = 1;
  if req_id is null then
    raise exception 'Nema zakazanog ELD zahteva - pozovi kickoff_eld_sync() prvo';
  end if;

  select * into resp from net._http_response where id = req_id;
  if resp.id is null then
    raise exception 'Odgovor za zahtev % jos nije stigao', req_id;
  end if;
  if resp.status_code is distinct from 200 then
    raise exception 'ELD API vratio status %: %', resp.status_code, resp.content;
  end if;

  body := resp.content::jsonb;

  for company_rec in
    select c.id as company_id, c.entry_column,
           (body->'data'->'companies'->c.external_id->target_date::text->>'eld_count')::int as eld_count
    from companies c
    where c.external_id is not null
      and (body->'data'->'companies') ? c.external_id
  loop
    eld_count := company_rec.eld_count;
    if eld_count is null or eld_count = 0 then
      continue;
    end if;

    select total into prev_count from truck_counts
    where company_id = company_rec.company_id and date = target_date - 1;
    if prev_count is null then
      select total into prev_count from truck_counts
      where company_id = company_rec.company_id and date < target_date
      order by date desc limit 1;
    end if;
    if prev_count is null then
      prev_count := 0;
    end if;

    delta := eld_count - prev_count;

    select start, basic, advanced into cur_start, cur_basic, cur_advanced
    from truck_counts where company_id = company_rec.company_id and date = target_date;

    if delta is not null and delta > 0 then
      if company_rec.entry_column = 'start' then cur_start := delta;
      elsif company_rec.entry_column = 'basic' then cur_basic := delta;
      else cur_advanced := delta;
      end if;
    end if;

    insert into truck_counts (company_id, date, total, start, basic, advanced)
    values (company_rec.company_id, target_date, eld_count, cur_start, cur_basic, cur_advanced)
    on conflict (company_id, date) do update
      set total = excluded.total, start = excluded.start, basic = excluded.basic, advanced = excluded.advanced;

    synced_rows := synced_rows + 1;
  end loop;

  return jsonb_build_object('target_date', target_date, 'rows_written', synced_rows, 'ran_at', now());
end;
$$;

grant execute on function backfill_eld_date(date) to anon, authenticated, service_role;
alter function backfill_eld_date(date) set statement_timeout = '25s';

-- ---------- raspored: 15:00 Europe/Belgrade (leti = 13:00 UTC) ----------
-- kickoff u 13:00 UTC, collect minut kasnije u 13:01 UTC da odgovor sigurno stigne.
-- Sva tri posla se sada pokrecu SVAKI DAN - kickoff_eld_sync() i
-- collect_eld_sync() interno preskacu (no-op) ako je tekuci datum neradni
-- (is_non_working_day), a carry_forward_last_working_day() u 13:05 UTC
-- interno preskace ako je tekuci datum radni. Tako se vikendi i praznici
-- (cak i kad praznik padne pon-pet) tretiraju isto, bez posebnih cron izraza.
-- NAPOMENA: zimi (CET, UTC+1) ovo ce raditi u 14:00 po lokalnom vremenu -
-- treba rucno pomeriti sve na '0 14 * * *' / '1 14 * * *' / '5 14 * * *' /
-- '5 14 * * *' / '6 14 * * *' / '10 14 * * *' / '11 14 * * *' (svih 7
-- poslova ispod, isti pomeraj od 1h) kad predje na zimsko vreme.

-- Retry u 13:05/13:06 i 13:10/13:11 UTC: ako 13:00/13:01 pokusaj nije upisao
-- nijedan red (greska ILI "tihi" neuspeh - 200 OK ali prazan odgovor od
-- ELD worker-a, videti kickoff_eld_sync_retry_if_needed() iznad), pokusa
-- ponovo automatski, bez potrebe da neko otvori sajt i klikne "Sinhronizuj
-- sada". Ako je 13:00 pokusaj vec uspeo, oba retry-ja se ne rade nista
-- (kickoff_eld_sync_retry_if_needed() vraca null, collect_eld_sync() samo
-- ponovo obradi vec obradjen odgovor - bezopasno, upsert je idempotentan).

do $$
begin
  if exists (select 1 from cron.job where jobname = 'eld-sync-kickoff') then
    perform cron.unschedule('eld-sync-kickoff');
  end if;
  if exists (select 1 from cron.job where jobname = 'eld-sync-collect') then
    perform cron.unschedule('eld-sync-collect');
  end if;
  if exists (select 1 from cron.job where jobname = 'eld-sync-weekend-carry') then
    perform cron.unschedule('eld-sync-weekend-carry');
  end if;
  if exists (select 1 from cron.job where jobname = 'eld-sync-retry1-kickoff') then
    perform cron.unschedule('eld-sync-retry1-kickoff');
  end if;
  if exists (select 1 from cron.job where jobname = 'eld-sync-retry1-collect') then
    perform cron.unschedule('eld-sync-retry1-collect');
  end if;
  if exists (select 1 from cron.job where jobname = 'eld-sync-retry2-kickoff') then
    perform cron.unschedule('eld-sync-retry2-kickoff');
  end if;
  if exists (select 1 from cron.job where jobname = 'eld-sync-retry2-collect') then
    perform cron.unschedule('eld-sync-retry2-collect');
  end if;
end $$;

select cron.schedule('eld-sync-kickoff', '0 13 * * *', $$select kickoff_eld_sync();$$);
select cron.schedule('eld-sync-collect', '1 13 * * *', $$select collect_eld_sync();$$);
select cron.schedule('eld-sync-weekend-carry', '5 13 * * *', $$select carry_forward_last_working_day();$$);
select cron.schedule('eld-sync-retry1-kickoff', '5 13 * * *', $$select kickoff_eld_sync_retry_if_needed();$$);
select cron.schedule('eld-sync-retry1-collect', '6 13 * * *', $$select collect_eld_sync();$$);
select cron.schedule('eld-sync-retry2-kickoff', '10 13 * * *', $$select kickoff_eld_sync_retry_if_needed();$$);
select cron.schedule('eld-sync-retry2-collect', '11 13 * * *', $$select collect_eld_sync();$$);
