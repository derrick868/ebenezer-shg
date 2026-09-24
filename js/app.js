import { CONFIG } from './config.js';
import { createDB } from './db.js';

/* ---------- helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const kes = (n) => 'KES ' + Number(n).toLocaleString('en-KE', { maximumFractionDigits: 2 });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (d) => new Date(d).toLocaleDateString('en-KE', { weekday: 'short', day: 'numeric', month: 'short' });
const fmtDay = (d) => new Date(d).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' });

const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; // local calendar day
const todayStr = () => ymd(new Date());
const dayShift = (str, n) => { const [y, m, d] = str.split('-').map(Number); return ymd(new Date(y, m - 1, d + n)); };
const daysBetween = (a, b) => Math.round((Date.UTC(...b.split('-').map((x, i) => (i === 1 ? x - 1 : +x))) - Date.UTC(...a.split('-').map((x, i) => (i === 1 ? x - 1 : +x)))) / 864e5);
const fmtYmd = (str) => fmtDay(new Date(str + 'T12:00:00'));

const MGR_PLANS = ['Daily Merry-Go-Round', 'Full Membership'];
const OFFICIAL_ROLES = ['chair', 'treasurer', 'secretary'];
const ROLE_LABEL = { chair: 'Chair', treasurer: 'Treasurer', secretary: 'Secretary' };
const EVENT_LABELS = { wedding: 'Wedding / Celebration', medical: 'Medical Emergency', bereavement: 'Bereavement Support' };
const STATUS_BADGE = { pending: 'badge-pending', active: 'badge-success', approved: 'badge-success', repaid: 'badge-muted', rejected: 'badge-danger', declined: 'badge-danger' };

let db;
const state = { profile: null, members: [], savings: [], loans: [], events: [], loanPayments: [], mgrPayments: [], eventContributions: [], notifications: [], openEvents: [], rotation: [], groupTotal: null };
let promptedLink = false;

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
  if (window.navigator.onLine === false || /failed to fetch|networkerror|load failed/i.test(e?.message || '')) {
    return 'No internet connection. Try again when you are back online.';
  }
  if (e?.code === '23505') return /email/i.test(e.message) ? 'That email is already registered.' : 'That entry already exists.';
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
const sumAmounts = (rows) => rows.reduce((t, r) => t + Number(r.amount), 0);
const savingsOf = (id) => sumAmounts(state.savings.filter((s) => s.member_id === id));
const loanPaid = (loanId) => sumAmounts(state.loanPayments.filter((p) => p.loan_id === loanId));
const loanBalance = (l) => Math.max(0, Number(l.total_payable) - loanPaid(l.id));

// Merry-go-round days a member has not paid, counting full days from approval (or MGR_START) up to yesterday.
function arrearsDays(m) {
  if (m.status !== 'active' || !MGR_PLANS.includes(m.plan)) return 0;
  const approved = ymd(new Date(m.approved_at || m.created_at));
  const from = approved > CONFIG.MGR_START ? approved : CONFIG.MGR_START;
  const last = dayShift(todayStr(), -1);
  if (from > last) return 0;
  const paid = new Set(state.mgrPayments.filter((p) => p.member_id === m.id && p.pay_date >= from && p.pay_date <= last).map((p) => p.pay_date));
  return Math.max(0, daysBetween(from, last) + 1 - paid.size);
}
const arrearsText = (m) => { const d = arrearsDays(m); return d ? `${d} day${d > 1 ? 's' : ''} (${kes(d * CONFIG.DAILY_RATE)})` : 'None'; };
const fmtCode = (c) => (c || '').replace(/(.{4})(?=.)/g, '$1-');
const hasActiveLoan = (id) => state.loans.some((l) => l.member_id === id && l.status === 'active');

/* ---------- data loading ---------- */
async function refresh() {
  const session = await db.auth.session();
  const signedIn = !!session;
  $('#signInBtn').hidden = signedIn;
  $('#signOutBtn').hidden = !signedIn || db.mode === 'demo';
  ['official', 'member', 'linking'].forEach((c) => document.body.classList.remove(c));
  $('#linkBanner').hidden = true;
  if (!signedIn) {
    Object.assign(state, { profile: null, members: [], savings: [], loans: [], events: [], loanPayments: [], mgrPayments: [], eventContributions: [], notifications: [], openEvents: [], rotation: [], groupTotal: null });
    renderBell();
    return;
  }

  try {
    state.profile = await db.profile();
    if (!state.profile) {
      // Signed in, but not linked to an approved member record yet.
      document.body.classList.add('linking');
      $('#linkBanner').hidden = false;
      if (!promptedLink) { promptedLink = true; openClaim(); }
      return;
    }

    const official = OFFICIAL_ROLES.includes(state.profile.role) && state.profile.status === 'active';
    document.body.classList.add(official ? 'official' : 'member');
    state.notifications = await db.notificationsFor(state.profile.id);

    if (official) {
      [state.members, state.savings, state.loans, state.events, state.loanPayments, state.mgrPayments, state.eventContributions] = await Promise.all(
        ['members', 'savings', 'loans', 'event_requests', 'loan_payments', 'mgr_payments', 'event_contributions'].map((t) => db.list(t))
      );
    } else {
      // Members only receive their own rows (enforced by the database) plus a few safe summaries.
      [state.savings, state.loans, state.events, state.loanPayments, state.mgrPayments, state.eventContributions, state.rotation, state.groupTotal, state.openEvents] = await Promise.all([
        db.list('savings'), db.list('loans'), db.list('event_requests'), db.list('loan_payments'), db.list('mgr_payments'), db.list('event_contributions'),
        db.rpc('rotation_members'), db.rpc('group_savings_total'), db.rpc('open_event_requests'),
      ]);
      state.members = [state.profile];
    }
  } catch (e) {
    console.error(e);
    toast(errorText(e), true);
    return;
  }
  render();
}

