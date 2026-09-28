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

// The API only accepts changes as JSON POSTs (see api.php), so anything with a body is sent that way.
async function send(action, body) {
    const res = await fetch(`api.php?action=${action}`, {
        method: body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { res, data: await res.json() };
}

function api(action, body) {
    const run = async () => {
        const { res, data } = await send(action, body);
        if (res.status === 401) {
            setSignedIn(false);
            throw new Error(data.error);
        }
        if (!res.ok) {
            alert(data.error || 'Something went wrong');
            throw new Error(data.error);
        }
        state = data;
        setSignedIn(true);
        requestRender();
    };
    const result = apiQueue.then(run);
    apiQueue = result.catch(() => {});
    return result;
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

document.addEventListener('pointerdown', () => { pointerDown = true; }, true);
document.addEventListener('pointerup', () => {
    pointerDown = false;
    if (renderPending) {
        renderPending = false;
        setTimeout(render); // after the click event has been dispatched
    }
}, true);

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
        const { res, data } = await send('login', { password: form.elements.password.value });
        if (!res.ok) {
            error.textContent = data.error || 'Something went wrong';
            error.hidden = false;
            form.elements.password.select();
            return;
        }
        form.reset();
        error.hidden = true;
        await api('state');
    } finally {
        submit.disabled = false;
    }
});

$('#logout').addEventListener('click', async () => {
    await send('logout', {});
    setSignedIn(false);
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
        html += `<tr><th>${charName(c)}<span class="lvl">${c.level}${c.realm ? ' · ' + esc(c.realm) : ''}</span></th>`;
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
    const keys = Object.keys(state.completions).filter(k => k <= current).sort();
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
        listItem('characters', c, `${charName(c)} <span class="muted">${c.level} ${esc(c.class)}${c.realm ? ' · ' + esc(c.realm) : ''}</span>`)
    ).join('') || '<li class="muted">No characters yet.</li>';

    $('#act-list').innerHTML = state.activities.map(a =>
        listItem('activities', a, `${esc(a.name)}${reqBadge(a)}${a.gold ? ` <span class="gold-inline">~${fmtGold(a.gold)}</span>` : ''}${a.notes ? ` <span class="muted">${esc(a.notes)}</span>` : ''}`)
    ).join('') || '<li class="muted">No activities yet.</li>';
}

// ---------- Forms ----------

const forms = {
    characters: { form: $('#char-form'), action: 'saveCharacter' },
    activities: { form: $('#act-form'), action: 'saveActivity' },
};

function resetForm(form) {
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
            if (form.elements[k]) form.elements[k].value = v;
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
        render();
    } else if (!document.activeElement?.matches('.gold-input')) {
        renderWeek();
    }
}, 60000);

api('state');
