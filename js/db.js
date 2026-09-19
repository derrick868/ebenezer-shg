import { CONFIG } from './config.js';

// Both adapters expose the same small interface, so app.js never knows which one it has:
//   mode, auth.{session,signIn,signOut,onChange}, list(table), insert(table,row), update(table,id,patch)
// Tables: members, savings, loans, event_requests

/* ---------- Demo mode: localStorage ---------- */
function localAdapter() {
  const KEY = 'ebenezer-shg:v1';
  const save = (d) => localStorage.setItem(KEY, JSON.stringify(d));
  const load = () => {
    try {
      const d = JSON.parse(localStorage.getItem(KEY));
      if (d && d.members) return d;
    } catch { /* fall through to seed */ }
    const seeded = seed();
    save(seeded);
    return seeded;
  };
  const defaults = { members: { status: 'pending' }, loans: { status: 'pending' }, event_requests: { status: 'pending' } };

  return {
    mode: 'demo',
    auth: {
      async session() { return { demo: true }; },
      async signIn() {},
      async signOut() {},
      onChange() {},
    },
    async list(table) {
      return [...load()[table]].sort((a, b) => b.created_at.localeCompare(a.created_at));
    },
    async insert(table, row) {
      const data = load();
      data[table].push({ id: crypto.randomUUID(), created_at: new Date().toISOString(), ...(defaults[table] || {}), ...row });
      save(data);
    },
    async update(table, id, patch) {
      const data = load();
      const record = data[table].find((r) => r.id === id);
      if (record) Object.assign(record, patch);
      save(data);
    },
  };
}

function seed() {
  const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString();
  const member = (name, plan, ago) => ({
    id: crypto.randomUUID(),
    full_name: name,
    email: name.toLowerCase().replace(/\s+/g, '.') + '@example.com',
    phone: '0700 000 000',
    plan,
    status: 'active',
    created_at: daysAgo(ago),
  });
  const deposit = (m, amount, ago) => ({ id: crypto.randomUUID(), member_id: m.id, amount, created_at: daysAgo(ago) });

  const jane = member('Jane Doe', 'Full Membership', 90);
  const john = member('John Smith', 'Daily Merry-Go-Round', 80);
  const mary = member('Mary Wanjiku', 'Full Membership', 70);

  return {
    members: [jane, john, mary],
    savings: [deposit(jane, 45000, 10), deposit(john, 12500, 9), deposit(mary, 28000, 8)],
    loans: [{ id: crypto.randomUUID(), member_id: john.id, principal: 10000, months: 3, total_payable: 13000, status: 'active', created_at: daysAgo(5) }],
    event_requests: [],
  };
}

/* ---------- Live mode: Supabase ---------- */
async function supabaseAdapter() {
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm');
  const sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
  const check = ({ error, data }) => {
    if (error) throw error;
    return data;
  };

  return {
    mode: 'supabase',
    auth: {
      async session() { return check(await sb.auth.getSession()).session; },
      async signIn(email, password) { check(await sb.auth.signInWithPassword({ email, password })); },
      async signOut() { await sb.auth.signOut(); },
      onChange(cb) { sb.auth.onAuthStateChange((_event, session) => cb(session)); },
    },
    async list(table) { return check(await sb.from(table).select('*').order('created_at', { ascending: false })); },
    async insert(table, row) { check(await sb.from(table).insert(row)); },
    async update(table, id, patch) { check(await sb.from(table).update(patch).eq('id', id)); },
  };
}

export async function createDB() {
  return CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY ? supabaseAdapter() : localAdapter();
}
