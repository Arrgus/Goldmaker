<?php
declare(strict_types=1);

// In Docker the data lives outside the web root; locally it defaults to ./data (blocked by data/.htaccess).
define('DATA_DIR', getenv('GOLDMAKER_DATA_DIR') ?: __DIR__ . '/data');
const DATA_FILE = DATA_DIR . '/goldmaker.json';
// Reads and writes of DATA_FILE are locked through this file, not DATA_FILE itself, because
// saving replaces DATA_FILE with a new file (see saveState).
const LOCK_FILE = DATA_DIR . '/goldmaker.lock';
const FAILURES_FILE = DATA_DIR . '/login-failures.json';

const SESSION_COOKIE = 'goldmaker_session';
const SESSION_TTL = 30 * 86400;
const MAX_LOGIN_FAILURES = 10;
const FAILURE_WINDOW = 15 * 60;

const MAX_LEVEL = 90;
const AUTO_SYNC_INTERVAL = 6 * 3600; // app.js syncs on its own once lastSync is older than this

require __DIR__ . '/armory.php';

header('Content-Type: application/json');
header('Cache-Control: no-store');

function emptyState(): array
{
    // No depositsFrom: a missing one is filled in from lastWeek (see depositsFrom).
    return [
        'characters' => [], 'activities' => [], 'completions' => new stdClass(), 'snapshots' => new stdClass(),
        'deposits' => new stdClass(), 'loot' => new stdClass(), 'prices' => new stdClass(),
    ];
}

function fail(string $message, int $code = 400): never
{
    http_response_code($code);
    echo json_encode(['error' => $message]);
    exit;
}

function newId(string $prefix): string
{
    // Prefixed so ids are never numeric strings (PHP would turn those into int array keys).
    return $prefix . bin2hex(random_bytes(5));
}

// $id comes straight from the request, so it may not even be a string; that is just "not found".
function findIndex(array $items, mixed $id): int
{
    foreach ($items as $i => $item) {
        if ($item['id'] === $id) {
            return $i;
        }
    }
    fail('Not found', 404);
}

// Ids are a type prefix plus random hex (see newId). app.js puts them into HTML attributes
// unescaped, and PHP would turn numeric ids into integer array keys.
function isId(mixed $id, string $prefix): bool
{
    return is_string($id) && preg_match("/^{$prefix}[0-9a-f]+\\z/", $id) === 1;
}

// A week key is the date of the Wednesday the week starts on (weekStart in app.js). The history
// view walks back week by week to the oldest key, so years are limited to WoW's lifetime:
// a key like 0050-01-01 would make that loop run for ever.
function isWeekKey(mixed $week): bool
{
    if (!is_string($week)) {
        return false;
    }
    $date = DateTimeImmutable::createFromFormat('!Y-m-d', $week);
    $year = $date ? (int) $date->format('Y') : 0;
    return $date && $date->format('Y-m-d') === $week // also rejects overflow like 2026-99-99
        && $date->format('N') === '3'
        && $year >= 2004 && $year <= (int) date('Y') + 1;
}

function clampLevel(mixed $level, int $default): int
{
    return max(1, min(MAX_LEVEL, is_numeric($level) ? (int) $level : $default));
}

// Gold is only kept to the hundred: the amounts are rough guides, so the rest is dropped
// (1250 -> 1200, 99 -> 0).
function goldAmount(mixed $gold): int
{
    return intdiv(max(0, (int) $gold), 100) * 100;
}

function text(mixed $value): string
{
    return is_scalar($value) ? trim((string) $value) : '';
}

// Field rules shared by the edit forms and the import.
function characterFields(array $in): array
{
    $name = text($in['name'] ?? '');
    if ($name === '') {
        fail('Character name is required');
    }
    return [
        'name' => $name,
        'realm' => text($in['realm'] ?? ''),
        'class' => text($in['class'] ?? ''),
        'level' => clampLevel($in['level'] ?? null, 80),
    ];
}

