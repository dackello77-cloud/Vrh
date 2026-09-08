-- VRH: fakture napravljene pre nego što je opis prebačen na engleski
-- (commit "PDF faktura: ... sve na engleskom") imaju stari srpski tekst
-- trajno upisan u invoices.description — ovo ga prevodi na već poslate/
-- postojeće redove. Nove fakture od sad idu direktno na engleskom.
-- Pokreni u Supabase SQL Editor-u. Bezbedno je pokrenuti više puta.

update invoices
set description = replace(
  description,
  'Mesečna pretplata, srazmerno preostalim danima',
  'Monthly subscription, prorated for remaining days'
)
where description like '%Mesečna pretplata, srazmerno preostalim danima%';
