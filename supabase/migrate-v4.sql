-- Ebenezer SHG v4: member-submitted payment claims (M-Pesa code + amount),
-- officials "Confirm receipt", event-support contributions, and in-app notifications.
-- Run once, AFTER migrate-v3.sql.

-- 1. Claims: pending until an official confirms -------------------------------------------------
alter table loan_payments add column status text not null default 'confirmed' check (status in ('pending', 'confirmed'));
alter table mgr_payments  add column status text not null default 'confirmed' check (status in ('pending', 'confirmed'));
alter table loan_payments add column mpesa_code text;
alter table mgr_payments  add column mpesa_code text;

-- Only count confirmed money towards a loan's balance and auto-close.
create or replace function public.check_loan_payment() returns trigger
language plpgsql security definer set search_path = public as $$
declare l loans; paid numeric;
begin
  select * into l from loans where id = new.loan_id for update;
  if not found then raise exception 'Loan not found'; end if;
  if l.status <> 'active' then raise exception 'Only active loans can receive payments'; end if;
  select coalesce(sum(amount), 0) into paid from loan_payments where loan_id = new.loan_id and status = 'confirmed';
  if new.status = 'confirmed' and paid + new.amount > l.total_payable then
    raise exception 'Payment is more than the balance (KES %)', l.total_payable - paid;
  end if;
  new.member_id := l.member_id;
  return new;
end $$;

create or replace function public.close_paid_loan() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update loans set status = 'repaid'
   where id = new.loan_id and status = 'active'
     and (select coalesce(sum(amount), 0) from loan_payments where loan_id = new.loan_id and status = 'confirmed') >= total_payable;
  return null;
end $$;
drop trigger if exists loan_payments_close on loan_payments;
create trigger loan_payments_close after insert or update of status on loan_payments
  for each row when (new.status = 'confirmed') execute function close_paid_loan();

create or replace function public.reopen_loan() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update loans set status = 'active'
   where id = old.loan_id and status = 'repaid'
     and coalesce((select sum(amount) from loan_payments where loan_id = old.loan_id and status = 'confirmed'), 0) < total_payable;
  return null;
end $$;

-- A member can claim a day only once; an official can still confirm one claim per day per member.
-- (the existing unique (member_id, pay_date) on mgr_payments already covers this)

-- 2. Event support: other members contribute towards an approved request -------------------------
create table event_contributions (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references event_requests (id) on delete restrict,
  member_id   uuid not null references members (id) on delete restrict,  -- the contributor
  amount      numeric(12, 2) not null check (amount > 0),
  mpesa_code  text,
  status      text not null default 'pending' check (status in ('pending', 'confirmed')),
  created_at  timestamptz not null default now()
);

