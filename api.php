<?php
declare(strict_types=1);

// In Docker the data lives outside the web root; locally it defaults to ./data (blocked by data/.htaccess).
define('DATA_DIR', getenv('GOLDMAKER_DATA_DIR') ?: __DIR__ . '/data');
const DATA_FILE = DATA_DIR . '/goldmaker.json';
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
    return ['characters' => [], 'activities' => [], 'completions' => new stdClass()];
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

function findIndex(array $items, string $id): int
{
    foreach ($items as $i => $item) {
        if ($item['id'] === $id) {
            return $i;
        }
    }
    fail('Not found', 404);
}

function isWeekKey(mixed $week): bool
{
    return is_string($week) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $week) === 1;
}

function clampLevel(mixed $level, int $default): int
{
    return max(1, min(MAX_LEVEL, is_numeric($level) ? (int) $level : $default));
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
        'gold' => max(0, (int) text($in['gold'] ?? 0)),
    ];
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
            $entries = (array) $entries;
            if (array_is_list($entries)) {
                $entries = array_fill_keys(array_filter($entries, 'is_string'), null);
            }
            foreach ($entries as $actId => $gold) {
                $result[$week][$charId][$actId] = is_numeric($gold) ? max(0, (int) $gold) : null;
            }
        }
    }
    return $result;
}

// Imported ids must look like ours: they end up in HTML attributes unescaped.
function importItems(mixed $items, string $prefix, callable $fields): array
{
    if (!is_array($items) || !array_is_list($items)) {
        fail('Not a Goldmaker data file');
    }
    $result = [];
    foreach ($items as $item) {
        $id = is_array($item) ? ($item['id'] ?? null) : null;
        if (!is_string($id) || !preg_match("/^{$prefix}[0-9a-f]+\\z/", $id) || in_array($id, array_column($result, 'id'), true)) {
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
    $fh = @fopen(DATA_FILE, 'r');
    if (!$fh) {
        return [];
    }
    flock($fh, LOCK_SH);
    $state = json_decode(stream_get_contents($fh) ?: '', true);
    fclose($fh);
    return is_array($state) ? $state : [];
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

$fh = fopen(DATA_FILE, 'c+');
flock($fh, LOCK_EX);
$raw = stream_get_contents($fh);
$state = $raw ? json_decode($raw, true) : null;
if (!is_array($state)) {
    $state = emptyState();
}
$state['completions'] = normalizeCompletions($state['completions'] ?? []);

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
        $act = activityFields($in);
        if (!empty($in['id'])) {
            $i = findIndex($state['activities'], $in['id']);
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
        $i = findIndex($state[$type], (string) ($in['id'] ?? ''));
        array_splice($state[$type], $i, 1);
        // Completion history is kept on purpose; entries for deleted ids are simply ignored.
        break;

    case 'move':
        $type = $in['type'] ?? '';
        if (!in_array($type, ['characters', 'activities'], true)) {
            fail('Bad type');
        }
        $i = findIndex($state[$type], (string) ($in['id'] ?? ''));
        $j = $i + (($in['dir'] ?? 0) < 0 ? -1 : 1);
        if ($j >= 0 && $j < count($state[$type])) {
            [$state[$type][$i], $state[$type][$j]] = [$state[$type][$j], $state[$type][$i]];
        }
        break;

    case 'toggle':
        $week = $in['week'] ?? null;
        $charId = (string) ($in['charId'] ?? '');
        $actId = (string) ($in['actId'] ?? '');
        if (!isWeekKey($week) || $charId === '' || $actId === '') {
            fail('Bad toggle');
        }
        $entries = $state['completions'][$week][$charId] ?? [];
        if (!empty($in['done'])) {
            // Snapshot the gold so later changes to the activity's default don't rewrite history.
            if (is_numeric($in['gold'] ?? null)) {
                $gold = max(0, (int) $in['gold']);
            } else {
                $act = $state['activities'][findIndex($state['activities'], $actId)];
                $gold = (int) ($act['gold'] ?? 0);
            }
            $entries[$actId] = $gold;
        } else {
            unset($entries[$actId]);
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
        ];
        if ($raw) {
            file_put_contents(DATA_DIR . '/backup-' . date('Y-m-d-His') . '.json', $raw);
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

if ($action !== 'state') {
    ftruncate($fh, 0);
    rewind($fh);
    fwrite($fh, json_encode($state, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
    fflush($fh);
}
flock($fh, LOCK_UN);
fclose($fh);

$state['completions'] = (object) $state['completions'];
$state['armoryEnabled'] = armoryConfigured();
$state['autoSyncInterval'] = AUTO_SYNC_INTERVAL;
echo json_encode($state);
