'use strict';

const CLASSES = {
    '': '#cccccc',
    'Death Knight': '#C41E3A',
    'Demon Hunter': '#A330C9',
    'Druid': '#FF7C0A',
    'Evoker': '#33937F',
    'Hunter': '#AAD372',
    'Mage': '#3FC7EB',
    'Monk': '#00FF98',
    'Paladin': '#F48CBA',
    'Priest': '#FFFFFF',
    'Rogue': '#FFF468',
    'Shaman': '#2B55FF',
    'Warlock': '#9A80E6',
    'Warrior': '#C69B6D',
};

let state = { characters: [], activities: [], completions: {}, deposits: {}, bank: null, charGold: {} };
let viewedWeek = currentWeekKey();

// View settings are kept per browser: a phone may hide what a desktop shows. Storage can be
// unavailable (private windows, blocked site data), which just means the defaults.
function readSetting(key) {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

function writeSetting(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch {
        // not remembered, that's all
    }
}

let hideLoot = readSetting('goldmaker.hideLoot') === '1';
// Whether the average behind "weeks to go" counts the current week (see weeklyAverage).
let countThisWeek = readSetting('goldmaker.countThisWeek') === '1';
// How many days the WoW Token chart shows, or "all".
let tokenRange = readSetting('goldmaker.tokenRange') || '7';

// ---------- Weeks ----------
// A week starts on Wednesday at 04:00 local time and is keyed by that Wednesday's date.

function weekStart(date) {
    const d = new Date(date);
    d.setHours(4, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay() - 3 + 7) % 7));
    if (d > date) d.setDate(d.getDate() - 7);
    return d;
}

function toKey(d) {
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fromKey(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d, 4);
}

function currentWeekKey() {
    return toKey(weekStart(new Date()));
}

function shiftWeek(key, n) {
    const d = fromKey(key);
    d.setDate(d.getDate() + 7 * n);
    return toKey(d);
}

function weekLabel(key) {
    const start = fromKey(key);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    const fmt = d => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return `${fmt(start)} – ${fmt(end)}, ${end.getFullYear()}`;
}

// ---------- API ----------

// Requests run one at a time so responses can't arrive out of order and show stale state.
let apiQueue = Promise.resolve();

function enqueue(run) {
    const result = apiQueue.then(run);
    apiQueue = result.catch(() => {});
    return result;
}

// Bumped on logout. Replies to requests made before it are dropped instead of showing the data again.
let signOuts = 0;

