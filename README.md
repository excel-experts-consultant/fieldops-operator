# FieldOps Operator

A second, separate app for operators, on its own Google and Cloudflare accounts.

- **Operators** (Android app): file **डीज़ल भरना** entries, and see live **FL Rep** readings — with the
  sheet's colours — for only the sites the superadmin gave them.
- **Superadmin** (web console): create operator logins (one at a time or hundreds at once),
  allocate sites by employee or by site, and watch every entry reach the sheet.

## What gets written where

Both operator forms write to the **`TNK FD` tab**, at the first empty row after the last value
in column A. Each writes only its own columns:

| Column | **डीज़ल भरना** | **सर्विस** |
|---|---|---|
| A | Date and time, e.g. `09 OCT 26 19:02:00` | Date and time |
| B | साइट का नाम | साइट का नाम |
| D | डीज़ल भरवाया | — |
| F | जनरेटर की रीडिंग | — |
| G | डीज़ल% (0–100) | — |
| J | — | सर्विस के बाद जनरेटर की रीडिंग |
| K | Employee name | Employee name |
| L | `RKP-45BT2` | — (no code on a service entry) |

No other column is touched, so your formulas are safe.

**`FL Rep` tab → मेरी साइट्स screen** (read only). A row is a site when column A holds a number
(SI No.) and column B a name. A row with only a name in B is a section heading (e.g. *Diesel Route*).
Columns C–G become Service · Tank Diesel Left · DSL% · Battery · Fuel Motor, coloured exactly as the
sheet shows them, including conditional formatting.

Tab names, the column L code and the timezone are all set in `wrangler.toml`.

## Built for 300–400 operators

Google lets one service account make **60 reads and 60 writes a minute, total**. The app stays far
inside that however many people use it:

- FL Rep is read from Google at most once a minute and shared with everyone.
- Entries are saved instantly, then written to the sheet in batches — one read + one write per batch.
  80 entries submitted in the same second cost 4 Google calls in testing.
- If Google is ever busy or down, entries wait safely and are written once it recovers. Nothing is lost.

Cloudflare's free plan covers this comfortably; exceeding a free limit never creates a bill.

---

## Setup — fresh accounts

Run everything from this project folder in Command Prompt.

### 1. Google (new account)

1. In Google Cloud Console create a project, enable **Google Sheets API**, create a **service account**,
   and download its **JSON key**.
2. Open the spreadsheet (it needs both a `TNK FD` and an `FL Rep` tab). **Share** it with the service
   account's email (`…@….iam.gserviceaccount.com`) as **Editor**.
3. Copy the spreadsheet ID from its URL: `docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`.

### 2. Cloudflare (new account)

```
npx wrangler logout
npx wrangler login
npx wrangler d1 create fieldops-operator
```

The project ships `wrangler.toml.example`, not `wrangler.toml`, so that unzipping an update can never
overwrite your settings. On a first install, copy it:

```
copy wrangler.toml.example wrangler.toml
```

Then copy the `database_id` it prints into `wrangler.toml`, and put your spreadsheet ID in `SHEET_ID`.
Do **not** add `account_id` to `wrangler.toml` — Pages refuses to deploy with it.

If you ever lose those values, `npx wrangler d1 list` prints the database id again.

Load the database tables:

```
npx wrangler d1 execute fieldops-operator --remote --file=./schema.sql
```

If that fails with an authentication error, run `schema-commands.bat` instead — it does the same,
one statement at a time.

Create the Pages project and deploy:

```
npx wrangler pages project create fieldops-operator --production-branch main
npx wrangler pages deploy public --project-name fieldops-operator --branch main --commit-dirty=true
```

Note the URL it prints (e.g. `https://fieldops-operator.pages.dev`).

### 3. Secrets

Paste the key through a file — pasting it into the prompt cuts it off at 1,020 characters.
Replace the path with wherever the JSON key was downloaded. Write it with **forward slashes**
(`C:/Users/...`) — backslashes get mangled on the way into Node:

```
node -e "const fs=require('fs');fs.writeFileSync('secret.txt',JSON.stringify(JSON.parse(fs.readFileSync('C:/Users/Arun/Downloads/your-key.json','utf8'))))"
npx wrangler pages secret put GOOGLE_SERVICE_ACCOUNT --project-name fieldops-operator < secret.txt

node -e "require('fs').writeFileSync('session.txt', require('crypto').randomBytes(32).toString('hex'))"
npx wrangler pages secret put SESSION_SECRET --project-name fieldops-operator < session.txt

del secret.txt session.txt
npx wrangler pages deploy public --project-name fieldops-operator --branch main --commit-dirty=true
```

