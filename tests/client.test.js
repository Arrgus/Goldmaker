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

    // The 1k arrows: quick clicks build on each other before the replies arrive, never below 0.
    log.length = 0;
    server.delay.toggle = 50;
    app(`bumpGold('c1', 'a1', 1000); bumpGold('c1', 'a1', 1000); bumpGold('c1', 'a1', -1000)`);
    await sleep(250);
    let golds = log.filter(e => e.event === 'send' && e.action === 'toggle').map(e => e.body.gold);
    check('quick arrow clicks add up', JSON.stringify(golds) === '[1045,2045,1045]', JSON.stringify(golds));
    log.length = 0;
    app(`bumpGold('c1', 'a1', -1000); bumpGold('c1', 'a1', -1000)`);
    await sleep(200);
    golds = log.filter(e => e.event === 'send' && e.action === 'toggle').map(e => e.body.gold);
    check('the arrows stop at 0', JSON.stringify(golds) === '[45,0]', JSON.stringify(golds));
    server.delay.toggle = 0;

    // Goals: the first is the current one. A later one shows how far the gold goes on its own and
    // how far the gold beyond the current one goes. Every goal also needs the reserve.
    app(`state = { characters: [], bank: { gold: 1200, time: 1 }, reserve: 0,
        goals: [{ id: 'g1', name: 'Mount', gold: 1000 }, { id: 'g2', name: 'Pet', gold: 500 }] }`);
    const progress = total => JSON.stringify(app(`goalsProgress(${total})`)
        .map(p => [p.alone && [p.alone.pct, p.alone.left], p.onTop && [p.onTop.pct, p.onTop.left]]));
    check('a later goal fills with the gold beyond the current one', progress(1200) === '[[[100,0],null],[[100,0],[40,300]]]', progress(1200));
    check("a later goal's gold to go includes the current goal", progress(600) === '[[[60,400],null],[[100,0],[0,900]]]', progress(600));
    check('a later goal also shows how far the gold goes on its own', progress(300) === '[[[30,700],null],[[60,200],[0,1200]]]', progress(300));
    app('state.reserve = 500');
    check('the reserve is added to every goal', progress(1200) === '[[[80,300],null],[[100,0],[0,800]]]', progress(1200));
    check('no goals, no progress', app('state.goals = []; goalsProgress(500).length') === 0);
    app(`state.reserve = 500; state.goals = [{ id: 'g1', name: 'Mount', gold: 2000 }]; renderGold()`);
    check('the header shows the current goal with the reserve', elements['#nav-total'].innerHTML.includes('48% of 2.5k'), elements['#nav-total'].innerHTML);

    // Goals in euros cost whole WoW Tokens (13€ each) at the last known price.
    app(`state.reserve = 0; state.tokenPrice = null; state.goals = [{ id: 'g1', name: 'Mount', gold: 1000 }, { id: 'g2', name: 'Game time', euros: 26.01 }]`);
    check('a goal in euros waits for the token price', progress(1500) === '[[[100,0],null],[null,null]]', progress(1500));
    app('state.tokenPrice = { gold: 300, time: 1 }');
    check('a goal in euros needs whole tokens', app('goalCost(state.goals[1]).tokens') === 3 && app('goalCost({ euros: 26 }).tokens') === 2
        && progress(1500) === '[[[100,0],null],[[100,0],[55,400]]]', progress(1500));
    app(`state.goals.reverse(); state.tokenPrice = null`);
    check('without a known cost for the current goal, a later one shows only its own progress', JSON.stringify(app('goalsProgress(500)')[1].onTop) === 'null');
    check('goal prices read gold or euros', JSON.stringify([app('parseGoalPrice("2.5m")'), app('parseGoalPrice("25€")'), app('parseGoalPrice(" 14,99 eur")'),
        app('parseGoalPrice("")'), app('parseGoalPrice("x€")'), app('parseGoalPrice("0")')])
        === '[{"gold":2500000},{"euros":25},{"euros":14.99},null,null,null]');

    // Hiding the loot activities also hides the characters who can do nothing else.
    app(`state = {
        characters: [{ id: 'c1', name: 'Main', level: 90 }, { id: 'c2', name: 'Lowbie', level: 70 }],
        activities: [{ id: 'a1', name: 'Weekly', minLevel: 80, gold: 1000 },
            { id: 'a2', name: 'Naxx', minLevel: 1, gold: 300, materials: [{ id: 'm1', name: 'Scrap' }] }],
        completions: { '2026-09-30': { c1: { a1: 1000 }, c2: { a2: 300 } } },
        snapshots: {}, deposits: {},
    }; viewedWeek = '2026-09-30'; hideLoot = true; renderWeek()`);
    let hiddenGrid = elements['#grid'].innerHTML;
    check('hiding removes the loot columns and the characters with nothing else', !hiddenGrid.includes('data-act="a2"')
        && !hiddenGrid.includes('Lowbie') && hiddenGrid.includes('Main') && hiddenGrid.includes('data-act="a1"'));
    check('the totals still count what is hidden', elements['#week-summary'].innerHTML.includes('<b>1,300g</b>')
        && hiddenGrid.includes('<span class="gold">1,300g</span>'), elements['#week-summary'].innerHTML);
    check('the toggle says what it hides', !elements['#loot-toggle'].hidden
        && elements['#loot-toggle span'].textContent === 'Hide Naxx (and 1 character)', elements['#loot-toggle span'].textContent);
    app(`state.activities.push({ id: 'a3', name: 'Any level', minLevel: 1, gold: 100 }); renderWeek()`);
    hiddenGrid = elements['#grid'].innerHTML;
    check('a character with another activity stays', hiddenGrid.includes('Lowbie') && hiddenGrid.includes('data-char="c2" data-act="a3"')
        && !hiddenGrid.includes('data-act="a2"'));
    app('hideLoot = false; renderWeek()');
    check('showing them again brings the loot back', elements['#grid'].innerHTML.includes('data-act="a2"'));
    app(`state.activities = state.activities.filter(a => !a.materials); renderWeek()`);
    check('without loot activities there is no toggle', elements['#loot-toggle'].hidden);

    // The Battle.net Balance pays for goals in euros first; on top of the current goal, only what it
    // leaves over counts.
    app(`state = { characters: [], bank: { gold: 600, time: 1 }, reserve: 0, tokenPrice: { gold: 300, time: 1 }, balance: { euros: 13, time: 1 },
        goals: [{ id: 'g1', name: 'Sub', euros: 20 }, { id: 'g2', name: 'Game', euros: 26 }] }`);
    check('the balance pays first, then whole tokens', JSON.stringify(app('goalCost(state.goals[0])')) === '{"gold":300,"tokens":1,"fromBalance":13}',
        JSON.stringify(app('goalCost(state.goals[0])')));
    check('a later goal only gets the balance the current one leaves', progress(600) === '[[[100,0],null],[[100,0],[50,300]]]', progress(600));
    app('state.tokenPrice = null');
    check('a goal the balance covers costs nothing, even without a token price', JSON.stringify(app('goalCost({ euros: 13 })'))
        === '{"gold":0,"tokens":0,"fromBalance":13}', JSON.stringify(app('goalCost({ euros: 13 })')));
    check('euros read with or without the €', JSON.stringify([app('parseEuros("13")'), app('parseEuros(" 14,99 € ")'), app('parseEuros("")')]) === '[13,14.99,null]'
        && Number.isNaN(app('parseEuros("x")')));

    // Weeks to go use the average of the finished weeks, or of every week with countThisWeek.
    app(`state = { characters: [{ id: 'c1', level: 90 }], activities: [{ id: 'a1', minLevel: 90, gold: 1000 }], snapshots: {}, deposits: {},
        completions: { [shiftWeek(currentWeekKey(), -2)]: { c1: { a1: 3000 } }, [shiftWeek(currentWeekKey(), -1)]: { c1: { a1: 1000 } },
            [currentWeekKey()]: { c1: { a1: 500 } } } }; countThisWeek = false`);
    check('the average leaves out the current week', JSON.stringify(app('weeklyAverage()')) === '{"gold":2000,"weeks":2}', JSON.stringify(app('weeklyAverage()')));
    check('weeks to go round up', app('weeksToGo(5000, weeklyAverage())') === 3 && app('weeksToGo(0, weeklyAverage())') === null
        && app('weeksToGo(5000, null)') === null);
    app('countThisWeek = true');
    check('the switch counts the current week too', JSON.stringify(app('weeklyAverage()')) === '{"gold":1500,"weeks":3}', JSON.stringify(app('weeklyAverage()')));
    app('countThisWeek = false');

    // The token price log: when it's usually lowest, what a good price is, and the chart.
    app(`tokenLog = []; {
        const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - 6);
        for (let t = start / 1000; t < start / 1000 + 5 * DAY; t += 1200) {
            tokenLog.push([t, new Date(t * 1000).getHours() === 6 ? 294000 : 300000]);
        }
    }`);
    const hours = app('pricePattern(tokenLog, 24, d => d.getHours(), DAY / 2)');
    check('the hourly pattern finds the hour the price dips', hours.indexOf(Math.min(...hours)) === 6 && Math.min(...hours) < -0.015,
        JSON.stringify(hours.map(h => +h.toFixed(4))));
    check('the lowest 3 hours include the dip', [4, 5, 6].includes(app('patternPeak(pricePattern(tokenLog, 24, d => d.getHours(), DAY / 2), 3, -1).from')));
    check('the weekly pattern waits for more days', app('pricePattern(tokenLog, 7, weekdaySlot, 3.5 * DAY)') === null);
    app(`state = { characters: [], goals: [{ id: 'g1', name: 'Sub', euros: 26 }], reserve: 0, armoryEnabled: true,
        tokenPrice: { gold: 300000, time: tokenLog.at(-1)[0] } }; tokenRange = '7'; renderGold()`);
    const gold = elements['#gold'].innerHTML;
    check('the token panel shows the chart and the hourly pattern', gold.includes('class="token-plot"') && gold.includes('Usually lowest around <b>')
        && gold.includes('id="token-refresh"') && gold.includes('Shows after 2 weeks of prices'));

    app(`tokenLog = Array.from({ length: 10 }, (_, i) => [Math.floor(Date.now() / 1000) - 3 * DAY + i * 7 * 3600, (i + 1) * 100])`);
    check('a good price is the cheapest 10% of 30 days', app('goodTokenPrice()') === 200, app('goodTokenPrice()'));
    app(`tokenLog = tokenLog.slice(0, 2)`);
    check('a good price needs 2 days of prices', app('goodTokenPrice()') === null, app('goodTokenPrice()'));
    const thinned = app(`thinOut(Array.from({ length: 1000 }, (_, i) => [i, i === 517 ? 1 : 500 + (i % 7)]), 50)`);
    check('thinning the chart keeps the dips', thinned.length <= 100 && thinned.some(e => e[1] === 1), thinned.length);

    // The page asks only for the log entries it doesn't have, once the state has a newer price.
    await sleep(20); // the requests the renders above started
    log.length = 0;
    server.fake.tokenHistory = () => json({ history: [[2000, 310000]] });
    context.saved = saved;
    elements.main.hidden = false; // signed in, on the Gold page
    app(`state = { ...saved, tokenPrice: { gold: 310000, time: 2000 } }; tokenLog = [[1000, 300000]]; loadTokenLog()`);
    await sleep(20);
    check('the log is fetched from the last entry on', JSON.stringify(log.find(e => e.action === 'tokenHistory')?.body) === '{"since":1000}'
        && JSON.stringify(app('tokenLog')) === '[[1000,300000],[2000,310000]]', JSON.stringify(app('tokenLog')));
    log.length = 0;
    app('loadTokenLog()');
    await sleep(20);
    check("an up-to-date log isn't fetched again", !log.some(e => e.action === 'tokenHistory'));
    delete server.fake.tokenHistory;

    // Refresh looks the price up straight away.
    log.length = 0;
    app('lookUpTokenPrice()');
    await sleep(50);
    check('Refresh asks the server for the price, then the state', log.some(e => e.event === 'send' && e.action === 'tokenPrice')
        && log.some(e => e.event === 'send' && e.action === 'state') && app('tokenPriceRun') === null);

    context.saved = saved;
    app('state = saved');

    console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
    process.exitCode = failed ? 1 : 0;
})();