-- Approved requests any signed-in member can see and contribute to (no other member's private info exposed).
create function public.open_event_requests()
returns table (id uuid, requester_name text, kind text, description text, created_at timestamptz, raised numeric)
language sql stable security definer set search_path = public as $$
  select r.id, m.full_name, r.kind, r.description, r.created_at,
         coalesce((select sum(c.amount) from event_contributions c where c.event_id = r.id and c.status = 'confirmed'), 0)
  from event_requests r join members m on m.id = r.member_id
  where r.status = 'approved' and (is_official() or my_member_id() is not null)
  order by r.created_at desc;
$$;
revoke all on function open_event_requests() from public, anon;
grant execute on function open_event_requests() to authenticated;

-- 3. Notifications ---------------------------------------------------------------------------------
create table notifications (
  id          uuid primary key default gen_random_uuid(),
  member_id   uuid not null references members (id) on delete cascade,
  title       text not null,
  body        text not null,
  read        boolean not null default false,
  created_at  timestamptz not null default now()
);
create index notifications_member_idx on notifications (member_id, created_at desc);

create function public.notify(mid uuid, t text, b text) returns void
language sql security definer set search_path = public as $$
  insert into notifications (member_id, title, body) values (mid, t, b);
$$;

create function public.notify_member_status() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'active' and old.status is distinct from 'active' then
    perform notify(new.id, 'Registration approved', 'You''re approved at Ebenezer SHG. Sign in and enter your membership code to link your account.');
  end if;
  return null;
end $$;
create trigger members_notify after update of status on members
  for each row execute function notify_member_status();

create function public.notify_loan_status() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = old.status then return null; end if;
  if new.status = 'active' then perform notify(new.member_id, 'Loan approved', format('Your loan of KES %s was approved.', new.principal));
  elsif new.status = 'rejected' then perform notify(new.member_id, 'Loan declined', format('Your loan request of KES %s was declined.', new.principal));
  elsif new.status = 'repaid' then perform notify(new.member_id, 'Loan fully repaid', 'Your loan has been fully repaid. Thank you!');
  end if;
  return null;
end $$;
create trigger loans_notify after update of status on loans
  for each row execute function notify_loan_status();

create function public.notify_event_status() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = old.status then return null; end if;
  if new.status = 'approved' then perform notify(new.member_id, 'Support request approved', 'Your event support request was approved. Other members can now contribute.');
  elsif new.status = 'declined' then perform notify(new.member_id, 'Support request declined', 'Your event support request was declined.');
  end if;
  return null;
end $$;
create trigger events_notify after update of status on event_requests
  for each row execute function notify_event_status();

create function public.notify_loan_payment() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'confirmed' and (tg_op = 'INSERT' or old.status <> 'confirmed') then
    perform notify(new.member_id, 'Loan repayment confirmed', format('Your repayment of KES %s was confirmed.', new.amount));
  end if;
  return null;
end $$;
create trigger loan_payments_notify after insert or update of status on loan_payments
  for each row execute function notify_loan_payment();

create function public.notify_mgr_payment() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'confirmed' and (tg_op = 'INSERT' or old.status <> 'confirmed') then
    perform notify(new.member_id, 'Contribution confirmed', format('Your merry-go-round contribution of KES %s for %s was confirmed.', new.amount, new.pay_date));
  end if;
  return null;
end $$;
create trigger mgr_payments_notify after insert or update of status on mgr_payments
  for each row execute function notify_mgr_payment();

create function public.notify_event_contribution() returns trigger
language plpgsql security definer set search_path = public as $$
declare recipient uuid;
begin
  if new.status = 'confirmed' and (tg_op = 'INSERT' or old.status <> 'confirmed') then
    perform notify(new.member_id, 'Contribution confirmed', format('Your contribution of KES %s was confirmed. Thank you!', new.amount));
    select member_id into recipient from event_requests where id = new.event_id;
    if recipient is not null then
      perform notify(recipient, 'You received support', format('Someone contributed KES %s towards your event support request.', new.amount));
    end if;
  end if;
  return null;
end $$;
create trigger event_contrib_notify after insert or update of status on event_contributions
  for each row execute function notify_event_contribution();

-- 4. Row Level Security -----------------------------------------------------------------------------
alter table event_contributions enable row level security;
alter table notifications       enable row level security;
revoke all on event_contributions, notifications from anon;

-- members insert their own pending claims; officials can insert already-confirmed direct entries
drop policy if exists "loan payments insert" on loan_payments;
create policy "loan payments insert" on loan_payments for insert to authenticated
  with check (is_official() or (member_id = my_member_id() and status = 'pending'));
create policy "loan payments confirm" on loan_payments for update to authenticated using (is_official()) with check (is_official());

drop policy if exists "mgr payments insert" on mgr_payments;
create policy "mgr payments insert" on mgr_payments for insert to authenticated
  with check (is_official() or (member_id = my_member_id() and status = 'pending'));
create policy "mgr payments confirm" on mgr_payments for update to authenticated using (is_official()) with check (is_official());

create policy "event contributions read"   on event_contributions for select to authenticated using (is_official() or member_id = my_member_id());
create policy "event contributions insert" on event_contributions for insert to authenticated
  with check (is_official() or (member_id = my_member_id() and status = 'pending'));
create policy "event contributions confirm" on event_contributions for update to authenticated using (is_official()) with check (is_official());
create policy "event contributions delete"  on event_contributions for delete to authenticated using (is_official());

create policy "notifications read" on notifications for select to authenticated using (member_id = my_member_id());
create policy "notifications mark read" on notifications for update to authenticated
  using (member_id = my_member_id()) with check (member_id = my_member_id());