function activityFields(array $in): array
{
    $name = text($in['name'] ?? '');
    if ($name === '') {
        fail('Activity name is required');
    }
    return [
        'name' => $name,
        'minLevel' => clampLevel($in['minLevel'] ?? null, 80),
        'notes' => text($in['notes'] ?? ''),
        'gold' => goldAmount(text($in['gold'] ?? 0)),
        'materials' => materialList($in['materials'] ?? []),
    ];
}

// ---------- Loot ----------
// An activity can list materials it drops that are sold on the Auction House (Naxxramas drops
// Wartorn Scrap and Frozen Runes). Each run records how many dropped, and each week has a price
// per material; app.js works out what they were worth (priceOf, lootValue).

function materialList(mixed $materials): array
{
    if (!is_array($materials) || !array_is_list($materials)) {
        fail('Bad materials');
    }
    $result = [];
    foreach ($materials as $material) {
        $id = is_array($material) ? ($material['id'] ?? null) : null;
        $name = is_array($material) ? text($material['name'] ?? '') : '';
        if (!isId($id, 'm') || $name === '' || in_array($id, array_column($result, 'id'), true)) {
            fail('Bad or duplicate material');
        }
        $result[] = ['id' => $id, 'name' => $name];
    }
    return $result;
}

// The activity form sends materials as comma-separated names. A name the activity already had
// keeps its id, so the counts and prices recorded for it stay attached; a renamed one starts afresh.
function materialsFromNames(mixed $names, array $existing): array
{
    $ids = [];
    foreach ($existing as $material) {
        $ids[strtolower($material['name'])] = $material['id'];
    }
    $result = [];
    foreach (explode(',', text($names)) as $name) {
        $name = trim($name);
        $key = strtolower($name);
        if ($name !== '' && !isset($result[$key])) {
            $result[$key] = ['id' => $ids[$key] ?? newId('m'), 'name' => $name];
        }
    }
    return array_values($result);
}

// What one run dropped: matId => count. Zero counts are left out, unless $keepZeros (a toggle
// uses them to remove a material).
function lootCounts(mixed $counts, bool $keepZeros = false): array
{
    if (!is_array($counts)) {
        fail('Bad loot');
    }
    $result = [];
    foreach ($counts as $matId => $count) {
        if (!isId($matId, 'm') || !is_int($count) || $count < 0) {
            fail("Bad loot count for \"$matId\"");
        }
        if ($count > 0 || $keepZeros) {
            $result[$matId] = $count;
        }
    }
    return $result;
}

// week => charId => actId => counts, validated like completions.
function normalizeLoot(mixed $loot): array
{
    $result = [];
    foreach ((array) $loot as $week => $chars) {
        if (!isWeekKey($week)) {
            fail("Bad week \"$week\" in loot");
        }
        foreach ((array) $chars as $charId => $runs) {
            if (!isId($charId, 'c')) {
                fail("Bad character id \"$charId\" in loot");
            }
            foreach ((array) $runs as $actId => $counts) {
                if (!isId($actId, 'a')) {
                    fail("Bad activity id \"$actId\" in loot");
                }
                if ($counts = lootCounts($counts)) {
                    $result[$week][$charId][$actId] = $counts;
                }
            }
        }
    }
    return $result;
}

// week => matId => gold per unit. A price holds until a later week sets another (priceOf in app.js).
function normalizePrices(mixed $prices): array
{
    $result = [];
    foreach ((array) $prices as $week => $materials) {
        if (!isWeekKey($week)) {
            fail("Bad week \"$week\" in prices");
        }
        foreach ((array) $materials as $matId => $price) {
            if (!isId($matId, 'm') || !is_int($price) || $price < 0) {
                fail("Bad price for \"$matId\" in week $week");
            }
            $result[$week][$matId] = $price;
        }
    }
    return $result;
}

// Removes $map[key1][key2]…, then any of its parents left empty.
function unsetPath(array &$map, array $keys): void
{
    $key = array_shift($keys);
    if (!isset($map[$key])) {
        return;
    }
    if ($keys) {
        unsetPath($map[$key], $keys);
        if ($map[$key]) {
            return;
        }
    }
    unset($map[$key]);
}

