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

-- ---------- raspored: 15:00 Europe/Belgrade (leti = 13:00 UTC) ----------
-- kickoff u 13:00 UTC, collect minut kasnije u 13:01 UTC da odgovor sigurno stigne.
-- NAPOMENA: zimi (CET, UTC+1) ovo ce raditi u 14:00 po lokalnom vremenu -
-- treba rucno pomeriti oba na '0 14 * * *' / '1 14 * * *' kad predje na zimsko vreme.

do $$
begin
  if exists (select 1 from cron.job where jobname = 'eld-sync-kickoff') then
    perform cron.unschedule('eld-sync-kickoff');
  end if;
  if exists (select 1 from cron.job where jobname = 'eld-sync-collect') then
    perform cron.unschedule('eld-sync-collect');
  end if;
end $$;

select cron.schedule('eld-sync-kickoff', '0 13 * * *', $$select kickoff_eld_sync();$$);
select cron.schedule('eld-sync-collect', '1 13 * * *', $$select collect_eld_sync();$$);
