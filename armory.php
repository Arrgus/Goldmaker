<?php
declare(strict_types=1);

// Blizzard Profile API client for the "sync" action in api.php: looks up each character's
// level and class. "syncProfessions" looks up one character's professions. Uses the client-credentials flow, so no Battle.net login is involved.
// Errors that affect the whole sync throw RuntimeException; per-character problems are
// returned as ['error' => ...] so one missing character doesn't stop the rest.

const ARMORY_TOKEN_FILE = DATA_DIR . '/blizzard-token.json';
const REALM_INDEX_FILE = DATA_DIR . '/realm-index.json';
const REALM_INDEX_TTL = 7 * 86400;
const ARMORY_TIMEOUT = 10;
const ARMORY_NOT_FOUND = 'Not found on the armory (renamed, transferred, or not logged in for a long time)';

function armoryConfigured(): bool
{
    return config('BLIZZARD_CLIENT_ID', 'blizzard_client_id') !== ''
        && config('BLIZZARD_CLIENT_SECRET', 'blizzard_client_secret') !== '';
}

function armoryRegion(): string
{
    $region = strtolower(config('BLIZZARD_REGION', 'blizzard_region') ?: 'eu');
    if (!in_array($region, ['us', 'eu', 'kr', 'tw'], true)) {
        throw new RuntimeException("Unknown Battle.net region \"$region\"");
    }
    return $region;
}

// English locale so class names match the CLASSES keys in app.js.
function armoryUrl(string $path, string $namespace): string
{
    $region = armoryRegion();
    return "https://$region.api.blizzard.com$path?"
        . http_build_query(['namespace' => "$namespace-$region", 'locale' => 'en_US']);
}

function armoryHandle(string $url, array $options = []): CurlHandle
{
    $ch = curl_init($url);
    curl_setopt_array($ch, $options + [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => ARMORY_TIMEOUT,
    ]);
    return $ch;
}

/** @return array{int, mixed} HTTP status and decoded JSON body */
function armoryRequest(string $url, array $options = []): array
{
    $ch = armoryHandle($url, $options);
    $body = curl_exec($ch);
    if ($body === false) {
        throw new RuntimeException('Could not reach Battle.net: ' . curl_error($ch));
    }
    return [curl_getinfo($ch, CURLINFO_RESPONSE_CODE), json_decode($body, true)];
}

function readJsonFile(string $path): array
{
    $data = is_file($path) ? json_decode((string) file_get_contents($path), true) : null;
    return is_array($data) ? $data : [];
}

// Tokens last about a day; cached in the data folder, which is never served.
function armoryToken(): string
{
    $cached = readJsonFile(ARMORY_TOKEN_FILE);
    if (($cached['expires'] ?? 0) > time() + 60 && is_string($cached['token'] ?? null)) {
        return $cached['token'];
    }
    [$status, $data] = armoryRequest('https://oauth.battle.net/token', [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => 'grant_type=client_credentials',
        CURLOPT_USERPWD => config('BLIZZARD_CLIENT_ID', 'blizzard_client_id')
            . ':' . config('BLIZZARD_CLIENT_SECRET', 'blizzard_client_secret'),
    ]);
    if ($status !== 200 || !is_string($data['access_token'] ?? null)) {
        throw new RuntimeException($status === 401
            ? 'Battle.net rejected the client ID or secret'
            : "Battle.net sign-in failed (HTTP $status)");
    }
    $token = $data['access_token'];
    file_put_contents(ARMORY_TOKEN_FILE, json_encode([
        'token' => $token,
        'expires' => time() + (int) ($data['expires_in'] ?? 3600),
    ]), LOCK_EX);
    return $token;
}

// "Colinas Pardas", "ColinasPardas" and "colinas-pardas" all reduce to "colinaspardas".
function realmKey(string $realm): string
{
    return preg_replace('/[^\p{L}\p{N}]+/u', '', mb_strtolower($realm));
}

/** @return array<string, string> realmKey() of each realm's name and slug => slug */
function realmSlugs(string $token): array
{
    $cached = readJsonFile(REALM_INDEX_FILE);
    if (($cached['fetchedAt'] ?? 0) > time() - REALM_INDEX_TTL && is_array($cached['slugs'] ?? null)) {
        return $cached['slugs'];
    }
    [$status, $data] = armoryRequest(armoryUrl('/data/wow/realm/index', 'dynamic'), [
        CURLOPT_HTTPHEADER => ["Authorization: Bearer $token"],
    ]);
    if ($status !== 200 || !is_array($data['realms'] ?? null)) {
        throw new RuntimeException("Could not load the realm list (HTTP $status)");
    }
    $slugs = [];
    foreach ($data['realms'] as $realm) {
        $slugs[realmKey((string) $realm['name'])] = $realm['slug'];
        $slugs[realmKey((string) $realm['slug'])] = $realm['slug'];
    }
    file_put_contents(REALM_INDEX_FILE, json_encode(['fetchedAt' => time(), 'slugs' => $slugs]), LOCK_EX);
    return $slugs;
}

