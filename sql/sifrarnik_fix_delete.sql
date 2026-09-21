-- VRH: Šifrarnik — ispravka brisanja (FK greška blokira svako brisanje)
--
-- Bag: brisanje BILO KOJE šifre je uvek padalo sa greškom (npr. "insert or
-- update on table sifrarnik_audit_log violates foreign key constraint").
-- Uzrok: AFTER DELETE trigger (sifrarnik_log_write, iz sql/sifrarnik.sql)
-- pokušava da upiše red u audit log sa sifrarnik_id koji u ISTOJ transakciji
-- upravo prestaje da postoji (red je već fizički obrisan pre nego što ovaj
-- trigger upiše log) — strana referenca (foreign key) ka sifrarnik(id) zato
-- uvek puca, i to obara CELO brisanje (trigger je u istoj transakciji).
--
-- Audit log po svojoj svrsi treba da može da pamti i redove koji više ne
-- postoje (to mu je i poenta — trag da je nešto obrisano) — zato ovde
-- sifrarnik_id ostaje običan uuid, bez čvrste FK reference ka sifrarnik.
-- Pokreni ovo JEDNOM u Supabase SQL Editor-u.

alter table sifrarnik_audit_log drop constraint if exists sifrarnik_audit_log_sifrarnik_id_fkey;
