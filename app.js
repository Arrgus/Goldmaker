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

let state = { characters: [], activities: [], completions: {} };
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
        const res = await fetch(`api.php?action=${action}`, {
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

function isDone(week, charId, actId) {
    const entries = state.completions[week]?.[charId];
    return !!entries && Object.hasOwn(entries, actId);
}

// Gold recorded for a completion; null (pre-gold data) falls back to the activity's default.
function goldOf(week, charId, act) {
    return state.completions[week]?.[charId]?.[act.id] ?? (act.gold || 0);
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
    const s = str.trim().toLowerCase().replace(/[\s,g]/g, '');
    if (s === '') return null;
    const m = s.match(/^(\d+)(\.\d+)?(k?)$/);
    if (!m) return NaN;
    const thousands = m[3] || m[1].length <= 2;
    return Math.round(parseFloat(m[1] + (m[2] || '')) * (thousands ? 1000 : 1));
}

function reqBadge(act) {
    if (act.minLevel >= 90) return '<span class="req req-90">90</span>';
    if (act.minLevel > 1) return `<span class="req">${act.minLevel}+</span>`;
    return '';
}

function charName(c) {
    return `<span style="color:${CLASSES[c.class] || CLASSES['']}">${esc(c.name)}</span>`;
}

function weekStats(week) {
    let done = 0, total = 0, gold = 0;
    const perChar = state.characters.map(c => {
        let d = 0, t = 0, g = 0;
        for (const a of state.activities) {
            if (!eligible(c, a)) continue;
            t++;
            if (isDone(week, c.id, a.id)) {
                d++;
                g += goldOf(week, c.id, a);
            }
        }
        done += d;
        total += t;
        gold += g;
        return { char: c, done: d, total: t, gold: g };
    });
    return { done, total, gold, perChar };
}

// ---------- Login ----------

function setSignedIn(signedIn) {
    const wasSignedIn = !$('main').hidden;
    document.body.classList.toggle('signed-out', !signedIn);
    $('main').hidden = !signedIn;
    $('#login-form').hidden = signedIn;
    if (!signedIn && wasSignedIn) {
        // Don't leave the previous data sitting in the page.
        state = { characters: [], activities: [], completions: {} };
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

    const { characters: chars, activities: acts } = state;
    if (!chars.length || !acts.length) {
        $('#grid').innerHTML = '<div class="empty">Add some characters and activities under <b>Manage</b> to get started.</div>';
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
    stats.perChar.forEach(({ char: c, done, total, gold }) => {
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
            const g = goldOf(viewedWeek, c.id, a);
            col.done++;
            col.gold += g;
            const custom = g !== (a.gold || 0);
            html += `<td class="cell done"><button class="check" ${ids} title="${title}">✔</button>`
                + `<button class="gold-edit${custom ? ' custom' : ''}" ${ids} title="Click to change gold">${fmtShort(g)}</button></td>`;
        });
        html += `<td class="row-total${total && done === total ? ' all-done' : ''}">${done}/${total}`
            + `${gold ? `<span class="gold">${fmtGold(gold)}</span>` : ''}</td></tr>`;
    });

    html += '</tbody><tfoot><tr><td></td>';
    for (const col of colTotals) {
        html += `<td class="${col.total && col.done === col.total ? 'all-done' : ''}">${col.done}/${col.total}<span class="gold">${fmtGold(col.gold)}</span></td>`;
    }
    html += `<td>${stats.done}/${stats.total}<span class="gold">${fmtGold(stats.gold)}</span></td></tr></tfoot></table>`;
    $('#grid').innerHTML = html;
}

function renderHistory() {
    const current = currentWeekKey();
    // The server rejects weeks before 2004 (isWeekKey in api.php); skipping them here too keeps
    // damaged data from making the loop below endless (toKey doesn't pad years under 1000).
    const keys = Object.keys(state.completions).filter(k => k >= '2004' && k <= current).sort();
    const oldest = keys[0] || current;

    let rows = '', allGold = 0, pastGold = 0, pastWeeks = 0;
    for (let k = current; k >= oldest; k = shiftWeek(k, -1)) {
        const s = weekStats(k);
        allGold += s.gold;
        if (k !== current) {
            pastGold += s.gold;
            pastWeeks++;
        }
        const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
        const chars = s.perChar.map(p => `<span>${charName(p.char)} ${p.done}/${p.total}</span>`).join('');
        rows += `<div class="history-row" data-week="${k}">
            <div class="when">${esc(weekLabel(k))}${k === current ? '<span class="badge-current">current</span>' : ''}</div>
            <div class="bar"><div style="width:${pct}%"></div></div>
            <div class="total">${s.done}/${s.total}</div>
            <div class="week-gold">${fmtGold(s.gold)}</div>
            <div class="chars">${chars}</div>
        </div>`;
    }

    let html = `<div class="summary">
        <div><span class="muted">Total earned</span><b>${fmtGold(allGold)}</b></div>
        ${pastWeeks ? `<div><span class="muted">Average per finished week</span><b>${fmtGold(pastGold / pastWeeks)}</b></div>` : ''}
    </div>`;
    html += rows + '<p class="muted">Totals use your current characters, levels and activities.</p>';
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

    $('#act-list').innerHTML = state.activities.map(a =>
        listItem('activities', a, `${esc(a.name)}${reqBadge(a)}${a.gold ? ` <span class="gold-inline">~${fmtGold(a.gold)}</span>` : ''}${a.notes ? ` <span class="muted">${esc(a.notes)}</span>` : ''}`)
    ).join('') || '<li class="muted">No activities yet.</li>';
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
    const btn = e.target.closest('button[data-char]');
    if (!btn) return;
    const { char, act } = btn.dataset;
    if (btn.classList.contains('gold-edit')) {
        editGold(btn, char, act);
    } else {
        const done = !isDone(viewedWeek, char, act);
        api('toggle', { week: viewedWeek, charId: char, actId: act, done }).then(() => {
            // Jump straight into the gold field so a non-default amount can just be typed.
            const goldBtn = done && $(`#grid .gold-edit[data-char="${char}"][data-act="${act}"]`);
            if (goldBtn) editGold(goldBtn, char, act);
        });
    }
});

// Swap the gold label for an input; Enter/blur saves, Escape cancels, empty resets to the default.
function editGold(btn, charId, actId) {
    const act = state.activities.find(a => a.id === actId);
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
            // A select only holds values it lists, so add any other (an imported minLevel of 70,
            // a class missing from CLASSES) rather than quietly changing it on save.
            if (field.tagName === 'SELECT' && ![...field.options].some(o => o.value === String(v))) {
                const option = new Option(v, v);
                option.dataset.extra = '';
                field.add(option);
            }
            field.value = v;
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
    } else if (!pointerDown && !document.activeElement?.matches('.gold-input')) {
        renderWeek();
    }
    renderSyncStatus();
    autoSync();
}, 60000);

api('state').then(autoSync, () => {});