// The WoW Token's current Auction House price, for the price log in api.php (logTokenPrice).
/** @return array{int, int} when Blizzard set the price, and the price in gold (the API gives copper) */
function fetchTokenPrice(): array
{
    [$status, $data] = armoryRequest(armoryUrl('/data/wow/token/index', 'dynamic'), [
        CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . armoryToken()],
    ]);
    if ($status !== 200 || !is_int($data['price'] ?? null)) {
        if ($status === 401) {
            @unlink(ARMORY_TOKEN_FILE); // token revoked early; fetch a new one next time
        }
        throw new RuntimeException("Could not load the WoW Token price (HTTP $status)");
    }
    $updated = is_int($data['last_updated_timestamp'] ?? null) ? intdiv($data['last_updated_timestamp'], 1000) : time();
    return [$updated, intdiv($data['price'], 10000)];
}

// The Profile API path of a character, found through its realm's slug.
function characterPath(array $char, array $slugs): string
{
    $realm = (string) ($char['realm'] ?? '');
    $slug = $slugs[realmKey($realm)] ?? null;
    if ($realm === '') {
        throw new RuntimeException('No realm set');
    }
    if ($slug === null) {
        throw new RuntimeException("Unknown realm \"$realm\"");
    }
    return "/profile/wow/character/$slug/" . rawurlencode(mb_strtolower((string) $char['name']));
}

/**
 * Looks up all characters in parallel.
 * @return array<string, array{level: int, class: string}|array{error: string}> keyed by character id
 */
function fetchArmoryCharacters(array $characters): array
{
    $token = armoryToken();
    $slugs = realmSlugs($token);
    $results = [];
    $handles = [];
    $multi = curl_multi_init();

    foreach ($characters as $char) {
        try {
            $path = characterPath($char, $slugs);
        } catch (RuntimeException $e) {
            $results[$char['id']] = ['error' => $e->getMessage()];
            continue;
        }
        $ch = armoryHandle(armoryUrl($path, 'profile'), [
            CURLOPT_HTTPHEADER => ["Authorization: Bearer $token"],
        ]);
        curl_multi_add_handle($multi, $ch);
        $handles[$char['id']] = $ch;
    }

    do {
        $status = curl_multi_exec($multi, $running);
        if ($running) {
            curl_multi_select($multi);
        }
    } while ($running && $status === CURLM_OK);

    foreach ($handles as $id => $ch) {
        $code = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $data = json_decode((string) curl_multi_getcontent($ch), true);
        curl_multi_remove_handle($multi, $ch);
        if ($code === 200 && is_int($data['level'] ?? null)) {
            $results[$id] = ['level' => $data['level'], 'class' => (string) ($data['character_class']['name'] ?? '')];
        } elseif ($code === 404) {
            $results[$id] = ['error' => ARMORY_NOT_FOUND];
        } elseif ($code === 0) {
            $results[$id] = ['error' => 'Could not reach Battle.net: ' . curl_error($ch)];
        } else {
            if ($code === 401) {
                @unlink(ARMORY_TOKEN_FILE); // token revoked early; fetch a new one next time
            }
            $results[$id] = ['error' => "Armory error (HTTP $code)"];
        }
    }
    return $results;
}

// One character's primary professions, for the "syncProfessions" action: the names in PROFESSIONS
// (api.php), at most MAX_PROFESSIONS. Asked for one character at a time from the Manage page, so
// any failure throws. Secondary professions (Cooking, Fishing) are left out.
/** @return list<string> */
function fetchArmoryProfessions(array $char): array
{
    $token = armoryToken();
    [$status, $data] = armoryRequest(armoryUrl(characterPath($char, realmSlugs($token)) . '/professions', 'profile'), [
        CURLOPT_HTTPHEADER => ["Authorization: Bearer $token"],
    ]);
    if ($status === 404) {
        throw new RuntimeException(ARMORY_NOT_FOUND);
    }
    if ($status !== 200 || !is_array($data)) {
        if ($status === 401) {
            @unlink(ARMORY_TOKEN_FILE); // token revoked early; fetch a new one next time
        }
        throw new RuntimeException("Armory error (HTTP $status)");
    }
    // A character without professions has no "primaries".
    $names = [];
    foreach ((array) ($data['primaries'] ?? []) as $primary) {
        $name = is_array($primary) ? ($primary['profession']['name'] ?? null) : null;
        if (in_array($name, PROFESSIONS, true) && !in_array($name, $names, true)) {
            $names[] = $name;
        }
    }
    return array_slice($names, 0, MAX_PROFESSIONS);
}
