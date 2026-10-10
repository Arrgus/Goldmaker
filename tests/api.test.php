<?php
// End-to-end checks for api.php. It runs under `php -S` from a throwaway copy of the site with a
// fresh data folder in the system temp dir, so config.local.php, real data and Battle.net are
// never involved. Needs PHP 8.1+ with the curl extension.
//
//   php tests/api.test.php
declare(strict_types=1);

const PASSWORD = 'test-password';

$tmp = sys_get_temp_dir() . '/goldmaker-test-' . bin2hex(random_bytes(4));
$dataDir = "$tmp/data";
$dataFile = "$dataDir/goldmaker.json";
mkdir("$tmp/site", 0777, true);
mkdir($dataDir);
foreach (['api.php', 'armory.php'] as $file) {
    copy(dirname(__DIR__) . "/$file", "$tmp/site/$file");
}

function removeTree(string $dir): void
{
    $items = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::CHILD_FIRST
    );
    foreach ($items as $item) {
        $item->isDir() ? rmdir($item->getPathname()) : unlink($item->getPathname());
    }
    rmdir($dir);
}

// ---------- Server ----------

$probe = stream_socket_server('tcp://127.0.0.1:0');
$port = (int) substr(strrchr(stream_socket_get_name($probe, false), ':'), 1);
fclose($probe);

$log = fopen("$tmp/server.log", 'w');
$server = proc_open(
    [PHP_BINARY, '-S', "127.0.0.1:$port", '-t', "$tmp/site"],
    [0 => ['pipe', 'r'], 1 => $log, 2 => $log],
    $pipes,
    "$tmp/site",
    // Empty Blizzard settings keep the armory sync switched off.
    ['GOLDMAKER_DATA_DIR' => $dataDir, 'GOLDMAKER_PASSWORD' => PASSWORD,
        'BLIZZARD_CLIENT_ID' => '', 'BLIZZARD_CLIENT_SECRET' => ''] + getenv()
);
register_shutdown_function(function () use ($server, $pipes, $log, $tmp) {
    fclose($pipes[0]);
    proc_terminate($server);
    proc_close($server);
    fclose($log);
    removeTree($tmp);
});

$ready = false;
for ($i = 0; $i < 50 && !$ready; $i++) {
    usleep(100_000);
    $ready = (bool) @fsockopen('127.0.0.1', $port);
}
if (!$ready) {
    fwrite(STDERR, "The test server didn't start:\n" . file_get_contents("$tmp/server.log"));
    exit(1);
}

// ---------- Helpers ----------

// Requests share one cookie jar, like a browser tab.
$cookies = curl_share_init();
curl_share_setopt($cookies, CURLSHOPT_SHARE, CURL_LOCK_DATA_COOKIE);

function request(string $action, mixed $body = null, bool $signedIn = true, array $options = []): CurlHandle
{
    global $port, $cookies;
    $ch = curl_init("http://127.0.0.1:$port/api.php?action=$action");
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_HTTPHEADER => ['Content-Type: application/json']]);
    if ($signedIn) {
        curl_setopt_array($ch, [CURLOPT_SHARE => $cookies, CURLOPT_COOKIEFILE => '']);
    }
    if ($body !== null) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, is_string($body) ? $body : json_encode($body));
    }
    curl_setopt_array($ch, $options);
    return $ch;
}

/** @return array{int, mixed} HTTP status and the decoded reply (null when it isn't JSON) */
function call(string $action, mixed $body = null, bool $signedIn = true, array $options = []): array
{
    $ch = request($action, $body, $signedIn, $options);
    $reply = curl_exec($ch);
    return [curl_getinfo($ch, CURLINFO_RESPONSE_CODE), json_decode((string) $reply, true)];
}

$failed = 0;

