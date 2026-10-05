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
        $('#grid').innerHTML = live
            ? '<div class="empty">Add some characters and activities under <b>Manage</b> to get started.</div>'
            : '<div class="empty">There were no characters or activities this week.</div>';
        return;
    }

    const stats = weekStats(viewedWeek);
    const bank = tracksDeposits(viewedWeek);
    $('#week-summary').innerHTML = weekSummary(stats);

    // Characters are rows and activities are columns: there are far more characters than activities.
    // An activity with loot gets a group of columns under its name: the run, a count per material
    // and the vendor gold, so its loot is filled in on the character's own row.
    const grouped = acts.some(a => materialsOf(a).length);
    const span = grouped ? ' rowspan="2"' : '';
    let head = `<tr><th${span}></th>`, subhead = '';
    for (const a of acts) {
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
    const cols = acts.map(() => ({ done: 0, total: 0, value: 0, gold: 0, counts: {} }));
    for (const { char: c, done, total, gold, mats, ...deposits } of stats.perChar) {
        body += `<tr><th>${charName(c)}<span class="lvl">${c.level}${c.realm ? ' · ' + esc(c.realm) : ''}${syncWarning(c)}</span></th>`
            + acts.map((a, i) => activityCells(c, a, cols[i])).join('')
            + `<td class="row-done${total && done === total ? ' all-done' : ''}">${done}/${total}</td>`
            + `<td class="row-gold">${gold || mats ? fmtGold(gold) + matsLine(mats) : '–'}</td>`
            + (bank ? `<td class="row-bank">${depositButton(c, deposits)}</td>` : '') + '</tr>';
    }

    let foot = '<tr><td>Total</td>';
    acts.forEach((a, i) => {
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
        const g = goldOf(week, c.id, a);
        const value = g + lootValue(week, c.id, a);
        col.done++;
        col.value += value;
        col.gold += g;
        const custom = !mats.length && g !== (a.gold || 0);
        html = `<td class="cell done"><button class="check" ${ids} title="${title}">✔</button>`
            + `<button class="gold-edit${custom ? ' custom' : ''}" ${ids} title="${mats.length ? 'What the run was worth. Click to edit the loot' : 'Click to change gold'}">${fmtShort(value)}</button></td>`;
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
    const when = t => new Date(t * 1000).toLocaleString(undefined,
        { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const history = deposits.length
        ? 'Deposited:' + deposits.map(d => `\n${fmtGold(d.gold)} on ${when(d.time)}`).join('') : '';
    if (pending) {
        const label = `Deposit ${deposited ? '+' : ''}${fmtShort(pending)}`;
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

// Progress towards the goal, or null when there's none.
function goalProgress(total) {
    const goal = state.goal?.gold || 0;
    if (!goal) return null;
    return { goal, pct: Math.min(100, Math.floor((total / goal) * 100)), left: Math.max(0, goal - total) };
}

function progressBar(pct) {
    return `<span class="goal-bar"><span style="width:${pct}%"></span></span>`;
}

function renderGold() {
    const { bank, chars, total } = goldOnHand();
    const counted = state.bank || state.characters.some(c => state.charGold?.[c.id]);
    const progress = goalProgress(total);
    const goalName = state.goal?.name || 'Goal';
    $('#nav-total').hidden = !counted && !progress;
    $('#nav-total').innerHTML = `<span>${fmtGold(total)}</span>`
        + (progress ? `${progressBar(progress.pct)}<span class="goal-pct">${progress.pct}% of ${fmtShort(progress.goal)}</span>` : '');
    $('#nav-total').title = progress
        ? `${goalName}: ${fmtGold(total)} of ${fmtGold(progress.goal)}, ${fmtGold(progress.left)} to go. Click to update.`
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
        <div class="goal">
            <label class="field"><span>Saving up for</span><input class="goal-input" id="goal-name" data-goal="name"
                value="${esc(state.goal?.name || '')}" placeholder="e.g. a mount" autocomplete="off"></label>
            <label class="field"><span>Goal</span><input class="goal-input count-input" id="goal-gold" data-goal="gold"
                value="${progress ? progress.goal.toLocaleString('en-US') : ''}" placeholder="no goal" inputmode="decimal" autocomplete="off"></label>
            ${progress ? `<div class="goal-progress">${progressBar(progress.pct)}<span class="muted">${progress.pct}%`
                + (progress.left ? `, ${fmtGold(progress.left)} to go` : ', reached ✔') + '</span></div>' : ''}
        </div>
        <table class="gold-list">${rows}</table>
        <p class="muted">Type in the gold as the game shows it (1,234,567, 250k or 1.2m). Enter or ↓ moves to the next field,
            Escape undoes the typing, and an empty field means not counted.</p>`);
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

// Gold counts and the goal save when they're left, one field at a time like the loot fields.
$('#gold').addEventListener('focusout', e => {
    const input = e.target;
    if (swapping || !input.matches('.count-input, .goal-input') || input.value === input.defaultValue) return;
    if (input.dataset.goal === 'name') {
        api('goal', { name: input.value });
        return;
    }
    const gold = parsePrice(input.value);
    input.classList.toggle('invalid', Number.isNaN(gold));
    if (Number.isNaN(gold)) return;
    if (input.dataset.goal) {
        api('goal', { gold });
    } else {
        api('gold', { charId: input.dataset.char ?? null, gold });
    }
});

$('#gold').addEventListener('keydown', e => {
    const input = e.target;
    if (!input.matches('.count-input, .goal-input')) return;
    if (e.key === 'Escape') {
        input.value = input.defaultValue;
        input.blur();
        return;
    }
    const up = e.key === 'ArrowUp' || (e.key === 'Enter' && e.shiftKey);
    if (!up && e.key !== 'ArrowDown' && e.key !== 'Enter') return;
    e.preventDefault();
    const fields = [...$('#gold').querySelectorAll('.count-input')];
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
    autoSync();
}, 60000);

api('state').then(autoSync, () => {});
