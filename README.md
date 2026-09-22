# Ebenezer SHG

Static site (HTML + ES modules, no build step). Runs as-is on Netlify.

## Run it now (demo mode)
Deploy or open with any static server. With `js/config.js` left empty the app stores data
in the browser (localStorage) and behaves as a signed-in official. Good for trying it out;
not shared between devices.

    npx serve .

## Go live with shared data (Supabase)
1. Create a free project at supabase.com.
2. SQL Editor: run `supabase/schema.sql`, then `supabase/migrate-v2.sql` (member logins and roles), then `supabase/migrate-v3.sql` (payment tracking).
3. Authentication > Sign In / Providers > Email: turn **on** "Allow new users to sign up" and turn **off** "Confirm email".
   Anyone can create an account, but an account sees nothing until it is linked to an approved member (see below).
4. Create your own login: Authentication > Users > Add user (tick Auto Confirm). Then edit and run
   `supabase/make-official.sql` in the SQL Editor to make that user the chair. Repeat for the treasurer and secretary.
   Do this straight after step 2, because existing logins lose access until they are made officials.
5. Project Settings > API: copy the Project URL and the `anon` key into `js/config.js`.
6. Redeploy.

## How members get in
1. A visitor fills in the registration form on the site (status: pending).
2. An official approves them under Member Reports.
3. The report now shows a one-time membership code with a **Copy invite** button. Send the message to the member (WhatsApp, SMS).
4. The member opens the site, taps Sign in > Create an account (any email and password), and enters the code.
   Their account is now linked. They see only their own savings, loans and requests, plus the merry-go-round schedule and group total.

Officials see and manage everything. Members can send loan and event-support requests; officials approve them.
Roles (chair, treasurer, secretary) are set in SQL with `make-official.sql`. All three have the same rights for now.

## Payment tracking
- **Daily contributions:** Services > Daily Merry-Go-Round > Daily contributions. Pick a date (default today), tap **Mark paid** or **Undo** per member.
  A member's unpaid days count full days from approval (or `MGR_START`) up to yesterday.
- **Loan repayments:** Services > Low-Interest Loans > **Record payment** on an active loan. Payments cannot exceed the balance,
  a fully paid loan closes itself, and deleting a wrong payment reopens it.
- **Statements:** **Statement** button per member in Member Reports, and **My statement** on the member dashboard. Use Print / Save as PDF.
- Members see their own balances, unpaid days and contribution history.

## Try the member view in demo mode
Open the site with `?as=member` at the end of the address (for example `index.html?as=member`).

## Deploy to Netlify
- Quick: app.netlify.com/drop, drag this folder in.
- Better: push to GitHub, Netlify > Add new site > Import from Git. Leave build command empty, publish directory `.`.
  Every push then redeploys. Rename the site under Site configuration to get `your-name.netlify.app`.

## Installing as an app (PWA)
The app installs on phones and desktops and opens offline. What's included:
- `manifest.webmanifest` and icons in `icons/` (regular and a maskable version for Android's adaptive icon shape).
- `sw.js`, a service worker that caches the app shell (HTML, CSS, JS, icons, fonts) so the app opens without a
  connection. It never caches Supabase data: every save and every load of members, savings, loans, etc. always goes
  to the network, so no financial data is ever left on the device by the service worker.
- Font Awesome and the Supabase client are self-hosted in `vendor/`, not loaded from a CDN, so the app shell has
  no external dependency once installed.
- An **Install app** button appears in the nav on Android and desktop Chrome/Edge when the browser allows it.
  iOS Safari has no install prompt, so a one-time banner tells iPhone users to use Share > Add to Home Screen.
- An offline banner appears when the connection drops; forms still show clear errors if a save can't reach the server.

**After any change to the files listed in `sw.js`'s `SHELL` array, bump `CACHE_VERSION` in `sw.js`.** Otherwise
installed apps keep serving the old files until the cache naturally expires.

**Testing installability:** Chrome DevTools > Application > Manifest, and the Lighthouse PWA audit.
Install prompts and full offline behaviour need a real HTTPS deployment (Netlify) or `localhost`; opening
`index.html` directly from disk will not register the service worker.

## Notes
- Merry-go-round order is by join date. The daily recipient is `(days since MGR_START) mod (members in rotation)`,
  so adding or removing a rotation member changes who is due on later days.
- Loan interest is 10% flat per month of the term (`LOAN_RATE` in `js/config.js`).
