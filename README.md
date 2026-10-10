# FieldOps Operator

A second, separate app for operators, on its own Google and Cloudflare accounts.

- **Operators** (Android app): file **डीज़ल भरना** entries, and see live **FL Rep** readings — with the
  sheet's colours — for only the sites the superadmin gave them.
- **Superadmin** (web console): create operator logins (one at a time or hundreds at once),
  allocate sites by employee or by site, and watch every entry reach the sheet.

## What gets written where

**डीज़ल भरना → `TNK FD` tab**, at the first empty row after the last value in column A:

| Column | Value |
|---|---|
| A | Date and time, e.g. `09 OCT 26 19:02:00` |
| B | साइट का नाम (typed by the operator) |
| D | डीज़ल भरवाया |
| F | जनरेटर की रीडिंग |
| K | Employee name |
| L | `RKP-45BT2` (the same code on every entry) |

No other column is touched, so formulas in C, E, G–J are safe.

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

Copy the `database_id` it prints into `wrangler.toml`, and put your spreadsheet ID in `SHEET_ID`.
Do **not** add `account_id` to `wrangler.toml` — Pages refuses to deploy with it.

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

### 5. Android app

1. In `public/js/api.js` set `window.FIELDOPS_API` to your Pages URL.
2. Push this folder to its own GitHub repository. The **Actions** tab builds the APK; download
   **FieldOps-Operator-APK** from the latest run.

The app ID is `com.dashboarddr.fieldops.operator`, so it installs **alongside** the existing FieldOps
app on the same phone.

---

## Day to day

- **New operators:** Employees → *Add many at once*. Paste `Name, username` lines; leave passwords
  out and 6-digit ones are generated. Download the CSV straight away — passwords are not shown again.
- **Give sites:** Allocate sites → *By employee* (tick their sites) or *By site* (tick everyone who
  should see it). Filter by section, then *Tick all shown* to give a whole route at once.
- **Renamed a site in the sheet?** Allocations follow it by the code before the `_` (A01, ZF4…).
- **Entries not in the sheet?** Entries → *Write waiting entries to the sheet now*. The console
  shows the last error if Google refused.
- **Change thresholds or colours?** Edit the conditional formatting in FL Rep. The app shows
  whatever the sheet shows, within a minute.

## Updating

After changing code: deploy with the `pages deploy` line above, and `git push` to rebuild the APK.