function check(string $name, bool $ok, mixed $got = null): void
{
    global $failed;
    if (!$ok) {
        $failed++;
    }
    echo $ok ? 'PASS  ' : 'FAIL  ', $name, $ok || $got === null ? '' : '  (got ' . json_encode($got) . ')', "\n";
}

// ---------- Signing in ----------

[$status] = call('state', signedIn: false);
check('state needs a session', $status === 401, $status);
[$status] = call('login', ['password' => 'wrong']);
check('a wrong password is refused', $status === 401, $status);
[$status] = call('login', ['password' => PASSWORD]);
check('the right password signs in', $status === 200, $status);
[$status] = call('saveCharacter');
check('changes must be POSTs', $status === 405, $status);
[$status] = call('saveCharacter', '{"name":"x"}', options: [CURLOPT_HTTPHEADER => ['Content-Type: text/plain']]);
check('changes must be sent as JSON (CSRF defence)', $status === 415, $status);

// ---------- Fresh start ----------

[$status, $state] = call('state');
check('a missing data file is a fresh start', $status === 200 && $state['characters'] === [], [$status, $state]);
check("reading doesn't create the data file", !file_exists($dataFile));

// ---------- Characters and activities ----------

[, $state] = call('saveCharacter', ['id' => '', 'name' => 'Alt', 'realm' => 'ColinasPardas', 'class' => 'Mage', 'level' => '200']);
$char = $state['characters'][0];
check('a new character gets a c… id', (bool) preg_match('/^c[0-9a-f]+$/', $char['id']), $char);
check('levels are clamped to the cap', $char['level'] === 90, $char['level']);

[, $state] = call('saveActivity', ['id' => '', 'name' => 'Weekly', 'minLevel' => '80', 'gold' => '1250', 'notes' => '']);
$act = $state['activities'][0];
check('activity gold drops anything below the hundred', $act['gold'] === 1200, $act['gold']);

[, $state] = call('saveCharacter', ['id' => $char['id'], 'name' => 'Renamed', 'level' => 85]);
check('editing keeps the id', $state['characters'][0]['id'] === $char['id'] && $state['characters'][0]['name'] === 'Renamed', $state['characters']);
foreach ([5, ['x'], 'c0000'] as $id) {
    [$status, $reply] = call('saveCharacter', ['id' => $id, 'name' => 'x']);
    check('saving with the id ' . json_encode($id) . ' is a clean 404', $status === 404 && isset($reply['error']), [$status, $reply]);
}

// ---------- Ticking cells ----------

$week = '2026-09-23';
$tick = fn(array $extra = []) => call('toggle', ['week' => $week, 'charId' => $char['id'], 'actId' => $act['id'], 'done' => true] + $extra);
$cellGold = fn(array $state) => $state['completions'][$week][$char['id']][$act['id']] ?? null;

[, $state] = $tick(['gold' => 1950]);
check('cell gold drops anything below the hundred', $cellGold($state) === 1900, $state['completions']);
[, $state] = $tick();
check('ticking a done cell again without gold keeps its gold', $cellGold($state) === 1900, $state['completions']);
$untick = fn() => call('toggle', ['week' => $week, 'charId' => $char['id'], 'actId' => $act['id'], 'done' => false]);
[, $state] = $untick();
check('unticking removes the entry', $state['completions'] === [], $state['completions']);
[, $state] = $tick();
check("ticking without gold snapshots the activity's default", $cellGold($state) === 1200, $state['completions']);
$untick();

$tooLate = (new DateTimeImmutable('first wednesday of january ' . ((int) date('Y') + 2)))->format('Y-m-d');
foreach (['0050-01-01', '2026-99-99', '2026-09-24', '2003-12-31', $tooLate, 20260923] as $badWeek) {
    [$status] = call('toggle', ['week' => $badWeek, 'charId' => $char['id'], 'actId' => $act['id'], 'done' => true, 'gold' => 100]);
    check('the week key ' . json_encode($badWeek) . ' is refused', $status === 400, $status);
}
[$status] = call('toggle', ['week' => '2004-12-01', 'charId' => $char['id'], 'actId' => $act['id'], 'done' => true, 'gold' => 100]);
check('an old but valid week is accepted', $status === 200, $status);
call('toggle', ['week' => '2004-12-01', 'charId' => $char['id'], 'actId' => $act['id'], 'done' => false]);