function render() {
  renderBell();
  if (document.body.classList.contains('official')) {
    renderMemberSelects();
    renderRotation();
    renderContributions();
    renderSavings();
    renderLoans();
    renderEvents();
    renderReports();
    renderClaims();
  } else {
    renderMember();
  }
}

/* ---------- rendering ---------- */
function timeAgo(iso) {
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return fmtDay(iso);
}

function renderBell() {
  const n = state.notifications;
  const unread = n.filter((x) => !x.read).length;
  const dot = $('#bellDot');
  dot.hidden = unread === 0;
  dot.textContent = unread > 9 ? '9+' : String(unread);
  $('#bellPanel').innerHTML = n.length
    ? n.map((x) => `<div class="bell-item${x.read ? '' : ' unread'}" data-notif="${esc(x.id)}"><strong>${esc(x.title)}</strong>${esc(x.body)}<time>${timeAgo(x.created_at)}</time></div>`).join('')
    : '<div class="bell-empty">No notifications yet.</div>';
}

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

// Who is paid on which day: members in join order, one per day, starting from MGR_START.
function rotationInfo(list) {
  const rotation = list
    .filter((m) => MGR_PLANS.includes(m.plan))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const n = rotation.length;
  if (!n) return null;

  const now = new Date();
  const todayUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const dayIndex = Math.floor((todayUtc - Date.parse(CONFIG.MGR_START)) / 864e5);
  const mod = (i) => ((i % n) + n) % n;
  const schedule = rotation
    .map((m, pos) => ({ m, offset: mod(pos - dayIndex) }))
    .sort((a, b) => a.offset - b.offset)
    .map(({ m, offset }) => ({ m, offset, date: new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset) }));
  return { n, pool: CONFIG.DAILY_RATE * n, today: rotation[mod(dayIndex)], tomorrow: rotation[mod(dayIndex + 1)], schedule };
}

function scheduleTable(info, myId) {
  const rows = info.schedule.map(({ m, offset, date }) =>
    `<tr class="${offset === 0 ? 'is-today' : ''}"><td>${esc(m.full_name)}${m.id === myId ? ' (you)' : ''}</td><td>${offset === 0 ? 'Today' : fmtDate(date)}</td><td>${kes(info.pool)}</td></tr>`);
  return table(['Member', 'Payout day', 'Pool'], rows, '');
}