// Completions are stored as week => charId => [actId => gold]. Older data used a plain
// list of actIds; convert those with null gold, meaning "use the activity's default".
function normalizeCompletions(mixed $completions): array
{
    $result = [];
    foreach ((array) $completions as $week => $chars) {
        if (!isWeekKey($week)) {
            fail("Bad week \"$week\" in completions");
        }
        foreach ((array) $chars as $charId => $entries) {
            if (!isId($charId, 'c')) {
                fail("Bad character id \"$charId\" in completions");
            }
            $entries = (array) $entries;
            if (array_is_list($entries)) {
                $entries = array_fill_keys(array_filter($entries, 'is_string'), null);
            }
            foreach ($entries as $actId => $gold) {
                if (!isId($actId, 'a')) {
                    fail("Bad activity id \"$actId\" in completions");
                }
                $result[$week][$charId][$actId] = is_numeric($gold) ? max(0, (int) $gold) : null;
            }
        }
    }
    return $result;
}

// Deposits record the gold a character has taken to the bank: week => charId => [{gold, time}].
// A character can be deposited more than once a week (more activities after the first deposit),
// so app.js compares the sum with what the character earned that week.
function normalizeDeposits(mixed $deposits): array
{
    $result = [];
    foreach ((array) $deposits as $week => $chars) {
        if (!isWeekKey($week)) {
            fail("Bad week \"$week\" in deposits");
        }
        foreach ((array) $chars as $charId => $list) {
            if (!isId($charId, 'c') || !is_array($list) || !array_is_list($list)) {
                fail("Bad character id \"$charId\" in deposits");
            }
            foreach ($list as $deposit) {
                if (!is_int($deposit['gold'] ?? null) || $deposit['gold'] <= 0 || !is_int($deposit['time'] ?? null)) {
                    fail("Bad deposit for \"$charId\" in week $week");
                }
                $result[$week][$charId][] = ['gold' => $deposit['gold'], 'time' => $deposit['time']];
            }
        }
    }
    return $result;
}

// Weeks before depositsFrom were played before deposits were tracked, so app.js treats their gold
// as banked. Data from before this existed starts tracking at its lastWeek; a fresh file at once.
function depositsFrom(array $data): ?string
{
    $from = array_key_exists('depositsFrom', $data) ? $data['depositsFrom'] : ($data['lastWeek'] ?? null);
    if ($from !== null && !isWeekKey($from)) {
        fail('Bad depositsFrom "' . text($from) . '"');
    }
    return $from;
}

// ---------- Closed weeks ----------
// When a week closes, the characters (with their levels) and activities it had are kept as a
// snapshot, so later changes don't rewrite how a past week looks. The server doesn't know when
// the reset is (weekStart in app.js), so the page sends its current week with every request.
// lastWeek is the latest week a request came from. When a request arrives from a later week,
// the data hasn't changed since lastWeek ended, so it is saved as lastWeek's snapshot before the
// request changes anything. Weeks without a request in between had the same setup, so a snapshot
// covers every week from its key up to the next snapshot; identical ones are not stored twice.

function snapshotActivity(array $in): array
{
    // Unlike an edit, a snapshot keeps gold exactly as it was (see goldAmount).
    return array_merge(activityFields($in), ['gold' => max(0, (int) ($in['gold'] ?? 0))]);
}

function snapshotOf(array $setup): array
{
    return [
        'characters' => importItems($setup['characters'] ?? null, 'c', 'characterFields'),
        'activities' => importItems($setup['activities'] ?? null, 'a', 'snapshotActivity'),
    ];
}

function normalizeSnapshots(mixed $snapshots): array
{
    $result = [];
    foreach ((array) $snapshots as $week => $setup) {
        if (!isWeekKey($week) || !is_array($setup)) {
            fail("Bad week \"$week\" in snapshots");
        }
        $result[$week] = snapshotOf($setup);
    }
    ksort($result);
    return $result;
}