foreach ([['0', $act['id']], ['a123', $act['id']], [5, $act['id']], [$char['id'], 'a12G'], [$char['id'], $char['id']]] as [$charId, $actId]) {
    [$status] = call('toggle', ['week' => $week, 'charId' => $charId, 'actId' => $actId, 'done' => true, 'gold' => 100]);
    check('the ids ' . json_encode([$charId, $actId]) . ' are refused', $status === 400, $status);
}

// ---------- Moving and deleting ----------

call('saveCharacter', ['name' => 'Second']);
[, $state] = call('move', ['type' => 'characters', 'id' => $char['id'], 'dir' => 1]);
check('move swaps neighbours', array_column($state['characters'], 'name') === ['Second', 'Renamed'], array_column($state['characters'], 'name'));
[, $state] = call('delete', ['type' => 'characters', 'id' => $state['characters'][0]['id']]);
check('delete removes the character', array_column($state['characters'], 'name') === ['Renamed'], array_column($state['characters'], 'name'));

// ---------- Import ----------

$tick(['gold' => 500]);
$export = json_decode(file_get_contents($dataFile), true);
[$status, $state] = call('import', ['data' => $export]);
check('importing a saved file works', $status === 200 && $state['characters'] === $export['characters'], $status);
check('the import keeps a backup of the old file', count(glob("$dataDir/backup-*.json")) === 1);

$before = file_get_contents($dataFile);
$badId = $export;
$badId['completions'][$week] = ['cXYZ' => [$act['id'] => 100]];
$badWeek = $export;
$badWeek['completions'] = ['0050-01-01' => $export['completions'][$week]];
foreach (['a bad completion id' => $badId, 'a bad week' => $badWeek] as $what => $data) {
    [$status] = call('import', ['data' => $data]);
    check("an import with $what is refused and changes nothing", $status === 400 && file_get_contents($dataFile) === $before, $status);
}

// ---------- Simultaneous saves ----------

$multi = curl_multi_init();
$handles = [];
for ($i = 1; $i <= 10; $i++) {
    $handles[] = $ch = request('saveCharacter', ['name' => "Parallel $i"]);
    curl_multi_add_handle($multi, $ch);
}
do {
    curl_multi_exec($multi, $running);
    if ($running) {
        curl_multi_select($multi);
    }
} while ($running);
$statuses = array_map(fn($ch) => curl_getinfo($ch, CURLINFO_RESPONSE_CODE), $handles);
$names = array_column(json_decode(file_get_contents($dataFile), true)['characters'], 'name');
check('10 simultaneous saves all land', array_unique($statuses) === [200] && count(preg_grep('/^Parallel /', $names)) === 10, $statuses);
check('no temp file is left behind', glob("$dataDir/*.tmp") === []);

// ---------- Damaged or empty data file ----------

$good = file_get_contents($dataFile);
$damaged = substr($good, 0, 200);
file_put_contents($dataFile, $damaged);
[$status, $reply] = call('state');
check('a damaged data file is an error, not an empty state', $status === 500 && str_contains($reply['error'] ?? '', 'damaged'), [$status, $reply]);
[$status] = call('saveCharacter', ['name' => 'x']);
check('a damaged data file is never overwritten', $status === 500 && file_get_contents($dataFile) === $damaged, $status);
file_put_contents($dataFile, '');
[$status, $state] = call('state');
check('an empty data file is a fresh start', $status === 200 && $state['characters'] === [], [$status, $state]);
file_put_contents($dataFile, $good);

// ---------- Closing weeks ----------

