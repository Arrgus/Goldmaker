// Checks app.js's request handling: it runs the script in a vm with a stub DOM and a simulated
// api.php. It covers the request queue, the armory sync, logging out and error replies. It can't
// cover real browser behaviour (form validation, <select> values, layout). Needs Node 18+.
//
//   node tests/client.test.js
'use strict';
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const started = Date.now();
const now = () => Date.now() - started;

// ---------- Stub DOM ----------
// Every element is a plain object that accepts whatever app.js sets on it; document.querySelector
// hands out one per selector, so tests can look at what the app did to it.

function fakeElement(props = {}) {
    const listeners = {};
    const el = {
        hidden: false, disabled: false, textContent: '', innerHTML: '', className: '', value: '', dataset: {},
        classList: { toggle() {}, contains() { return false; } },
        addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
        fire(type, event = {}) { for (const fn of listeners[type] || []) fn(event); },
        querySelector(sel) { return ((el.children ||= {})[sel] ||= fakeElement()); },
        querySelectorAll() { return []; },
        focus() {}, select() {}, reset() {}, click() {},
        ...props,
    };
    el.elements = new Proxy({}, { get: (fields, name) => (fields[name] ||= fakeElement()) });
    return el;
}

const elements = { main: fakeElement({ hidden: true }), '#login-form': fakeElement({ hidden: true }) };
const document = fakeElement({ body: fakeElement() });
document.querySelector = sel => (elements[sel] ||= fakeElement());

// ---------- Simulated api.php ----------

const server = {
    signedIn: true,
    delay: {}, // action => ms before replying
    fake: {},  // action => () => Response, or throws like a network failure
    data: {
        characters: [{ id: 'c1', name: 'Alt', realm: 'Realm', class: 'Mage', level: 90 }],
        activities: [{ id: 'a1', name: 'Weekly', minLevel: 80, notes: '', gold: 100 }],
        completions: {},
        armoryEnabled: true, autoSyncInterval: 21600, lastSync: Math.floor(Date.now() / 1000),
    },
};
const log = [];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function fetchStub(url, options) {
    const action = /action=(\w+)/.exec(url)[1];
    const body = options.body ? JSON.parse(options.body) : {};
    log.push({ t: now(), event: 'send', action, body });
    const signedIn = server.signedIn; // api.php checks the cookie when the request arrives
    if (server.delay[action]) await sleep(server.delay[action]);
    let res;
    if (server.fake[action]) {
        res = server.fake[action]();
    } else if (action === 'login') {
        server.signedIn = true;
        res = json({ ok: true });
    } else if (action === 'logout') {
        server.signedIn = false;
        res = json({ ok: true });
    } else if (!signedIn) {
        res = json({ error: 'Not signed in' }, 401);
    } else {
        if (action === 'toggle') {
            const week = (server.data.completions[body.week] ||= {});
            (week[body.charId] ||= {})[body.actId] = body.gold ?? 100;
        }
        if (action === 'sync') server.data.lastSync = Math.floor(Date.now() / 1000);
        res = json(server.data);
    }
    log.push({ t: now(), event: 'reply', action });
    return res;
}

// ---------- Load app.js ----------

