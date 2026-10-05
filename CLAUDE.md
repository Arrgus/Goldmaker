# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Goldmaker is a personal tracker for World of Warcraft weekly gold-making activities, used across many alts. The grid has one row per character and one column per activity. Each cell records whether that character did that activity this week, and how much gold it paid. It's a single-user app: plain PHP, vanilla JS and one JSON file, with no framework, build step or dependencies.

## Where it runs and how to change it

- **Live:** the app only runs on the Dokploy server (see Deployment). The real data is `/data/goldmaker.json` in the server's persistent volume.
- **The local copy is retired (since 2026-09-29).** It used to run under the local Apache (`D:\htdocs`). The `data/` folder and `config.local.php` here are stale leftovers: don't treat them as the real data, and never copy them over the server's. `config()` still falls back to `config.local.php` when an env var is empty.
- **Making a change:** edit here, run the checks below, commit, then push `main` to GitHub (`origin`) and deploy it from Dokploy.
- **Checks:**
  - `php tests/api.test.php` runs end-to-end tests of `api.php`. It starts `php -S` from a temp copy of the site with a fresh data folder, so it never touches real data, `config.local.php` or Battle.net. Needs PHP 8.1+ with curl.
  - `node tests/client.test.js` runs `app.js` against a stub DOM and a simulated server. It checks the request queue, the sync, logging out and error handling. Needs Node 18+.
  - Syntax only: `php -l api.php` and `node --check app.js`. There's no linter or bundler.
  - **Not covered:** the real armory sync, Apache (the `.htaccess` rules and headers) and real browser behaviour (form validation, `<select>` values, layout, and keeping the loot fields' focus and typing across re-renders). Check those by hand, for example with the Docker command under Deployment.
- **Running it locally:**
  - Docker is closest to the server.
  - `php -S` also works, but it ignores `.htaccess`, so the data-folder block and the security headers don't apply.
  - The armory sync fails locally with an SSL error, because the local Windows PHP has no CA bundle configured (`curl.cainfo`). The Docker image is fine.
- Needs PHP 8.1+ (`never` return type, `array_is_list`).

## Deployment (Dokploy)

- **Image:** the `Dockerfile` builds on `php:8.3-apache`, so there's no compose file. It turns on `.htaccess` support and the headers module, and loads `docker/apache.conf` as `zz-…` so it overrides Debian's `security.conf`.
- **Files served:** only the files listed in the `COPY` line go into the web root. **A new site file must be added to that line.** `tests/` isn't deployed.
- **Data:** `GOLDMAKER_DATA_DIR=/data` sits outside the web root. `/data` must be a persistent volume, and the entrypoint `chown`s it to `www-data` at startup.
  - Besides `goldmaker.json`, it holds `goldmaker.lock`, `login-failures.json` and the armory caches (`blizzard-token.json`, `realm-index.json`).
  - It also holds `backup-<timestamp>.json` files from imports. These are the only backups the app makes itself.
  - `goldmaker.json.tmp` only exists for a moment during a save.
- **If the app reports a damaged data file,** nothing has been changed. Replace `/data/goldmaker.json` with a good copy: a `backup-*.json`, or a backup of the volume.
- **Env vars on the server:** `GOLDMAKER_PASSWORD`, plus `BLIZZARD_CLIENT_ID`, `BLIZZARD_CLIENT_SECRET` and `BLIZZARD_REGION` (default `eu`) for the armory sync. `config()` in `api.php` reads each env var first, then the matching key in `config.local.php`.
- **HTTPS:** Traefik terminates TLS. `api.php` trusts `X-Forwarded-Proto` to decide whether the cookie gets the `Secure` flag.
- **Local test:** `docker build -t goldmaker . && docker run -p 8080:80 -e GOLDMAKER_PASSWORD=… -v <dir>:/data goldmaker`

## Architecture

**`api.php`** is the whole backend: one script dispatched by `?action=` (`login`, `logout`, `state`, `saveCharacter`, `saveActivity`, `delete`, `move`, `toggle`, `deposit`, `price`, `gold`, `goal`, `import`, `sync`).
- **Auth runs before the data file is opened.**
  - There is a single shared password. The `goldmaker_session` cookie holds `expiry.hmac`, keyed by that password, so there is no server-side session storage and changing the password signs everyone out. The cookie is renewed once it's more than halfway to expiry.
  - Every action except `state` must be a POST with a JSON content type (the CSRF defence, together with the SameSite=Lax cookie).
  - Failed logins are counted globally in `DATA_DIR/login-failures.json` (10 per 15 minutes, then 429).
- It reads JSON from the request body.
- **Loading and saving:**
  - Every request holds an exclusive `flock` on `DATA_DIR/goldmaker.lock` for its whole duration, then loads the data file (`loadState`) and mutates it. Actions other than `state` save it back.
  - `saveState` writes a `.tmp` file and renames it over the data file, so a crash or full disk never leaves a half-written file. The lock lives in its own file because that rename replaces the data file.
  - A data file that exists but doesn't parse is a 500 error, never treated as empty, because the next save would overwrite it. An empty or missing file is a fresh start.
- **Every action returns the complete new state.** The front end never patches its state locally. It replaces `state` with whatever the API returns and re-renders everything.
- Errors go through `fail()`, which returns `{error}` with an HTTP status code.
- IDs are prefixed random hex (`c…` for characters, `a…` for activities), so PHP never turns them into integer array keys. Keep the prefixes. `isId()` enforces the format wherever ids come from outside: `toggle`, the import, and the completion keys checked on every load.

**Armory sync** (`armory.php`, included by `api.php`; blocked from direct web access):
- **Trigger:** the `sync` action looks up every character on the Blizzard Profile API and overwrites `level` and `class`. `app.js` calls it from the Manage button, and on its own when `lastSync` is older than `AUTO_SYNC_INTERVAL` (6h).
- **Order of work:** lookups run *before* the exclusive data lock (reading a snapshot under a shared lock), then are applied by character id, so slow Blizzard calls never block other requests.
- **Blizzard calls:** it uses client credentials and English (en_US) names, so classes match the `CLASSES` keys in `app.js`. Characters are fetched in parallel with `curl_multi`.
- **Realm matching:** the stored realm is matched to a slug through the realm index, via `realmKey()`, which lowercases and strips everything but letters and numbers.
- **Caching:** the OAuth token and the realm index are cached as JSON files in `DATA_DIR`.
- **Errors:** a failure for one character is saved as `syncError` on that character. A failure of the whole sync is saved as the top-level `lastSyncError`, and `lastSync` is set either way so a broken setup isn't retried constantly. `saveCharacter` rebuilds the character, which drops `syncError`.
- **Extra response fields:** the API response adds `armoryEnabled` and `autoSyncInterval`. They are never written to the file.

**Import** (the `import` action, under Manage → Data):
- **What it does:** replaces all data with an uploaded `goldmaker.json`, first saving the old file as `DATA_DIR/backup-<timestamp>.json`.
- **Validation:** imported items go through the same `characterFields` / `activityFields` / `normalizeCompletions` as normal edits.
- **IDs must match `^[ca][0-9a-f]+$`,** because `app.js` puts ids into HTML attributes unescaped.
- **Sync state:** the import drops `lastSync`, so the page re-syncs levels right after.

**Apache hardening** (`.htaccess`, `data/.htaccess`): denies access to `data/`, dotfiles, `CLAUDE.md` and the config files, and sets the CSP and other security headers. The CSP allows inline *styles*, which the class colours and history bars need, but no inline scripts.

**`app.js`** holds all client logic: rendering, forms and events. Views are rebuilt as HTML strings; `esc()` must wrap all user text. Events are delegated from `#grid`, `#history` and `#view-manage`.
- **Requests:**
  - `send()` is the raw fetch helper. It turns network failures and replies that aren't JSON into ordinary `{error}` replies.
  - `check()` handles an error reply: a 401 makes `setSignedIn(false)` swap to the login form and clear the in-memory data, and any other error is shown in an alert.
  - `api()` also swaps in the returned state.
- **Request queue:**
  - `api()` sends requests one at a time through `enqueue()`, so responses can't arrive out of order. Login and logout go through the queue too.
  - The armory sync is the exception: it bypasses the queue so clicks don't wait for Battle.net, then fetches `state` through the queue instead of using its own reply, which may be older.
  - Logout signs the page out at once but sends its request only after everything already underway, including a running sync, so no reply can renew the cookie afterwards. `signOuts` makes the page ignore replies to requests made before the logout.
- `requestRender()` waits for `pointerup` (or `pointercancel`, which ends a touch that became a scroll) before re-rendering. Otherwise re-rendering between mousedown and mouseup swallows clicks, for example when leaving a gold input by clicking another cell.

## Data model (`goldmaker.json` in `DATA_DIR`)

```
characters: [{id, name, realm, class, level, syncError?}]  // order = display order ("move" swaps neighbours)
activities: [{id, name, minLevel, notes, gold, materials}]  // gold = default reward; older entries may lack gold/materials
                                                            // materials: [{id: "m…", name}], see Loot below
completions: { "<weekKey>": { "<charId>": { "<actId>": gold|null } } }
snapshots: { "<weekKey>": {characters, activities} }  // setup of closed weeks, see below
deposits: { "<weekKey>": { "<charId>": [{gold, time}] } }  // gold taken to the bank, see below
depositsFrom: weekKey|null  // weeks before it count as banked
loot: { "<weekKey>": { "<charId>": { "<actId>": { "<matId>": count } } } }  // materials a run dropped
prices: { "<weekKey>": { "<matId>": gold } }  // AH price per item, see Loot below
bank: {gold, time}|null  // gold counted in the bank, see Gold on hand below
charGold: { "<charId>": {gold, time} }  // gold counted on each character
goal: {gold, name}  // what's being saved up for; gold 0 = no goal
lastWeek?: weekKey  // latest week a request came from
lastSync?: unix time, lastSyncError?: string|null
```

- **Week keys** are the `YYYY-MM-DD` date of the Wednesday the week starts on. The weekly reset is Wednesday 04:00 in the *browser's* local time and is computed only in `app.js` (`weekStart`/`currentWeekKey`). The server's `isWeekKey` only accepts a real Wednesday from 2004 to next year, and `renderHistory` skips anything older: it walks back week by week to the oldest key, and a year like `0050` made that loop endless.
- **Bad stored data fails loudly:** the stored completions are validated on every load, so a bad week key or id there makes every request fail with an error instead of being dropped silently.
- **Completion gold is a snapshot** taken when the cell is ticked, so changing an activity's default later doesn't rewrite history. `null` means "use the activity's current default". Older data stored a plain list of activity IDs; `api.php` migrates those to `null` on every load.
  - A `toggle` without gold gives a new run the activity's default, and leaves the gold of a run that's already done as it is. So to reset a cell to the default, `app.js` sends the default itself.
- **Gold is kept in whole hundreds.** The amounts are rough guides, so when an activity's default or a cell's gold is saved, `goldAmount()` in `api.php` drops the rest (1,250 → 1,200, 99 → 0). Values stored before this rule are left as they are. The exception is the vendor gold of an activity with loot (`hasLoot`), which is only a few hundred and is kept as typed.
- **Eligibility:** a character can do an activity if `char.level >= act.minLevel`. Levels are clamped to 1–`MAX_LEVEL` (90, the current cap) in `api.php`, and armory levels are clamped too. When the cap rises, update `MAX_LEVEL`, the `max` attributes in `index.html` and the activity level options.
- **Closed weeks keep their setup.** `send()` adds the browser's current week as `?week=` to every request. When it's later than `lastWeek`, `closeWeeks()` in `api.php` saves the data as it stands as `lastWeek`'s snapshot, *before* the request changes anything, since nothing changed after that week ended. That includes a `state` read, which then saves.
  - A snapshot covers the weeks from its key up to the next one; one identical to the previous snapshot isn't stored. `weekSetup()` in `app.js` picks the right one: weeks from `lastWeek` on use the live data, and weeks older than every snapshot (from before this existed) use the oldest one.
  - The grid, gold defaults and history totals of a past week all come from its snapshot. Ticking a cell in a closed week sends that snapshot's default gold.
  - Snapshots are validated on every load and on import, with the same field rules (except gold, kept as it was).
- **Bank deposits.** Each character's Bank cell has a Deposit button, labelled with the amount, that records the gold not yet banked that week (earned minus the sum of its deposits) as a new deposit, with a timestamp. Doing more activities afterwards makes the button come back with just the new amount. Once everything is banked it shows "Banked ✔"; clicking it undoes the latest deposit (`deposit` with `undo`). The week's totals, the grid footer and the History view show what is still to deposit.
  - Deposits are stored as given; they aren't kept to the hundred. Unticking a cell never removes a deposit, so a character can show more deposited than earned, which counts as fully banked.
  - `depositsFrom` stops weeks from before the feature existing from showing up as unbanked. A file without it starts tracking at its `lastWeek` (null when it has none, meaning every week is tracked); `api.php` fills it in on load and stores it with the next save. The import does the same.
  - Deposits are validated on every load and on import, like completions.
- **Loot** (built for Naxxramas, which drops Wartorn Scrap and Frozen Runes). An activity can list materials sold on the Auction House, typed as comma-separated names in its Manage form.
  - **Ids:** `saveActivity` keeps the `m…` id of a name the activity already had (case-insensitive), so renaming a material starts it afresh.
  - **Week page:** such an activity gets a group of columns in the grid, under its name: Run (the tick, showing what the run was worth), a count per material and Vendor (the gold from vendored items, the cell's ordinary completion gold). Its loot is filled in on each character's own row; an earlier version had a separate table next to the grid, whose rows didn't line up with it.
  - **Saving:** each field is saved on its own as a `toggle`: a count as `loot: {matId: count}`, the vendor gold as `gold`. `api.php` merges the counts into the run's loot, and 0 removes a material. Sending one field at a time matters: while one field's save is on its way, a reply to an earlier save can redraw the row's other fields with older values, which must not be sent back.
  - Filling in a run that isn't ticked ticks it. A plain tick leaves the loot alone. Unticking removes it, so the page asks first when the run has loot.
  - **Keyboard:** Enter or ↓ moves to the same field in the next row, Shift+Enter or ↑ to the row above, and Escape undoes the typing.
  - **Prices** are set in the column headers per week (`price`, `null` removes the week's own one). A price holds until a later week sets another, and weeks before the first price use it (`priceOf`). Prices are whole gold, not kept to the hundred, and `parsePrice` reads `45` as 45g, unlike `parseGold`. The Vendor fields use `parsePrice` too.
  - **Not deposited:** the mats are sold from one character, so their value counts as earned (row totals show it as "+… in mats", and History includes it) but never as gold to deposit.
  - **Typing while replies arrive:** fields save on `focusout` when they differ from what was rendered (`defaultValue`). `setGrid` puts the focused field back after a re-render, keeping what was typed.
  - Validated on every load and on import, like completions.
- **Gold on hand** (the Gold page). The bank and each character have a field for the gold the game shows, typed in by hand (`gold` action; no `charId` means the bank, `null` clears). `time` is when it was typed in.
  - A deposit adds its gold to the bank's count and undoing it takes it off (never below 0), without changing `time`. A bank with only deposits has `time: null`. The page shows how much was deposited since the last count.
  - The grand total (bank plus the characters that still exist) sits in the header (`#nav-total`) whenever anything is counted. Deleting a character drops its gold.
  - Whole gold, read with `parsePrice` (which also takes `1.2m`). Field values use en-US grouping, since a locale's own (`1.234.567`) wouldn't parse back.
  - Validated on every load and on import.
  - **Goal:** one goal, set on the Gold page (`goal` action, each field sent on its own like the loot fields). While its gold is above 0, the header shows a progress bar towards it next to the total.
- **Deleting** a character or activity keeps its completion history, and it still shows in the weeks whose snapshot has it. Elsewhere entries with unknown IDs are ignored when rendering.
- **Realms** are stored as typed by the user, in the in-game style without spaces (e.g. `ColinasPardas`); they are not Blizzard API slugs. The characters are on EU realms.

## Front-end conventions

- **Week page layout:** the totals sit next to the week's dates (`weekSummary`). The grid ends with Done, Gold (mats on a line of their own, since they aren't deposited) and Bank (the Deposit button, left out for weeks before `depositsFrom`). Rows are kept to two lines so the 26-odd characters fit on fewer screens. The header, the footer and the character names stay in view while scrolling (sticky `thead`, `tfoot` cells and row headers), so the grid needs no scroll box of its own.
- **Class colors:** the `CLASSES` map in `app.js` supplies the class colors and also fills the class `<select>`.
- **Gold input** (`parseGold`) accepts `1900`, `1,900`, `1.9k` and `20k`. A number with one or two digits before the decimal point is read as thousands (`19` means 19k). An empty input means "use the default".
- **Activity gold field:** it keeps `step="100"` so the arrows move by 100. Instead of letting the browser refuse a value like 1250, its `invalid` handler rounds the value down and submits again. Negative values are left for the browser's own warning.

## Open issues (from the September 2026 audit)

The audit's data-loss and robustness bugs are fixed and covered by `tests/`. These items are still open.

**Security:**
- **The session cookie is signed with the password itself** (`sessionSignature`).
  - A leaked cookie lets someone test password guesses offline, which gets around the login limit.
  - Logging out only clears your own copy of the cookie, so a stolen copy stays valid; only changing the password signs it out.
  - **Fix:** mix a random secret, stored in `DATA_DIR`, into the key. Deleting that file then signs out every session.
- **No HSTS header.**
  - First make sure the Dokploy domain has HTTPS with redirect switched on.
  - Then add `Header always set Strict-Transport-Security "max-age=31536000" "expr=%{HTTP:X-Forwarded-Proto} == 'https'"` to `.htaccess`.
- **The Dockerfile copies the site with `--chown=www-data`,** so Apache could overwrite its own code and `.htaccess`. Nothing needs that; drop `--chown`.
- **Accepted by design:** anyone can block new logins by sending 10 wrong passwords every 15 minutes. Existing sessions keep working.

**Bugs:**
- **Import backups:** they're named to the second, so two imports within the same second overwrite the first backup. Backups are never pruned.
- **Realm-index cache:** it isn't tied to a region. After changing `BLIZZARD_REGION`, the old list is used for up to 7 days; delete `realm-index.json` to refresh it.
- **Double-clicking Add** in the Manage forms submits twice and creates two entries.
