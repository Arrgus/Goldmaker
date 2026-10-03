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

let state = { characters: [], activities: [], completions: {}, deposits: {} };
let viewedWeek = currentWeekKey();

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

function fmtShort(n) {
    return n < 1000 ? String(n) : `${+(n / 1000).toFixed(2)}k`;
}

// Accepts "1900", "1,900", "1.9k", "20k". Numbers with one or two digits before the decimal
// point are read as thousands ("19" = 19k, "1.2" = 1.2k), since sub-1k rewards are rare.
// Empty means "use the default" (null); garbage is NaN.
function parseGold(str) {
    return parseAmount(str, true);
}

// A material's price per unit: like parseGold, but small numbers are gold ("45" = 45g).
function parsePrice(str) {
    return parseAmount(str, false);
}

function parseAmount(str, shortMeansThousands) {
    const s = str.trim().toLowerCase().replace(/[\s,g]/g, '');
    if (s === '') return null;
    const m = s.match(/^(\d+)(\.\d+)?(k?)$/);
    if (!m) return NaN;
    const thousands = m[3] || (shortMeansThousands && m[1].length <= 2);
    return Math.round(parseFloat(m[1] + (m[2] || '')) * (thousands ? 1000 : 1));
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
        state = { characters: [], activities: [], completions: {}, deposits: {} };
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
        autoSync();
    } finally {
        submit.disabled = false;
    }
});

// The page signs out at once, but the logout request waits for requests already underway
// (including a sync), so none of them can renew the session cookie after it has been cleared.
$('#logout').addEventListener('click', () => {
    signOuts++;
    setSignedIn(false);
    enqueue(async () => {
        await syncRun?.catch(() => {});
        await send('logout', {});
    });
});

// ---------- Rendering ----------

function render() {
    renderWeek();
    renderHistory();
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
        $('#grid').innerHTML = live
            ? '<div class="empty">Add some characters and activities under <b>Manage</b> to get started.</div>'
            : '<div class="empty">There were no characters or activities this week.</div>';
        return;
    }

    // Characters are rows and activities are columns: there are far more characters than activities.
    const stats = weekStats(viewedWeek);
    let html = '<table class="grid"><thead><tr><th></th>';
    for (const a of acts) {
        html += `<th${a.notes ? ` title="${esc(a.notes)}"` : ''}>${esc(a.name)}`
            + `<span class="lvl">${reqBadge(a)}${a.gold ? `<span class="req">~${fmtShort(a.gold)}</span>` : ''}</span></th>`;
    }
    html += '<th></th></tr></thead><tbody>';

    const colTotals = acts.map(() => ({ done: 0, total: 0, gold: 0 }));
    stats.perChar.forEach(({ char: c, done, total, gold, mats, ...bank }) => {
        html += `<tr><th>${charName(c)}<span class="lvl">${c.level}${c.realm ? ' · ' + esc(c.realm) : ''}${syncWarning(c)}</span></th>`;
        acts.forEach((a, i) => {
            if (!eligible(c, a)) {
                html += '<td class="cell na">–</td>';
                return;
            }
            const col = colTotals[i];
            col.total++;
            const ids = `data-char="${c.id}" data-act="${a.id}"`;
            const title = `${esc(c.name)}: ${esc(a.name)}`;
            if (!isDone(viewedWeek, c.id, a.id)) {
                html += `<td class="cell"><button class="check" ${ids} title="${title}">○</button></td>`;
                return;
            }
            // An activity with loot shows what the run was worth; it's edited in its own table.
            const loot = materialsOf(a).length > 0;
            const g = goldOf(viewedWeek, c.id, a);
            const value = g + lootValue(viewedWeek, c.id, a);
            col.done++;
            col.gold += value;
            const custom = !loot && g !== (a.gold || 0);
            html += `<td class="cell done"><button class="check" ${ids} title="${title}">✔</button>`
                + `<button class="gold-edit${custom ? ' custom' : ''}" ${ids} title="${loot ? 'Click to edit the loot' : 'Click to change gold'}">${fmtShort(value)}</button></td>`;
        });
        html += `<td class="row-total${total && done === total ? ' all-done' : ''}">${done}/${total}`
            + `${gold ? `<span class="gold">${fmtGold(gold)}</span>` : ''}${matsLine(mats)}${depositButton(c, bank)}</td></tr>`;
    });

    html += '</tbody><tfoot><tr><td></td>';
    for (const col of colTotals) {
        html += `<td class="${col.total && col.done === col.total ? 'all-done' : ''}">${col.done}/${col.total}<span class="gold">${fmtGold(col.gold)}</span></td>`;
    }
    html += `<td>${stats.done}/${stats.total}<span class="gold">${fmtGold(stats.gold)}</span>${matsLine(stats.mats)}`
        + `${stats.pending ? `<span class="to-deposit">${fmtGold(stats.pending)} to deposit</span>` : ''}</td></tr></tfoot></table>`;
    setGrid(`<div class="week-tables">${html}${acts.map(a => lootTable(a, chars)).join('')}</div>`);
}