[, $state] = call('saveCharacter', ['name' => 'Leveler', 'level' => 80]);
$leveler = end($state['characters'])['id'];
$levelIn = fn(array $state, string $week) => array_column($state['snapshots'][$week]['characters'] ?? [], 'level', 'id')[$leveler] ?? null;

[, $state] = call('state&week=2026-09-02');
check('the first request only records the week', $state['lastWeek'] === '2026-09-02' && $state['snapshots'] === [], $state['lastWeek'] ?? null);
call('saveCharacter', ['id' => $leveler, 'name' => 'Leveler', 'level' => 85]);
[, $state] = call('state&week=2026-09-09');
check('a new week keeps the old one as a snapshot', $levelIn($state, '2026-09-02') === 85, $state['snapshots']);
check('closing a week is saved, even on a read', isset(json_decode(file_get_contents($dataFile), true)['snapshots']['2026-09-02']));
[, $state] = call('saveCharacter', ['id' => $leveler, 'name' => 'Leveler', 'level' => 90, 'week' => '2026-09-09']);
check('changes after the reset leave the closed week alone', $levelIn($state, '2026-09-02') === 85, $state['snapshots']);
[, $state] = call('state&week=2026-09-02');
check('a request from an older week closes nothing', $state['lastWeek'] === '2026-09-09' && count($state['snapshots']) === 1, $state['lastWeek']);
[, $state] = call('state&week=2026-09-16');
check('the next week gets its own snapshot', $levelIn($state, '2026-09-09') === 90, $state['snapshots']);
[, $state] = call('state&week=2026-09-23');
check('an unchanged week is not stored again', count($state['snapshots']) === 2 && $state['lastWeek'] === '2026-09-23', array_keys($state['snapshots']));
[, $state] = call("state&week=$tooLate");
check('a week in the future is ignored', $state['lastWeek'] === '2026-09-23', $state['lastWeek']);

$export = json_decode(file_get_contents($dataFile), true);
[$status, $state] = call('import', ['data' => $export]);
check('an import keeps the snapshots', $status === 200 && $levelIn($state, '2026-09-02') === 85 && $state['lastWeek'] === '2026-09-23', $status);
$before = file_get_contents($dataFile);
$badSnapshot = $export;
$badSnapshot['snapshots']['2026-09-02']['characters'][0]['id'] = 'cXYZ';
[$status] = call('import', ['data' => $badSnapshot]);
check('an import with a bad snapshot id is refused', $status === 400 && file_get_contents($dataFile) === $before, $status);

// ---------- Deposits ----------

check('a fresh data file tracks deposits from the start', $state['depositsFrom'] === null, $state['depositsFrom'] ?? 'missing');
$old = json_decode(file_get_contents($dataFile), true);
unset($old['depositsFrom']);
file_put_contents($dataFile, json_encode($old));
[, $state] = call('state&week=2026-09-30');
check('data from before deposits starts tracking at its lastWeek', $state['depositsFrom'] === '2026-09-23', $state['depositsFrom'] ?? null);
$deposit = fn(array $extra) => call('deposit', $extra + ['week' => $week, 'charId' => $char['id']]);
$depositGold = fn(array $state) => array_column($state['deposits'][$week][$char['id']] ?? [], 'gold');
$deposit(['gold' => 1200]);
[, $state] = $deposit(['gold' => 1250]);
check('deposits add up as a list, kept to the gold', $depositGold($state) === [1200, 1250], $state['deposits']);
[, $state] = $deposit(['undo' => true]);
check('undo removes the latest deposit', $depositGold($state) === [1200], $state['deposits']);
[, $state] = $deposit(['undo' => true]);
check('undoing the last one removes the week', $state['deposits'] === [], $state['deposits']);
foreach ([['gold' => 0], ['gold' => 'x'], ['gold' => 100, 'charId' => 'cXYZ'], ['gold' => 100, 'week' => '2026-09-24']] as $bad) {
    [$status] = $deposit($bad);
    check('the deposit ' . json_encode($bad) . ' is refused', $status === 400, $status);
}

