// Ebenezer SHG settings.
// Leave the Supabase values empty to run in demo mode (data stays in this browser).
// Paste your project values to switch on the shared database.
export const CONFIG = {
  SUPABASE_URL: '',       // e.g. https://abcdxyz.supabase.co
  SUPABASE_ANON_KEY: '',  // Project Settings > API > anon public key (safe to expose; protected by the RLS policies)

  DAILY_RATE: 100,        // KES per member per day, Merry-Go-Round
  LOAN_RATE: 0.10,        // 10% flat, charged per month of the term
  MGR_START: '2026-01-01' // Day 1 of the rotation (YYYY-MM-DD)
};
