# Ebenezer SHG

Static site (HTML + ES modules, no build step). Runs as-is on Netlify.

## Run it now (demo mode)
Deploy or open with any static server. With `js/config.js` left empty the app stores data
in the browser (localStorage) and behaves as a signed-in official. Good for trying it out;
not shared between devices.

    npx serve .

## Go live with shared data (Supabase)
1. Create a free project at supabase.com.
2. SQL Editor > paste `supabase/schema.sql` > Run.
3. Authentication > Providers > Email: turn **off** "Allow new users to sign up".
   Then Authentication > Users > Add user, for each official (chair, treasurer, secretary).
   Anyone who can sign in can read and edit all records, so keep this list to officials only.
4. Project Settings > API: copy the Project URL and the `anon` key into `js/config.js`.
5. Redeploy.

## Deploy to Netlify
- Quick: app.netlify.com/drop, drag this folder in.
- Better: push to GitHub, Netlify > Add new site > Import from Git. Leave build command empty, publish directory `.`.
  Every push then redeploys. Rename the site under Site configuration to get `your-name.netlify.app`.

## Converting to a PWA later
The app is already HTTPS-ready, responsive and uses relative paths. To finish:
1. Add `manifest.webmanifest` (name, `start_url: "/"`, `display: "standalone"`, 192px and 512px icons) and link it in `<head>`.
2. Add `sw.js` that caches `index.html`, `css/`, `js/` and the Font Awesome files, and register it from `app.js`.
3. Self-host Font Awesome and the Supabase client (or bundle them with Vite) so the app shell works offline.

## Notes
- Merry-go-round order is by join date. The daily recipient is `(days since MGR_START) mod (members in rotation)`,
  so adding or removing a rotation member changes who is due on later days.
- Loan interest is 10% flat per month of the term (`LOAN_RATE` in `js/config.js`).