const alerts = [];
const confirms = [];
let confirmAnswer = true;
const context = vm.createContext({
    document, console, Response,
    fetch: fetchStub,
    alert: message => alerts.push(String(message)),
    confirm: message => { confirms.push(String(message)); return confirmAnswer; },
    setTimeout, clearTimeout, setInterval: () => 0,
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8'), context);
const app = code => vm.runInContext(code, context);

let failed = 0;
function check(name, ok, got) {
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || got === undefined ? '' : `  (got ${got})`}`);
}

async function reset() {
    Object.assign(server, { signedIn: true, delay: {}, fake: {} });
    alerts.length = 0;
    await app('api("state")').catch(() => {});
    await sleep(20);
    log.length = 0;
}
const sentAt = (action, from = 0) => log.find(e => e.event === 'send' && e.action === action && e.t >= from)?.t;
const repliedAt = action => log.find(e => e.event === 'reply' && e.action === action)?.t;
const showingData = () => !elements.main.hidden || app('state.characters.length') > 0;

(async () => {
    await sleep(50); // the page's own api('state') on load

    // A click during a slow armory sync goes through straight away.
    await reset();
    server.delay.sync = 800;
    const syncing = app('sync()').catch(() => {});
    await sleep(20);
    const disabledWhileSyncing = elements['#sync-btn'].disabled;
    const clicked = now();
    await app('api("toggle", { week: "2026-09-23", charId: "c1", actId: "a1", done: true, gold: 700 })');
    const clickMs = now() - clicked;
    await syncing;
    await sleep(20);
    check("a click during a slow sync doesn't wait for it", clickMs < 400, `${clickMs} ms`);
    check('the sync button is disabled while syncing', disabledWhileSyncing && !elements['#sync-btn'].disabled);
    check("the sync's reply doesn't undo the click", app('state.completions["2026-09-23"]?.c1?.a1') === 700);

    // Logging out while a sync is running.
    await reset();
    server.delay.sync = 400;
    const syncing2 = app('sync()').catch(() => {});
    await sleep(50);
    const clickedLogout = now();
    elements['#logout'].fire('click');
    const signedOutAtOnce = elements.main.hidden;
    await syncing2;
    await sleep(100);
    check('logout signs the page out at once', signedOutAtOnce);
    check("the sync's reply doesn't bring the data back", !showingData());
    check('the logout request waits for the sync', sentAt('logout', clickedLogout) >= repliedAt('sync'),
        `logout sent at ${sentAt('logout', clickedLogout)} ms, sync replied at ${repliedAt('sync')} ms`);

    // Logging out while a queued request is on its way.
    await reset();
    server.delay.toggle = 300;
    const toggling = app('api("toggle", { week: "2026-09-23", charId: "c1", actId: "a1", done: true })').catch(() => {});
    await sleep(50);
    elements['#logout'].fire('click');
    await toggling;
    await sleep(100);
    check("an in-flight request's reply doesn't bring the data back", !showingData());

    // Error replies are shown, whatever shape they arrive in.
    await reset();
    for (const [name, fake, message] of [
        ["a proxy's HTML error page", () => new Response('<html>Bad Gateway</html>', { status: 502 }), 'Server error (HTTP 502)'],
        ['a 200 reply that isn\'t JSON', () => new Response('<b>Warning</b>: …', { status: 200 }), 'Server error (HTTP 200)'],
        ['a network failure', () => { throw new TypeError('Failed to fetch'); }, 'Could not reach the server'],
        ['an API error', () => json({ error: 'Bad toggle' }, 400), 'Bad toggle'],
    ]) {
        alerts.length = 0;
        server.fake.toggle = fake;
        let rejected = false;
        await app('api("toggle", { week: "2026-09-23", charId: "c1", actId: "a1", done: true })').catch(() => { rejected = true; });
        check(`${name} is shown`, rejected && alerts[0] === message, JSON.stringify(alerts));
    }
    check('the data survives the errors', app('state.characters.length') === 1);

    // A 401 swaps to the login form.
    await reset();
    server.signedIn = false;
    await app('api("state")').catch(() => {});
    check('a 401 shows the login form', elements.main.hidden && !elements['#login-form'].hidden && alerts.length === 0);

    // A touch that turns into a scroll ends with pointercancel instead of pointerup.
    await reset();
    document.fire('pointerdown');
    app('requestRender()');
    document.fire('pointercancel');
    await sleep(20);
    check('pointercancel releases the render hold', app('pointerDown') === false && app('renderPending') === false);

    // Closed weeks are counted with their snapshot, not with today's characters and levels.
    const saved = app('state');
    app(`state = {
        characters: [{ id: 'c1', level: 90 }, { id: 'c2', level: 90 }],
        activities: [{ id: 'a1', minLevel: 90, gold: 100 }],
        completions: { '2026-09-02': { c1: { a1: 100 } }, '2026-09-16': { c1: { a1: 100 } } },
        snapshots: { '2026-09-09': { characters: [{ id: 'c1', level: 90 }], activities: [{ id: 'a1', minLevel: 90, gold: 100 }] } },
        lastWeek: '2026-09-23',
    }`);
    const total = week => { const s = app(`weekStats('${week}')`); return `${s.done}/${s.total}`; };
    check('a closed week uses the snapshot in force', total('2026-09-16') === '1/1', total('2026-09-16'));
    check('weeks before the first snapshot use the oldest one', total('2026-09-02') === '1/1', total('2026-09-02'));
    check('the open week uses the live data', total('2026-09-23') === '0/2', total('2026-09-23'));

    // Gold still to deposit: what was earned minus what was banked, only from depositsFrom on.
    app(`state = {
        characters: [{ id: 'c1', level: 90 }],
        activities: [{ id: 'a1', minLevel: 90, gold: 1000 }, { id: 'a2', minLevel: 90, gold: 500 }],
        completions: { '2026-09-16': { c1: { a1: null } }, '2026-09-23': { c1: { a1: null, a2: 700 } } },
        snapshots: {}, deposits: { '2026-09-23': { c1: [{ gold: 1000, time: 0 }] } },
        depositsFrom: '2026-09-23',
    }`);
    const pending = week => app(`weekStats('${week}').pending`);
    check('a second visit leaves only the new gold to deposit', pending('2026-09-23') === 700, pending('2026-09-23'));
    check('weeks before depositsFrom count as banked', pending('2026-09-16') === 0, pending('2026-09-16'));
    app(`state.deposits['2026-09-23'].c1.push({ gold: 900, time: 0 })`);
    check('depositing more than earned leaves nothing to deposit', pending('2026-09-23') === 0, pending('2026-09-23'));

    // Loot is worth its count at the week's prices, which carry over until a later week sets new ones.
    app(`state = {
        characters: [{ id: 'c1', name: 'Alt', level: 90 }],
        activities: [{ id: 'a1', name: 'Naxx', minLevel: 1, gold: 300, materials: [{ id: 'm1', name: 'Scrap' }, { id: 'm2', name: 'Rune' }] }],
        completions: { '2026-09-16': { c1: { a1: 300 } }, '2026-09-23': { c1: { a1: 200 } }, '2026-09-30': { c1: { a1: 300 } } },
        loot: { '2026-09-16': { c1: { a1: { m1: 10 } } }, '2026-09-23': { c1: { a1: { m1: 10, m2: 2 } } }, '2026-09-30': { c1: { a1: { m1: 10 } } } },
        prices: { '2026-09-23': { m1: 50, m2: 1000 }, '2026-09-30': { m2: 1500 } },
        snapshots: {}, deposits: { '2026-09-23': { c1: [{ gold: 200, time: 0 }] } },
    }`);
    const stats = week => app(`weekStats('${week}')`);
    check("loot is worth its counts at the week's prices", stats('2026-09-23').mats === 2500, stats('2026-09-23').mats);
    check('a price carries over to later weeks', stats('2026-09-30').mats === 500, stats('2026-09-30').mats);
    check('weeks before the first price use it', stats('2026-09-16').mats === 500, stats('2026-09-16').mats);
    check('the mats are never gold to deposit', stats('2026-09-23').gold === 200 && stats('2026-09-23').pending === 0,
        JSON.stringify(stats('2026-09-23')));

    app(`viewedWeek = '2026-09-30'; renderWeek()`);
    const grid = elements['#grid'].innerHTML;
    check('the run cell shows the whole run', /class="gold-edit" data-char="c1" data-act="a1" title="[^"]*">800</.test(grid));
    check('the loot fields show the counts', /id="loot-a1-c1-m1"[^>]*value="10"/.test(grid) && /id="loot-a1-c1-gold"[^>]*value="300"/.test(grid));
    check('a carried-over price is marked', /class="price-input inherited" id="price-a1-m1"[^>]*value="50"/.test(grid)
        && /class="price-input" id="price-a1-m2"[^>]*value="1500"/.test(grid));
    check('the row total keeps the mats apart', grid.includes('<td class="row-gold">300g<span class="mats">+500g in mats</span></td>'));
    check('the week summary counts the mats as earned', elements['#week-summary'].innerHTML.includes('<b>800g</b>'), elements['#week-summary'].innerHTML);

    // Unticking a run removes its loot, so it asks first.
    log.length = 0;
    confirmAnswer = false;
    const runButton = { dataset: { char: 'c1', act: 'a1' }, classList: { contains: () => false } };
    elements['#grid'].fire('click', { target: { closest: sel => sel === 'button[data-char]' ? runButton : null } });
    await sleep(20);
    confirmAnswer = true;
    check('unticking a run with loot asks first', /Untick Naxx for Alt\?[\s\S]*10 Scrap/.test(confirms.at(-1)) && !log.some(e => e.action === 'toggle'),
        JSON.stringify(confirms));

    check('prices read small numbers as gold', app('parsePrice("45")') === 45 && app('parsePrice("1.2k")') === 1200
        && app('parsePrice("1,250g")') === 1250 && app('parsePrice(" ")') === null && Number.isNaN(app('parsePrice("x")')));
    check('gold still reads small numbers as thousands', app('parseGold("19")') === 19000);
    check('counts are whole numbers', app('parseCount("")') === 0 && app('parseCount(" 12 ")') === 12 && Number.isNaN(app('parseCount("1.5")')));

    // A loot field is saved on its own, as a tick: another field of the row may still show an older
    // reply. An empty gold field means the default.
    await reset();
    const field = (value, dataset) => ({ value, dataset, classList: { toggle(name, on) { this[name] = on; } } });
    const savedField = async (value, dataset) => {
        log.length = 0;
        context.field = field(value, { char: 'c1', act: 'a1', ...dataset });
        app('viewedWeek = currentWeekKey(); saveLoot(field)');
        await sleep(20);
        return log.find(e => e.action === 'toggle')?.body;
    };
    const week = app('currentWeekKey()');
    let sent = await savedField('12', { mat: 'm1' });
    check('a count is saved on its own', JSON.stringify(sent)
        === JSON.stringify({ week, charId: 'c1', actId: 'a1', done: true, loot: { m1: 12 } }), JSON.stringify(sent));
    sent = await savedField('', {});
    check('an emptied gold field saves the default', JSON.stringify(sent)
        === JSON.stringify({ week, charId: 'c1', actId: 'a1', done: true, gold: 100 }), JSON.stringify(sent));
    sent = await savedField('45', {});
    check('vendor gold reads small numbers as gold', sent?.gold === 45, JSON.stringify(sent));
    const bad = field('a dozen', { char: 'c1', act: 'a1', mat: 'm1' });
    context.field = bad;
    log.length = 0;
    app('saveLoot(field)');
    await sleep(20);
    check("a field that isn't a number is marked, not saved", bad.classList.invalid === true && !log.some(e => e.action === 'toggle'));

    context.saved = saved;
    app('state = saved');

    console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
    process.exitCode = failed ? 1 : 0;
})();
