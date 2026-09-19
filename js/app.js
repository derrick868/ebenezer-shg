import { CONFIG } from './config.js';
import { createDB } from './db.js';

/* ---------- helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const kes = (n) => 'KES ' + Number(n).toLocaleString('en-KE', { maximumFractionDigits: 2 });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (d) => new Date(d).toLocaleDateString('en-KE', { weekday: 'short', day: 'numeric', month: 'short' });
const fmtDay = (d) => new Date(d).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' });

const MGR_PLANS = ['Daily Merry-Go-Round', 'Full Membership'];
const EVENT_LABELS = { wedding: 'Wedding / Celebration', medical: 'Medical Emergency', bereavement: 'Bereavement Support' };
const STATUS_BADGE = { pending: 'badge-pending', active: 'badge-success', approved: 'badge-success', repaid: 'badge-muted', rejected: 'badge-danger', declined: 'badge-danger' };

let db;
const state = { members: [], savings: [], loans: [], events: [] };

let toastTimer;
function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

function errorText(e) {
  if (e?.code === '23505') return 'That email is already registered.';
  if (e?.code === '42501') return 'You do not have permission to do that. Sign in as an official and try again.';
  return e?.message || 'Something went wrong. Try again.';
}

// Runs an async action for a form: disables the submit button and reports errors.
async function guarded(button, action) {
  if (button) button.disabled = true;
  try {
    await action();
  } catch (e) {
    console.error(e);
    toast(errorText(e), true);
  } finally {
    if (button) button.disabled = false;
  }
}

const memberName = (id) => state.members.find((m) => m.id === id)?.full_name ?? 'Unknown member';
const activeMembers = () => state.members.filter((m) => m.status === 'active');
const savingsOf = (id) => state.savings.filter((s) => s.member_id === id).reduce((sum, s) => sum + Number(s.amount), 0);
const hasActiveLoan = (id) => state.loans.some((l) => l.member_id === id && l.status === 'active');

/* ---------- data loading ---------- */
async function refresh() {
  const authed = db.mode === 'demo' || !!(await db.auth.session());
  document.body.classList.toggle('authed', authed);
  $('#signInBtn').hidden = authed;
  $('#signOutBtn').hidden = !authed || db.mode === 'demo';
  if (!authed) return;

  try {
    [state.members, state.savings, state.loans, state.events] = await Promise.all(
      ['members', 'savings', 'loans', 'event_requests'].map((t) => db.list(t))
    );
  } catch (e) {
    console.error(e);
    toast(errorText(e), true);
    return;
  }
  render();
}

function render() {
  renderMemberSelects();
  renderRotation();
  renderSavings();
  renderLoans();
  renderEvents();
  renderReports();
}

/* ---------- rendering ---------- */
function renderMemberSelects() {
  const options = '<option value="">Select member</option>' +
    activeMembers().map((m) => `<option value="${esc(m.id)}">${esc(m.full_name)}</option>`).join('');
  $$('.member-select').forEach((sel) => {
    const current = sel.value;
    sel.innerHTML = options;
    if (current) sel.value = current;
  });
}