function renderRotation() {
  $('#mgrRate').textContent = `${kes(CONFIG.DAILY_RATE)} / member`;
  const info = rotationInfo(state.members.filter((m) => m.status === 'active'));
  if (!info) {
    $('#mgrToday').textContent = 'No members in the rotation yet';
    $('#mgrTomorrow').textContent = '-';
    $('#mgrRotation').innerHTML = '';
    return;
  }
  $('#mgrToday').textContent = `${info.today.full_name} (${kes(info.pool)} pooled)`;
  $('#mgrTomorrow').textContent = info.tomorrow.full_name;
  $('#mgrRotation').innerHTML = scheduleTable(info);
}

function renderContributions() {
  const input = $('#mgrDate');
  if (!input.value) input.value = todayStr();
  input.max = todayStr();
  const date = input.value;
  const members = state.members
    .filter((m) => m.status === 'active' && MGR_PLANS.includes(m.plan))
    .sort((a, b) => a.full_name.localeCompare(b.full_name));
  const paid = new Map(state.mgrPayments.filter((p) => p.pay_date === date).map((p) => [p.member_id, p]));

  $('#mgrCollected').textContent = `${kes(paid.size * CONFIG.DAILY_RATE)} of ${kes(members.length * CONFIG.DAILY_RATE)}`;
  const rows = members.map((m) => {
    const payment = paid.get(m.id);
    const action = payment
      ? `<button type="button" class="btn-sm danger" data-mgr-undo="${esc(payment.id)}">Undo</button>`
      : `<button type="button" class="btn-sm" data-mgr-pay="${esc(m.id)}">Mark paid</button>`;
    const owes = arrearsDays(m);
    return `<tr><td>${esc(m.full_name)}${owes ? `<br><small class="owing">Owes ${arrearsText(m)}</small>` : ''}</td><td>${payment ? badge('active', 'Paid') : badge('pending', 'Not paid')}</td><td>${action}</td></tr>`;
  });
  $('#mgrContrib').innerHTML = table(['Member', 'Status', ''], rows, 'No members in the rotation yet.');
}

