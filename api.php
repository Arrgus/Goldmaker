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

// ---------- Auth ----------
// A single shared password from the environment (or config.local.php for local dev).
// The session cookie is "expiry.hmac", keyed by the password, so it survives restarts
// without server-side storage and changing the password signs everyone out.

function password(): string
{
    $pw = getenv('GOLDMAKER_PASSWORD');
    if (($pw === false || $pw === '') && is_file(__DIR__ . '/config.local.php')) {
        $pw = (require __DIR__ . '/config.local.php')['password'] ?? '';
    }
    if (!is_string($pw) || $pw === '') {
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

$fh = fopen(DATA_FILE, 'c+');
flock($fh, LOCK_EX);
$raw = stream_get_contents($fh);
$state = $raw ? json_decode($raw, true) : null;
if (!is_array($state)) {
    $state = emptyState();
}
$state['completions'] = (array) ($state['completions'] ?? []);

// Completions are stored as week => charId => [actId => gold]. Older data used a plain
// list of actIds; convert those with null gold, meaning "use the activity's default".
foreach ($state['completions'] as $week => $chars) {
    foreach ((array) $chars as $charId => $entries) {
        if (array_is_list($entries)) {
            $state['completions'][$week][$charId] = array_fill_keys($entries, null);
        }
    }
}

switch ($action) {
    case 'state':
        break;

    case 'saveCharacter':
        $name = trim((string) ($in['name'] ?? ''));
        if ($name === '') {
            fail('Name is required');
        }
        $char = [
            'name' => $name,
            'realm' => trim((string) ($in['realm'] ?? '')),
            'class' => (string) ($in['class'] ?? ''),
            'level' => max(1, min(90, (int) ($in['level'] ?? 80))),
        ];
        if (!empty($in['id'])) {
            $i = findIndex($state['characters'], $in['id']);
            $state['characters'][$i] = ['id' => $in['id']] + $char;
        } else {
            $state['characters'][] = ['id' => newId('c')] + $char;
        }
        break;

    case 'saveActivity':
        $name = trim((string) ($in['name'] ?? ''));
        if ($name === '') {
            fail('Name is required');
        }
        $act = [
            'name' => $name,
            'minLevel' => max(1, min(90, (int) ($in['minLevel'] ?? 80))),
            'notes' => trim((string) ($in['notes'] ?? '')),
            'gold' => max(0, (int) ($in['gold'] ?? 0)),
        ];
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
echo json_encode($state);