// Returns true when it changed $state.
function closeWeeks(array &$state, mixed $week): bool
{
    // A week key is a past Wednesday; the margin covers time zones ahead of the server's.
    if (!isWeekKey($week) || $week > date('Y-m-d', time() + 86400)) {
        return false;
    }
    $last = $state['lastWeek'] ?? null;
    if ($last !== null && $week <= $last) {
        return false;
    }
    if ($last !== null) {
        $snapshot = snapshotOf($state);
        if ($snapshot != (end($state['snapshots']) ?: null)) {
            $state['snapshots'][$last] = $snapshot;
            ksort($state['snapshots']);
        }
    }
    $state['lastWeek'] = $week;
    return true;
}

function importItems(mixed $items, string $prefix, callable $fields): array
{
    if (!is_array($items) || !array_is_list($items)) {
        fail('Not a Goldmaker data file');
    }
    $result = [];
    foreach ($items as $item) {
        $id = is_array($item) ? ($item['id'] ?? null) : null;
        if (!isId($id, $prefix) || in_array($id, array_column($result, 'id'), true)) {
            fail('Invalid or duplicate id in the imported file');
        }
        $result[] = ['id' => $id] + $fields($item);
    }
    return $result;
}

// Settings come from environment variables on the server, or from config.local.php locally.
function config(string $env, string $localKey): string
{
    static $local = null;
    $value = getenv($env);
    if ($value === false || $value === '') {
        $local ??= is_file(__DIR__ . '/config.local.php') ? (array) require __DIR__ . '/config.local.php' : [];
        $value = $local[$localKey] ?? '';
    }
    return is_string($value) ? $value : '';
}

// Reads the saved data under a shared lock, for work that must happen before taking the
// exclusive lock (see the "sync" action).
function readStateSnapshot(): array
{
    $lock = fopen(LOCK_FILE, 'c');
    flock($lock, LOCK_SH);
    $state = json_decode(@file_get_contents(DATA_FILE) ?: '', true);
    fclose($lock);
    return is_array($state) ? $state : [];
}

// A data file that exists but doesn't parse is an error, never an empty state: the next save
// would overwrite it and everything in it would be lost.
function loadState(): array
{
    $raw = is_file(DATA_FILE) ? file_get_contents(DATA_FILE) : '';
    if ($raw === false) {
        fail('Could not read the data file', 500);
    }
    $state = $raw === '' ? emptyState() : json_decode($raw, true);
    if (!is_array($state)) {
        fail('The data file is damaged (' . json_last_error_msg() . '). Nothing was changed; restore goldmaker.json from a backup.', 500);
    }
    $state += emptyState();
    $state['completions'] = normalizeCompletions($state['completions']);
    $state['snapshots'] = normalizeSnapshots($state['snapshots']);
    $state['deposits'] = normalizeDeposits($state['deposits']);
    $state['loot'] = normalizeLoot($state['loot']);
    $state['prices'] = normalizePrices($state['prices']);
    if (isset($state['lastWeek']) && !isWeekKey($state['lastWeek'])) {
        fail('Bad lastWeek "' . text($state['lastWeek']) . '" in the data file', 500);
    }
    return $state;
}