function renderMember() {
  const p = state.profile;
  $('#myName').textContent = p.full_name;
  $('#mySavings').textContent = kes(sumAmounts(state.savings));
  $('#myGroupTotal').textContent = state.groupTotal == null ? '-' : kes(state.groupTotal);

  const inRotation = MGR_PLANS.includes(p.plan);
  $('#myMgrBox').hidden = !inRotation;
  $('#myMgrCard').hidden = !inRotation;
  if (inRotation) {
    const info = rotationInfo(state.rotation);
    if (info) {
      const mine = info.schedule.find((x) => x.m.id === p.id);
      $('#myPayout').textContent = mine ? (mine.offset === 0 ? 'Today' : fmtDate(mine.date)) : '-';
      $('#myMgrToday').textContent = info.today.full_name;
      $('#myMgrTable').innerHTML = scheduleTable(info, p.id);
    } else {
      $('#myPayout').textContent = '-';
      $('#myMgrToday').textContent = 'No members in the rotation yet';
      $('#myMgrTable').innerHTML = '';
    }
  }

  if (inRotation) {
    $('#myArrears').textContent = arrearsText(p);
    $('#myArrears').classList.toggle('owing', arrearsDays(p) > 0);
    $('#myPayments').innerHTML = table(['Date', 'Amount', 'Status'],
      [...state.mgrPayments].sort((a, b) => b.pay_date.localeCompare(a.pay_date)).slice(0, 7)
        .map((x) => `<tr><td>${fmtYmd(x.pay_date)}</td><td>${kes(x.amount)}</td><td>${x.status === 'pending' ? badge('pending', 'Awaiting confirmation') : badge('active', 'Confirmed')}</td></tr>`), 'No contributions recorded yet.');
  }

  $('#myDeposits').innerHTML = table(['Amount', 'Date'],
    state.savings.map((s) => `<tr><td>${kes(s.amount)}</td><td>${fmtDay(s.created_at)}</td></tr>`), 'No deposits recorded yet.');
  $('#myLoans').innerHTML = table(['Amount', 'Payable', 'Balance', 'Status', ''],
    state.loans.map((l) => {
      const pending = state.loanPayments.some((p) => p.loan_id === l.id && p.status === 'pending');
      const action = l.status === 'active'
        ? (pending ? '<span class="claim-type">Payment pending</span>' : `<button type="button" class="btn-sm" data-repay-loan="${esc(l.id)}">Repay</button>`)
        : '';
      return `<tr><td>${kes(l.principal)}<br><small>${l.months} mo</small></td><td>${kes(l.total_payable)}</td><td>${l.status === 'active' ? kes(loanBalance(l)) : '-'}</td><td>${badge(l.status)}</td><td>${action}</td></tr>`;
    }), 'No loans yet.');
  $('#myEvents').innerHTML = table(['Request', 'Status'],
    state.events.map((ev) => `<tr><td>${esc(EVENT_LABELS[ev.kind] || ev.kind)}<br><small>${esc(ev.description)}</small></td><td>${badge(ev.status)}</td></tr>`), 'No support requests yet.');

  const mine = new Set(state.events.map((ev) => ev.id));
  $('#openEvents').innerHTML = table(['Member', 'Request', 'Raised', ''], state.openEvents.map((ev) => {
    const pending = state.eventContributions.some((c) => c.event_id === ev.id && c.status === 'pending');
    const action = mine.has(ev.id) ? '<small>Your request</small>'
      : pending ? '<span class="claim-type">Sent, awaiting confirmation</span>'
      : `<button type="button" class="btn-sm" data-support="${esc(ev.id)}">Contribute</button>`;
    return `<tr><td>${esc(ev.requester_name)}</td><td>${esc(EVENT_LABELS[ev.kind] || ev.kind)}<br><small>${esc(ev.description)}</small></td><td>${kes(ev.raised)}</td><td>${action}</td></tr>`;
  }), 'No open support requests right now.');
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
    if (l.status === 'active') actions = `<button type="button" class="btn-sm" data-pay-loan="${esc(l.id)}">Record payment</button>`;
    const balance = l.status === 'active' ? kes(loanBalance(l)) : l.status === 'repaid' ? kes(0) : '-';
    return `<tr><td>${esc(memberName(l.member_id))}</td><td>${kes(l.principal)}<br><small>${l.months} mo</small></td><td>${kes(l.total_payable)}</td><td>${balance}</td><td>${badge(l.status)}</td><td><div class="row-actions">${actions}</div></td></tr>`;
  });
  $('#loansList').innerHTML = table(['Member', 'Amount', 'Payable', 'Balance', 'Status', ''], rows, 'No loans recorded yet.');
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

