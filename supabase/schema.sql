-- Ebenezer SHG: run this once in Supabase > SQL Editor.

create table members (
  id          uuid primary key default gen_random_uuid(),
  full_name   text not null check (length(trim(full_name)) > 0),
  email       text not null,
  phone       text not null,
  plan        text not null check (plan in ('Daily Merry-Go-Round', 'Monthly Savings', 'Full Membership')),
  status      text not null default 'pending' check (status in ('pending', 'active')),
  created_at  timestamptz not null default now()
);
create unique index members_email_unique on members (lower(email));

create table savings (
  id          uuid primary key default gen_random_uuid(),
  member_id   uuid not null references members (id) on delete restrict,
  amount      numeric(12, 2) not null check (amount > 0),
  created_at  timestamptz not null default now()
);

create table loans (
  id             uuid primary key default gen_random_uuid(),
  member_id      uuid not null references members (id) on delete restrict,
  principal      numeric(12, 2) not null check (principal > 0),
  months         int not null check (months in (1, 3, 6)),
  total_payable  numeric(12, 2) not null,
  status         text not null default 'pending' check (status in ('pending', 'active', 'repaid', 'rejected')),
  created_at     timestamptz not null default now()
);

create table event_requests (
  id           uuid primary key default gen_random_uuid(),
  member_id    uuid not null references members (id) on delete restrict,
  kind         text not null check (kind in ('wedding', 'medical', 'bereavement')),
  description  text not null,
  status       text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  created_at   timestamptz not null default now()
);

-- Row Level Security: nobody can touch anything unless a policy allows it.
alter table members        enable row level security;
alter table savings        enable row level security;
alter table loans          enable row level security;
alter table event_requests enable row level security;

-- Visitors (not signed in) may only submit a registration, and only as 'pending'.
create policy "public can register" on members
  for insert to anon
  with check (status = 'pending');

-- Signed-in officials can do everything.
create policy "officials manage members"  on members        for all to authenticated using (true) with check (true);
create policy "officials manage savings"  on savings        for all to authenticated using (true) with check (true);
create policy "officials manage loans"    on loans          for all to authenticated using (true) with check (true);
create policy "officials manage events"   on event_requests for all to authenticated using (true) with check (true);
