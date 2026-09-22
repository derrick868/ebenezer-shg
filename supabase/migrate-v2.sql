-- Ebenezer SHG v2: member logins + roles.
-- Run AFTER schema.sql (fresh install) or on top of an existing v1 database. Run once.

-- 1. Roles, account link, and one-time membership (claim) codes -------------
alter table members
  add column role text not null default 'member'
    check (role in ('member', 'chair', 'treasurer', 'secretary')),
  add column user_id uuid unique references auth.users (id) on delete set null,
  add column claim_code text unique
    default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));

-- 2. Helper functions -------------------------------------------------------
create function public.is_official() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from members
    where user_id = auth.uid() and status = 'active'
      and role in ('chair', 'treasurer', 'secretary')
  );
$$;

create function public.my_member_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from members where user_id = auth.uid() and status = 'active';
$$;

-- A signed-in person links their account to an approved member record with the code an official gave them.
create function public.claim_member(code text) returns uuid
language plpgsql security definer set search_path = public as $$
declare mid uuid;
begin
  if auth.uid() is null then raise exception 'Please sign in first'; end if;
  if exists (select 1 from members where user_id = auth.uid()) then
    raise exception 'This account is already linked to a member';
  end if;
  update members
     set user_id = auth.uid(), claim_code = null
   where claim_code = upper(regexp_replace(coalesce(code, ''), '[^A-Za-z0-9]', '', 'g'))
     and status = 'active' and user_id is null
  returning id into mid;
  if mid is null then raise exception 'That code is invalid or was already used'; end if;
  return mid;
end $$;

-- Members can see who is in the merry-go-round and the group total, nothing else about other members.
create function public.rotation_members()
returns table (id uuid, full_name text, plan text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select m.id, m.full_name, m.plan, m.created_at
  from members m
  where m.status = 'active'
    and m.plan in ('Daily Merry-Go-Round', 'Full Membership')
    and (is_official() or my_member_id() is not null)
  order by m.created_at;
$$;

create function public.group_savings_total() returns numeric
language sql stable security definer set search_path = public as $$
  select case when is_official() or my_member_id() is not null
              then coalesce((select sum(amount) from savings), 0) end;
$$;

revoke all on function is_official(), my_member_id(), claim_member(text),
                       rotation_members(), group_savings_total() from public, anon;
grant execute on function is_official(), my_member_id(), claim_member(text),
                          rotation_members(), group_savings_total() to authenticated;

-- 3. The database, not the browser, computes loan totals (keep 0.10 in sync with LOAN_RATE in js/config.js)
create function public.set_loan_total() returns trigger language plpgsql as $$
begin
  new.total_payable := new.principal + new.principal * 0.10 * new.months;
  return new;
end $$;
create trigger loans_total before insert on loans
  for each row execute function set_loan_total();

-- 4. Column privileges: clients can never set role, status, user_id or claim_code on insert,
--    and officials can only change a member's status from the app (roles are changed in SQL).
revoke insert, update on members from anon, authenticated;
grant insert (full_name, email, phone, plan) on members to anon, authenticated;
grant update (status) on members to authenticated;

-- 5. Row Level Security: replace the v1 "any signed-in user can do everything" policies
drop policy if exists "public can register"        on members;
drop policy if exists "officials manage members"   on members;
drop policy if exists "officials manage savings"   on savings;
drop policy if exists "officials manage loans"     on loans;
drop policy if exists "officials manage events"    on event_requests;

-- members
create policy "anyone can register"     on members for insert to anon, authenticated with check (status = 'pending');
create policy "officials read members"  on members for select to authenticated using (is_official());
create policy "read own member row"     on members for select to authenticated using (user_id = auth.uid());
create policy "officials update members" on members for update to authenticated using (is_official()) with check (is_official());

-- savings: members read their own; only officials record deposits
create policy "savings read"   on savings for select to authenticated using (is_official() or member_id = my_member_id());
create policy "savings insert" on savings for insert to authenticated with check (is_official());
create policy "savings update" on savings for update to authenticated using (is_official()) with check (is_official());

-- loans: members read and request their own (pending only); officials decide
create policy "loans read"   on loans for select to authenticated using (is_official() or member_id = my_member_id());
create policy "loans insert" on loans for insert to authenticated
  with check (is_official() or (member_id = my_member_id() and status = 'pending'));
create policy "loans update" on loans for update to authenticated using (is_official()) with check (is_official());

-- event support requests: same pattern
create policy "events read"   on event_requests for select to authenticated using (is_official() or member_id = my_member_id());
create policy "events insert" on event_requests for insert to authenticated
  with check (is_official() or (member_id = my_member_id() and status = 'pending'));
create policy "events update" on event_requests for update to authenticated using (is_official()) with check (is_official());