function renderClaims() {
  const rows = [];
  state.mgrPayments.filter((p) => p.status === 'pending').forEach((p) => rows.push({
    when: p.created_at, cells: `<td><span class="claim-type">Merry-go-round</span><br>${esc(memberName(p.member_id))}</td><td>${kes(p.amount)}<br><small>${fmtYmd(p.pay_date)}</small></td><td>${esc(p.mpesa_code || '-')}</td>`,
    table: 'mgr_payments', id: p.id,
  }));
  state.loanPayments.filter((p) => p.status === 'pending').forEach((p) => rows.push({
    when: p.created_at, cells: `<td><span class="claim-type">Loan repayment</span><br>${esc(memberName(p.member_id))}</td><td>${kes(p.amount)}<br><small>${fmtDay(p.paid_on)}</small></td><td>${esc(p.mpesa_code || '-')}</td>`,
    table: 'loan_payments', id: p.id,
  }));
  state.eventContributions.filter((c) => c.status === 'pending').forEach((c) => rows.push({
    when: c.created_at, cells: `<td><span class="claim-type">Event support</span><br>${esc(memberName(c.member_id))}</td><td>${kes(c.amount)}</td><td>${esc(c.mpesa_code || '-')}</td>`,
    table: 'event_contributions', id: c.id,
  }));
  rows.sort((a, b) => a.when.localeCompare(b.when));
  const body = rows.map((r) =>
    `<tr>${r.cells}<td><div class="row-actions">${actionBtn(r.table, r.id, 'confirmed', 'Confirm receipt')}<button type="button" class="btn-sm danger" data-reject="${r.table}" data-id="${esc(r.id)}">Reject</button></div></td></tr>`);
  $('#claimsList').innerHTML = table(['Claim', 'Amount', 'M-Pesa code', ''], body, 'No pending claims.');
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
        const role = ROLE_LABEL[m.role] ? `<span class="role-tag">${ROLE_LABEL[m.role]}</span>` : '';
        let account = '';
        if (m.status === 'active' && m.user_id) account = '<br><small>Account linked</small>';
        else if (m.status === 'active' && m.claim_code) {
          account = `<br><small>Code <code>${esc(fmtCode(m.claim_code))}</code></small> <button type="button" class="btn-sm" data-copy-invite data-id="${esc(m.id)}">Copy invite</button>`;
        }
        const owes = arrearsDays(m);
        const owing = owes ? `<br><small class="owing">Owes ${arrearsText(m)}</small>` : '';
        const statement = m.status === 'active' ? `<br><button type="button" class="btn-sm" data-statement="${esc(m.id)}">Statement</button>` : '';
        return `<tr><td>${esc(m.full_name)}${role}<br><small>${esc(m.plan)}</small></td><td>${kes(savingsOf(m.id))}</td><td>${status}${owing}${account}${statement}</td></tr>`;
      }).join('')
    : '<tr><td colspan="3" class="empty">No members match this filter.</td></tr>';
}

/* ---------- statements ---------- */
function statementHtml(m) {
  const mine = (rows) => rows.filter((r) => r.member_id === m.id);
  const savings = mine(state.savings);
  const loans = mine(state.loans);
  const loanPays = mine(state.loanPayments);
  const contributions = mine(state.mgrPayments).sort((a, b) => b.pay_date.localeCompare(a.pay_date));
  const owing = loans.filter((l) => l.status === 'active').reduce((t, l) => t + loanBalance(l), 0);
  const inRotation = MGR_PLANS.includes(m.plan);
  const loanOf = (id) => loans.find((l) => l.id === id);

  return `<div class="statement">
    <h2 id="statementTitle">Ebenezer Self Help Group</h2>
    <div class="meta">Member statement for <strong>${esc(m.full_name)}</strong> (${esc(m.plan)}) &middot; ${esc(m.email)}<br>Generated ${fmtDay(new Date())}</div>
    <div class="summary">
      <div>Total savings<strong>${kes(sumAmounts(savings))}</strong></div>
      <div>Loan balance owed<strong>${kes(owing)}</strong></div>
      ${inRotation ? `<div>Contributions paid<strong>${contributions.length} day${contributions.length === 1 ? '' : 's'}</strong></div><div>Unpaid days<strong>${arrearsText(m)}</strong></div>` : ''}
    </div>
    <h4>Savings deposits</h4>
    ${table(['Date', 'Amount'], savings.map((s) => `<tr><td>${fmtDay(s.created_at)}</td><td>${kes(s.amount)}</td></tr>`), 'No deposits.')}
    <h4>Loans</h4>
    ${table(['Date', 'Amount', 'Term', 'Payable', 'Balance', 'Status'], loans.map((l) =>
      `<tr><td>${fmtDay(l.created_at)}</td><td>${kes(l.principal)}</td><td>${l.months} mo</td><td>${kes(l.total_payable)}</td><td>${l.status === 'active' ? kes(loanBalance(l)) : '-'}</td><td>${esc(l.status)}</td></tr>`), 'No loans.')}
    <h4>Loan repayments</h4>
    ${table(['Date', 'Loan', 'Amount'], [...loanPays].sort((a, b) => b.paid_on.localeCompare(a.paid_on)).map((p) =>
      `<tr><td>${fmtYmd(p.paid_on)}</td><td>${loanOf(p.loan_id) ? kes(loanOf(p.loan_id).principal) : '-'}</td><td>${kes(p.amount)}</td></tr>`), 'No repayments.')}
    ${inRotation ? `<h4>Merry-go-round contributions</h4>${table(['Date', 'Amount'], contributions.map((x) => `<tr><td>${fmtYmd(x.pay_date)}</td><td>${kes(x.amount)}</td></tr>`), 'No contributions.')}` : ''}
  </div>`;
}

