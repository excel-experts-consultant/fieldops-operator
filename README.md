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

- **The two operator screens:** **डीज़ल भरना** records a fill (columns D and F, plus the code in L).
  **सर्विस** records the generator reading after a service (column J only, no code). Both need only
  the site name typed in, and both work offline.
- **New operators:** Employees → *Add many at once*. Paste `Name, username` lines; leave passwords
  out and 6-digit ones are generated. Download the CSV straight away — passwords are not shown again.
- **Who is signed in where:** the **Devices** tab lists every phone each account has signed in on.
  Accounts on two or more are highlighted, and a handset used by two different accounts is badged
  *shared phone*. The strip at the top shows how many accounts are on 2+ devices, so you can see it
  without opening the tab. **Sign out all** clears an account's devices and stops every phone at
  once; the person's password still works, so they just sign in again on the right phone.
  The id is made by the app at install and kept in its own storage — it identifies the install, not
  the handset, so a reinstall or clearing app data shows up as a new device.
- **Someone leaves:** Employees → **Delete** on their row. Their login stops working at once and their
  sites are released, but the entries they filed are kept and still show their name, in the console and
  in the sheet. Their username becomes free to reuse. To block someone only temporarily, use **Disable**
  instead — that keeps their site list so re-enabling restores everything.
- **Give sites:** Allocate sites → *By employee* (tick their sites) or *By site* (tick everyone who
  should see it). Filter by section, then *Tick all shown* to give a whole route at once.
- **Renamed a site in the sheet?** Allocations follow it by the code before the `_` (A01, ZF4…).
- **Entries not in the sheet?** Entries → *Write waiting entries to the sheet now*. The console
  shows the last error if Google refused.
- **Change thresholds or colours?** Edit the conditional formatting in FL Rep. The app shows
  whatever the sheet shows, within a minute.

## Updating

After changing code:

```
npx wrangler pages deploy public --project-name fieldops-operator --branch main --commit-dirty=true
git add -A && git commit -m "what changed" && git push
```

The deploy updates the website and the console at once. The push rebuilds the APK, which operators
only need to reinstall if the app's own screens changed — the APK loads the live site, so most
changes reach them without a new install.

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
| `no such table: devices` or `no such column: token_version` | The database predates device tracking. Run `migrate-devices.sql` (or the .bat) once. |
| An operator is signed out unexpectedly | Someone pressed *Sign out all* for them, or their account was disabled. They can sign in again as normal. |
| `Google Sheets is busy` | Google's per-minute quota was hit. Entries are safe and go in automatically; nothing to do. |
| APK installs but shows a blank screen | `window.FIELDOPS_API` in `public/js/api.js` is wrong or unset. Fix it, push, rebuild. |
