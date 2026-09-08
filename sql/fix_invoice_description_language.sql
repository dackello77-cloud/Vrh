-- VRH: fakture napravljene pre nego što je tekst opisa usklađen sa stvarnom
-- fakturom (screen/Invoice_5252_from_VRH_Tracking_Technologies_LLC.pdf) imaju
-- stari tekst (srpski, ili raniju englesku verziju) trajno upisan u
-- invoices.description — ovo ga ponovo generiše iz invoice_date + tipa
-- paketa firme, isto kao što nove fakture rade od sad.
-- Pokreni u Supabase SQL Editor-u. Bezbedno je pokrenuti više puta.

update invoices i
set description = (
  select
    (case when c.entry_column = 'basic' then 'VRH BASIC PACKAGE' else 'VRH ADVANCED PACKAGE' end)
    || ' — Basic subscription with level 2 Technical Support prorated ('
    || to_char(i.invoice_date, 'MM-DD') || ')'
  from companies c
  where c.id = i.company_id
)
where i.description like '%Mesečna pretplata%'
   or i.description like '%Monthly subscription, prorated for remaining days%';