// Under a gold total: the materials' value, kept apart because it isn't gold to deposit.
function matsLine(mats) {
    return mats ? `<span class="mats">+${fmtGold(mats)} in mats</span>` : '';
}

// Next to the grid, for an activity with materials: a row per character that can do it, with
// the materials it dropped, its gold (vendored items) and what the run was worth at the week's
// prices. The prices are set in the header. Filling in a run that isn't ticked yet ticks it.
function lootTable(act, chars) {
    const mats = materialsOf(act);
    const rows = chars.filter(c => eligible(c, act));
    if (!mats.length || !rows.length) return '';
    const week = viewedWeek;

    let html = `<table class="grid loot"><thead><tr><th>${esc(act.name)}</th>`;
    for (const m of mats) {
        const { price, from } = priceOf(week, m.id);
        const inherited = from && from !== week;
        const title = !from ? 'Auction House price per item: not set yet'
            : inherited ? `Price per item, from the week of ${weekLabel(from)}. Type a new one for this week.`
            : 'Auction House price per item this week';
        html += `<th>${esc(m.name)}<span class="lvl">@ <input class="price-input${inherited ? ' inherited' : ''}" id="price-${act.id}-${m.id}"`
            + ` data-mat="${m.id}" value="${from ? price : ''}" placeholder="price" title="${esc(title)}" autocomplete="off">g</span></th>`;
    }
    html += '<th>Gold</th><th>Value</th></tr></thead><tbody>';

    let runs = 0, goldTotal = 0, valueTotal = 0;
    const countTotals = {};
    for (const c of rows) {
        const done = isDone(week, c.id, act.id);
        const counts = done ? lootOf(week, c.id, act.id) : {};
        const ids = `data-char="${c.id}" data-act="${act.id}"`;
        html += `<tr class="${done ? 'done' : 'idle'}"><th>${charName(c)}</th>`;
        for (const m of mats) {
            const n = counts[m.id] || 0;
            countTotals[m.id] = (countTotals[m.id] || 0) + n;
            html += `<td><input class="loot-input" id="loot-${act.id}-${c.id}-${m.id}" ${ids} data-mat="${m.id}" value="${n || ''}"`
                + ` placeholder="0" inputmode="numeric" autocomplete="off" title="${esc(c.name)}: ${esc(m.name)}"></td>`;
        }
        const gold = done ? goldOf(week, c.id, act) : null;
        const value = done ? gold + lootValue(week, c.id, act) : 0;
        if (done) {
            runs++;
            goldTotal += gold;
            valueTotal += value;
        }
        html += `<td><input class="loot-input" id="loot-${act.id}-${c.id}-gold" ${ids} value="${gold ?? ''}"`
            + ` placeholder="${act.gold || 0}" autocomplete="off" title="${esc(c.name)}: gold from vendored items"></td>`
            + `<td class="value">${done ? fmtGold(value) : '–'}</td></tr>`;
    }

    html += `</tbody><tfoot><tr><td>${runs}/${rows.length} runs</td>`;
    for (const m of mats) {
        const n = countTotals[m.id];
        html += `<td>${n}<span class="gold">${fmtGold(n * priceOf(week, m.id).price)}</span></td>`;
    }
    return html + `<td><span class="gold">${fmtGold(goldTotal)}</span></td><td><span class="gold">${fmtGold(valueTotal)}</span></td></tr></tfoot></table>`;
}

// Swaps in the grid's new HTML. Replies come in while the loot table is being filled in, so the
// field being typed in is put back as it was: focused, with the text typed so far.
let swapping = false; // the old fields' focusout is not a save