function openStatement(m) {
  $('#statementBody').innerHTML = statementHtml(m);
  $('#statementDialog').showModal();
}

/* ---------- loan maths ---------- */
function loanTerms(amount, months) {
  const interest = amount * CONFIG.LOAN_RATE * months;
  const total = amount + interest;
  return { total, monthly: total / months };
}

function showLoanResult(amount, months, target = '#calcResult') {
  const { total, monthly } = loanTerms(amount, months);
  $(target).innerHTML = `Total Payable: ${kes(total)}<br><small>(Monthly Repayment: ${kes(monthly)})</small>`;
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

  // Sign in / create account
  const dialog = $('#signInDialog');
  let authMode = 'signin';
  const setAuthMode = (mode) => {
    authMode = mode;
    const signup = mode === 'signup';
    $('#signInTitle').textContent = signup ? 'Create your account' : 'Sign in';
    $('#authSubmit').textContent = signup ? 'Create account' : 'Sign in';
    $('#authToggle').textContent = signup ? 'Already have an account? Sign in' : 'New member? Create an account';
    $('#authHelp').hidden = !signup;
    const pw = $('#signInForm').elements.password;
    pw.autocomplete = signup ? 'new-password' : 'current-password';
    pw.minLength = signup ? 8 : 0;
    $('#signInError').textContent = '';
  };
  const openSignIn = () => { setAuthMode('signin'); dialog.showModal(); };
  $('#signInBtn').addEventListener('click', openSignIn);
  $$('[data-open-signin]').forEach((b) => b.addEventListener('click', openSignIn));
  $('#authToggle').addEventListener('click', () => setAuthMode(authMode === 'signin' ? 'signup' : 'signin'));
  $('#signInCancel').addEventListener('click', () => dialog.close());
  $('#signOutBtn').addEventListener('click', async () => { await db.auth.signOut(); promptedLink = false; await refresh(); toast('Signed out.'); });
  $('#signInForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    guarded($('button[type=submit]', form), async () => {
      try {
        const email = form.elements.email.value.trim();
        const password = form.elements.password.value;
        if (authMode === 'signup') {
          const signedIn = await db.auth.signUp(email, password);
          if (!signedIn) {
            $('#signInError').textContent = 'Account created. Confirm your email, then sign in.';
            return;
          }
        } else {
          await db.auth.signIn(email, password);
        }
      } catch (err) {
        $('#signInError').textContent = err.message || 'Could not sign in.';
        return;
      }
      form.reset();
      dialog.close();
      await refresh();
    });
  });

  // Link account to membership
  $('#openClaim').addEventListener('click', openClaim);
  $('#claimCancel').addEventListener('click', () => $('#claimDialog').close());
  $('#claimForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    guarded($('button[type=submit]', form), async () => {
      try {
        await db.rpc('claim_member', { code: form.elements.code.value });
      } catch (err) {
        $('#claimError').textContent = err.message || 'Could not link the account.';
        return;
      }
      form.reset();
      $('#claimDialog').close();
      await refresh();
      toast('Account linked. Welcome!');
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

  // Member self-service: loan and event support requests
  const myLoanForm = $('#myLoanForm');
  const readMyLoan = () => ({ amount: parseFloat(myLoanForm.elements.amount.value), months: parseInt(myLoanForm.elements.months.value, 10) });
  myLoanForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const { amount, months } = readMyLoan();
    if (!(amount > 0)) { $('#myCalcResult').textContent = 'Please enter a valid amount.'; return; }
    showLoanResult(amount, months, '#myCalcResult');
  });
  $('#myLoanSend').addEventListener('click', (e) => {
    const { amount, months } = readMyLoan();
    if (!(amount > 0)) return toast('Enter a valid loan amount.', true);
    guarded(e.currentTarget, async () => {
      const total = showLoanResult(amount, months, '#myCalcResult');
      await db.insert('loans', { member_id: state.profile.id, principal: amount, months, total_payable: total });
      myLoanForm.elements.amount.value = '';
      toast('Loan request sent. An official will review it.');
      await refresh();
    });
  });
  $('#myEventForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    guarded($('button[type=submit]', form), async () => {
      await db.insert('event_requests', {
        member_id: state.profile.id,
        kind: form.elements.kind.value,
        description: form.elements.description.value.trim(),
      });
      form.reset();
      toast('Support request sent.');
      await refresh();
    });
  });

  // Officials: copy a ready-to-send invite message for an approved member
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-copy-invite]');
    if (!btn) return;
    const m = state.members.find((x) => x.id === btn.dataset.id);
    if (!m) return;
    const text = `Hi ${m.full_name}, you're approved at Ebenezer SHG. Your membership code is ${fmtCode(m.claim_code)}. ` +
      `Open ${location.origin}, tap Sign in, then "Create an account" using ${m.email}, and enter the code when asked.`;
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => toast('Invite message copied.'), () => window.prompt('Copy this message:', text));
    else window.prompt('Copy this message:', text);
  });

  // Notifications bell
  $('#bellBtn').addEventListener('click', (e) => {
    const open = $('#bellPanel').hidden;
    $('#bellPanel').hidden = !open;
    e.currentTarget.setAttribute('aria-expanded', String(open));
    if (open && state.notifications.some((n) => !n.read)) {
      guarded(null, async () => {
        await Promise.all(state.notifications.filter((n) => !n.read).map((n) => db.update('notifications', n.id, { read: true })));
        state.notifications.forEach((n) => { n.read = true; });
        renderBell();
      });
    }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#bellBtn') && !e.target.closest('#bellPanel')) { $('#bellPanel').hidden = true; $('#bellBtn').setAttribute('aria-expanded', 'false'); }
  });

  // Member: send today's merry-go-round contribution
  $('#mySendForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    guarded($('button[type=submit]', form), async () => {
      await db.insert('mgr_payments', { member_id: state.profile.id, pay_date: todayStr(), amount: CONFIG.DAILY_RATE, mpesa_code: form.elements.mpesa_code.value.trim() || null });
      form.reset();
      toast('Sent. An official will confirm once it shows on the statement.');
      await refresh();
    });
  });

  // Member: repay a loan
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-repay-loan]');
    if (!btn) return;
    const loan = state.loans.find((l) => l.id === btn.dataset.repayLoan);
    if (!loan) return;
    const amount = window.prompt(`Amount paid towards this loan (balance ${kes(loanBalance(loan))}):`);
    if (amount === null) return;
    const code = window.prompt('M-Pesa code (optional):') || null;
    guarded(btn, async () => {
      await db.insert('loan_payments', { loan_id: loan.id, amount: Number(amount), paid_on: todayStr(), mpesa_code: code });
      toast('Sent. An official will confirm once it shows on the statement.');
      await refresh();
    });
  });

  // Member: contribute to another member's approved event request
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-support]');
    if (!btn) return;
    const amount = window.prompt('Amount to contribute (KES):');
    if (amount === null) return;
    const code = window.prompt('M-Pesa code (optional):') || null;
    guarded(btn, async () => {
      await db.insert('event_contributions', { event_id: btn.dataset.support, member_id: state.profile.id, amount: Number(amount), mpesa_code: code });
      toast('Sent. An official will confirm once it shows on the statement.');
      await refresh();
    });
  });

  // Officials: confirm or reject a pending claim
  document.addEventListener('click', (e) => {
    const reject = e.target.closest('button[data-reject]');
    if (!reject) return;
    guarded(reject, async () => {
      await db.remove(reject.dataset.reject, reject.dataset.id);
      toast('Claim rejected.');
      await refresh();
    });
  });

  // Merry-go-round contributions (officials)
  $('#mgrDate').addEventListener('change', renderContributions);
  document.addEventListener('click', (e) => {
    const pay = e.target.closest('button[data-mgr-pay]');
    const undo = e.target.closest('button[data-mgr-undo]');
    if (pay) {
      guarded(pay, async () => {
        await db.insert('mgr_payments', { member_id: pay.dataset.mgrPay, pay_date: $('#mgrDate').value, amount: CONFIG.DAILY_RATE });
        await refresh();
      });
    } else if (undo) {
      guarded(undo, async () => { await db.remove('mgr_payments', undo.dataset.mgrUndo); await refresh(); });
    }
  });

  // Loan repayments (officials)
  const payDialog = $('#paymentDialog');
  let payLoan = null;
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-pay-loan]');
    if (!btn) return;
    payLoan = state.loans.find((l) => l.id === btn.dataset.payLoan);
    if (!payLoan) return;
    const form = $('#paymentForm');
    $('#paymentInfo').textContent = `${memberName(payLoan.member_id)}: balance ${kes(loanBalance(payLoan))}`;
    form.elements.amount.max = loanBalance(payLoan);
    form.elements.amount.value = '';
    form.elements.paid_on.value = todayStr();
    form.elements.paid_on.max = todayStr();
    payDialog.showModal();
  });
  $('#paymentCancel').addEventListener('click', () => payDialog.close());
  $('#paymentForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    guarded($('button[type=submit]', form), async () => {
      await db.insert('loan_payments', {
        loan_id: payLoan.id,
        member_id: payLoan.member_id,
        amount: Number(form.elements.amount.value),
        paid_on: form.elements.paid_on.value,
      });
      payDialog.close();
      toast('Payment recorded.');
      await refresh();
    });
  });

  // Statements
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-statement]');
    if (!btn) return;
    const m = state.members.find((x) => x.id === btn.dataset.statement);
    if (m) openStatement(m);
  });
  $('#myStatementBtn').addEventListener('click', () => openStatement(state.profile));
  $('#statementClose').addEventListener('click', () => $('#statementDialog').close());
  $('#statementPrint').addEventListener('click', () => window.print());

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

