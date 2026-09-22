-- Ebenezer SHG v3: payment tracking (loan repayments + daily merry-go-round contributions).
-- Run once, AFTER migrate-v2.sql and BEFORE deploying the v3 site files.

-- 1. When a member was approved (merry-go-round arrears count from this day) --------------------
alter table members add column approved_at timestamptz;
-- Existing members: tracking starts today. Backfill earlier days from the Contributions panel if needed.
update members set approved_at = now() where status = 'active';

create function public.set_approved_at() returns trigger language plpgsql as $$
begin
  if new.status = 'active' and old.status is distinct from 'active' then new.approved_at := now(); end if;
  return new;
end $$;
create trigger members_approved_at before update on members
  for each row execute function set_approved_at();

-- 2. Loan repayments -----------------------------------------------------------------------------
create table loan_payments (
  id          uuid primary key default gen_random_uuid(),
  loan_id     uuid not null references loans (id) on delete restrict,
  member_id   uuid not null references members (id) on delete restrict,
  amount      numeric(12, 2) not null check (amount > 0),
  paid_on     date not null default current_date,
  created_at  timestamptz not null default now()
);
create index loan_payments_loan_idx on loan_payments (loan_id);

-- Validates a payment (active loan, not more than the balance) and copies the loan's member.
create function public.check_loan_payment() returns trigger
language plpgsql security definer set search_path = public as $$
declare l loans; paid numeric;
begin
  select * into l from loans where id = new.loan_id for update;
  if not found then raise exception 'Loan not found'; end if;
  if l.status <> 'active' then raise exception 'Only active loans can receive payments'; end if;
  select coalesce(sum(amount), 0) into paid from loan_payments where loan_id = new.loan_id;
  if paid + new.amount > l.total_payable then
    raise exception 'Payment is more than the balance (KES %)', l.total_payable - paid;
  end if;
  new.member_id := l.member_id;
  return new;
end $$;
create trigger loan_payments_check before insert on loan_payments
  for each row execute function check_loan_payment();

-- A loan closes itself when fully paid, and reopens if a payment is deleted by mistake.
create function public.close_paid_loan() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update loans set status = 'repaid'
   where id = new.loan_id and status = 'active'
     and (select sum(amount) from loan_payments where loan_id = new.loan_id) >= total_payable;
  return null;
end $$;
create trigger loan_payments_close after insert on loan_payments
  for each row execute function close_paid_loan();

create function public.reopen_loan() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update loans set status = 'active'
   where id = old.loan_id and status = 'repaid'
     and coalesce((select sum(amount) from loan_payments where loan_id = old.loan_id), 0) < total_payable;
  return null;
end $$;
create trigger loan_payments_reopen after delete on loan_payments
  for each row execute function reopen_loan();

-- 3. Daily merry-go-round contributions (one row per member per day) -----------------------------
create table mgr_payments (
  id          uuid primary key default gen_random_uuid(),
  member_id   uuid not null references members (id) on delete restrict,
  pay_date    date not null,
  amount      numeric(12, 2) not null default 100 check (amount > 0),
  created_at  timestamptz not null default now(),
  unique (member_id, pay_date)
);

-- 4. Row Level Security: members read their own; only officials record or correct -----------------
alter table loan_payments enable row level security;
alter table mgr_payments  enable row level security;
revoke all on loan_payments, mgr_payments from anon;

create policy "loan payments read"   on loan_payments for select to authenticated using (is_official() or member_id = my_member_id());
create policy "loan payments insert" on loan_payments for insert to authenticated with check (is_official());
create policy "loan payments delete" on loan_payments for delete to authenticated using (is_official());

create policy "mgr payments read"   on mgr_payments for select to authenticated using (is_official() or member_id = my_member_id());
create policy "mgr payments insert" on mgr_payments for insert to authenticated with check (is_official());
create policy "mgr payments delete" on mgr_payments for delete to authenticated using (is_official());