[, $state] = $deposit(['gold' => 500]);
$export = json_decode(file_get_contents($dataFile), true);
[$status, $state] = call('import', ['data' => $export]);
check('an import keeps deposits and depositsFrom', $status === 200 && $depositGold($state) === [500] && $state['depositsFrom'] === '2026-09-23', $status);
$before = file_get_contents($dataFile);
$badDeposit = $export;
$badDeposit['deposits'][$week][$char['id']][0]['gold'] = -5;
[$status] = call('import', ['data' => $badDeposit]);
check('an import with a bad deposit is refused', $status === 400 && file_get_contents($dataFile) === $before, $status);
$fresh = $export;
unset($fresh['depositsFrom'], $fresh['lastWeek']);
[, $state] = call('import', ['data' => $fresh]);
check('a file without lastWeek tracks deposits from the start', $state['depositsFrom'] === null, $state['depositsFrom'] ?? 'missing');

// ---------- Loot ----------

$naxxFields = ['name' => 'Naxxramas', 'minLevel' => '1', 'gold' => '300'];
[, $state] = call('saveActivity', $naxxFields + ['materials' => 'Wartorn Scrap, Frozen Rune, wartorn scrap, ']);
$naxx = end($state['activities']);
check('materials get m… ids, without repeats', array_column($naxx['materials'], 'name') === ['Wartorn Scrap', 'Frozen Rune']
    && count(preg_grep('/^m[0-9a-f]+$/', array_column($naxx['materials'], 'id'))) === 2, $naxx['materials']);
[$scrap, $rune] = array_column($naxx['materials'], 'id');
[, $state] = call('saveActivity', $naxxFields + ['id' => $naxx['id'], 'materials' => 'frozen rune, Wartorn Scrap, Gem']);
$mats = end($state['activities'])['materials'];
check('editing keeps the ids of the materials still listed', $mats[0]['id'] === $rune && $mats[1]['id'] === $scrap
    && !in_array($mats[2]['id'], [$scrap, $rune], true) && $mats[0]['name'] === 'frozen rune', $mats);

$run = fn(array $extra) => call('toggle', $extra + ['week' => $week, 'charId' => $char['id'], 'actId' => $naxx['id'], 'done' => true]);
$lootIn = fn(array $state) => $state['loot'][$week][$char['id']][$naxx['id']] ?? null;
[, $state] = $run(['loot' => [$scrap => 12, $rune => 0]]);
check('a run keeps its loot, without zero counts', $lootIn($state) === [$scrap => 12], $state['loot']);
check("a run without gold gets the activity's default", $state['completions'][$week][$char['id']][$naxx['id']] === 300, $state['completions']);
[, $state] = $run(['gold' => 500]);
check('ticking again without loot leaves the loot alone', $lootIn($state) === [$scrap => 12], $state['loot']);
[, $state] = $run(['loot' => [$rune => 2]]);
check('only the materials sent change', $lootIn($state) === [$scrap => 12, $rune => 2], $state['loot']);
check('a done run keeps its gold when no gold is sent', $state['completions'][$week][$char['id']][$naxx['id']] === 500, $state['completions']);
[, $state] = $run(['gold' => 350]);
check('the vendor gold of an activity with loot is kept as sent', $state['completions'][$week][$char['id']][$naxx['id']] === 350, $state['completions']);
[, $state] = $run(['loot' => [$scrap => 0]]);
check('a count of 0 removes a material', $lootIn($state) === [$rune => 2], $state['loot']);
[, $state] = $run(['loot' => [$rune => 0]]);
check('a run with no loot left has none', $state['loot'] === [], $state['loot']);
$run(['loot' => [$scrap => 3]]);
[, $state] = $run(['done' => false]);
check('unticking a run removes its loot', $state['loot'] === [], $state['loot']);
foreach ([[$scrap => -1], [$scrap => 1.5], [$scrap => '3'], ['m12G' => 1], 'x'] as $bad) {
    [$status] = $run(['loot' => $bad]);
    check('the loot ' . json_encode($bad) . ' is refused', $status === 400, $status);
}

