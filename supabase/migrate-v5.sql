-- Ebenezer SHG v5: notify officials when something needs their attention
-- (new registration, loan request, event request, or payment claim), and
-- a proper unread count for the bell (previous versions only showed a dot).
-- Run once, AFTER migrate-v4.sql.

create function public.notify_officials(t text, b text) returns void
language sql security definer set search_path = public as $$
  insert into notifications (member_id, title, body)
  select id, t, b from members where status = 'active' and role in ('chair', 'treasurer', 'secretary');
$$;

create function public.notify_new_registration() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform notify_officials('New registration', format('%s registered and is awaiting approval.', new.full_name));
  return null;
end $$;
create trigger members_notify_officials after insert on members
  for each row execute function notify_new_registration();

create function public.notify_new_loan() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'pending' then
    perform notify_officials('New loan request', format('%s requested a loan of KES %s.', (select full_name from members where id = new.member_id), new.principal));
  end if;
  return null;
end $$;
create trigger loans_notify_officials after insert on loans
  for each row execute function notify_new_loan();

create function public.notify_new_event() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform notify_officials('New support request', format('%s requested event support.', (select full_name from members where id = new.member_id)));
  return null;
end $$;
create trigger events_notify_officials after insert on event_requests
  for each row execute function notify_new_event();

create function public.notify_new_claim() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'pending' then
    perform notify_officials('Payment claim submitted', format('%s submitted a payment of KES %s to confirm.', (select full_name from members where id = new.member_id), new.amount));
  end if;
  return null;
end $$;
create trigger mgr_payments_notify_officials after insert on mgr_payments
  for each row execute function notify_new_claim();
create trigger loan_payments_notify_officials after insert on loan_payments
  for each row execute function notify_new_claim();
create trigger event_contrib_notify_officials after insert on event_contributions
  for each row execute function notify_new_claim();
