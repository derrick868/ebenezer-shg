-- Make an existing Supabase user an official (chair / treasurer / secretary).
-- 1. Create the user first: Authentication > Users > Add user (or have them create an account on the site).
-- 2. Edit the three values below, then run. Repeat for each official.
do $$
declare
  the_email text := 'CHANGE-ME@example.com';
  the_name  text := 'Your Name';
  the_role  text := 'chair';          -- chair | treasurer | secretary
  uid uuid;
begin
  select id into uid from auth.users where lower(email) = lower(the_email);
  if uid is null then raise exception 'No Supabase user with that email. Create the user first.'; end if;

  insert into members (full_name, email, phone, plan, status)
  values (the_name, the_email, '', 'Full Membership', 'active')
  on conflict ((lower(email))) do nothing;

  update members
     set role = the_role, status = 'active', user_id = uid, claim_code = null
   where lower(email) = lower(the_email);
end $$;