`.gitignore` already keeps `secret.txt` and `session.txt` out of GitHub, but delete them anyway.

### 4. Superadmin login

```
node make-admin.js "Jay Gupta" superadmin YourPassword
```

Run the `npx wrangler d1 execute …` line it prints (or double-click `create-admin.bat`).
Sign in at your Pages URL — the superadmin lands on the console.

### 5. GitHub and the Android app

Use the **same GitHub account** as the first app, but a **new, separate repository**.

> Do not push this into `task_status_form`. That repository holds the live FieldOps app, and
> pushing these files over it would replace that app and break the running APK build.

First, set your Pages URL in `public/js/api.js`:

```
window.FIELDOPS_API = 'https://fieldops-operator.pages.dev';
```

Create an empty repository on GitHub (e.g. `fieldops-operator`), with no README or .gitignore, then
from this folder:

```
git init
git add .
git commit -m "FieldOps Operator"
git branch -M main
git remote add origin https://github.com/YOUR-ACCOUNT/fieldops-operator.git
git push -u origin main
```

The push starts the build. Open the repository's **Actions** tab, wait for the green tick, open the
run, and download **FieldOps-Operator-APK** at the bottom. It arrives as a zip; unzip it for
`app-debug.apk`.

The app ID is `com.dashboarddr.fieldops.operator`, so it installs **alongside** the existing FieldOps
app. Operators can have both on one phone.

---

## Day to day

- **The two operator screens:** **डीज़ल भरना** records a fill (columns D, F and G, plus the code in L).
  **सर्विस** records the generator reading after a service (column J only, no code). Both need only
  the site name typed in, and both work offline.
- **New operators:** Employees → *Add many at once*. Paste `Name, username` lines; leave passwords
  out and 6-digit ones are generated. Download the CSV straight away — passwords are not shown again.
- **Finding entries:** the **Entries** tab shows one page at a time. Filter by operator, by
  डीज़ल भरना / सर्विस, by a date range, or type a site or a name in the search box; tick
  *Only waiting* to see just the ones not yet in the sheet. The count on the right (*1–100 of
  20,002*) is the number matching your filters, not the number on screen, and 100 / 200 rows per
  page is your choice. All of this is worked out in the database, so a year of entries opens as
  fast as today's.
- **Long lists elsewhere:** the allocate screen and the employee table draw the first few hundred
  rows and offer the rest on a *Show all* button, so neither hangs at 2,000 sites or 400 people.
  *Tick all shown* still acts on **every** site matching the filter, not only the drawn ones — so
  picking a section and ticking it gives that whole route.
- **New phones need your approval.** An operator's **first** phone works straight away. Any
  phone after that — a second handset, a reinstall, the website in a browser — is refused at
  sign-in with a Hindi message saying approval was requested, and waits for you. The top strip
  shows **Phones to approve**; click it to see them, then **Approve** or **Reject**. Once approved,
  the operator just signs in again on that phone.
  - **Reject** keeps the phone on record, so signing in from it again is refused without asking
    you each time. You can still approve it later.
  - **Remove** (on an approved phone) signs out that phone only; their other phones carry on. If
    it was their only phone, the next phone they use is let in like a first phone.
  - **Sign out all** clears every phone for that person — a clean start; their next phone is let in
    as their first.
  - A sign-in is tied to the phone it was made on, so copying the app's data to another handset
    does not carry the sign-in with it.
  - The superadmin is never held for approval.
  - The phone id is made by the app at install and kept in its own storage, so reinstalling the app
    or clearing its data makes it a new phone that needs approval again (unless it is their only one).
- **Who is signed in where:** the **Devices** tab lists every phone, approved, waiting or rejected,
  with the waiting ones first. Accounts on two or more approved phones are highlighted, and a
  handset used by two different accounts is badged *shared phone*.
  The tab pages too, and the *2+ devices* and *shared phone* marks are worked out across everyone,
  so a person's two phones are both flagged even when they land on different pages.
- **Someone leaves:** Employees → **Delete** on their row. Their login stops working at once and their
  sites are released, but the entries they filed are kept and still show their name, in the console and
  in the sheet. Their username becomes free to reuse. To block someone only temporarily, use **Disable**
  instead — that keeps their site list so re-enabling restores everything.
- **Give sites:** Allocate sites → *By employee* (tick their sites) or *By site* (tick everyone who
  should see it). Filter by section, then *Tick all shown* to give a whole route at once.