$price = fn(array $extra) => call('price', $extra + ['week' => $week, 'matId' => $scrap]);
[, $state] = $price(['price' => 450]);
check('a price is kept per week', $state['prices'] === [$week => [$scrap => 450]], $state['prices']);
[, $state] = $price(['price' => '1200.4']);
check('prices are whole gold', ($state['prices'][$week][$scrap] ?? null) === 1200, $state['prices']);
[, $state] = $price(['price' => null]);
check('a null price removes the week\'s price', $state['prices'] === [], $state['prices']);
foreach ([['price' => -1], ['price' => 'x'], ['price' => 5, 'matId' => 'a123'], ['price' => 5, 'week' => '2026-09-24']] as $bad) {
    [$status] = $price($bad);
    check('the price ' . json_encode($bad) . ' is refused', $status === 400, $status);
}

$run(['loot' => [$scrap => 7]]);
$price(['price' => 450]);
$export = json_decode(file_get_contents($dataFile), true);
[$status, $state] = call('import', ['data' => $export]);
check('an import keeps materials, loot and prices', $status === 200 && $lootIn($state) === [$scrap => 7]
    && $state['prices'] === [$week => [$scrap => 450]] && end($state['activities'])['materials'] === $mats, $status);
$before = file_get_contents($dataFile);
$badLoot = $export;
$badLoot['loot'][$week][$char['id']][$naxx['id']] = [$scrap => -2];
$badPrice = $export;
$badPrice['prices'][$week][$scrap] = 'cheap';
$badMaterial = $export;
$badMaterial['activities'][array_key_last($export['activities'])]['materials'][0]['id'] = 'mXYZ';
foreach (['bad loot' => $badLoot, 'a bad price' => $badPrice, 'a bad material id' => $badMaterial] as $what => $data) {
    [$status] = call('import', ['data' => $data]);
    check("an import with $what is refused", $status === 400 && file_get_contents($dataFile) === $before, $status);
}

call('state&week=2026-09-23');
[, $state] = call('state&week=2026-09-30');
$closed = array_column($state['snapshots']['2026-09-23']['activities'] ?? [], 'materials', 'id')[$naxx['id']] ?? null;
check('a closed week keeps its materials', $closed === $mats, $state['snapshots']);

// ---------- Gold on hand ----------

[, $state] = call('gold', ['gold' => '1500000.4']);
check('the bank count is whole gold, with the time it was typed in', $state['bank']['gold'] === 1500000 && is_int($state['bank']['time']), $state['bank']);
[, $state] = $deposit(['gold' => 2000]);
check('a deposit adds to the bank', $state['bank']['gold'] === 1502000, $state['bank']);
[, $state] = $deposit(['undo' => true]);
check('undoing a deposit takes it off the bank', $state['bank']['gold'] === 1500000, $state['bank']);
[, $state] = call('gold', ['charId' => $char['id'], 'gold' => 12345]);
check("a character's gold is kept as typed", $state['charGold'][$char['id']]['gold'] === 12345, $state['charGold']);
foreach ([['gold' => -1], ['gold' => 'x'], ['charId' => 'a123', 'gold' => 5], ['charId' => 5, 'gold' => 5]] as $bad) {
    [$status] = call('gold', $bad);
    check('the gold ' . json_encode($bad) . ' is refused', $status === 400, $status);
}
[$status] = call('gold', ['charId' => 'c0000', 'gold' => 5]);
check('gold for an unknown character is a 404', $status === 404, $status);
$export = json_decode(file_get_contents($dataFile), true);
[$status, $state] = call('import', ['data' => $export]);
check('an import keeps the gold counts', $status === 200 && $state['bank']['gold'] === 1500000
    && $state['charGold'][$char['id']]['gold'] === 12345, $status);
