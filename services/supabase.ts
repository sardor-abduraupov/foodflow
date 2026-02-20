import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Supabase is used ONLY for image storage. The anon key is safe in the frontend;
// service role and Gemini keys must remain server-side (Cloudflare Worker).
let cachedClient: SupabaseClient | null = null;

export const getSupabaseClient = (): SupabaseClient | null => {
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

  if (!url || !anonKey) return null;

  if (!cachedClient) {
    cachedClient = createClient(url, anonKey, {
      auth: { persistSession: false },
    });
  }

  return cachedClient;
};