/* ---------- PWA: service worker, install button, offline banner ---------- */
function setupPWA() {
  if ('serviceWorker' in window.navigator && location.protocol !== 'file:') {
    window.navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker not registered', err));
  }

  let installEvent = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installEvent = e;
    $('#installBtn').hidden = false;
  });
  window.addEventListener('appinstalled', () => { $('#installBtn').hidden = true; });
  $('#installBtn').addEventListener('click', async () => {
    if (!installEvent) return;
    installEvent.prompt();
    await installEvent.userChoice;
    installEvent = null;
    $('#installBtn').hidden = true;
  });

  // iOS has no install prompt: show a one-time hint in Safari.
  const isIos = /iphone|ipad|ipod/i.test(window.navigator.userAgent || '');
  const installed = window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone;
  let seen = false;
  try { seen = !!localStorage.getItem('shg-ios-hint'); } catch { /* storage blocked */ }
  $('#iosHint').hidden = !(isIos && !installed && !seen);
  $('#iosHintClose').addEventListener('click', () => {
    $('#iosHint').hidden = true;
    try { localStorage.setItem('shg-ios-hint', '1'); } catch { /* storage blocked */ }
  });

  const syncOnline = () => { $('#offlineBanner').hidden = window.navigator.onLine !== false; };
  window.addEventListener('online', () => { syncOnline(); refresh(); });
  window.addEventListener('offline', syncOnline);
  syncOnline();
}

function openClaim() {
  $('#claimError').textContent = '';
  $('#claimDialog').showModal();
}

/* ---------- start ---------- */
async function init() {
  bindUI();
  setupPWA();
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