$before = file_get_contents($dataFile);
$badGold = $export;
$badGold['charGold'][$char['id']]['gold'] = -3;
[$status] = call('import', ['data' => $badGold]);
check('an import with a bad gold count is refused', $status === 400 && file_get_contents($dataFile) === $before, $status);
[, $state] = call('gold', ['charId' => $char['id'], 'gold' => null]);
check("null clears a character's gold", $state['charGold'] === [], $state['charGold']);
call('gold', ['charId' => $char['id'], 'gold' => 100]);
[, $state] = call('delete', ['type' => 'characters', 'id' => $char['id']]);
check('deleting a character drops its gold', $state['charGold'] === [], $state['charGold']);
[, $state] = call('gold', ['gold' => null]);
check('null clears the bank', $state['bank'] === null, $state['bank']);
[, $state] = call('deposit', ['week' => $week, 'charId' => $char['id'], 'gold' => 700]);
check('a deposit with no bank count starts one', $state['bank'] === ['gold' => 700, 'time' => null], $state['bank']);

// ---------- Goals ----------

[, $state] = call('state');
check('a file without goals has none', $state['goals'] === [], $state['goals']);
[, $state] = call('goal', ['add' => true, 'name' => '  Mount  ', 'gold' => '2500000']);
call('goal', ['add' => true, 'name' => 'Pet', 'gold' => 400000]);
[, $state] = call('goal', ['add' => true, 'gold' => 1e6]);
check('goals are added at the end, with g… ids', array_column($state['goals'], 'name') === ['Mount', 'Pet', '']
    && array_column($state['goals'], 'gold') === [2500000, 400000, 1000000]
    && count(preg_grep('/^g[0-9a-f]+$/', array_column($state['goals'], 'id'))) === 3, $state['goals']);
[$mount, $pet, $third] = array_column($state['goals'], 'id');
call('goal', ['id' => $pet, 'gold' => '450000.4']);
[, $state] = call('goal', ['id' => $pet, 'name' => 'Rare pet']);
check('goal fields are saved one at a time', $state['goals'][1] === ['id' => $pet, 'name' => 'Rare pet', 'gold' => 450000], $state['goals']);
[, $state] = call('goal', ['id' => $third, 'first' => true]);
check('"first" makes a goal the current one', array_column($state['goals'], 'id') === [$third, $mount, $pet], $state['goals']);
[, $state] = call('goal', ['id' => $third, 'remove' => true]);
check('removing the current goal makes the next one current', array_column($state['goals'], 'id') === [$mount, $pet], $state['goals']);
foreach ([['add' => true, 'gold' => 0], ['add' => true, 'gold' => 'lots'], ['add' => true, 'name' => 'x'],
    ['id' => $pet, 'gold' => null], ['id' => $pet, 'gold' => -1], ['gold' => 5]] as $bad) {
    [$status] = call('goal', $bad);
    check('the goal ' . json_encode($bad) . ' is refused', $status === 400 || $status === 404, $status);
}
[$status] = call('goal', ['id' => 'g0000', 'remove' => true]);
check('an unknown goal is a 404', $status === 404, $status);