function table(headers, rows, emptyText) {
  if (!rows.length) return `<p class="empty">${esc(emptyText)}</p>`;
  return `<table class="report-table"><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

const badge = (status, label) => `<span class="badge ${STATUS_BADGE[status] || 'badge-muted'}">${esc(label ?? status)}</span>`;
const actionBtn = (table, id, status, label, danger = false) =>
  `<button type="button" class="btn-sm${danger ? ' danger' : ''}" data-table="${table}" data-id="${esc(id)}" data-status="${status}">${label}</button>`;

function renderRotation() {
  $('#mgrRate').textContent = `${kes(CONFIG.DAILY_RATE)} / member`;
  const rotation = state.members
    .filter((m) => m.status === 'active' && MGR_PLANS.includes(m.plan))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const n = rotation.length;

  if (!n) {
    $('#mgrToday').textContent = 'No members in the rotation yet';
    $('#mgrTomorrow').textContent = '-';
    $('#mgrRotation').innerHTML = '';
    return;
  }

  const now = new Date();
  const todayUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const dayIndex = Math.floor((todayUtc - Date.parse(CONFIG.MGR_START)) / 864e5);
  const mod = (i) => ((i % n) + n) % n;
  const pool = CONFIG.DAILY_RATE * n;

  $('#mgrToday').textContent = `${rotation[mod(dayIndex)].full_name} (${kes(pool)} pooled)`;
  $('#mgrTomorrow').textContent = rotation[mod(dayIndex + 1)].full_name;

  const rows = rotation
    .map((m, pos) => ({ m, offset: mod(pos - dayIndex) }))
    .sort((a, b) => a.offset - b.offset)
    .map(({ m, offset }) => {
      const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
      return `<tr class="${offset === 0 ? 'is-today' : ''}"><td>${esc(m.full_name)}</td><td>${offset === 0 ? 'Today' : fmtDate(date)}</td><td>${kes(pool)}</td></tr>`;
    });
  $('#mgrRotation').innerHTML = table(['Member', 'Payout day', 'Pool'], rows, '');
}

function renderSavings() {
  const total = state.savings.reduce((sum, s) => sum + Number(s.amount), 0);
  $('#savingsTotal').textContent = kes(total);
  const rows = state.savings.slice(0, 5).map((s) =>
    `<tr><td>${esc(memberName(s.member_id))}</td><td>${kes(s.amount)}</td><td>${fmtDay(s.created_at)}</td></tr>`);
  $('#savingsRecent').innerHTML = table(['Recent deposits', 'Amount', 'Date'], rows, 'No deposits recorded yet.');
}

function renderLoans() {
  const rows = state.loans.map((l) => {
    let actions = '';
    if (l.status === 'pending') actions = actionBtn('loans', l.id, 'active', 'Approve') + actionBtn('loans', l.id, 'rejected', 'Reject', true);
    if (l.status === 'active') actions = actionBtn('loans', l.id, 'repaid', 'Mark repaid');
    return `<tr><td>${esc(memberName(l.member_id))}</td><td>${kes(l.principal)}</td><td>${l.months} mo</td><td>${kes(l.total_payable)}</td><td>${badge(l.status)}</td><td><div class="row-actions">${actions}</div></td></tr>`;
  });
  $('#loansList').innerHTML = table(['Member', 'Amount', 'Term', 'Payable', 'Status', ''], rows, 'No loans recorded yet.');
}

function renderEvents() {
  const rows = state.events.map((ev) => {
    const actions = ev.status === 'pending'
      ? actionBtn('event_requests', ev.id, 'approved', 'Approve') + actionBtn('event_requests', ev.id, 'declined', 'Decline', true)
      : '';
    return `<tr><td>${esc(memberName(ev.member_id))}</td><td>${esc(EVENT_LABELS[ev.kind] || ev.kind)}<br><small>${esc(ev.description)}</small></td><td>${badge(ev.status)}</td><td><div class="row-actions">${actions}</div></td></tr>`;
  });
  $('#eventsList').innerHTML = table(['Member', 'Request', 'Status', ''], rows, 'No support requests yet.');
}

function renderReports() {
  const filter = $('#reportFilter').value;
  const pct = Math.round(CONFIG.LOAN_RATE * 100);
  const members = [...state.members].sort((a, b) => a.full_name.localeCompare(b.full_name));
  const shown = members.filter((m) => {
    if (filter === 'active') return m.status === 'active' && MGR_PLANS.includes(m.plan);
    if (filter === 'loans') return hasActiveLoan(m.id);
    return true;
  });

  $('#reportData').innerHTML = shown.length
    ? shown.map((m) => {
        let status;
        if (m.status === 'pending') status = `${badge('pending', 'Awaiting approval')} ${actionBtn('members', m.id, 'active', 'Approve')}`;
        else if (hasActiveLoan(m.id)) status = badge('pending', `${pct}% Loan Active`);
        else status = badge('active', 'Up to date');
        return `<tr><td>${esc(m.full_name)}<br><small>${esc(m.plan)}</small></td><td>${kes(savingsOf(m.id))}</td><td>${status}</td></tr>`;
      }).join('')
    : '<tr><td colspan="3" class="empty">No members match this filter.</td></tr>';
}

/* ---------- loan maths ---------- */
function loanTerms(amount, months) {
  const interest = amount * CONFIG.LOAN_RATE * months;
  const total = amount + interest;
  return { total, monthly: total / months };
}

function showLoanResult(amount, months) {
  const { total, monthly } = loanTerms(amount, months);
  $('#calcResult').innerHTML = `Total Payable: ${kes(total)}<br><small>(Monthly Repayment: ${kes(monthly)})</small>`;
  return total;
}

/* ---------- events ---------- */
function openService(panelId) {
  $$('.action-panel').forEach((p) => p.classList.remove('active'));
  const panel = document.getElementById(panelId);
  if (!panel) return;
  panel.classList.add('active');
  panel.scrollIntoView({ behavior: 'smooth' });
}

function bindUI() {
  $$('[data-panel]').forEach((btn) => btn.addEventListener('click', () => openService(btn.dataset.panel)));

  $('#navToggle').addEventListener('click', (e) => {
    const open = $('#navLinks').classList.toggle('open');
    e.currentTarget.setAttribute('aria-expanded', String(open));
  });
  $$('#navLinks a').forEach((a) => a.addEventListener('click', () => $('#navLinks').classList.remove('open')));

  // Sign in / out
  const dialog = $('#signInDialog');
  const openSignIn = () => { $('#signInError').textContent = ''; dialog.showModal(); };
  $('#signInBtn').addEventListener('click', openSignIn);
  $$('[data-open-signin]').forEach((b) => b.addEventListener('click', openSignIn));
  $('#signInCancel').addEventListener('click', () => dialog.close());
  $('#signOutBtn').addEventListener('click', async () => { await db.auth.signOut(); await refresh(); toast('Signed out.'); });
  $('#signInForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    guarded($('button[type=submit]', form), async () => {
      try {
        await db.auth.signIn(form.elements.email.value.trim(), form.elements.password.value);
      } catch (err) {
        $('#signInError').textContent = err.message || 'Could not sign in.';
        return;
      }
      form.reset();
      dialog.close();
      await refresh();
      toast('Signed in.');
    });
  });

  // Registration (public)
  $('#regForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    guarded($('button[type=submit]', form), async () => {
      const name = form.elements.full_name.value.trim();
      await db.insert('members', {
        full_name: name,
        email: form.elements.email.value.trim().toLowerCase(),
        phone: form.elements.phone.value.trim(),
        plan: form.elements.plan.value,
      });
      form.reset();
      const box = $('#regAlert');
      box.textContent = `Thank you, ${name}. Your registration was received and is awaiting approval by the group officials.`;
      setTimeout(() => { box.textContent = ''; }, 8000);
      await refresh();
    });
  });

  // Savings
  $('#savingsForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    guarded($('button[type=submit]', form), async () => {
      await db.insert('savings', { member_id: form.elements.member.value, amount: Number(form.elements.amount.value) });
      form.elements.amount.value = '';
      toast('Deposit recorded.');
      await refresh();
    });
  });

  // Loans: calculate (public) and record (officials)
  const loanForm = $('#loanForm');
  const readLoan = () => ({ amount: parseFloat(loanForm.elements.amount.value), months: parseInt(loanForm.elements.months.value, 10) });
  loanForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const { amount, months } = readLoan();
    if (!(amount > 0)) { $('#calcResult').textContent = 'Please enter a valid amount.'; return; }
    showLoanResult(amount, months);
  });
  $('#loanRecordBtn').addEventListener('click', (e) => {
    const { amount, months } = readLoan();
    if (!loanForm.elements.member.value) return toast('Select a member first.', true);
    if (!(amount > 0)) return toast('Enter a valid loan amount.', true);
    guarded(e.currentTarget, async () => {
      const total = showLoanResult(amount, months);
      await db.insert('loans', { member_id: loanForm.elements.member.value, principal: amount, months, total_payable: total });
      loanForm.elements.amount.value = '';
      toast('Loan request recorded as pending.');
      await refresh();
    });
  });

  // Event support
  $('#eventForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    guarded($('button[type=submit]', form), async () => {
      await db.insert('event_requests', {
        member_id: form.elements.member.value,
        kind: form.elements.kind.value,
        description: form.elements.description.value.trim(),
      });
      form.reset();
      toast('Support request submitted.');
      await refresh();
    });
  });

  // Reports filter
  $('#reportFilter').addEventListener('change', renderReports);

  // Status buttons in tables (approve, reject, mark repaid...)
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-table][data-status]');
    if (!btn) return;
    guarded(btn, async () => {
      await db.update(btn.dataset.table, btn.dataset.id, { status: btn.dataset.status });
      toast('Updated.');
      await refresh();
    });
  });
}

/* ---------- start ---------- */
async function init() {
  bindUI();
  try {
    db = await createDB();
  } catch (e) {
    console.error(e);
    toast('Could not connect to the database. Check js/config.js.', true);
    return;
  }
  $('#demoBanner').hidden = db.mode !== 'demo';
  db.auth.onChange(() => refresh());
  await refresh();
}

init();
