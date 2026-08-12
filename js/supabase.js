import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const SUPABASE_URL = "https://dzhqzsofbhljkbnfyzfg.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_UrrQXdLtHE9b76JWrmQu6w_riigOk40";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
