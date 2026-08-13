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
  window_start date := current_date - 2;
begin
  if is_non_working_day(current_date) then
    return jsonb_build_object('skipped', true, 'reason', 'neradni dan');
  end if;

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
      eld_count := d.eld_count;
      -- eld_count = 0 znaci da izvor jos nije azurirao taj dan (placeholder).
      -- Preskacemo da ne bismo obrisali stvarne podatke nulom.
      if eld_count is null or eld_count = 0 then
        continue;
      end if;

      prev_date := (d.date_key::date - interval '1 day')::date::text;
      prev_count := (company_rec.dates -> prev_date ->> 'eld_count')::int;
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

  return jsonb_build_object(
    'companies_synced', synced_companies,
    'rows_written', synced_rows,
    'ran_at', now()
  );
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

-- ---------- raspored: 15:00 Europe/Belgrade (leti = 13:00 UTC) ----------
-- kickoff u 13:00 UTC, collect minut kasnije u 13:01 UTC da odgovor sigurno stigne.
-- Sva tri posla se sada pokrecu SVAKI DAN - kickoff_eld_sync() i
-- collect_eld_sync() interno preskacu (no-op) ako je tekuci datum neradni
-- (is_non_working_day), a carry_forward_last_working_day() u 13:05 UTC
-- interno preskace ako je tekuci datum radni. Tako se vikendi i praznici
-- (cak i kad praznik padne pon-pet) tretiraju isto, bez posebnih cron izraza.
-- NAPOMENA: zimi (CET, UTC+1) ovo ce raditi u 14:00 po lokalnom vremenu -
-- treba rucno pomeriti sve na '0 14 * * *' / '1 14 * * *' / '5 14 * * *'
-- kad predje na zimsko vreme.

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
end $$;

select cron.schedule('eld-sync-kickoff', '0 13 * * *', $$select kickoff_eld_sync();$$);
select cron.schedule('eld-sync-collect', '1 13 * * *', $$select collect_eld_sync();$$);
select cron.schedule('eld-sync-weekend-carry', '5 13 * * *', $$select carry_forward_last_working_day();$$);