[, $state] = call('goal', ['add' => true, 'name' => 'Game time', 'euros' => '25.999']);
$gameTime = end($state['goals'])['id'];
check('a goal can be priced in euros, to the cent', end($state['goals']) === ['id' => $gameTime, 'name' => 'Game time', 'euros' => 26], end($state['goals']));
[, $state] = call('goal', ['id' => $gameTime, 'gold' => 900000]);
check('gold replaces a goal\'s euros', end($state['goals']) === ['id' => $gameTime, 'name' => 'Game time', 'gold' => 900000], end($state['goals']));
[, $state] = call('goal', ['id' => $gameTime, 'euros' => 13]);
check('euros replace a goal\'s gold', end($state['goals']) === ['id' => $gameTime, 'name' => 'Game time', 'euros' => 13], end($state['goals']));
foreach ([['euros' => 0], ['euros' => 'lots'], ['euros' => -5]] as $bad) {
    [$status] = call('goal', ['id' => $gameTime] + $bad);
    check('the goal price ' . json_encode($bad) . ' is refused', $status === 400, $status);
}

[, $state] = call('state');
check('the reserve starts at 500k', $state['reserve'] === 500000 && $state['tokenPrice'] === null, [$state['reserve'], $state['tokenPrice']]);
[, $state] = call('reserve', ['gold' => '250000.4']);
check('the reserve is whole gold', $state['reserve'] === 250000, $state['reserve']);
[, $state] = call('reserve', ['gold' => null]);
check('an empty reserve is none', $state['reserve'] === 0, $state['reserve']);
foreach ([['gold' => -1], ['gold' => 'x']] as $bad) {
    [$status] = call('reserve', $bad);
    check('the reserve ' . json_encode($bad) . ' is refused', $status === 400, $status);
}
call('reserve', ['gold' => 400000]);
[$status, $reply] = call('tokenPrice', []);
check('the token price needs the Battle.net API', $status === 400 && str_contains($reply['error'] ?? '', 'not configured'), [$status, $reply]);

$export = json_decode(file_get_contents($dataFile), true);
$export['tokenPrice'] = ['gold' => 364300, 'time' => 1760000000];
[$status, $state] = call('import', ['data' => $export]);
check('an import keeps the goals, the reserve and the token price', $status === 200 && $state['goals'] === $export['goals']
    && $state['reserve'] === 400000 && $state['tokenPrice'] === $export['tokenPrice'], $status);
$before = file_get_contents($dataFile);
$bothPrices = $export;
$bothPrices['goals'][0]['euros'] = 10;
$badReserve = $export;
$badReserve['reserve'] = -1;
foreach (['a goal with both gold and euros' => $bothPrices, 'a bad reserve' => $badReserve] as $what => $data) {
    [$status] = call('import', ['data' => $data]);
    check("an import with $what is refused", $status === 400 && file_get_contents($dataFile) === $before, $status);
}
call('goal', ['id' => $gameTime, 'remove' => true]);
$export = json_decode(file_get_contents($dataFile), true);
$before = file_get_contents($dataFile);
$badGoal = $export;
$badGoal['goals'][1]['id'] = $mount;
[$status] = call('import', ['data' => $badGoal]);
check('an import with a duplicate goal is refused', $status === 400 && file_get_contents($dataFile) === $before, $status);

$old = $export;
unset($old['goals']);
$old['goal'] = ['gold' => 3000000, 'name' => 'Old mount'];
file_put_contents($dataFile, json_encode($old));
[, $state] = call('state');
check('an older single goal becomes the list\'s only goal', $state['goals'] === [['id' => 'g0', 'name' => 'Old mount', 'gold' => 3000000]]
    && !isset($state['goal']), $state['goals']);
[, $state] = call('goal', ['id' => 'g0', 'name' => 'Renamed mount']);
check('its id holds until the next save', $state['goals'][0]['name'] === 'Renamed mount'
    && !isset(json_decode(file_get_contents($dataFile), true)['goal']), $state['goals']);
$old['goal']['gold'] = 0;
[, $state] = call('import', ['data' => $old]);
check('an older empty goal is no goal', $state['goals'] === [], $state['goals']);

// ---------- Signing out ----------

call('logout', []);
[$status] = call('state');
check('logout ends the session', $status === 401, $status);

echo $failed ? "\n$failed check(s) failed\n" : "\nAll checks passed\n";
exit($failed ? 1 : 0);
