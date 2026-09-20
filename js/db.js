import { CONFIG } from './config.js';

// Both adapters expose the same small interface, so app.js never knows which one it has:
//   mode
//   auth.{session, signIn, signUp, signOut, onChange}
//   profile()            the signed-in person's member row, or null if not linked yet
//   list(table)          rows the current person is allowed to see
//   insert(table,row), update(table,id,patch)
//   rpc(name,args)       server-side functions (claim_member, rotation_members, group_savings_total)
// Tables: members, savings, loans, event_requests

const MGR_PLANS = ['Daily Merry-Go-Round', 'Full Membership'];

/* ---------- Demo mode: localStorage ---------- */
function localAdapter() {
  const KEY = 'ebenezer-shg:v1';
  // Open the demo as a plain member with  ?as=member  to try the member dashboard.
  const asMember = new URLSearchParams(location.search).get('as') === 'member';

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
  const me = () => load().members.find((m) => m.full_name === 'Jane Doe');
  const denied = () => { throw new Error('Not allowed for members'); };
  const defaults = { members: { status: 'pending' }, loans: { status: 'pending' }, event_requests: { status: 'pending' } };

  return {
    mode: 'demo',
    auth: {
      async session() { return { demo: true }; },
      async signIn() {},
      async signUp() { return true; },
      async signOut() {},
      onChange() {},
    },
    async profile() {
      return asMember ? me() : { id: 'demo', full_name: 'Demo Official', role: 'chair', status: 'active' };
    },
    async list(table) {
      let rows = [...load()[table]];
      if (asMember) rows = rows.filter((r) => (table === 'members' ? r.id === me().id : r.member_id === me().id));
      return rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
    },
    async insert(table, row) {
      if (asMember && table !== 'members' && row.member_id !== me().id) denied();
      const data = load();
      data[table].push({ id: crypto.randomUUID(), created_at: new Date().toISOString(), ...(defaults[table] || {}), ...row });
      save(data);
    },
    async update(table, id, patch) {
      if (asMember) denied();
      const data = load();
      const record = data[table].find((r) => r.id === id);
      if (record) Object.assign(record, patch);
      save(data);
    },
    async rpc(name) {
      const data = load();
      if (name === 'rotation_members') {
        return data.members
          .filter((m) => m.status === 'active' && MGR_PLANS.includes(m.plan))
          .map(({ id, full_name, plan, created_at }) => ({ id, full_name, plan, created_at }));
      }
      if (name === 'group_savings_total') return data.savings.reduce((t, s) => t + Number(s.amount), 0);
      throw new Error('Not available in demo mode');
    },
  };
}

function seed() {
  const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString();
  const member = (name, plan, ago, code) => ({
    id: crypto.randomUUID(),
    full_name: name,
    email: name.toLowerCase().replace(/\s+/g, '.') + '@example.com',
    phone: '0700 000 000',
    plan,
    status: 'active',
    role: 'member',
    user_id: null,
    claim_code: code,
    created_at: daysAgo(ago),
  });
  const deposit = (m, amount, ago) => ({ id: crypto.randomUUID(), member_id: m.id, amount, created_at: daysAgo(ago) });

  const jane = member('Jane Doe', 'Full Membership', 90, 'DEMO00000001');
  const john = member('John Smith', 'Daily Merry-Go-Round', 80, 'DEMO00000002');
  const mary = member('Mary Wanjiku', 'Full Membership', 70, 'DEMO00000003');

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
      // Resolves true when the new account is signed in straight away (email confirmation switched off).
      async signUp(email, password) { return !!check(await sb.auth.signUp({ email, password })).session; },
      async signOut() { await sb.auth.signOut(); },
      // Supabase holds an internal lock while this callback runs, so calling any
      // supabase method inside it deadlocks. Defer to the next tick instead.
      onChange(cb) {
        sb.auth.onAuthStateChange((event, session) => {
          if (event === 'INITIAL_SESSION') return; // init() already refreshes
          setTimeout(() => cb(session), 0);
        });
      },
    },
    async profile() {
      const session = check(await sb.auth.getSession()).session;
      if (!session) return null;
      return check(await sb.from('members').select('*').eq('user_id', session.user.id).maybeSingle());
    },
    async list(table) { return check(await sb.from(table).select('*').order('created_at', { ascending: false })); },
    async insert(table, row) { check(await sb.from(table).insert(row)); },
    async update(table, id, patch) { check(await sb.from(table).update(patch).eq('id', id)); },
    async rpc(name, args) { return check(await sb.rpc(name, args)); },
  };
}

export async function createDB() {
  return CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY ? supabaseAdapter() : localAdapter();
}
