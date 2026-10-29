-- VRH keys.html: podela Šifrarnika i Informacija po firmama (Absolute, RST,
-- M&M Tracking, VRH). Svaka stavka dobija kolonu "firma"; keys.html gore
-- prikazuje red sa firmama i filtrira obe stranice po izabranoj firmi.
-- Postojeće stavke ostaju bez firme (null) i vide se pod "Nerazvrstano" dok
-- im se firma ne dodeli kroz Izmeni. Idempotentno je.

alter table sifrarnik add column if not exists firma text;
alter table informacije add column if not exists firma text;
