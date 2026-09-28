# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Goldmaker is a personal tracker for World of Warcraft weekly gold-making activities, used across many alts. The grid has one row per character and one column per activity. Each cell records whether that character did that activity this week, and how much gold it paid. It's a single-user app: plain PHP, vanilla JS and one JSON file, with no framework, build step, dependencies or tests.

## Running and checking

- The project lives in the local Apache docroot (`D:\htdocs`), so it's served from there. `php -S localhost:8000` from the project root also works.
- Needs PHP 8.1+ (`never` return type, `array_is_list`).
- The app requires a login. For local use, copy `config.local.php.example` to `config.local.php` (gitignored). On a server, set the `GOLDMAKER_PASSWORD` env var instead. `GOLDMAKER_DATA_DIR` moves the data folder, e.g. outside the web root in Docker.
- The armory sync needs curl to trust HTTPS certificates. The local Windows PHP has no CA bundle configured (`curl.cainfo`), so syncing fails locally with an SSL error; the Docker image is fine.
- `php -S` ignores `.htaccess`, so the data-folder block and the security headers only apply under Apache.
- Syntax check: `php -l api.php`. There is no linter, test suite or bundler.
- `data/goldmaker.json` holds the real data. Don't reset it, reformat it by hand or commit test data into it.

## Deployment (Dokploy)

- **Image:** the `Dockerfile` builds on `php:8.3-apache`, so there's no compose file. It turns on `.htaccess` support and the headers module, and loads `docker/apache.conf` as `zz-…` so it overrides Debian's `security.conf`.
- **Files served:** only the files listed in the `COPY` line go into the web root. **A new site file must be added to that line.**
- **Data:** `GOLDMAKER_DATA_DIR=/data` sits outside the web root. `/data` must be a persistent volume, and the entrypoint `chown`s it to `www-data` at startup.
- **Env vars on the server:** `GOLDMAKER_PASSWORD`, plus `BLIZZARD_CLIENT_ID`, `BLIZZARD_CLIENT_SECRET` and `BLIZZARD_REGION` (default `eu`) for the armory sync. `config()` in `api.php` reads each env var first, then the matching key in `config.local.php`.
- **HTTPS:** Traefik terminates TLS. `api.php` trusts `X-Forwarded-Proto` to decide whether the cookie gets the `Secure` flag.
- **Local test:** `docker build -t goldmaker . && docker run -p 8080:80 -e GOLDMAKER_PASSWORD=… -v <dir>:/data goldmaker`

## Architecture

**`api.php`** is the whole backend: one script dispatched by `?action=` (`login`, `logout`, `state`, `saveCharacter`, `saveActivity`, `delete`, `move`, `toggle`).
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

## Data model (`data/goldmaker.json`)

```
characters: [{id, name, realm, class, level, syncError?}]  // order = display order ("move" swaps neighbours)
activities: [{id, name, minLevel, notes, gold}]  // gold = default reward; older entries may lack it
completions: { "<weekKey>": { "<charId>": { "<actId>": gold|null } } }
lastSync?: unix time, lastSyncError?: string|null
```

- **Week keys** are the `YYYY-MM-DD` date of the Wednesday the week starts on. The weekly reset is Wednesday 04:00 in the *browser's* local time and is computed only in `app.js` (`weekStart`/`currentWeekKey`). The server's `isWeekKey` only accepts a real Wednesday from 2004 to next year, and `renderHistory` skips anything older: it walks back week by week to the oldest key, and a year like `0050` made that loop endless.
- **Bad stored data fails loudly:** the stored completions are validated on every load, so a bad week key or id there makes every request fail with an error instead of being dropped silently.
- **Completion gold is a snapshot** taken when the cell is ticked, so changing an activity's default later doesn't rewrite history. `null` means "use the activity's current default". Older data stored a plain list of activity IDs; `api.php` migrates those to `null` on every load.
- **Gold is kept in whole hundreds.** The amounts are rough guides, so when an activity's default or a cell's gold is saved, `goldAmount()` in `api.php` drops the rest (1,250 → 1,200, 99 → 0). Values stored before this rule are left as they are.
- **Eligibility:** a character can do an activity if `char.level >= act.minLevel`. Levels are clamped to 1–`MAX_LEVEL` (90, the current cap) in `api.php`, and armory levels are clamped too. When the cap rises, update `MAX_LEVEL`, the `max` attributes in `index.html` and the activity level options.
- **Deleting** a character or activity keeps its completion history; entries with unknown IDs are ignored when rendering.
- **History totals** are recomputed from the *current* characters, levels and activities, not from what existed in that week.
- **Realms** are stored as typed by the user, in the in-game style without spaces (e.g. `ColinasPardas`); they are not Blizzard API slugs. The characters are on EU realms.

## Front-end conventions

- **Class colors:** the `CLASSES` map in `app.js` supplies the class colors and also fills the class `<select>`.
- **Gold input** (`parseGold`) accepts `1900`, `1,900`, `1.9k` and `20k`. A number with one or two digits before the decimal point is read as thousands (`19` means 19k). An empty input means "use the default".
- **Activity gold field:** it keeps `step="100"` so the arrows move by 100. Instead of letting the browser refuse a value like 1250, its `invalid` handler rounds the value down and submits again. Negative values are left for the browser's own warning.
