-- VRH: Šifrarnik grupe — zabrani brisanje grupe koja je još u upotrebi
--
-- Ranije (sql/sifrarnik_grupe.sql) je FK bio "on delete set null" — brisanje
-- grupe je bilo dozvoljeno i kad je grupa dodeljena šiframa, samo bi im se
-- grupa tiho izbrisala. Sad je obrnuto: baza ODBIJA brisanje grupe dok god
-- je bar jedna šifra još uvek koristi (dodatna zaštita — glavna provera je
-- na frontend-u u js/app.js, sa jasnom porukom pre nego što se uopšte
-- pokuša brisanje).
--
-- Pokreni ovo JEDNOM u Supabase SQL Editor-u, POSLE sql/sifrarnik_grupe.sql.

alter table sifrarnik drop constraint if exists sifrarnik_grupa_id_fkey;
alter table sifrarnik
  add constraint sifrarnik_grupa_id_fkey
  foreign key (grupa_id) references sifrarnik_grupe(id);