- **Renamed a site in the sheet?** Allocations follow it by the code before the `_` (A01, ZF4…).
- **Entries not in the sheet?** Entries → *Write waiting entries to the sheet now*. The console
  shows the last error if Google refused. An entry is safe the moment the operator's phone gets its
  answer — it is stored here first and copied to the sheet after, so a slow or stuck Google delays
  entries but never loses them, and the operator is never left waiting on it. If Google refuses,
  everything holds off for 30 seconds rather than hammering it, so *write now* can say "busy" for
  up to half a minute after an error; that is the back-off, not a failure.
- **Change thresholds or colours?** Edit the conditional formatting in FL Rep. The app shows
  whatever the sheet shows, within a minute.

## Updating

After changing code:

```
npx wrangler pages deploy public --project-name fieldops-operator --branch main --commit-dirty=true
git add -A && git commit -m "what changed" && git push
```

The deploy updates the website and the console at once. The push rebuilds the APK.

The APK carries its own copy of the operator screens and calls the deployed API, so:

- changes under `functions/` reach every operator **as soon as you deploy** — no new APK;
- changes to `public/app.html`, `public/index.html` or `public/js/api.js` need a **new APK installed**
  on the phones.

## If something goes wrong

| What you see | What it means |
|---|---|
| `Configuration file for Pages projects does not support account_id` | Remove `account_id` from `wrangler.toml`. |
| `Unterminated string in JSON at position 1020` on the site | The service-account secret was pasted into the prompt and cut off. Re-send it from a file as in step 3. |
| `authentication error` on `d1 execute --file` | Use `schema-commands.bat` instead. |
| `UNIQUE constraint failed: users.username` | That username exists. Pick another, or use *Reset password* in the console. |
| Operators see no sites | They have none allocated yet, or the sheet's tab is not named `FL Rep`. |
| Delete says entries "have not reached the sheet yet" | Google is behind. Wait a minute, or press *Write waiting entries to the sheet now* under Entries, then delete. This guard means deleting someone can never be what loses an entry. |
| `no such column: employee_name` | The database predates employee deletion. Run `migrate-employee-delete.sql` (or the .bat) once. |
| `no such column: kind` | The database predates the सर्विस screen. Run `migrate-service-screen.sql` (or the .bat) once. |
| `no such column: status` or `no such column: diesel_pct` | The database predates phone approval and the डीज़ल% box. Run `migrate-approval.sql` (or the .bat) once, then deploy again. |
| An operator says the app wants approval on their usual phone | They reinstalled the app or cleared its data, which makes it a new phone. Approve it under Devices, and Remove the old entry. |
| `no such table: devices` or `no such column: token_version` | The database predates device tracking. Run `migrate-devices.sql` (or the .bat) once. |
| An operator is signed out unexpectedly | Someone pressed *Sign out all* for them, or their account was disabled. They can sign in again as normal. |
| `Google Sheets is busy` | Google's per-minute quota was hit. Entries are safe and go in automatically; nothing to do. |
| The submit button sits on "जमा हो रहा है…" | It cannot any more: the app answers the phone as soon as the entry is stored, waiting at most ~2.5 s for the sheet, and the phone gives up on any request after 20 s and keeps the entry. If an old APK is still installed, deploy the API — that alone fixes it. |
| Entries stay "waiting" for many minutes | Find out which it is:<br>`npx wrangler d1 execute fieldops-operator --remote --command="SELECT * FROM kv WHERE key='sync'"`<br>A message there is Google refusing (sharing, SHEET_ID or tab name). Nothing there, plus a row in `locks`, means a write never started — clear it with `...--command="DELETE FROM locks"`. |
| APK installs but shows a blank screen | `window.FIELDOPS_API` in `public/js/api.js` is wrong or unset. Fix it, push, rebuild. |
| The app says "नेटवर्क नहीं है" on sign-in but the website works | The phone's request was blocked before it was sent. Any header added to `public/js/api.js` must also be listed in `access-control-allow-headers` in the API's OPTIONS handler — the website never shows this because it calls its own origin. Fix it and **redeploy**; no new APK is needed. |

## Why the console stays quick

Nothing in the console loads a whole table. The browser asks for one page, and the database does
the filtering and counting:

| At 400 operators, 20,000 entries, 2,000 sites | |
|---|---|
| Opening the console, signed in to a usable screen | **1.3 s** |
| One page of entries (100 rows) | 28 KB, 13 ms |
| Searching all 20,000 entries | 410 ms from the keystroke |
| Any console query, measured server-side | 7–23 ms |
| Loading all 20,000 entries the old way | ~5.5 MB and 15× the drawing work |

Typing waits for you to stop before it redraws, so holding a key down costs one redraw instead of
one per letter.
