// Ebenezer SHG settings.
// Leave the Supabase values empty to run in demo mode (data stays in this browser).
// Paste your project values to switch on the shared database.
export const CONFIG = {
  SUPABASE_URL: 'https://dowdlofsaxdwmuclvqsg.supabase.co',       // e.g. https://abcdxyz.supabase.co
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRvd2Rsb2ZzYXhkd211Y2x2cXNnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk4Mjk3NDksImV4cCI6MjEwNTQwNTc0OX0.nuSC58pNBi-WC9BCvTMBs5SreJYHnjT3dc-tdKei1X0',  // Project Settings > API > anon public key (safe to expose; protected by the RLS policies)

  DAILY_RATE: 100,        // KES per member per day, Merry-Go-Round
  LOAN_RATE: 0.10,        // 10% flat, charged per month of the term
  MGR_START: '2026-01-01' // Day 1 of the rotation (YYYY-MM-DD)
};
