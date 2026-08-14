import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const SUPABASE_URL = "https://dzhqzsofbhljkbnfyzfg.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_UrrQXdLtHE9b76JWrmQu6w_riigOk40";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Poseban klijent sa izolovanom (neupisanom) sesijom — koristi se ISKLJUČIVO
// da admin napravi nov korisnički nalog (auth.signUp) iz Settings > Korisnici
// bez da to zameni trenutnu (admin) sesiju u glavnom `supabase` klijentu.
export const supabaseAdminCreate = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, storageKey: "vrh-admin-create" },
});
