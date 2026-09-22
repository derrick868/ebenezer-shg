import { CONFIG } from './config.js';

// Both adapters expose the same small interface, so app.js never knows which one it has:
//   mode
//   auth.{session, signIn, signUp, signOut, onChange}
//   profile()            the signed-in person's member row, or null if not linked yet
//   list(table)          rows the current person is allowed to see
//   insert(table,row), update(table,id,patch)
//   rpc(name,args)       server-side functions (claim_member, rotation_members, group_savings_total)
// Tables: members, savings, loans, event_requests, loan_payments, mgr_payments

const MGR_PLANS = ['Daily Merry-Go-Round', 'Full Membership'];
const TABLES = ['members', 'savings', 'loans', 'event_requests', 'loan_payments', 'mgr_payments'];

/* ---------- Demo mode: localStorage ---------- */
function localAdapter() {
  const KEY = 'ebenezer-shg:v1';
  // Open the demo as a plain member with  ?as=member  to try the member dashboard.
  const asMember = new URLSearchParams(location.search).get('as') === 'member';

  const save = (d) => localStorage.setItem(KEY, JSON.stringify(d));
  const load = () => {
    try {
      const d = JSON.parse(localStorage.getItem(KEY));
      if (d && d.members) {
        TABLES.forEach((t) => { d[t] ??= []; }); // data saved by an older version of the demo
        return d;
      }
    } catch { /* fall through to seed */ }
    const seeded = seed();
    save(seeded);
    return seeded;
  };
  const me = () => load().members.find((m) => m.full_name === 'Jane Doe');
  const denied = () => { throw new Error('Not allowed for members'); };
  const MEMBER_TABLES = ['loans', 'event_requests'];
  const paidOn = (data, loanId) => data.loan_payments.filter((p) => p.loan_id === loanId).reduce((t, p) => t + Number(p.amount), 0);
  // Mirrors the database triggers: a loan closes when fully paid and reopens if a payment is removed.
  const syncLoan = (data, loanId) => {
    const loan = data.loans.find((l) => l.id === loanId);
    if (!loan) return;
    const paid = paidOn(data, loanId);
    if (loan.status === 'active' && paid >= Number(loan.total_payable)) loan.status = 'repaid';
    else if (loan.status === 'repaid' && paid < Number(loan.total_payable)) loan.status = 'active';
  };
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
      if (asMember && table !== 'members' && !(MEMBER_TABLES.includes(table) && row.member_id === me().id)) denied();
      const data = load();
      if (table === 'loan_payments') {
        const loan = data.loans.find((l) => l.id === row.loan_id);
        if (!loan) throw new Error('Loan not found');
        if (loan.status !== 'active') throw new Error('Only active loans can receive payments');
        const balance = Number(loan.total_payable) - paidOn(data, loan.id);
        if (row.amount > balance) throw new Error(`Payment is more than the balance (KES ${balance})`);
        row = { ...row, member_id: loan.member_id };
      }
      if (table === 'mgr_payments' && data.mgr_payments.some((p) => p.member_id === row.member_id && p.pay_date === row.pay_date)) {
        throw new Error('That entry already exists.');
      }
      data[table].push({ id: crypto.randomUUID(), created_at: new Date().toISOString(), ...(defaults[table] || {}), ...row });
      if (table === 'loan_payments') syncLoan(data, row.loan_id);
      save(data);
    },
    async update(table, id, patch) {
      if (asMember) denied();
      const data = load();
      const record = data[table].find((r) => r.id === id);
      if (record) {
        if (table === 'members' && patch.status === 'active' && !record.approved_at) record.approved_at = new Date().toISOString();
        Object.assign(record, patch);
      }
      save(data);
    },
    async remove(table, id) {
      if (asMember) denied();
      const data = load();
      const record = data[table].find((r) => r.id === id);
      data[table] = data[table].filter((r) => r.id !== id);
      if (table === 'loan_payments' && record) syncLoan(data, record.loan_id);
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
    approved_at: daysAgo(3),
    created_at: daysAgo(ago),
  });
  const deposit = (m, amount, ago) => ({ id: crypto.randomUUID(), member_id: m.id, amount, created_at: daysAgo(ago) });

  const jane = member('Jane Doe', 'Full Membership', 90, 'DEMO00000001');
  const john = member('John Smith', 'Daily Merry-Go-Round', 80, 'DEMO00000002');
  const mary = member('Mary Wanjiku', 'Full Membership', 70, 'DEMO00000003');

  const dateStr = (n) => {
    const d = new Date(Date.now() - n * 864e5);
    return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
  };
  const contribution = (m, ago) => ({ id: crypto.randomUUID(), member_id: m.id, pay_date: dateStr(ago), amount: 100, created_at: daysAgo(ago) });
  const loan = { id: crypto.randomUUID(), member_id: john.id, principal: 10000, months: 3, total_payable: 13000, status: 'active', created_at: daysAgo(5) };

  return {
    members: [jane, john, mary],
    savings: [deposit(jane, 45000, 10), deposit(john, 12500, 9), deposit(mary, 28000, 8)],
    loans: [loan],
    event_requests: [],
    loan_payments: [{ id: crypto.randomUUID(), loan_id: loan.id, member_id: john.id, amount: 4000, paid_on: dateStr(2), created_at: daysAgo(2) }],
    // Yesterday and the day before: Jane and John paid; Mary missed the day before.
    mgr_payments: [contribution(jane, 1), contribution(john, 1), contribution(mary, 1), contribution(jane, 2), contribution(john, 2)],
  };
}

/* ---------- Live mode: Supabase ---------- */
// The Supabase client is self-hosted (vendor/supabase.js, v2.45.4) so the app shell works offline.
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(el);
  });
}

async function supabaseAdapter() {
  await loadScript('vendor/supabase.js');
  const { createClient } = window.supabase;
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
    async remove(table, id) { check(await sb.from(table).delete().eq('id', id)); },
    async rpc(name, args) { return check(await sb.rpc(name, args)); },
  };
}

export async function createDB() {
  return CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY ? supabaseAdapter() : localAdapter();
}