function setGrid(html) {
    const active = document.activeElement;
    const typing = active?.id && active.matches('#grid input') ? {
        id: active.id, value: active.value, edited: active.value !== active.defaultValue,
        start: active.selectionStart, end: active.selectionEnd,
    } : null;
    swapping = true;
    try {
        $('#grid').innerHTML = html;
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
    const when = t => new Date(t * 1000).toLocaleString(undefined,
        { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const history = deposits.length
        ? 'Deposited:' + deposits.map(d => `\n${fmtGold(d.gold)} on ${when(d.time)}`).join('') : '';
    if (pending) {
        const label = deposited ? `Deposit +${fmtShort(pending)}` : 'Deposit';
        const title = `${esc(c.name)}: mark ${fmtGold(pending)} as deposited in the bank${history ? '\n\n' + history : ''}`;
        return `<button class="deposit" data-deposit="${c.id}" data-gold="${pending}" title="${title}">${label}</button>`;
    }
    if (!deposited) return '';
    return `<button class="deposit banked" data-undo-deposit="${c.id}" title="${history}\n\nClick to undo the last deposit">Banked ✔</button>`;
}

function renderHistory() {
    const current = currentWeekKey();
    // The server rejects weeks before 2004 (isWeekKey in api.php); skipping them here too keeps
    // damaged data from making the loop below endless (toKey doesn't pad years under 1000).
    const keys = Object.keys(state.completions).filter(k => k >= '2004' && k <= current).sort();
    const oldest = keys[0] || current;

    let rows = '', allGold = 0, pastGold = 0, pastWeeks = 0, allPending = 0;
    for (let k = current; k >= oldest; k = shiftWeek(k, -1)) {
        const s = weekStats(k);
        const earned = s.gold + s.mats;
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
    html += rows + '<p class="muted">Past weeks use the characters, levels and activities they had at the reset.</p>';
    $('#history').innerHTML = html;
}

function listItem(type, item, inner) {
    return `<li>
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
        return listItem('activities', a, `${esc(a.name)}${reqBadge(a)}${a.gold ? ` <span class="gold-inline">~${fmtGold(a.gold)}</span>` : ''}`
            + `${mats ? ` <span class="muted">· loot: ${mats}</span>` : ''}${a.notes ? ` <span class="muted">${esc(a.notes)}</span>` : ''}`);
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
        autoSync();
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

document.querySelectorAll('nav button').forEach(btn => btn.addEventListener('click', () => showView(btn.dataset.view)));

function showView(name) {
    document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
    document.querySelectorAll('main > section').forEach(s => s.hidden = s.id !== `view-${name}`);
}

$('#prev-week').addEventListener('click', () => { viewedWeek = shiftWeek(viewedWeek, -1); renderWeek(); });
$('#next-week').addEventListener('click', () => { viewedWeek = shiftWeek(viewedWeek, 1); renderWeek(); });
$('#this-week').addEventListener('click', () => { viewedWeek = currentWeekKey(); renderWeek(); });

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
    if (btn.classList.contains('gold-edit')) {
        if (!focusLoot(char, act)) editGold(btn, char, act);
    } else {
        const done = !isDone(viewedWeek, char, act);
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

// Moves to a character's row in an activity's loot table; false when the activity has none.
function focusLoot(charId, actId) {
    const mat = materialsOf(weekSetup(viewedWeek).activities.find(a => a.id === actId))[0];
    const input = mat && document.getElementById(`loot-${actId}-${charId}-${mat.id}`);
    if (!input) return false;
    input.focus();
    input.select();
    return true;
}

// Loot and price fields save when they're left, if they changed since they were rendered (a
// re-render keeps what's being typed, see setGrid). Enter leaves the field, Escape undoes the typing.
$('#grid').addEventListener('focusout', e => {
    const input = e.target;
    if (swapping || !input.matches('.loot-input, .price-input') || input.value === input.defaultValue) return;
    if (input.matches('.price-input')) {
        savePrice(input);
    } else {
        saveRun(input.closest('tr'));
    }
});

$('#grid').addEventListener('keydown', e => {
    if (!e.target.matches('.loot-input, .price-input')) return;
    if (e.key === 'Escape') e.target.value = e.target.defaultValue;
    if (e.key === 'Enter' || e.key === 'Escape') e.target.blur();
});

// Saves a row of a loot table, ticking the run if it wasn't yet. A field that isn't a number is
// marked and nothing is saved.
function saveRun(row) {
    const inputs = [...row.querySelectorAll('.loot-input')];
    const { char, act } = inputs[0].dataset;
    const body = { week: viewedWeek, charId: char, actId: act, done: true, loot: {} };
    let valid = true;
    for (const input of inputs) {
        const mat = input.dataset.mat;
        const value = mat ? parseCount(input.value) : parseGold(input.value);
        input.classList.toggle('invalid', Number.isNaN(value));
        if (Number.isNaN(value)) {
            valid = false;
        } else if (mat) {
            body.loot[mat] = value;
        } else if (value !== null) {
            body.gold = value;
        }
    }
    if (!valid) return;
    // An empty gold field means the default, as when ticking a cell; a closed week has its own.
    const setup = weekSetup(viewedWeek);
    if (body.gold === undefined && !setup.live) body.gold = setup.activities.find(a => a.id === act)?.gold || 0;
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
            api('toggle', { week: viewedWeek, charId, actId, done: true, gold });
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
    autoSync();
}, 60000);

api('state').then(autoSync, () => {});