// Writes a temp file and renames it over the data file, so a crash or a full disk mid-write
// leaves the previous version in place instead of a truncated file.
function saveState(array $state): void
{
    try {
        $json = json_encode($state, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
    } catch (JsonException $e) {
        fail('Could not save the data: ' . $e->getMessage(), 500);
    }
    $tmp = DATA_FILE . '.tmp';
    $fh = @fopen($tmp, 'w');
    $written = $fh && fwrite($fh, $json) === strlen($json) && fflush($fh) && fsync($fh);
    if ($fh) {
        fclose($fh);
    }
    if (!$written || !@rename($tmp, DATA_FILE)) {
        @unlink($tmp);
        fail('Could not save the data file. Nothing was changed.', 500);
    }
}

// ---------- Auth ----------
// A single shared password from the environment (or config.local.php for local dev).
// The session cookie is "expiry.hmac", keyed by the password, so it survives restarts
// without server-side storage and changing the password signs everyone out.

function password(): string
{
    $pw = config('GOLDMAKER_PASSWORD', 'password');
    if ($pw === '') {
        fail('Login is not configured: set GOLDMAKER_PASSWORD', 503);
    }
    return $pw;
}

function sessionSignature(int $expires): string
{
    return hash_hmac('sha256', "session:$expires", password());
}

// Expiry of a valid session cookie, or null when not signed in.
function sessionExpiry(): ?int
{
    [$expires, $sig] = explode('.', (string) ($_COOKIE[SESSION_COOKIE] ?? ''), 2) + ['', ''];
    $valid = ctype_digit($expires) && (int) $expires > time()
        && hash_equals(sessionSignature((int) $expires), $sig);
    return $valid ? (int) $expires : null;
}

function setSessionCookie(string $value, int $expires): void
{
    // Behind Dokploy's Traefik, PHP sees plain HTTP, so trust the forwarded scheme too.
    $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https';
    setcookie(SESSION_COOKIE, $value, [
        'expires' => $expires,
        'path' => '/',
        'secure' => $https,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}

function signIn(): void
{
    $expires = time() + SESSION_TTL;
    setSessionCookie($expires . '.' . sessionSignature($expires), $expires);
}

// Failed logins are counted globally (not per IP, which the proxy hides), so a flood of
// guesses locks everyone out for FAILURE_WINDOW. Acceptable for a single-user app.
function login(mixed $given): void
{
    $fh = fopen(FAILURES_FILE, 'c+');
    flock($fh, LOCK_EX);
    $failures = array_filter(
        (array) json_decode(stream_get_contents($fh) ?: '[]', true),
        fn($t) => is_int($t) && $t > time() - FAILURE_WINDOW
    );
    if (count($failures) >= MAX_LOGIN_FAILURES) {
        fail('Too many failed logins, try again in a few minutes', 429);
    }
    $ok = is_string($given) && hash_equals(hash('sha256', password()), hash('sha256', $given));
    if (!$ok) {
        $failures[] = time();
    }
    ftruncate($fh, 0);
    rewind($fh);
    fwrite($fh, json_encode(array_values($failures)));
    fclose($fh);
    if (!$ok) {
        sleep(1);
        fail('Wrong password', 401);
    }
    signIn();
}

if (!is_dir(DATA_DIR)) {
    mkdir(DATA_DIR, 0770, true);
}

$action = $_GET['action'] ?? 'state';

// Anything but reading state must be a JSON POST: cross-site pages can't send that without
// a CORS preflight, and the SameSite=Lax cookie isn't sent on cross-site POSTs anyway.
if ($action !== 'state') {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        fail('POST required', 405);
    }
    if (!str_starts_with(strtolower($_SERVER['CONTENT_TYPE'] ?? ''), 'application/json')) {
        fail('JSON body required', 415);
    }
}
$in = json_decode(file_get_contents('php://input') ?: '{}', true);
if (!is_array($in)) {
    $in = [];
}

if ($action === 'login') {
    login($in['password'] ?? null);
    echo json_encode(['ok' => true]);
    exit;
}
if ($action === 'logout') {
    setSessionCookie('', 1);
    echo json_encode(['ok' => true]);
    exit;
}
$expires = sessionExpiry();
if ($expires === null) {
    fail('Not signed in', 401);
}
if ($expires - time() < SESSION_TTL / 2) {
    signIn(); // sliding expiry: regular use keeps you signed in
}

// Armory lookups can take seconds, so they run before the exclusive lock is taken; the
// results are applied by character id below, skipping anyone deleted in the meantime.
$armory = [];
$armoryError = null;
if ($action === 'sync') {
    if (!armoryConfigured()) {
        fail('Armory sync is not configured: set BLIZZARD_CLIENT_ID and BLIZZARD_CLIENT_SECRET');
    }
    try {
        $armory = fetchArmoryCharacters(readStateSnapshot()['characters'] ?? []);
    } catch (RuntimeException $e) {
        $armoryError = $e->getMessage();
    }
}

$lock = fopen(LOCK_FILE, 'c');
flock($lock, LOCK_EX);
$state = loadState();
// Before closeWeeks moves lastWeek on, so that tracking starts with the week the data was last used
// in. Until the next save this is worked out again on every load, with the same result.
$state['depositsFrom'] = depositsFrom($state);
$changed = closeWeeks($state, $_GET['week'] ?? null);

switch ($action) {
    case 'state':
        break;

    case 'saveCharacter':
        $char = characterFields($in);
        if (!empty($in['id'])) {
            $i = findIndex($state['characters'], $in['id']);
            $state['characters'][$i] = ['id' => $in['id']] + $char;
        } else {
            $state['characters'][] = ['id' => newId('c')] + $char;
        }
        break;

    case 'saveActivity':
        $i = empty($in['id']) ? null : findIndex($state['activities'], $in['id']);
        $materials = materialsFromNames($in['materials'] ?? '', $i === null ? [] : $state['activities'][$i]['materials'] ?? []);
        $act = activityFields(['materials' => $materials] + $in);
        if ($i !== null) {
            $state['activities'][$i] = ['id' => $in['id']] + $act;
        } else {
            $state['activities'][] = ['id' => newId('a')] + $act;
        }
        break;

    case 'delete':
        $type = $in['type'] ?? '';
        if (!in_array($type, ['characters', 'activities'], true)) {
            fail('Bad type');
        }
        $i = findIndex($state[$type], $in['id'] ?? null);
        array_splice($state[$type], $i, 1);
        // Completion history is kept on purpose; entries for deleted ids are simply ignored.
        break;

    case 'move':
        $type = $in['type'] ?? '';
        if (!in_array($type, ['characters', 'activities'], true)) {
            fail('Bad type');
        }
        $i = findIndex($state[$type], $in['id'] ?? null);
        $j = $i + (($in['dir'] ?? 0) < 0 ? -1 : 1);
        if ($j >= 0 && $j < count($state[$type])) {
            [$state[$type][$i], $state[$type][$j]] = [$state[$type][$j], $state[$type][$i]];
        }
        break;

    case 'toggle':
        $week = $in['week'] ?? null;
        $charId = $in['charId'] ?? null;
        $actId = $in['actId'] ?? null;
        if (!isWeekKey($week) || !isId($charId, 'c') || !isId($actId, 'a')) {
            fail('Bad toggle');
        }
        $entries = $state['completions'][$week][$charId] ?? [];
        if (!empty($in['done'])) {
            // Snapshot the gold so later changes to the activity's default don't rewrite history.
            // A run that's already done keeps its gold unless new gold is sent (a loot field saved).
            if (is_numeric($in['gold'] ?? null)) {
                $entries[$actId] = goldAmount($in['gold']);
            } elseif (!array_key_exists($actId, $entries)) {
                $act = $state['activities'][findIndex($state['activities'], $actId)];
                $entries[$actId] = (int) ($act['gold'] ?? 0);
            }
            // The Week page sends the loot fields one at a time, so only the materials sent change
            // and a count of 0 removes one. A plain tick leaves the loot as it was.
            if (array_key_exists('loot', $in)) {
                $counts = array_filter(array_replace($state['loot'][$week][$charId][$actId] ?? [], lootCounts($in['loot'], true)));
                if ($counts) {
                    $state['loot'][$week][$charId][$actId] = $counts;
                } else {
                    unsetPath($state['loot'], [$week, $charId, $actId]);
                }
            }
        } else {
            unset($entries[$actId]);
            unsetPath($state['loot'], [$week, $charId, $actId]);
        }
        if ($entries) {
            $state['completions'][$week][$charId] = $entries;
        } else {
            unset($state['completions'][$week][$charId]);
            if (empty($state['completions'][$week])) {
                unset($state['completions'][$week]);
            }
        }
        break;

    case 'deposit':
        // Adds a deposit of the given gold, or with "undo" removes the latest one.
        $week = $in['week'] ?? null;
        $charId = $in['charId'] ?? null;
        if (!isWeekKey($week) || !isId($charId, 'c')) {
            fail('Bad deposit');
        }
        $list = $state['deposits'][$week][$charId] ?? [];
        if (!empty($in['undo'])) {
            array_pop($list);
        } else {
            $gold = is_numeric($in['gold'] ?? null) ? (int) $in['gold'] : 0;
            if ($gold <= 0) {
                fail('Nothing to deposit');
            }
            $list[] = ['gold' => $gold, 'time' => time()];
        }
        if ($list) {
            $state['deposits'][$week][$charId] = $list;
        } else {
            unset($state['deposits'][$week][$charId]);
            if (empty($state['deposits'][$week])) {
                unset($state['deposits'][$week]);
            }
        }
        break;

    case 'price':
        // Sets a material's price for a week, or with a null price removes it, so the week goes
        // back to the price before it.
        $week = $in['week'] ?? null;
        $matId = $in['matId'] ?? null;
        $price = $in['price'] ?? null;
        if (!isWeekKey($week) || !isId($matId, 'm') || ($price !== null && (!is_numeric($price) || $price < 0))) {
            fail('Bad price');
        }
        if ($price === null) {
            unsetPath($state['prices'], [$week, $matId]);
        } else {
            $state['prices'][$week][$matId] = (int) round((float) $price);
        }
        break;

    case 'import':
        // Replaces everything with an uploaded goldmaker.json. The old file is kept as a backup
        // next to it; lastSync is dropped so the page re-syncs levels from the armory.
        $data = $in['data'] ?? null;
        if (!is_array($data)) {
            fail('Not a Goldmaker data file');
        }
        $imported = [
            'characters' => importItems($data['characters'] ?? null, 'c', 'characterFields'),
            'activities' => importItems($data['activities'] ?? null, 'a', 'activityFields'),
            'completions' => normalizeCompletions($data['completions'] ?? []),
            'snapshots' => normalizeSnapshots($data['snapshots'] ?? []),
            'deposits' => normalizeDeposits($data['deposits'] ?? []),
            'depositsFrom' => depositsFrom($data),
            'loot' => normalizeLoot($data['loot'] ?? []),
            'prices' => normalizePrices($data['prices'] ?? []),
        ];
        if (isWeekKey($data['lastWeek'] ?? null)) {
            // The next request closes the file's last week with the imported setup.
            $imported['lastWeek'] = $data['lastWeek'];
        }
        if (is_file(DATA_FILE) && !@copy(DATA_FILE, DATA_DIR . '/backup-' . date('Y-m-d-His') . '.json')) {
            fail('Could not back up the current data, so nothing was imported', 500);
        }
        $state = $imported;
        break;

    case 'sync':
        foreach ($state['characters'] as &$char) {
            $result = $armory[$char['id']] ?? null;
            if ($result === null) {
                continue; // added while the lookup ran, or the whole sync failed
            }
            unset($char['syncError']);
            if (isset($result['error'])) {
                $char['syncError'] = $result['error'];
                continue;
            }
            $char['level'] = clampLevel($result['level'], $char['level']);
            if ($result['class'] !== '') {
                $char['class'] = $result['class'];
            }
        }
        unset($char);
        // Set even when the sync failed, so a broken setup isn't retried on every page load.
        $state['lastSync'] = time();
        $state['lastSyncError'] = $armoryError;
        break;

    default:
        fail('Unknown action');
}

if ($action !== 'state' || $changed) {
    saveState($state);
}
flock($lock, LOCK_UN);
fclose($lock);

$state['completions'] = (object) $state['completions'];
$state['snapshots'] = (object) $state['snapshots'];
$state['deposits'] = (object) $state['deposits'];
$state['loot'] = (object) $state['loot'];
$state['prices'] = (object) $state['prices'];
$state['armoryEnabled'] = armoryConfigured();
$state['autoSyncInterval'] = AUTO_SYNC_INTERVAL;
echo json_encode($state);