// The API only accepts changes as JSON POSTs (see api.php), so anything with a body is sent that way.
// A network failure or a reply that isn't JSON (a PHP fatal error, the proxy's error page during
// a redeploy) comes back as an ordinary error.
async function send(action, body) {
    try {
        // The server closes past weeks by this (closeWeeks in api.php).
        const res = await fetch(`api.php?action=${action}&week=${currentWeekKey()}`, {
            method: body ? 'POST' : 'GET',
            headers: { 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
        });
        const data = await res.json().catch(() => ({ error: `Server error (HTTP ${res.status})` }));
        return { status: res.status, ok: res.ok && !data.error, data };
    } catch {
        return { status: 0, ok: false, data: { error: 'Could not reach the server' } };
    }
}

// Throws on an error reply, after swapping to the login form (401) or showing the error.
function check({ status, ok, data }) {
    if (ok) return;
    if (status === 401) {
        setSignedIn(false);
    } else {
        alert(data.error || 'Something went wrong');
    }
    throw new Error(data.error);
}

function api(action, body) {
    const signOutsBefore = signOuts;
    return enqueue(async () => {
        const reply = await send(action, body);
        if (signOuts !== signOutsBefore) return;
        check(reply);
        state = reply.data;
        setSignedIn(true);
        requestRender();
    });
}

// Re-rendering between mousedown and mouseup would swallow the click (e.g. leaving a gold
// input by clicking the next cell), so renders wait until the pointer is released.
let pointerDown = false;
let renderPending = false;

function requestRender() {
    if (pointerDown) {
        renderPending = true;
    } else {
        render();
    }
}

function pointerReleased() {
    pointerDown = false;
    if (renderPending) {
        renderPending = false;
        setTimeout(render); // after the click event has been dispatched
    }
}

document.addEventListener('pointerdown', () => { pointerDown = true; }, true);
document.addEventListener('pointerup', pointerReleased, true);
// A touch that turns into a scroll ends with pointercancel, not pointerup.
document.addEventListener('pointercancel', pointerReleased, true);

// ---------- Helpers ----------

const $ = sel => document.querySelector(sel);

function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function eligible(char, act) {
    return char.level >= act.minLevel;
}

// Characters and activities as they were in a week. The server keeps a snapshot of each closed
// week (closeWeeks in api.php): a snapshot covers the weeks from its key up to the next one.
// Weeks from lastWeek on haven't closed yet and use the live data, as do all weeks until the first
// snapshot exists. Weeks from before snapshots existed use the oldest one.
function weekSetup(week) {
    const keys = Object.keys(state.snapshots || {}).sort();
    if (!keys.length || !state.lastWeek || week >= state.lastWeek) {
        return { characters: state.characters, activities: state.activities, live: true };
    }
    return state.snapshots[keys.findLast(k => k <= week) ?? keys[0]];
}

function isDone(week, charId, actId) {
    const entries = state.completions[week]?.[charId];
    return !!entries && Object.hasOwn(entries, actId);
}

// Gold recorded for a completion; null (pre-gold data) falls back to the activity's default.
function goldOf(week, charId, act) {
    return state.completions[week]?.[charId]?.[act.id] ?? (act.gold || 0);
}

// Gold taken to the bank, as a list of deposits: a character can go back for more activities.
function depositsOf(week, charId) {
    return state.deposits?.[week]?.[charId] || [];
}

// Weeks before depositsFrom were played before deposits were tracked and count as banked.
function tracksDeposits(week) {
    return !state.depositsFrom || week >= state.depositsFrom;
}

// Materials an activity drops that are sold on the Auction House (Naxxramas: Wartorn Scrap and
// Frozen Runes). Each run records how many dropped; they're worth what the week's prices say.
// They're sold from one character, so their value counts as earned but never as gold to deposit.
function materialsOf(act) {
    return act?.materials || [];
}

function lootOf(week, charId, actId) {
    return state.loot?.[week]?.[charId]?.[actId] || {};
}

// A price holds from the week it was set until a later week sets another. Weeks before the first
// price use that one.
function priceOf(week, matId) {
    const prices = state.prices || {};
    const weeks = Object.keys(prices).filter(k => Object.hasOwn(prices[k], matId)).sort();
    const from = weeks.findLast(k => k <= week) ?? weeks[0];
    return { price: from ? prices[from][matId] : 0, from };
}

function lootValue(week, charId, act) {
    const counts = lootOf(week, charId, act.id);
    return materialsOf(act).reduce((sum, m) => sum + (counts[m.id] || 0) * priceOf(week, m.id).price, 0);
}

function fmtGold(n) {
    return `${Math.round(n).toLocaleString()}g`;
}

// A moment in the last weeks, e.g. "Tue 14 Oct, 07:20".
function fmtWhen(time) {
    return new Date(time * 1000).toLocaleString(undefined,
        { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function fmtShort(n) {
    if (n >= 1e6) return `${+(n / 1e6).toFixed(2)}M`;
    return n < 1000 ? String(n) : `${+(n / 1000).toFixed(2)}k`;
}

// Accepts "1900", "1,900", "1.9k", "20k". Numbers with one or two digits before the decimal
// point are read as thousands ("19" = 19k, "1.2" = 1.2k), since sub-1k rewards are rare.
// Empty means "use the default" (null); garbage is NaN.
function parseGold(str) {
    return parseAmount(str, true);
}

// A material's price per unit, a run's vendor gold or the gold counted on the Gold page: like
// parseGold, but small numbers are gold ("45" = 45g), and "1.2m" is understood.
function parsePrice(str) {
    return parseAmount(str, false);
}

function parseAmount(str, shortMeansThousands) {
    const s = str.trim().toLowerCase().replace(/[\s,g]/g, '');
    if (s === '') return null;
    const m = s.match(/^(\d+)(\.\d+)?([km]?)$/);
    if (!m) return NaN;
    const scale = m[3] === 'm' ? 1e6 : m[3] || (shortMeansThousands && m[1].length <= 2) ? 1000 : 1;
    return Math.round(parseFloat(m[1] + (m[2] || '')) * scale);
}

// How many of a material dropped: a whole number, empty for none.
function parseCount(str) {
    const s = str.trim();
    return s === '' ? 0 : /^\d+$/.test(s) ? Number(s) : NaN;
}

function reqBadge(act) {
    if (act.minLevel >= 90) return '<span class="req req-90">90</span>';
    if (act.minLevel > 1) return `<span class="req">${act.minLevel}+</span>`;
    return '';
}

function charName(c) {
    return `<span style="color:${CLASSES[c.class] || CLASSES['']}">${esc(c.name)}</span>`;
}

// gold is the gold earned, mats the value of the materials looted; only gold is deposited.
function weekStats(week) {
    let done = 0, total = 0, gold = 0, mats = 0, pending = 0;
    const { characters, activities } = weekSetup(week);
    const perChar = characters.map(c => {
        let d = 0, t = 0, g = 0, m = 0;
        for (const a of activities) {
            if (!eligible(c, a)) continue;
            t++;
            if (isDone(week, c.id, a.id)) {
                d++;
                g += goldOf(week, c.id, a);
                m += lootValue(week, c.id, a);
            }
        }
        const deposits = depositsOf(week, c.id);
        const deposited = deposits.reduce((sum, dep) => sum + dep.gold, 0);
        const p = tracksDeposits(week) ? Math.max(0, g - deposited) : 0;
        done += d;
        total += t;
        gold += g;
        mats += m;
        pending += p;
        return { char: c, done: d, total: t, gold: g, mats: m, deposits, deposited, pending: p };
    });
    return { done, total, gold, mats, pending, perChar };
}

// ---------- Login ----------

function setSignedIn(signedIn) {
    const wasSignedIn = !$('main').hidden;
    document.body.classList.toggle('signed-out', !signedIn);
    $('main').hidden = !signedIn;
    $('#login-form').hidden = signedIn;
    if (!signedIn && wasSignedIn) {
        // Don't leave the previous data sitting in the page.
        state = { characters: [], activities: [], completions: {}, deposits: {}, bank: null, charGold: {} };
        tokenLog = null;
        render();
    }
    if (!signedIn) $('#login-form').elements.password.focus();
}

$('#login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.target;
    const error = form.querySelector('.login-error');
    const submit = form.querySelector('[type=submit]');
    submit.disabled = true;
    try {
        // Queued behind a logout that may still be waiting to be sent (see below).
        const { ok, data } = await enqueue(() => send('login', { password: form.elements.password.value }));
        if (!ok) {
            error.textContent = data.error || 'Something went wrong';
            error.hidden = false;
            form.elements.password.select();
            return;
        }
        form.reset();
        error.hidden = true;
        await api('state');
        autoRefresh();
    } finally {
        submit.disabled = false;
    }
});

// The page signs out at once, but the logout request waits for requests already underway
// (including a sync or a token price lookup), so none of them can renew the session cookie after
// it has been cleared.
$('#logout').addEventListener('click', () => {
    signOuts++;
    setSignedIn(false);
    enqueue(async () => {
        await syncRun?.catch(() => {});
        await tokenPriceRun;
        await send('logout', {});
    });
});

// ---------- Rendering ----------

function render() {
    renderWeek();
    renderHistory();
    renderGold();
    renderManage();
}

function renderWeek() {
    const current = currentWeekKey();
    const isCurrent = viewedWeek === current;
    $('#week-label').innerHTML = esc(weekLabel(viewedWeek)) + (isCurrent ? '<span class="badge-current">current</span>' : '');
    $('#next-week').disabled = isCurrent;
    $('#this-week').hidden = isCurrent;

    if (isCurrent) {
        const ms = fromKey(shiftWeek(current, 1)) - new Date();
        const days = Math.floor(ms / 86400000);
        const hours = Math.floor((ms % 86400000) / 3600000);
        $('#week-sub').textContent = `Resets in ${days}d ${hours}h (Wednesday 04:00)`;
    } else {
        $('#week-sub').textContent = 'Past week, click cells to fix entries';
    }

    const { characters: chars, activities: acts, live } = weekSetup(viewedWeek);
    if (!chars.length || !acts.length) {
        $('#week-summary').innerHTML = '';
        $('#loot-toggle').hidden = true;
        $('#grid').innerHTML = live
            ? '<div class="empty">Add some characters and activities under <b>Manage</b> to get started.</div>'
            : '<div class="empty">There were no characters or activities this week.</div>';
        return;
    }

    const stats = weekStats(viewedWeek);
    const bank = tracksDeposits(viewedWeek);
    $('#week-summary').innerHTML = weekSummary(stats);

    // The activities with loot (Naxxramas) can be hidden, and with them the characters who can't
    // do anything else: those below level 80. The totals still count everything.
    const lootActs = acts.filter(a => materialsOf(a).length);
    const shown = hideLoot ? acts.filter(a => !lootActs.includes(a)) : acts;
    const rows = hideLoot ? stats.perChar.filter(p => shown.some(a => eligible(p.char, a))) : stats.perChar;
    const hiddenChars = stats.perChar.length - rows.length;
    $('#loot-toggle').hidden = !lootActs.length;
    $('#hide-loot').checked = hideLoot;
    $('#loot-toggle span').textContent = `Hide ${lootActs.map(a => a.name).join(', ')}`
        + (hideLoot && hiddenChars ? ` (and ${hiddenChars} character${hiddenChars === 1 ? '' : 's'})` : '');
    if (!shown.length || !rows.length) {
        $('#grid').innerHTML = '<div class="empty">Everything this week is hidden.</div>';
        return;
    }

    // Characters are rows and activities are columns: there are far more characters than activities.
    // An activity with loot gets a group of columns under its name: the run, a count per material
    // and the vendor gold, so its loot is filled in on the character's own row.
    const grouped = shown.some(a => materialsOf(a).length);
    const span = grouped ? ' rowspan="2"' : '';
    let head = `<tr><th${span}></th>`, subhead = '';
    for (const a of shown) {
        const mats = materialsOf(a);
        const notes = a.notes ? ` title="${esc(a.notes)}"` : '';
        const typical = a.gold ? `<span class="req">~${fmtShort(a.gold)}</span>` : '';
        if (!mats.length) {
            head += `<th${span}${notes}>${esc(a.name)}<span class="lvl">${reqBadge(a)}${typical}</span></th>`;
            continue;
        }
        head += `<th class="group" colspan="${mats.length + 2}"${notes}>${esc(a.name)}<span class="lvl">${reqBadge(a)}</span></th>`;
        subhead += '<th class="sub" title="Tick the run, or fill in its loot. Shows what the run was worth.">Run</th>'
            + mats.map(m => priceHeader(a, m)).join('')
            + `<th class="sub" title="Gold from vendored items">Vendor<span class="lvl">${typical}</span></th>`;
    }
    head += `<th class="total"${span} title="Activities done out of those the character can do">Done</th>`
        + `<th class="total"${span} title="Gold earned, plus the value of the mats looted">Gold</th>`
        + (bank ? `<th class="total"${span} title="Gold taken to the bank. Mats aren't deposited.">Bank</th>` : '') + '</tr>'
        + (grouped ? `<tr>${subhead}</tr>` : '');

    let body = '';
    const cols = shown.map(() => ({ done: 0, total: 0, value: 0, gold: 0, counts: {} }));
    for (const { char: c, done, total, gold, mats, ...deposits } of rows) {
        body += `<tr><th>${charName(c)}<span class="lvl">${c.level}${c.realm ? ' · ' + esc(c.realm) : ''}${syncWarning(c)}</span></th>`
            + shown.map((a, i) => activityCells(c, a, cols[i])).join('')
            + `<td class="row-done${total && done === total ? ' all-done' : ''}">${done}/${total}</td>`
            + `<td class="row-gold">${gold || mats ? fmtGold(gold) + matsLine(mats) : '–'}</td>`
            + (bank ? `<td class="row-bank">${depositButton(c, deposits)}</td>` : '') + '</tr>';
    }

    let foot = `<tr><td${hideLoot ? ' title="The Done, Gold and Bank totals include what\'s hidden"' : ''}>Total</td>`;
    shown.forEach((a, i) => {
        const col = cols[i];
        foot += `<td class="${col.total && col.done === col.total ? 'all-done' : ''}">${col.done}/${col.total}<span class="gold">${fmtGold(col.value)}</span></td>`;
        const mats = materialsOf(a);
        for (const m of mats) {
            const n = col.counts[m.id] || 0;
            foot += `<td>${n}<span class="gold">${fmtGold(n * priceOf(viewedWeek, m.id).price)}</span></td>`;
        }
        if (mats.length) foot += `<td><span class="gold">${fmtGold(col.gold)}</span></td>`;
    });
    foot += `<td class="${stats.total && stats.done === stats.total ? 'all-done' : ''}">${stats.done}/${stats.total}</td>`
        + `<td><span class="gold">${fmtGold(stats.gold)}</span>${matsLine(stats.mats)}</td>`
        + (bank ? `<td>${stats.pending ? `<span class="to-deposit">${fmtGold(stats.pending)} to deposit</span>`
            : stats.gold ? '<span class="all-done">All banked ✔</span>' : ''}</td>` : '') + '</tr>';

    setGrid(`<table class="grid"><thead>${head}</thead><tbody>${body}</tbody><tfoot>${foot}</tfoot></table>`);
}

// Next to the week's dates: what was done, earned and is still to take to the bank.
function weekSummary(s) {
    return `<div><span class="muted">Done</span><b class="count">${s.done}/${s.total}</b></div>`
        + `<div><span class="muted">Earned</span><b>${fmtGold(s.gold + s.mats)}</b>`
        + `${s.mats ? `<span class="muted">incl. ${fmtGold(s.mats)} in mats</span>` : ''}</div>`
        + (s.pending ? `<div><span class="muted">To deposit</span><b class="to-deposit">${fmtGold(s.pending)}</b></div>` : '');
}

// Under a gold total: the materials' value, kept apart because it isn't gold to deposit.
function matsLine(mats) {
    return mats ? `<span class="mats">+${fmtGold(mats)} in mats</span>` : '';
}

// A material's column header, with its Auction House price per item for the week.
function priceHeader(act, m) {
    const { price, from } = priceOf(viewedWeek, m.id);
    const inherited = from && from !== viewedWeek;
    const title = !from ? 'Auction House price per item: not set yet'
        : inherited ? `Price per item, from the week of ${weekLabel(from)}. Type a new one for this week.`
        : 'Auction House price per item this week';
    return `<th class="sub">${esc(m.name)}<span class="lvl">@ <input class="price-input${inherited ? ' inherited' : ''}" id="price-${act.id}-${m.id}"`
        + ` data-mat="${m.id}" value="${from ? price : ''}" placeholder="price" title="${esc(title)}" autocomplete="off">g</span></th>`;
}

// One activity's cells in a character's row. A done run shows its gold, or for an activity with
// loot what the run was worth, followed by a field per material and one for the vendor gold.
// Filling in those fields on a run that isn't ticked yet ticks it. col adds up the column totals.
function activityCells(c, a, col) {
    const mats = materialsOf(a);
    if (!eligible(c, a)) return `<td class="cell na"${mats.length ? ` colspan="${mats.length + 2}"` : ''}>–</td>`;
    col.total++;
    const week = viewedWeek;
    const done = isDone(week, c.id, a.id);
    const ids = `data-char="${c.id}" data-act="${a.id}"`;
    const title = `${esc(c.name)}: ${esc(a.name)}`;
    let html;
    if (done) {
        const g = bumpedGold[`${week}.${c.id}.${a.id}`] ?? goldOf(week, c.id, a);
        const value = g + lootValue(week, c.id, a);
        col.done++;
        col.value += value;
        col.gold += g;
        const custom = !mats.length && g !== (a.gold || 0);
        html = `<td class="cell done"><button class="check" ${ids} title="${title}">✔</button>`
            + (mats.length ? '' : `<span class="gold-row"><button class="bump" ${ids} data-step="-1000" title="1k less">‹</button>`)
            + `<button class="gold-edit${custom ? ' custom' : ''}" ${ids} title="${mats.length ? 'What the run was worth. Click to edit the loot' : 'Click to change gold'}">${fmtShort(value)}</button>`
            + (mats.length ? '' : `<button class="bump" ${ids} data-step="1000" title="1k more">›</button></span>`) + '</td>';
    } else {
        html = `<td class="cell"><button class="check" ${ids} title="${title}">○</button></td>`;
    }
    if (!mats.length) return html;

    // Placeholders only on done runs, so the empty rows stay quiet.
    const counts = done ? lootOf(week, c.id, a.id) : {};
    for (const m of mats) {
        const n = counts[m.id] || 0;
        col.counts[m.id] = (col.counts[m.id] || 0) + n;
        html += `<td class="loot"><input class="loot-input" id="loot-${a.id}-${c.id}-${m.id}" ${ids} data-mat="${m.id}" value="${n || ''}"`
            + ` placeholder="${done ? 0 : ''}" inputmode="numeric" autocomplete="off" title="${esc(c.name)}: ${esc(m.name)}"></td>`;
    }
    return html + `<td class="loot"><input class="loot-input" id="loot-${a.id}-${c.id}-gold" ${ids} value="${done ? goldOf(week, c.id, a) : ''}"`
        + ` placeholder="${done ? a.gold || 0 : ''}" autocomplete="off" title="${esc(c.name)}: gold from vendored items"></td>`;
}

// Swaps in the grid's new HTML. Replies come in while the loot is being filled in, so the field
// being typed in is put back as it was: focused, with the text typed so far.
let swapping = false; // the old fields' focusout is not a save

function setGrid(html) {
    setHtml($('#grid'), html);
}

// Replaces el's HTML, keeping the field being typed in as it was (see setGrid).
function setHtml(el, html) {
    const active = document.activeElement;
    const typing = active?.id && active.matches('input') && el.contains(active) ? {
        id: active.id, value: active.value, edited: active.value !== active.defaultValue,
        start: active.selectionStart, end: active.selectionEnd,
    } : null;
    swapping = true;
    try {
        el.innerHTML = html;
    } finally {
        swapping = false;
    }
    const input = typing && document.getElementById(typing.id);
    if (!input) return;
    input.focus();
    if (typing.edited) input.value = typing.value;
    if (input.value === typing.value) {
        input.setSelectionRange(typing.start, typing.end);
    } else {
        input.select(); // e.g. the default gold appeared when the run was ticked
    }
}

// Under a character's weekly total: a button to record a deposit of the gold not yet banked, or,
// once everything is banked, a mark that undoes the latest deposit.
function depositButton(c, { deposits, deposited, pending }) {
    if (!tracksDeposits(viewedWeek)) return '';
    const history = deposits.length
        ? 'Deposited:' + deposits.map(d => `\n${fmtGold(d.gold)} on ${fmtWhen(d.time)}`).join('') : '';
    if (pending) {
        const label = `Deposit ${deposited ? '+' : ''}${fmtShort(pending)}`;
        const title = `${esc(c.name)}: mark ${fmtGold(pending)} as deposited in the bank${history ? '\n\n' + history : ''}`;
        return `<button class="deposit" data-deposit="${c.id}" data-gold="${pending}" title="${title}">${label}</button>`;
    }
    if (!deposited) return '';
    return `<button class="deposit banked" data-undo-deposit="${c.id}" title="${history}\n\nClick to undo the last deposit">Banked ✔</button>`;
}

// Every week from the current one back to the oldest with anything done, newest first.
function historyWeeks() {
    const current = currentWeekKey();
    // The server rejects weeks before 2004 (isWeekKey in api.php); skipping them here too keeps
    // damaged data from making the loop below endless (toKey doesn't pad years under 1000).
    const keys = Object.keys(state.completions || {}).filter(k => k >= '2004' && k <= current).sort();
    const oldest = keys[0] || current;
    const weeks = [];
    for (let k = current; k >= oldest; k = shiftWeek(k, -1)) {
        const stats = weekStats(k);
        weeks.push({ week: k, stats, earned: stats.gold + stats.mats });
    }
    return weeks;
}

function renderHistory() {
    const current = currentWeekKey();
    let rows = '', allGold = 0, pastGold = 0, pastWeeks = 0, allPending = 0;
    for (const { week: k, stats: s, earned } of historyWeeks()) {
        allGold += earned;
        allPending += s.pending;
        if (k !== current) {
            pastGold += earned;
            pastWeeks++;
        }
        const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
        const chars = s.perChar.map(p => `<span>${charName(p.char)} ${p.done}/${p.total}</span>`).join('');
        rows += `<div class="history-row" data-week="${k}">
            <div class="when">${esc(weekLabel(k))}${k === current ? '<span class="badge-current">current</span>' : ''}</div>
            <div class="bar"><div style="width:${pct}%"></div></div>
            <div class="total">${s.done}/${s.total}</div>
            <div class="week-gold">${fmtGold(earned)}${s.mats ? `<span class="mats">incl. ${fmtGold(s.mats)} in mats</span>` : ''}${s.pending ? `<span class="to-deposit">${fmtGold(s.pending)} to deposit</span>` : ''}</div>
            <div class="chars">${chars}</div>
        </div>`;
    }

    let html = `<div class="summary">
        <div><span class="muted">Total earned</span><b>${fmtGold(allGold)}</b></div>
        ${pastWeeks ? `<div><span class="muted">Average per finished week</span><b>${fmtGold(pastGold / pastWeeks)}</b></div>` : ''}
        ${allPending ? `<div><span class="muted">Not deposited yet</span><b class="to-deposit">${fmtGold(allPending)}</b></div>` : ''}
    </div>`;
    html += `<div class="history-list">${rows}</div>`
        + '<p class="muted">Past weeks use the characters, levels and activities they had at the reset.</p>';
    $('#history').innerHTML = html;
}

// ---------- Gold on hand ----------
// The gold owned: the bank plus what each character carries, both counted by hand from the game.
// Deposits add to the bank's count between counts (the "deposit" action in api.php).

function goldOnHand() {
    const bank = state.bank?.gold || 0;
    const chars = state.characters.reduce((sum, c) => sum + (state.charGold?.[c.id]?.gold || 0), 0);
    return { bank, chars, total: bank + chars };
}

// Deposits recorded since the bank was last counted, which its count already includes.
function depositedSinceCount() {
    const since = state.bank?.time || 0;
    let sum = 0;
    for (const chars of Object.values(state.deposits || {})) {
        for (const list of Object.values(chars)) {
            for (const d of list) if (d.time > since) sum += d.gold;
        }
    }
    return sum;
}

// Field values use plain comma grouping: the browser's own (e.g. "1.234.567") wouldn't parse back.
function countField(id, count, attrs, title) {
    const value = count ? count.gold.toLocaleString('en-US') : '';
    return `<input class="count-input" id="${id}" ${attrs} value="${value}" placeholder="not counted"`
        + ` inputmode="decimal" autocomplete="off" title="${esc(title)}">`;
}

// A goal can be priced in euros (real-money purchases): it then costs the WoW Tokens that cover
// it. A token is redeemed for 13€ of Battle.net Balance in the EU, and tokens can't be split.
const TOKEN_EUROS = 13;
const TOKEN_REFRESH = 3600; // s; the token price is looked up again after this while it's needed

// What a goal costs in gold: its gold, or the tokens for its euros at the last known price. The
// Battle.net Balance from tokens already bought (euros) pays for what it can first. gold is null
// while there's no price yet, unless the balance covers it all.
function goalCost(goal, balance = state.balance?.euros || 0) {
    if (goal.euros == null) return { gold: goal.gold, tokens: null, fromBalance: 0 };
    const cents = Math.round(goal.euros * 100);
    const fromBalance = Math.min(cents, Math.round(balance * 100));
    const tokens = Math.ceil((cents - fromBalance) / (TOKEN_EUROS * 100));
    const price = state.tokenPrice?.gold;
    return { gold: !tokens ? 0 : price ? tokens * price : null, tokens, fromBalance: fromBalance / 100 };
}

// Progress towards each goal. Every goal also needs the reserve to stay in the bank once it's
// bought. The first goal is the current one. A later one shows two things: how far the gold goes
// if it were the current goal (alone), and how far the gold beyond the current goal goes towards
// it (onTop), whose "left" is what the current goal and this one need together. Either is null
// when a cost isn't known yet (a goal in euros before the token price is in). On top of the current
// goal, only the Battle.net Balance it leaves over counts.
function goalsProgress(total) {
    const reserve = state.reserve || 0;
    const balance = state.balance?.euros || 0;
    const pct = (have, need) => need > 0 ? Math.max(0, Math.min(100, Math.floor((have / need) * 100))) : 100;
    const goals = (state.goals || []).map(goal => ({ goal, ...goalCost(goal, balance) }));
    const current = goals[0];
    const balanceLeft = Math.max(0, balance - (current?.fromBalance || 0));
    return goals.map((g, i) => {
        if (g.gold == null) return { ...g, alone: null, onTop: null };
        const need = g.gold + reserve;
        const alone = { need, pct: pct(total, need), left: Math.max(0, need - total) };
        const extra = i ? goalCost(g.goal, balanceLeft).gold : null;
        const onTop = !i || current.gold == null || extra == null ? null : {
            pct: pct(total - current.gold - reserve, extra),
            left: Math.max(0, current.gold + extra + reserve - total),
        };
        return { ...g, alone, onTop };
    });
}

// Gold earned per week on average (gold plus mats), for how long a goal will take. Like History's
// average, only finished weeks count: the current one is usually far from done. countThisWeek adds
// it, once it's as good as done. Null before there's a week to count.
function weeklyAverage() {
    const weeks = historyWeeks();
    const counted = countThisWeek ? weeks : weeks.slice(1);
    if (!counted.length) return null;
    return { gold: counted.reduce((sum, w) => sum + w.earned, 0) / counted.length, weeks: counted.length };
}

// How many weeks of average earnings the gold still to go takes: null when it's reached or there's
// no average to go by.
function weeksToGo(left, average) {
    return left > 0 && average?.gold > 0 ? Math.ceil(left / average.gold) : null;
}

function fmtWeeks(n) {
    return `≈ ${n} week${n === 1 ? '' : 's'}`;
}


function goalName(goal, i) {
    return goal.name || (i ? 'Later goal' : 'Current goal');
}

// A bar filling towards a goal. A later goal's has two fills: how far the gold goes if it were the
// current goal (paler, behind), and how far the gold beyond the current goal goes (in front).
function progressBar(pct, behind = null) {
    return '<span class="goal-bar">' + (behind == null ? '' : `<span class="alone" style="width:${behind}%"></span>`)
        + `<span style="width:${pct}%"></span></span>`;
}

function fmtEuros(euros) {
    return `${Number.isInteger(euros) ? euros : euros.toFixed(2)}€`;
}

// An amount in euros, with or without the €: "13", "14,99 €", "25 eur". Empty is null, garbage NaN.
function parseEuros(str) {
    const s = str.trim().toLowerCase().replace(/€|eur|\s/g, '');
    if (s === '') return null;
    const m = s.match(/^(\d+)(?:[.,](\d{1,2}))?$/);
    return m ? Number(`${m[1]}.${m[2] || 0}`) : NaN;
}

// A goal's price: gold as parsePrice reads it, or euros when marked with € or "eur" ("25€",
// "14,99 €"). null when it isn't one: a goal can't be emptied, only removed.
function parseGoalPrice(str) {
    const s = str.trim().toLowerCase();
    if (!/€|eur/.test(s)) {
        const gold = parsePrice(s);
        return gold > 0 ? { gold } : null;
    }
    const euros = parseEuros(s);
    return euros > 0 ? { euros } : null;
}

function renderGold() {
    const { bank, chars, total } = goldOnHand();
    const counted = state.bank || state.characters.some(c => state.charGold?.[c.id]);
    const goals = goalsProgress(total);
    const current = goals[0];
    const average = goals.length ? weeklyAverage() : null;
    const currentWeeks = current?.alone && weeksToGo(current.alone.left, average);
    $('#nav-total').hidden = !counted && !current;
    $('#nav-total').innerHTML = `<span>${fmtGold(total)}</span>`
        + (current?.alone ? `${progressBar(current.alone.pct)}<span class="goal-pct">${current.alone.pct}% of ${fmtShort(current.alone.need)}</span>` : '');
    $('#nav-total').title = current?.alone
        ? `${goalName(current.goal, 0)}: ${fmtGold(total)} of ${fmtGold(current.alone.need)}, `
            + (current.alone.left ? `${fmtGold(current.alone.left)} to go${currentWeeks ? `, ${fmtWeeks(currentWeeks)}` : ''}` : 'reached')
            + '. Click to update.'
        : 'All your gold: the bank plus every character. Click to update it.';

    const since = depositedSinceCount();
    const bankNote = [
        state.bank?.time ? `counted ${ago(state.bank.time)}` : state.bank ? 'from deposits only' : '',
        since && state.bank?.time ? `incl. ${fmtGold(since)} deposited since` : '',
    ].filter(Boolean).join(' · ');
    let rows = `<tr class="bank-row"><th>Bank</th>`
        + `<td>${countField('count-bank', state.bank, '', 'Gold in the bank. Deposits on the Week page add to it.')}</td>`
        + `<td class="muted">${bankNote}</td></tr>`;
    for (const c of state.characters) {
        const count = state.charGold?.[c.id];
        rows += `<tr><th>${charName(c)}<span class="lvl">${c.level}${c.realm ? ' · ' + esc(c.realm) : ''}</span></th>`
            + `<td>${countField(`count-${c.id}`, count, `data-char="${c.id}"`, `Gold on ${c.name}`)}</td>`
            + `<td class="muted">${count?.time ? `updated ${ago(count.time)}` : ''}</td></tr>`;
    }

    setHtml($('#gold'), `<div class="summary">
            <div><span class="muted">Total</span><b>${fmtGold(total)}</b></div>
            <div><span class="muted">In the bank</span><b class="count">${fmtGold(bank)}</b></div>
            <div><span class="muted">On characters</span><b class="count">${fmtGold(chars)}</b></div>
        </div>
        <table class="goal-list">${goals.map((g, i) => goalRow(g, i, average)).join('')}${newGoalRow(goals.length)}${reserveRow()}</table>
        ${goals.length ? averageLine(average) : ''}
        ${tokenSection()}
        <table class="gold-list">${rows}</table>
        <p class="muted">Type in the gold as the game shows it (1,234,567, 250k or 1.2m). Enter or ↓ moves to the next field,
            Escape undoes the typing, and an empty field means not counted.</p>`);
    loadTokenLog();
}

// A goal's row: its name and price, which save when they're left, its progress and how many
// weeks it's likely to take.
function goalRow({ goal, gold, tokens, fromBalance, alone, onTop }, i, average) {
    const ids = `data-id="${goal.id}"`;
    const price = goal.euros == null ? goal.gold.toLocaleString('en-US') : fmtEuros(goal.euros);
    return `<tr${i ? '' : ' class="current"'}><th>${i ? 'Later' : 'Current'}</th>`
        + `<td><input class="goal-input" id="goal-name-${goal.id}" ${ids} data-field="name" value="${esc(goal.name)}"`
        + ` placeholder="${goalName({}, i)}" autocomplete="off"></td>`
        + `<td><input class="goal-input count-input" id="goal-gold-${goal.id}" ${ids} data-field="gold" value="${price}"`
        + ` inputmode="decimal" autocomplete="off" title="Gold, or a real-money price in euros (e.g. 25€)">${goalCostNote(gold, tokens, fromBalance)}</td>`
        + `<td>${goalProgressCell(alone, onTop, goalWeeks(alone, onTop, average))}</td>`
        + `<td class="goal-buttons">${i ? `<button data-goal-first="${goal.id}" title="Save up for this one now">Make current</button>` : ''}`
        + `<button class="danger" data-goal-remove="${goal.id}" title="Remove this goal">Remove</button></td></tr>`;
}

// Under a goal in euros: what the Battle.net Balance pays, the tokens for the rest at today's price,
// and what they'd cost at a good price (see goodTokenPrice).
function goalCostNote(gold, tokens, fromBalance) {
    if (tokens == null) return '';
    const lines = [];
    if (fromBalance) lines.push(`${fmtEuros(fromBalance)} from Balance`);
    if (tokens || !fromBalance) {
        lines.push(`${fromBalance ? '+ ' : ''}${tokens} token${tokens === 1 ? '' : 's'}${gold == null ? '' : ` = ${fmtGold(gold)}`}`);
    }
    const good = goodTokenPrice();
    const price = state.tokenPrice?.gold;
    const dip = tokens && good && price && good < price
        ? `<span class="goal-cost dip" title="At a good price: the cheapest 10% of the last 30 days">≈ ${fmtGold(tokens * good)} at a good price</span>` : '';
    return lines.map(line => `<span class="goal-cost">${line}</span>`).join('') + dip;
}

// Weeks of average earnings until a goal is reached, under its progress. For a later goal, until
// there's enough for the current goal and this one (its "on top" figure), and on its own.
function goalWeeks(alone, onTop, average) {
    const weeks = alone && weeksToGo((onTop || alone).left, average);
    if (!weeks) return '';
    const when = new Date(Date.now() + weeks * 7 * DAY * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    const own = onTop && weeksToGo(alone.left, average);
    const title = `At ${fmtGold(average.gold)} earned a week${onTop ? `, for ${goalName(state.goals[0], 0)} and this goal together` : ''}`;
    return `<span class="goal-eta" title="${esc(title)}">${fmtWeeks(weeks)}${onTop ? ' for both' : ''}, around ${esc(when)}`
        + `${own && own !== weeks ? ` · ${fmtWeeks(own)} on its own` : ''}</span>`;
}

// What "weeks to go" is based on, with the switch that counts the current week too.
function averageLine(average) {
    const basis = average
        ? `Weeks to go are at ${fmtGold(average.gold)} earned a week, the average of ${average.weeks}`
            + `${countThisWeek ? '' : ' finished'} week${average.weeks === 1 ? '' : 's'}${countThisWeek ? ' including this one' : ''}.`
        : 'Weeks to go show once a week is finished.';
    return `<div class="goal-average muted"><span>${basis}</span><label class="toggle">`
        + `<input type="checkbox" id="count-this-week"${countThisWeek ? ' checked' : ''}><span>Count this week too</span></label></div>`;
}

// The current goal has one bar. A later goal's bar has both fills, and both numbers in the
// matching colours, unless the gold beyond the current goal already covers it.
function goalProgressCell(alone, onTop, weeks) {
    if (!alone) return '<span class="muted">Waiting for the WoW Token price</span>';
    const reserve = state.reserve ? ` plus the ${fmtGold(state.reserve)} kept in the bank` : '';
    const left = p => p.left ? `${fmtGold(p.left)} to go` : 'reached ✔';
    const currentName = esc(goalName(state.goals[0], 0));
    let text, bar, title;
    if (!onTop) {
        text = `${alone.pct}%, ${left(alone)}`;
        bar = progressBar(alone.pct);
        title = `What the goal costs${reserve}.`;
    } else if (!onTop.left) {
        text = `reached, even on top of ${currentName} ✔`;
        bar = progressBar(100);
        title = `The gold covers ${currentName}, this goal${reserve}.`;
    } else {
        text = `<b class="on-top">${onTop.pct}%</b> on top of ${currentName}, ${left(onTop)}`
            + ` · <b class="alone">${alone.pct}%</b> on its own${alone.left ? `, ${left(alone)}` : ' ✔'}`;
        bar = progressBar(onTop.pct, alone.pct);
        title = `Bright: the gold beyond ${currentName}${reserve}, towards this goal. Pale: how far the gold goes if this were the current goal.`;
    }
    return `<div class="goal-progress" title="${esc(title)}">${bar}<span class="muted">${text}${weeks}</span></div>`;
}

// The fields for a new goal. It goes at the end of the list, so the first goal added is the current one.
function newGoalRow(count) {
    return `<tr class="new-goal"><th>${count ? 'Add' : 'Goal'}</th>`
        + `<td><input class="goal-input new-goal" id="goal-new-name" data-field="name"`
        + ` placeholder="${count ? 'a later goal' : 'e.g. a mount'}" autocomplete="off"></td>`
        + '<td><input class="goal-input count-input new-goal" id="goal-new-gold" data-field="gold" placeholder="gold or €"'
        + ' inputmode="decimal" autocomplete="off" title="Gold, or a real-money price in euros (e.g. 25€)"></td>'
        + '<td colspan="2"><button id="goal-add">Add goal</button></td></tr>';
}

// The gold that must stay in the bank after buying a goal, added to every goal.
function reserveRow() {
    return '<tr class="reserve"><th>Keep</th><td class="muted">in the bank after buying a goal</td>'
        + `<td><input class="goal-input count-input" id="goal-reserve" data-field="reserve" value="${(state.reserve || 0).toLocaleString('en-US')}"`
        + ' placeholder="none" inputmode="decimal" autocomplete="off"></td>'
        + '<td colspan="2" class="muted">Added to every goal</td></tr>';
}

// ---------- WoW Token ----------
// The server logs every price it looks up (TOKEN_LOG_FILE in api.php), every few minutes even while
// no page is open. The Gold page shows that history and when the price usually dips, so the tokens
// for goals in euros can be bought cheaply, along with the Battle.net Balance of tokens already bought.

const DAY = 86400; // s
let tokenLog = null; // [[time, gold], …] oldest first, from the "tokenHistory" action
let tokenLogRun = null;

// Fetches the log entries the page doesn't have yet, whenever the state has a newer price than
// them. Only while the Gold page is shown: the log grows by a few hundred entries a day.
function loadTokenLog() {
    const have = tokenLog?.length ? tokenLog.at(-1)[0] : 0;
    const showing = !$('#view-gold').hidden && !$('main').hidden;
    if (tokenLogRun || !showing || (tokenLog && have >= (state.tokenPrice?.time || 0))) return;
    const signOutsBefore = signOuts;
    tokenLogRun = send('tokenHistory', { since: have }).then(({ ok, data }) => {
        if (!ok || signOuts !== signOutsBefore || !Array.isArray(data.history)) return;
        tokenLog = [...(tokenLog || []), ...data.history];
        requestRender();
    }).finally(() => { tokenLogRun = null; });
}

// The logged prices of the last `days` days (Infinity for all of them).
function tokenWindow(days) {
    const from = Date.now() / 1000 - days * DAY;
    return (tokenLog || []).filter(([t]) => t >= from);
}

// What counts as a good price: the cheapest 10% of the last 30 days. Null until those cover two
// days, too short to tell a dip from the price of the moment. Worked out once per log update.
let goodPriceCache = { log: null, length: 0, price: null };

function goodTokenPrice() {
    if (goodPriceCache.log === tokenLog && goodPriceCache.length === tokenLog?.length) return goodPriceCache.price;
    const recent = tokenWindow(30);
    let price = null;
    if (recent.length > 1 && recent.at(-1)[0] - recent[0][0] >= 2 * DAY) {
        const prices = recent.map(e => e[1]).sort((a, b) => a - b);
        price = prices[Math.floor(prices.length * 0.1)];
    }
    goodPriceCache = { log: tokenLog, length: tokenLog?.length, price };
    return price;
}

// How far the price usually is from the price around it at each slot (an hour of the day, a day of
// the week). Each price is compared with the average of those within halfWindow of it, so a rising
// or falling price doesn't count, and the gaps are averaged per slot. Null while a slot has no prices.
function pricePattern(entries, slots, slotOf, halfWindow) {
    const sums = Array(slots).fill(0);
    const counts = Array(slots).fill(0);
    let lo = 0, hi = 0, sum = 0;
    for (const [time, gold] of entries) {
        while (hi < entries.length && entries[hi][0] <= time + halfWindow) sum += entries[hi++][1];
        while (entries[lo][0] < time - halfWindow) sum -= entries[lo++][1];
        const slot = slotOf(new Date(time * 1000));
        sums[slot] += gold / (sum / (hi - lo)) - 1;
        counts[slot]++;
    }
    return counts.every(Boolean) ? sums.map((s, i) => s / counts[i]) : null;
}

// The run of `width` slots (wrapping round) when the price is usually lowest (sign -1) or highest (1).
function patternPeak(pattern, width, sign) {
    let best = null;
    for (let from = 0; from < pattern.length; from++) {
        let sum = 0;
        for (let k = 0; k < width; k++) sum += pattern[(from + k) % pattern.length];
        if (!best || (sum / width) * sign > best.dev * sign) best = { from, dev: sum / width };
    }
    return best;
}

// The days of the week in the order of the WoW week, which starts on Wednesday.
const WEEKDAYS = ['Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'Monday', 'Tuesday'];
const weekdaySlot = d => (d.getDay() + 4) % 7;
const fmtHour = h => `${String(h % 24).padStart(2, '0')}:00`;

function fmtPct(dev) {
    return `${(Math.abs(dev) * 100).toFixed(1)}%`;
}

// A gap from the usual price in gold per token, at today's price.
function fmtWorth(dev) {
    const gold = state.tokenPrice?.gold;
    return gold ? ` (≈ ${fmtGold(Math.abs(dev) * gold)} ${dev < 0 ? 'less' : 'more'})` : '';
}

// The token's price, the good price to wait for, the Battle.net Balance and the price history.
function tokenSection() {
    const price = state.tokenPrice;
    const euroGoals = (state.goals || []).some(g => g.euros != null);
    if (!state.armoryEnabled && !price && !state.balance && !euroGoals) return '';
    const good = goodTokenPrice();
    const balance = state.balance;
    const notes = [];
    if (!state.armoryEnabled) notes.push('The Battle.net API isn\'t set up on the server, so the price isn\'t looked up.');
    if (state.tokenPriceError) notes.push(`<span class="sync-error">Last lookup failed: ${esc(state.tokenPriceError)}</span>`);
    const refresh = state.armoryEnabled ? `<button id="token-refresh"${tokenPriceRun ? ' disabled' : ''}`
        + ` title="Look up the price now. The server also does every few minutes.">${tokenPriceRun ? 'Refreshing…' : 'Refresh'}</button>` : '';
    return `<section class="token">
        <h2>WoW Token</h2>
        <div class="summary">
            <div><span class="muted">Price</span><b>${price ? fmtGold(price.gold) : '–'}</b>
                <span class="muted">${price ? `for ${TOKEN_EUROS}€ of Balance, set ${ago(price.time)}` : 'not looked up yet'}</span></div>
            <div><span class="muted">Good price</span><b class="count">${good ? `≤ ${fmtGold(good)}` : '–'}</b>
                <span class="muted">${good ? 'the cheapest 10% of 30 days' : 'after 2 days of prices'}</span></div>
            <div><span class="muted">Battle.net Balance</span>
                <input class="goal-input count-input" id="token-balance" data-field="balance" value="${balance ? fmtEuros(balance.euros) : ''}"
                    placeholder="none" inputmode="decimal" autocomplete="off" title="Balance from tokens already bought, in euros. Goals in euros use it first.">
                <span class="muted">${balance ? `updated ${ago(balance.time)}` : 'from tokens already bought'}</span></div>
            <div class="token-refresh">${refresh}</div>
        </div>
        ${price && good && price.gold <= good ? '<p class="token-good">▼ A good time to buy: the price is in the cheapest 10% of the last 30 days.</p>' : ''}
        ${notes.length ? `<p class="muted">${notes.join(' ')}</p>` : ''}
        ${tokenHistory(price, good)}
    </section>`;
}

function tokenHistory(price, good) {
    if (!tokenLog) {
        chartView = null;
        return price ? '<p class="muted">Loading the price history…</p>' : '';
    }
    if (tokenLog.length < 2) {
        chartView = null;
        return '<p class="muted">The price history fills in as the server logs prices, every few minutes.</p>';
    }
    const ranges = [['1', '24 hours'], ['7', '7 days'], ['30', '30 days'], ['90', '90 days'], ['all', 'All']];
    const buttons = ranges.map(([days, label]) =>
        `<button data-token-range="${days}"${days === tokenRange ? ' class="active"' : ''}>${label}</button>`).join('');
    const entries = tokenWindow(tokenRange === 'all' ? Infinity : Number(tokenRange));
    return `<div class="token-ranges">${buttons}</div>${rangeStats(entries, price)}${tokenChart(entries, good)}${tokenPatterns()}`;
}

function rangeStats(entries, price) {
    if (!entries.length) return '<p class="muted">No prices were logged in this period.</p>';
    let low = entries[0], high = entries[0], sum = 0;
    for (const e of entries) {
        if (e[1] < low[1]) low = e;
        if (e[1] > high[1]) high = e;
        sum += e[1];
    }
    const higher = price ? entries.filter(e => e[1] > price.gold).length : 0;
    return `<p class="muted token-stats">Low <b>${fmtGold(low[1])}</b> on ${esc(fmtWhen(low[0]))}`
        + ` · average <b>${fmtGold(sum / entries.length)}</b> · high <b>${fmtGold(high[1])}</b> on ${esc(fmtWhen(high[0]))}`
        + (price ? ` · now lower than ${Math.round((higher / entries.length) * 100)}% of these prices` : '') + '</p>';
}

// The price over the chosen period. The plot is drawn in its own units and stretched to the page's
// width; the labels, the crosshair and its tooltip are HTML on top, placed in percentages.
const CHART_W = 720, CHART_H = 200;
let chartView = null; // what the chart shows, for the crosshair (showChartPoint)

function tokenChart(entries, good) {
    if (entries.length < 2) {
        chartView = null;
        return '';
    }
    const t0 = entries[0][0], t1 = entries.at(-1)[0];
    let lo = Infinity, hi = -Infinity;
    for (const [, gold] of entries) {
        lo = Math.min(lo, gold);
        hi = Math.max(hi, gold);
    }
    const pad = (hi - lo) * 0.1 || hi * 0.02 || 1;
    lo -= pad;
    hi += pad;
    chartView = { entries, t0, t1, lo, hi };
    const x = t => ((t - t0) / (t1 - t0 || 1)) * CHART_W;
    const y = gold => CHART_H - ((gold - lo) / (hi - lo)) * CHART_H;
    const pct = (v, of) => `${((v / of) * 100).toFixed(2)}%`;
    const line = thinOut(entries, 360).map(([t, gold], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(gold).toFixed(1)}`).join('');
    const ticks = niceTicks(lo, hi, 6);
    const showGood = good && good > lo && good < hi;
    const { times, label } = timeTicks(t0, t1);
    return `<div class="token-chart">
        <div class="token-y">${ticks.map(v => `<span style="top:${pct(y(v), CHART_H)}">${fmtShort(v)}</span>`).join('')}</div>
        <div class="token-plot">
            <svg viewBox="0 0 ${CHART_W} ${CHART_H}" preserveAspectRatio="none" aria-hidden="true">
                ${ticks.map(v => `<line class="grid" x1="0" x2="${CHART_W}" y1="${y(v)}" y2="${y(v)}"/>`).join('')}
                ${showGood ? `<line class="good" x1="0" x2="${CHART_W}" y1="${y(good)}" y2="${y(good)}"/>` : ''}
                <path class="area" d="${line}L${CHART_W},${CHART_H}L0,${CHART_H}Z"/>
                <path class="line" d="${line}"/>
            </svg>
            ${showGood ? `<span class="good-label" style="top:${pct(y(good), CHART_H)}">good price</span>` : ''}
            <div class="cross"></div><div class="dot"></div><div class="tip"></div>
        </div>
        <div class="token-x">${times.map(t => `<span style="left:${pct(x(t), CHART_W)}">${esc(label(t))}</span>`).join('')}</div>
    </div>`;
}

// At most about 2 × buckets points, keeping each bucket's lowest and highest price so the dips show.
function thinOut(entries, buckets) {
    if (entries.length <= buckets * 2) return entries;
    const size = entries.length / buckets;
    const points = [];
    for (let b = 0; b < buckets; b++) {
        const slice = entries.slice(Math.floor(b * size), Math.floor((b + 1) * size));
        if (!slice.length) continue;
        let low = slice[0], high = slice[0];
        for (const e of slice) {
            if (e[1] < low[1]) low = e;
            if (e[1] > high[1]) high = e;
        }
        points.push(...(low[0] <= high[0] ? [low, high] : [high, low]));
    }
    return points;
}

// Round values for the axis, about `count` of them between lo and hi.
function niceTicks(lo, hi, count) {
    const raw = (hi - lo) / count;
    const magnitude = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map(m => m * magnitude).find(s => s >= raw);
    const ticks = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) ticks.push(v);
    return ticks;
}

// Up to 6 times for the axis, on round hours, midnights or the 1st of a month, and how to label them.
function timeTicks(t0, t1) {
    const hours = (t1 - t0) / 3600;
    const step = [3, 6, 12, 24, 48, 96, 168, 336, 720, 1440, 2160, 4320].find(h => hours / h <= 6) || 8640;
    const d = new Date(t0 * 1000);
    d.setMinutes(0, 0, 0);
    let next;
    if (step < 24) {
        d.setHours(Math.ceil(d.getHours() / step) * step);
        next = () => d.setHours(d.getHours() + step);
    } else if (step < 720) {
        d.setHours(24); // the next midnight
        next = () => d.setDate(d.getDate() + step / 24);
    } else {
        d.setHours(0);
        d.setDate(1);
        d.setMonth(d.getMonth() + 1);
        next = () => d.setMonth(d.getMonth() + step / 720);
    }
    const times = [];
    for (; d / 1000 <= t1; next()) {
        if (d / 1000 >= t0) times.push(d / 1000);
    }
    const options = step < 24 ? { weekday: 'short', hour: '2-digit', minute: '2-digit' }
        : step < 720 ? { day: 'numeric', month: 'short' } : { month: 'short', year: 'numeric' };
    return { times, label: t => new Date(t * 1000).toLocaleString(undefined, options) };
}

// Moves the crosshair to the logged price nearest the pointer, with its price and time.
function showChartPoint(plot, clientX) {
    if (!chartView) return;
    const { entries, t0, t1, lo, hi } = chartView;
    const box = plot.getBoundingClientRect();
    const t = t0 + Math.max(0, Math.min(1, (clientX - box.left) / box.width)) * (t1 - t0);
    let a = 0, b = entries.length - 1; // the first price at or after t
    while (a < b) {
        const m = (a + b) >> 1;
        if (entries[m][0] < t) a = m + 1; else b = m;
    }
    const [time, gold] = a > 0 && t - entries[a - 1][0] < entries[a][0] - t ? entries[a - 1] : entries[a];
    const f = (time - t0) / (t1 - t0 || 1);
    const left = `${f * 100}%`;
    plot.querySelector('.cross').style.left = left;
    const dot = plot.querySelector('.dot');
    dot.style.left = left;
    dot.style.top = `${(1 - (gold - lo) / (hi - lo)) * 100}%`;
    const tip = plot.querySelector('.tip');
    tip.innerHTML = `<b>${fmtGold(gold)}</b><span>${esc(fmtWhen(time))}</span>`;
    tip.style.left = left;
    tip.classList.toggle('flip', f > 0.6);
    plot.classList.add('hovering');
}

// When the price is usually lower or higher: by hour of the day and by day of the week, from the
// last 90 days, in the browser's time.
function tokenPatterns() {
    const recent = tokenWindow(90);
    const span = recent.length ? (recent.at(-1)[0] - recent[0][0]) / DAY : 0;
    const hours = span >= 3 && pricePattern(recent, 24, d => d.getHours(), DAY / 2);
    const days = span >= 14 && pricePattern(recent, 7, weekdaySlot, 3.5 * DAY);
    let html = '<div class="token-patterns"><div><h3>By hour of the day</h3>';
    if (hours) {
        const low = patternPeak(hours, 3, -1), high = patternPeak(hours, 3, 1);
        html += `<p class="muted">Usually lowest around <b>${fmtHour(low.from)}–${fmtHour(low.from + 3)}</b>,`
            + ` ${fmtPct(low.dev)} below the price around it${fmtWorth(low.dev)}.`
            + ` Highest around ${fmtHour(high.from)}–${fmtHour(high.from + 3)}, ${fmtPct(high.dev)} above.</p>`
            + patternBars(hours, i => (i % 6 ? '' : fmtHour(i)), i => `${fmtHour(i)}–${fmtHour(i + 1)}`);
    } else {
        html += `<p class="muted">Shows after 3 days of prices (${span.toFixed(1)} so far).</p>`;
    }
    html += '</div><div><h3>By day of the week</h3>';
    if (days) {
        const low = patternPeak(days, 1, -1), high = patternPeak(days, 1, 1);
        html += `<p class="muted">Usually lowest on <b>${WEEKDAYS[low.from]}</b>, ${fmtPct(low.dev)} below the price around it${fmtWorth(low.dev)}.`
            + ` Highest on ${WEEKDAYS[high.from]}, ${fmtPct(high.dev)} above.</p>`
            + patternBars(days, i => WEEKDAYS[i].slice(0, 3), i => WEEKDAYS[i]);
    } else {
        html += `<p class="muted">Shows after 2 weeks of prices (${Math.floor(span)} day${Math.floor(span) === 1 ? '' : 's'} so far).</p>`;
    }
    return html + '</div></div>'
        + (hours ? '<p class="muted">From the last 90 days, in your time. Each price is compared with the average price in the day'
            + ' (or the week) around it, so a rising or falling price doesn\'t count. Point at a bar for its figures.</p>' : '');
}

// One bar per slot, up from the middle line when the price is usually higher and down when lower.
function patternBars(pattern, label, name) {
    const max = Math.max(...pattern.map(Math.abs)) || 1;
    return '<div class="pattern">' + pattern.map((dev, i) => {
        const title = `${name(i)}: usually ${fmtPct(dev)} ${dev < 0 ? 'below' : 'above'} the price around it${fmtWorth(dev)}`;
        return `<div class="pattern-col" title="${esc(title)}"><span class="${dev < 0 ? 'lower' : 'higher'}"`
            + ` style="height:${((Math.abs(dev) / max) * 50).toFixed(1)}%"></span><i>${label(i)}</i></div>`;
    }).join('') + '</div>';
}


function listItem(type, item, inner) {
    const editing = forms[type].form.elements.id.value === item.id;
    return `<li${editing ? ' class="editing"' : ''}>
        <span class="grow">${inner}</span>
        <button data-move="-1" data-type="${type}" data-id="${item.id}" title="Move up">▲</button>
        <button data-move="1" data-type="${type}" data-id="${item.id}" title="Move down">▼</button>
        <button data-edit data-type="${type}" data-id="${item.id}">Edit</button>
        <button data-delete data-type="${type}" data-id="${item.id}" class="danger">Delete</button>
    </li>`;
}

function renderManage() {
    $('#char-list').innerHTML = state.characters.map(c =>
        listItem('characters', c, `${charName(c)} <span class="muted">${c.level} ${esc(c.class)}${c.realm ? ' · ' + esc(c.realm) : ''}</span>`
            + (c.syncError ? ` <span class="sync-error">${esc(c.syncError)}</span>` : ''))
    ).join('') || '<li class="muted">No characters yet.</li>';
    renderSyncStatus();

    $('#act-list').innerHTML = state.activities.map(a => {
        const mats = materialsOf(a).map(m => esc(m.name)).join(', ');
        const details = [mats && `Loot: ${mats}`, esc(a.notes || '')].filter(Boolean).join(' · ');
        return listItem('activities', a, `${esc(a.name)}${reqBadge(a)}${a.gold ? ` <span class="gold-inline">~${fmtGold(a.gold)}</span>` : ''}`
            + (details ? `<span class="details">${details}</span>` : ''));
    }).join('') || '<li class="muted">No activities yet.</li>';
}

// ---------- Armory sync ----------
// The server refreshes levels and classes from the Blizzard API (armory.php). The page asks for
// that whenever the last sync is older than state.autoSyncInterval, or from the Manage button.

let syncRun = null; // promise of the sync in progress
let lastAutoSync = 0; // ms; keeps a failing server from being retried every minute

function sync() {
    if (!syncRun) {
        syncRun = runSync().finally(() => {
            syncRun = null;
            renderSyncStatus();
        });
        renderSyncStatus();
    }
    return syncRun;
}

// The Battle.net lookups take a while, so the sync bypasses the request queue rather than
// holding up clicks. Its reply may then be older than theirs, so instead of showing it, the
// state is fetched again through the queue.
async function runSync() {
    const signOutsBefore = signOuts;
    const reply = await send('sync', {});
    if (signOuts !== signOutsBefore) return;
    check(reply);
    await api('state');
}

function autoSync() {
    const stale = Date.now() / 1000 - (state.lastSync || 0) > state.autoSyncInterval;
    if (state.armoryEnabled && stale && Date.now() - lastAutoSync > 10 * 60000) {
        lastAutoSync = Date.now();
        sync().catch(() => {});
    }
}

function ago(timestamp) {
    const minutes = Math.round((Date.now() / 1000 - timestamp) / 60);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)} days ago`;
}

function syncWarning(c) {
    return c.syncError ? ` <span class="sync-warn" title="Armory sync: ${esc(c.syncError)}">⚠</span>` : '';
}

function renderSyncStatus() {
    $('#sync').hidden = !state.armoryEnabled;
    $('#sync-btn').disabled = !!syncRun;
    $('#sync-btn').textContent = syncRun ? 'Syncing…' : 'Sync with Armory';
    const status = $('#sync-status');
    status.className = state.lastSyncError ? 'sync-error' : 'muted';
    status.textContent = state.lastSyncError ? `Last sync failed: ${state.lastSyncError}`
        : state.lastSync ? `Levels synced ${ago(state.lastSync)}` : 'Not synced yet';
}

$('#sync-btn').addEventListener('click', () => sync().catch(() => {}));

// The WoW Token price, looked up and logged by the server (the "tokenPrice" action). The server
// logs it every few minutes on its own, so the page only asks from the Refresh button, or when goals
// in euros need the price and the latest is older than TOKEN_REFRESH (the logger isn't running,
// e.g. outside Docker). Like the sync, it bypasses the request queue and then fetches the state
// through it. A failure is kept in the state and shown.
let tokenPriceRun = null;
let lastTokenPriceTry = 0; // ms; keeps a failing lookup from being retried every minute

function lookUpTokenPrice() {
    if (tokenPriceRun) return tokenPriceRun;
    lastTokenPriceTry = Date.now();
    const signOutsBefore = signOuts;
    tokenPriceRun = send('tokenPrice', {}).then(reply => {
        if (signOuts !== signOutsBefore) return;
        check(reply);
        return api('state');
    }).catch(() => {}).finally(() => {
        tokenPriceRun = null;
        requestRender();
    });
    requestRender(); // shows the button as busy
    return tokenPriceRun;
}

function autoTokenPrice() {
    const needed = state.armoryEnabled && (state.goals || []).some(g => g.euros != null);
    const stale = Date.now() / 1000 - (state.tokenPrice?.time || 0) > TOKEN_REFRESH;
    if (needed && stale && Date.now() - lastTokenPriceTry >= 10 * 60000) lookUpTokenPrice();
}

// Whatever the server should refresh on its own once the state is in.
function autoRefresh() {
    autoSync();
    autoTokenPrice();
}

// ---------- Export ----------

$('#export-btn').addEventListener('click', () => {
    if (!state) return;
    const { armoryEnabled, autoSyncInterval, tokenPrice, ...data } = state; // fields the API adds, never stored
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'goldmaker.json';
    a.click();
    URL.revokeObjectURL(url);
});

// ---------- Import ----------

$('#import-btn').addEventListener('click', () => $('#import-file').click());

$('#import-file').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = ''; // so picking the same file again still fires "change"
    if (!file) return;
    let data;
    try {
        data = JSON.parse(await file.text());
    } catch {
        alert(`${file.name} is not a valid JSON file.`);
        return;
    }
    if (!Array.isArray(data?.characters) || !Array.isArray(data?.activities)) {
        alert(`${file.name} is not a Goldmaker data file.`);
        return;
    }
    const weeks = Object.keys(data.completions || {}).length;
    const summary = `${data.characters.length} characters, ${data.activities.length} activities, ${weeks} weeks of history`;
    if (!confirm(`Replace ALL current data with ${file.name}?

${summary}

The current data is kept as a backup on the server.`)) return;
    try {
        await api('import', { data });
        lastAutoSync = 0; // the import cleared lastSync; refresh levels right away
        autoRefresh();
    } catch {
        // api() has already shown the error
    }
});

// ---------- Forms ----------

const forms = {
    characters: { form: $('#char-form'), action: 'saveCharacter' },
    activities: { form: $('#act-form'), action: 'saveActivity' },
};

function resetForm(form) {
    form.querySelectorAll('option[data-extra]').forEach(o => o.remove());
    form.reset();
    form.elements.id.value = '';
    form.querySelector('[type=submit]').textContent = 'Add';
    form.querySelector('.cancel').hidden = true;
    renderManage();
}

for (const { form, action } of Object.values(forms)) {
    form.addEventListener('submit', async e => {
        e.preventDefault();
        await api(action, Object.fromEntries(new FormData(form)));
        resetForm(form);
        form.elements.name.focus();
    });
    form.querySelector('.cancel').addEventListener('click', () => resetForm(form));
}

// The server keeps gold to the hundred (goldAmount in api.php). Rather than let step="100"
// refuse something like 1250, round it down and submit again.
const goldField = forms.activities.form.elements.gold;
goldField.addEventListener('invalid', e => {
    if (!goldField.validity.stepMismatch || goldField.validity.rangeUnderflow) return;
    e.preventDefault();
    goldField.value = Math.floor(goldField.valueAsNumber / 100) * 100;
    setTimeout(() => forms.activities.form.requestSubmit());
});

$('#char-form').elements.class.innerHTML = Object.keys(CLASSES)
    .map(c => `<option value="${c}">${c || 'Class…'}</option>`).join('');

// ---------- Events ----------

document.querySelectorAll('nav button, #nav-total').forEach(btn => btn.addEventListener('click', () => showView(btn.dataset.view)));

function showView(name) {
    document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
    document.querySelectorAll('main > section').forEach(s => s.hidden = s.id !== `view-${name}`);
    if (name === 'gold') loadTokenLog();
}

$('#prev-week').addEventListener('click', () => { viewedWeek = shiftWeek(viewedWeek, -1); renderWeek(); });
$('#next-week').addEventListener('click', () => { viewedWeek = shiftWeek(viewedWeek, 1); renderWeek(); });
$('#this-week').addEventListener('click', () => { viewedWeek = currentWeekKey(); renderWeek(); });
$('#hide-loot').addEventListener('change', e => {
    hideLoot = e.target.checked;
    writeSetting('goldmaker.hideLoot', hideLoot ? '1' : '0');
    renderWeek();
});

$('#grid').addEventListener('click', e => {
    const deposit = e.target.closest('button[data-deposit]');
    if (deposit) {
        api('deposit', { week: viewedWeek, charId: deposit.dataset.deposit, gold: Number(deposit.dataset.gold) });
        return;
    }
    const undo = e.target.closest('button[data-undo-deposit]');
    if (undo) {
        const charId = undo.dataset.undoDeposit;
        const last = depositsOf(viewedWeek, charId).at(-1);
        const name = state.characters.find(c => c.id === charId)?.name ?? 'this character';
        if (last && confirm(`Undo the last deposit of ${fmtGold(last.gold)} for ${name}?`)) {
            api('deposit', { week: viewedWeek, charId, undo: true });
        }
        return;
    }
    const btn = e.target.closest('button[data-char]');
    if (!btn) return;
    const { char, act } = btn.dataset;
    if (btn.classList.contains('bump')) {
        bumpGold(char, act, Number(btn.dataset.step));
    } else if (btn.classList.contains('gold-edit')) {
        if (!focusLoot(char, act)) editGold(btn, char, act);
    } else {
        const done = !isDone(viewedWeek, char, act);
        if (!done && !confirmUntick(char, act)) return;
        const body = { week: viewedWeek, charId: char, actId: act, done };
        // The server would use the activity's current default; a closed week uses its own.
        const setup = weekSetup(viewedWeek);
        if (done && !setup.live) body.gold = setup.activities.find(a => a.id === act)?.gold || 0;
        api('toggle', body).then(() => {
            // Jump straight into the gold field (or the loot) so a non-default amount can just be typed.
            const goldBtn = done && $(`#grid .gold-edit[data-char="${char}"][data-act="${act}"]`);
            if (goldBtn && !focusLoot(char, act)) editGold(goldBtn, char, act);
        });
    }
});

// Gold a cell's arrows have asked for but whose reply hasn't come back yet, by "week.charId.actId".
// Quick clicks build on it rather than on the state, which only catches up with the replies.
const bumpedGold = {};

// The arrows move a run's gold by 1k (world quests and the like), never below 0.
function bumpGold(charId, actId, step) {
    const key = `${viewedWeek}.${charId}.${actId}`;
    const act = weekSetup(viewedWeek).activities.find(a => a.id === actId);
    const gold = Math.max(0, (bumpedGold[key] ?? goldOf(viewedWeek, charId, act)) + step);
    bumpedGold[key] = gold;
    requestRender();
    api('toggle', { week: viewedWeek, charId, actId, done: true, gold }).finally(() => {
        if (bumpedGold[key] === gold) {
            delete bumpedGold[key];
            requestRender();
        }
    });
}

// Unticking a run removes its loot (api.php), so a run with loot filled in asks first.
function confirmUntick(charId, actId) {
    const { characters, activities } = weekSetup(viewedWeek);
    const act = activities.find(a => a.id === actId);
    const counts = lootOf(viewedWeek, charId, actId);
    const loot = materialsOf(act).filter(m => counts[m.id]).map(m => `${counts[m.id]} ${m.name}`);
    if (!loot.length) return true;
    const name = characters.find(c => c.id === charId)?.name ?? 'this character';
    return confirm(`Untick ${act.name} for ${name}?\n\nIts loot (${loot.join(', ')}) will be removed.`);
}

// Moves to the first loot field of a character's run; false when the activity has no loot.
function focusLoot(charId, actId) {
    const mat = materialsOf(weekSetup(viewedWeek).activities.find(a => a.id === actId))[0];
    const input = mat && document.getElementById(`loot-${actId}-${charId}-${mat.id}`);
    if (!input) return false;
    input.focus();
    input.select();
    return true;
}

// Loot and price fields save when they're left, if they changed since they were rendered (a
// re-render keeps what's being typed, see setGrid).
$('#grid').addEventListener('focusout', e => {
    const input = e.target;
    if (swapping || !input.matches('.loot-input, .price-input') || input.value === input.defaultValue) return;
    if (input.matches('.price-input')) {
        savePrice(input);
    } else {
        saveLoot(input);
    }
});

// Loot fields work like a spreadsheet: Enter or ↓ moves to the same field in the next row, and
// Shift+Enter or ↑ to the one above, saving the field left. Escape undoes the typing.
$('#grid').addEventListener('keydown', e => {
    const input = e.target;
    if (!input.matches('.loot-input, .price-input')) return;
    if (e.key === 'Escape') {
        input.value = input.defaultValue;
        input.blur();
        return;
    }
    const up = e.key === 'ArrowUp' || (e.key === 'Enter' && e.shiftKey);
    if (!up && e.key !== 'ArrowDown' && e.key !== 'Enter') return;
    e.preventDefault();
    const next = input.matches('.loot-input') && fieldBelow(input, up ? -1 : 1);
    if (next) {
        next.focus();
        next.select();
    } else if (e.key === 'Enter') {
        input.blur();
    }
});

// The same loot field in another row (step -1 is the row above), skipping the characters who
// can't do the activity.
function fieldBelow(input, step) {
    const { act, mat } = input.dataset;
    const column = [...$('#grid').querySelectorAll(`.loot-input[data-act="${act}"]${mat ? `[data-mat="${mat}"]` : ':not([data-mat])'}`)];
    return column[column.indexOf(input) + step];
}

// Saves one loot field, ticking the run if it wasn't yet; a field that isn't a number is marked
// instead. Only that field is sent (api.php merges it in): the row's other fields may still show
// an older reply while their own saves are on the way.
function saveLoot(input) {
    const { char, act, mat } = input.dataset;
    const value = mat ? parseCount(input.value) : parsePrice(input.value);
    input.classList.toggle('invalid', Number.isNaN(value));
    if (Number.isNaN(value)) return;
    const body = { week: viewedWeek, charId: char, actId: act, done: true };
    const setup = weekSetup(viewedWeek);
    const defaultGold = setup.activities.find(a => a.id === act)?.gold || 0;
    if (mat) {
        body.loot = { [mat]: value };
        // A new run gets the default gold; the server would use the live one, a closed week has its own.
        if (!setup.live && !isDone(viewedWeek, char, act)) body.gold = defaultGold;
    } else {
        body.gold = value ?? defaultGold; // empty means the default
    }
    api('toggle', body);
}

// An empty price removes this week's own price, so the one from before applies again.
function savePrice(input) {
    const price = parsePrice(input.value);
    input.classList.toggle('invalid', Number.isNaN(price));
    if (!Number.isNaN(price)) api('price', { week: viewedWeek, matId: input.dataset.mat, price });
}

// Swap the gold label for an input; Enter/blur saves, Escape cancels, empty resets to the default.
function editGold(btn, charId, actId) {
    const act = weekSetup(viewedWeek).activities.find(a => a.id === actId);
    const input = document.createElement('input');
    input.className = 'gold-input';
    const initial = String(goldOf(viewedWeek, charId, act));
    input.value = initial;
    input.placeholder = String(act.gold || 0);
    btn.replaceWith(input);
    input.focus();
    input.select();

    let finished = false;
    const finish = save => {
        if (finished) return;
        finished = true;
        const gold = parseGold(input.value);
        const changed = input.value.trim() !== initial;
        if (save && changed && !Number.isNaN(gold)) {
            // Empty means the default; without gold the server would keep the current amount.
            api('toggle', { week: viewedWeek, charId, actId, done: true, gold: gold ?? (act.gold || 0) });
        } else {
            requestRender();
        }
    };
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
}

// Gold counts and goals save when they're left, one field at a time like the loot fields. The
// fields for a new goal wait for Enter or the Add button instead.
$('#gold').addEventListener('focusout', e => {
    const input = e.target;
    if (swapping || !input.matches('.count-input, .goal-input') || input.matches('.new-goal')
        || input.value === input.defaultValue) return;
    const { id, field } = input.dataset;
    if (field === 'name') {
        api('goal', { id, name: input.value });
        return;
    }
    if (field === 'balance') {
        const euros = parseEuros(input.value);
        input.classList.toggle('invalid', Number.isNaN(euros));
        if (!Number.isNaN(euros)) api('balance', { euros });
        return;
    }
    if (field === 'gold') {
        const price = parseGoalPrice(input.value);
        input.classList.toggle('invalid', !price);
        if (price) api('goal', { id, ...price }).then(autoTokenPrice, () => {});
        return;
    }
    const gold = parsePrice(input.value);
    input.classList.toggle('invalid', Number.isNaN(gold));
    if (Number.isNaN(gold)) return;
    if (field === 'reserve') {
        api('reserve', { gold: gold ?? 0 });
    } else {
        api('gold', { charId: input.dataset.char ?? null, gold });
    }
});

$('#gold').addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.id === 'token-refresh') {
        lookUpTokenPrice();
    } else if (btn.dataset.tokenRange) {
        tokenRange = btn.dataset.tokenRange;
        writeSetting('goldmaker.tokenRange', tokenRange);
        renderGold();
    } else if (btn.id === 'goal-add') {
        addGoal();
    } else if (btn.dataset.goalFirst) {
        api('goal', { id: btn.dataset.goalFirst, first: true });
    } else if (btn.dataset.goalRemove) {
        const i = state.goals.findIndex(g => g.id === btn.dataset.goalRemove);
        if (i >= 0 && confirm(`Remove the goal "${goalName(state.goals[i], i)}"?`)) {
            api('goal', { id: state.goals[i].id, remove: true });
        }
    }
});

$('#gold').addEventListener('change', e => {
    if (e.target.id !== 'count-this-week') return;
    countThisWeek = e.target.checked;
    writeSetting('goldmaker.countThisWeek', countThisWeek ? '1' : '0');
    renderGold();
});

// The chart's crosshair follows the pointer to the nearest logged price.
$('#gold').addEventListener('pointermove', e => {
    const plot = e.target.closest('.token-plot');
    if (plot) showChartPoint(plot, e.clientX);
});
$('#gold').addEventListener('pointerout', e => {
    const plot = e.target.closest('.token-plot');
    if (plot && !plot.contains(e.relatedTarget)) plot.classList.remove('hovering');
});

let addingGoal = false; // so a double click or a repeated Enter adds the goal once

async function addGoal() {
    const price = parseGoalPrice($('#goal-new-gold').value);
    $('#goal-new-gold').classList.toggle('invalid', !price);
    if (!price) {
        $('#goal-new-gold').focus();
        return;
    }
    if (addingGoal) return;
    addingGoal = true;
    try {
        await api('goal', { add: true, name: $('#goal-new-name').value, ...price });
        // Only now: the re-render keeps what was typed in the field that has the focus.
        $('#goal-new-name').value = '';
        $('#goal-new-gold').value = '';
        autoTokenPrice();
    } catch {
        // api() has already shown the error
    } finally {
        addingGoal = false;
    }
}

$('#gold').addEventListener('keydown', e => {
    const input = e.target;
    if (!input.matches('.count-input, .goal-input')) return;
    if (e.key === 'Escape') {
        input.value = input.defaultValue;
        input.blur();
        return;
    }
    if (e.key === 'Enter' && input.matches('.new-goal')) {
        e.preventDefault();
        addGoal();
        return;
    }
    const up = e.key === 'ArrowUp' || (e.key === 'Enter' && e.shiftKey);
    if (!up && e.key !== 'ArrowDown' && e.key !== 'Enter') return;
    e.preventDefault();
    // A goal's fields move within their own column, the gold counts down their list.
    const fields = [...$('#gold').querySelectorAll(input.matches('.goal-input')
        ? `.goal-input[data-field="${input.dataset.field}"]` : '.gold-list .count-input')];
    const next = fields[fields.indexOf(input) + (up ? -1 : 1)];
    if (next) {
        next.focus();
        next.select();
    } else if (e.key === 'Enter') {
        input.blur();
    }
});

$('#history').addEventListener('click', e => {
    const row = e.target.closest('.history-row');
    if (!row) return;
    viewedWeek = row.dataset.week;
    renderWeek();
    showView('week');
});

$('#view-manage').addEventListener('click', e => {
    const btn = e.target.closest('button[data-type]');
    if (!btn) return;
    const { type, id } = btn.dataset;
    const item = state[type].find(x => x.id === id);

    if (btn.dataset.move) {
        api('move', { type, id, dir: Number(btn.dataset.move) });
    } else if ('edit' in btn.dataset) {
        const form = forms[type].form;
        resetForm(form); // clears fields older items may not have (e.g. gold)
        form.elements.id.value = id;
        for (const [k, v] of Object.entries(item)) {
            const field = form.elements[k];
            if (!field) continue;
            const value = k === 'materials' ? v.map(m => m.name).join(', ') : v;
            // A select only holds values it lists, so add any other (an imported minLevel of 70,
            // a class missing from CLASSES) rather than quietly changing it on save.
            if (field.tagName === 'SELECT' && ![...field.options].some(o => o.value === String(value))) {
                const option = new Option(value, value);
                option.dataset.extra = '';
                field.add(option);
            }
            field.value = value;
        }
        form.querySelector('[type=submit]').textContent = 'Save';
        form.querySelector('.cancel').hidden = false;
        renderManage();
        form.elements.name.focus();
    } else if ('delete' in btn.dataset) {
        if (confirm(`Delete "${item.name}"?`)) api('delete', { type, id });
    }
});

// Roll over to the new week if the page is left open across the reset.
let lastCurrent = currentWeekKey();
setInterval(() => {
    const now = currentWeekKey();
    if (now !== lastCurrent) {
        if (viewedWeek === lastCurrent) viewedWeek = now;
        lastCurrent = now;
        requestRender();
    } else if (!pointerDown && !document.activeElement?.matches('#grid input')) {
        renderWeek();
    }
    renderSyncStatus();
    autoRefresh();
}, 60000);

api('state').then(autoRefresh, () => {});
