# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Goldmaker is a personal tracker for World of Warcraft weekly gold-making activities, used across many alts. The grid has one row per character and one column per activity. Each cell records whether that character did that activity this week, and how much gold it paid. It's a single-user app: plain PHP, vanilla JS and one JSON file, with no framework, build step, dependencies or tests.

## Running and checking

- The project lives in the local Apache docroot (`D:\htdocs`), so it's served from there. `php -S localhost:8000` from the project root also works.
- Needs PHP 8.1+ (`never` return type, `array_is_list`).
- The app requires a login. For local use, copy `config.local.php.example` to `config.local.php` (gitignored). On a server, set the `GOLDMAKER_PASSWORD` env var instead. `GOLDMAKER_DATA_DIR` moves the data folder, e.g. outside the web root in Docker.
- `php -S` ignores `.htaccess`, so the data-folder block and the security headers only apply under Apache.
- Syntax check: `php -l api.php`. There is no linter, test suite or bundler.
- `data/goldmaker.json` holds the real data. Don't reset it, reformat it by hand or commit test data into it.

## Deployment (Dokploy)

- **Image:** the `Dockerfile` builds on `php:8.3-apache`, so there's no compose file. It turns on `.htaccess` support and the headers module, and loads `docker/apache.conf` as `zz-…` so it overrides Debian's `security.conf`.
- **Files served:** only the files listed in the `COPY` line go into the web root. **A new site file must be added to that line.**
- **Data:** `GOLDMAKER_DATA_DIR=/data` sits outside the web root. `/data` must be a persistent volume, and the entrypoint `chown`s it to `www-data` at startup.
- **Env vars on the server:** `GOLDMAKER_PASSWORD`.
- **HTTPS:** Traefik terminates TLS. `api.php` trusts `X-Forwarded-Proto` to decide whether the cookie gets the `Secure` flag.
- **Local test:** `docker build -t goldmaker . && docker run -p 8080:80 -e GOLDMAKER_PASSWORD=… -v <dir>:/data goldmaker`

## Architecture

**`api.php`** is the whole backend: one script dispatched by `?action=` (`login`, `logout`, `state`, `saveCharacter`, `saveActivity`, `delete`, `move`, `toggle`).
- **Auth runs before the data file is opened.**
  - There is a single shared password. The `goldmaker_session` cookie holds `expiry.hmac`, keyed by that password, so there is no server-side session storage and changing the password signs everyone out. The cookie is renewed once it's more than halfway to expiry.
  - Every action except `state` must be a POST with a JSON content type (the CSRF defence, together with the SameSite=Lax cookie).
  - Failed logins are counted globally in `DATA_DIR/login-failures.json` (10 per 15 minutes, then 429).
- It reads JSON from the request body.
- Every request opens the data file with an exclusive `flock` for its whole duration, then loads, mutates and rewrites the full file. Actions other than `state` write the file back.
- **Every action returns the complete new state.** The front end never patches its state locally. It replaces `state` with whatever the API returns and re-renders everything.
- Errors go through `fail()`, which returns `{error}` with an HTTP status code.
- IDs are prefixed random hex (`c…` for characters, `a…` for activities), so PHP never turns them into integer array keys. Keep the prefixes.

**Apache hardening** (`.htaccess`, `data/.htaccess`): denies access to `data/`, dotfiles, `CLAUDE.md` and the config files, and sets the CSP and other security headers. The CSP allows inline *styles*, which the class colours and history bars need, but no inline scripts.

**`app.js`** holds all client logic: rendering, forms and events. Views are rebuilt as HTML strings; `esc()` must wrap all user text. Events are delegated from `#grid`, `#history` and `#view-manage`.
- A 401 from any API call makes `setSignedIn(false)` swap to the login form and clear the in-memory data. `send()` is the raw fetch helper; `api()` also swaps in the returned state.
- `api()` sends requests one at a time through a promise queue, so responses can't arrive out of order.
- `requestRender()` waits for `pointerup` before re-rendering. Otherwise re-rendering between mousedown and mouseup swallows clicks, for example when leaving a gold input by clicking another cell.

## Data model (`data/goldmaker.json`)

```
characters: [{id, name, realm, class, level}]    // order = display order ("move" swaps neighbours)
activities: [{id, name, minLevel, notes, gold}]  // gold = default reward; older entries may lack it
completions: { "<weekKey>": { "<charId>": { "<actId>": gold|null } } }
```

- **Week keys** are the `YYYY-MM-DD` date of the Wednesday the week starts on. The weekly reset is Wednesday 04:00 in the *browser's* local time and is computed only in `app.js` (`weekStart`/`currentWeekKey`); the server just checks the key format.
- **Completion gold is a snapshot** taken when the cell is ticked, so changing an activity's default later doesn't rewrite history. `null` means "use the activity's current default". Older data stored a plain list of activity IDs; `api.php` migrates those to `null` on every load.
- **Eligibility:** a character can do an activity if `char.level >= act.minLevel`. Levels are clamped to 1–90 (the current cap) on both sides.
- **Deleting** a character or activity keeps its completion history; entries with unknown IDs are ignored when rendering.
- **History totals** are recomputed from the *current* characters, levels and activities, not from what existed in that week.
- **Realms** are stored as typed by the user, in the in-game style without spaces (e.g. `ColinasPardas`); they are not Blizzard API slugs. The characters are on EU realms.

## Front-end conventions

- **Class colors:** the `CLASSES` map in `app.js` supplies the class colors and also fills the class `<select>`.
- **Gold input** (`parseGold`) accepts `1900`, `1,900`, `1.9k` and `20k`. A number with one or two digits before the decimal point is read as thousands (`19` means 19k). An empty input means "use the default".
