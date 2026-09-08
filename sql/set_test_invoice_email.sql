-- VRH: test faza slanja faktura emailom — dok se testiranje ne završi, sve
-- firme šalju na istu test adresu (umesto na stvarni email firme).
-- Pokreni ovo u Supabase SQL Editor-u. Bezbedno je pokrenuti više puta
-- (samo prepiše email kod SVIH firmi na test adresu).
--
-- Kad se testiranje završi: za svaku firmu ručno upiši pravi email u
-- Podešavanja > Kompanije (kolona "Email"), ili ovde radi grupno preko SQL-a.

update companies set email = 'dackello77@gmail.com';
