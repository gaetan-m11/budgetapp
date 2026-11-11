'use strict';
/* BudgetApp mobile — données sur l'appareil (IndexedDB), synchronisées avec le PC par un
   fichier JSON dans Google Drive. Montants en centimes entiers, jamais en flottants. */

const VERSION = '1.0.0';
const FILE_NAME = 'budget-sync.json';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const COLLECTIONS = ['accounts', 'categories', 'transactions', 'budgets'];
const TYPE_LABELS = { expense: 'Dépense', income: 'Revenu', transfer: 'Transfert' };
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août',
  'septembre', 'octobre', 'novembre', 'décembre'];
const SYNC_LABELS = { setup: 'À configurer', login: 'Se connecter', busy: 'Synchro…',
  ok: 'À jour', pending: 'À envoyer', offline: 'Hors ligne', error: 'Erreur' };

const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nowIso = () => new Date().toISOString();
const newId = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '')
  : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''));
const pad = (n) => String(n).padStart(2, '0');

function emptyState() {
  return { format: 1, settings: { currency: 'CHF', month_start_day: 1, updated_at: '' },
    accounts: [], categories: [], transactions: [], budgets: [], tombstones: {} };
}

/* ---------------------------------------------------------------- état ---- */
const S = { state: emptyState(), tab: 'home', ym: null, txAll: false, query: '',
  sync: 'setup', syncError: '', editing: null };
let cfg = {};
try { cfg = JSON.parse(localStorage.getItem('budgetapp.cfg') || '{}'); } catch { cfg = {}; }
// Identifiant client OAuth par défaut (public par nature, modifiable dans Réglages).
const DEFAULT_CLIENT_ID = '971376105327-59e25b4426fii4d2ikj9l2pepijf11ir.apps.googleusercontent.com';
if (!cfg.clientId) cfg.clientId = DEFAULT_CLIENT_ID;
const saveCfg = () => localStorage.setItem('budgetapp.cfg', JSON.stringify(cfg));

const store = {
  db: null,
  open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('budgetapp', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('kv');
      request.onsuccess = () => { this.db = request.result; resolve(); };
      request.onerror = () => reject(request.error);
    });
  },
  get(key) {
    return new Promise((resolve, reject) => {
      const request = this.db.transaction('kv').objectStore('kv').get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  },
  set(key, value) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
};
const saveState = () => store.set('state', S.state).catch(() => toast('Enregistrement impossible'));

/* ------------------------------------------------------- montants, dates ---- */
const currency = () => S.state.settings.currency || 'CHF';

function fmt(cents, sign = false) {
  const abs = Math.abs(cents);
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, "'");
  const prefix = cents < 0 ? '-' : (sign && cents > 0 ? '+' : '');
  return `${prefix}${whole}.${pad(abs % 100)} ${currency()}`;
}

/** Montant sans la devise (cartes étroites). */
const bare = (cents, sign = false) => fmt(cents, sign).slice(0, -(currency().length + 1));

/** "1'234.50", "12,5", "45" -> centimes entiers ; null si invalide. */
function parseAmount(text) {
  const clean = String(text || '').replace(/[\s'’]/g, '').replace(',', '.');
  const match = /^(\d+)(?:\.(\d{0,2}))?$/.exec(clean);
  if (!match) return null;
  return parseInt(match[1], 10) * 100 + parseInt((match[2] || '').padEnd(2, '0') || '0', 10);
}

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const fmtDate = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const startDay = () => Math.min(28, Math.max(1, parseInt(S.state.settings.month_start_day, 10) || 1));

function addMonths(y, m, delta) {
  const index = y * 12 + (m - 1) + delta;
  return [Math.floor(index / 12), (index % 12) + 1];
}
/** Mois budgétaire : du jour de début à la veille du jour de début suivant. */
function period(y, m) {
  const day = startDay();
  const [ny, nm] = addMonths(y, m, 1);
  const end = new Date(Date.UTC(ny, nm - 1, day) - 86400000).toISOString().slice(0, 10);
  return [`${y}-${pad(m)}-${pad(day)}`, end];
}
function budgetMonthOf(iso) {
  const y = +iso.slice(0, 4), m = +iso.slice(5, 7), d = +iso.slice(8, 10);
  return d >= startDay() ? [y, m] : addMonths(y, m, -1);
}
const monthLabel = ([y, m]) => `${MONTHS[m - 1]} ${y}`;

/* ------------------------------------------------------------- calculs ---- */
const byId = (list) => new Map(list.map((r) => [r.uuid, r]));
const accounts = () => S.state.accounts.filter((a) => !a.archived)
  .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
const topCategories = () => S.state.categories.filter((c) => !c.parent)
  .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
const subCategories = (parent) => S.state.categories.filter((c) => c.parent === parent)
  .sort((a, b) => a.name.localeCompare(b.name, 'fr'));

/** Solde : initial + revenus - dépenses, transferts déplacés d'un compte à l'autre. */
function balances() {
  const result = new Map(S.state.accounts.map((a) => [a.uuid, a.initial_balance_cents]));
  for (const t of S.state.transactions) {
    const delta = t.type === 'income' ? t.amount_cents : -t.amount_cents;
    if (result.has(t.account)) result.set(t.account, result.get(t.account) + delta);
    if (t.type === 'transfer' && result.has(t.to_account)) {
      result.set(t.to_account, result.get(t.to_account) + t.amount_cents);
    }
  }
  return result;
}
function inPeriod(from, to) {
  return S.state.transactions.filter((t) => t.date >= from && t.date <= to);
}
function totals(from, to) {
  let income = 0, expense = 0;
  for (const t of inPeriod(from, to)) {
    if (t.type === 'income') income += t.amount_cents;
    else if (t.type === 'expense') expense += t.amount_cents;
  }
  return { income, expense, savings: income - expense };
}
function spent(category, y, m) {
  const [from, to] = period(y, m);
  return inPeriod(from, to).filter((t) => t.type === 'expense' && t.category === category)
    .reduce((sum, t) => sum + t.amount_cents, 0);
}
/** Reliquat reporté (jamais négatif) depuis le mois de départ du budget. */
function carry(budget, y, m) {
  if (!budget.rollover) return 0;
  let [cy, cm] = budget.start_month.split('-').map(Number);
  let value = 0;
  while (cy < y || (cy === y && cm < m)) {
    value = Math.max(0, budget.amount_cents + value - spent(budget.category, cy, cm));
    [cy, cm] = addMonths(cy, cm, 1);
  }
  return value;
}
function budgetLevel(spentCents, available) {
  if (spentCents > available) return 'over';
  if (available > 0 && spentCents * 100 >= available * 80) return 'warning';
  return 'ok';
}

/* ------------------------------------------------------------- fusion ---- */
/** Fusionne l'état distant dans l'état local ; renvoie le nombre de changements reçus. */
function merge(local, remote) {
  let changed = 0;
  for (const name of COLLECTIONS) {
    const map = byId(local[name]);
    for (const record of remote[name] || []) {
      if (!record || !record.uuid || !record.updated_at) continue;
      const deleted = local.tombstones[record.uuid];
      if (deleted && deleted >= record.updated_at) continue;
      const mine = map.get(record.uuid);
      if (!mine || record.updated_at > mine.updated_at) {
        map.set(record.uuid, record);
        delete local.tombstones[record.uuid];
        changed += 1;
      }
    }
    local[name] = [...map.values()];
  }
  for (const [uuid, deletedAt] of Object.entries(remote.tombstones || {})) {
    let found = false;
    for (const name of COLLECTIONS) {
      const index = local[name].findIndex((r) => r.uuid === uuid);
      if (index < 0) continue;
      found = true;
      if (local[name][index].updated_at <= deletedAt) {
        local[name].splice(index, 1);
        local.tombstones[uuid] = deletedAt;
        changed += 1;
      }
      break;
    }
    if (!found && !local.tombstones[uuid]) local.tombstones[uuid] = deletedAt;
  }
  const shared = remote.settings || {};
  if (shared.updated_at && shared.updated_at > (local.settings.updated_at || '')) {
    local.settings = { ...shared };
    changed += 1;
  }
  return changed;
}

function canonical(state) {
  const sortKeys = (value) => {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
    }
    return value;
  };
  const data = { settings: state.settings || {}, tombstones: state.tombstones || {} };
  for (const name of COLLECTIONS) {
    data[name] = [...(state[name] || [])].sort((a, b) => (a.uuid < b.uuid ? -1 : 1));
  }
  return JSON.stringify(sortKeys(data));
}

/* -------------------------------------------------------- Google Drive ---- */
class DriveError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function requestToken() {
  return new Promise((resolve, reject) => {
    if (!(window.google && google.accounts && google.accounts.oauth2)) {
      reject(new Error("Le service de connexion Google n'est pas chargé (réseau ?)."));
      return;
    }
    const client = google.accounts.oauth2.initTokenClient({
      client_id: cfg.clientId,
      scope: SCOPE,
      callback: (response) => {
        if (response.error) { reject(new Error(response.error_description || response.error)); return; }
        cfg.token = response.access_token;
        cfg.tokenExp = Date.now() + (Number(response.expires_in || 3600) - 120) * 1000;
        cfg.connected = true;
        saveCfg();
        resolve();
      },
      error_callback: (error) => reject(new Error(
        error && error.type === 'popup_closed' ? 'Connexion annulée.'
          : 'La fenêtre de connexion Google a été bloquée.')),
    });
    client.requestAccessToken({ prompt: cfg.connected ? '' : 'consent' });
  });
}

async function drive(url, options = {}) {
  const response = await fetch(url, {
    ...options, headers: { Authorization: `Bearer ${cfg.token}`, ...(options.headers || {}) },
  });
  if (response.status === 401) {
    cfg.token = null; saveCfg();
    throw new DriveError(401, 'Session Google expirée.');
  }
  if (!response.ok) throw new DriveError(response.status, `Google Drive a répondu ${response.status}.`);
  return response;
}
async function findFile() {
  const query = encodeURIComponent(`name='${FILE_NAME}' and trashed=false`);
  const response = await drive('https://www.googleapis.com/drive/v3/files'
    + `?q=${query}&fields=files(id,name,modifiedTime)&orderBy=modifiedTime desc&pageSize=5`);
  const files = (await response.json()).files || [];
  return files.length ? files[0].id : null;
}
async function createFile() {
  const meta = JSON.stringify({ name: FILE_NAME, mimeType: 'application/json' });
  const body = `--budgetapp\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`
    + `--budgetapp\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(S.state)}\r\n--budgetapp--`;
  const response = await drive(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
    { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=budgetapp' }, body });
  return (await response.json()).id;
}
async function download(fileId) {
  const response = await drive(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
  const text = (await response.text()).trim();
  return text ? JSON.parse(text) : emptyState();
}
async function upload(fileId) {
  await drive(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(S.state) });
}

let syncing = false;
let syncTimer = null;

function setSync(state, error = '') {
  S.sync = state;
  S.syncError = error;
  const button = $('#syncBtn');
  button.dataset.state = state;
  $('#syncLabel').textContent = SYNC_LABELS[state] || '';
  if (S.tab === 'settings' && !$('#clientId:focus')) render();
}

/** interactive = déclenché par un geste (peut ouvrir la connexion Google). */
async function sync(interactive = false, createIfMissing = false) {
  if (syncing) return;
  if (!cfg.clientId) { setSync('setup'); if (interactive) go('settings'); return; }
  if (!navigator.onLine) { setSync('offline'); return; }
  if (!cfg.token || Date.now() > (cfg.tokenExp || 0)) {
    if (!interactive) { setSync('login'); return; }
  }
  syncing = true;
  setSync('busy');
  try {
    if (!cfg.token || Date.now() > (cfg.tokenExp || 0)) await requestToken();
    if (!cfg.fileId) {
      cfg.fileId = await findFile();
      if (!cfg.fileId) {
        if (cfg.hadFile && !createIfMissing) {
          throw new DriveError(404, 'Fichier de synchronisation introuvable dans Google Drive.');
        }
        cfg.fileId = await createFile();
      }
      cfg.hadFile = true;
      saveCfg();
    }
    let remote;
    try {
      remote = await download(cfg.fileId);
    } catch (error) {
      if (error.status === 404) { cfg.fileId = null; saveCfg(); }
      throw error.status === 404
        ? new DriveError(404, 'Fichier de synchronisation introuvable dans Google Drive.') : error;
    }
    if ((remote.format || 1) > 1) throw new Error('Mettez à jour BudgetApp mobile (format plus récent).');
    const received = merge(S.state, remote);
    await saveState();
    if (canonical(S.state) !== canonical(remote)) await upload(cfg.fileId);
    cfg.lastSync = nowIso();
    cfg.dirty = false;
    saveCfg();
    syncing = false;
    setSync('ok');
    if (received) { render(); if (interactive) toast(`${received} modification(s) reçue(s)`); }
    else if (interactive) toast('Synchronisé');
  } catch (error) {
    syncing = false;
    if (error.status === 401) setSync('login');
    else setSync('error', error.message || String(error));
    if (interactive) toast(S.syncError || 'Connexion Google requise');
  }
}

/** À appeler après chaque modification locale. */
function changed() {
  cfg.dirty = true;
  saveCfg();
  saveState();
  if (S.sync === 'ok') setSync('pending');
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => sync(false), 1500);
  render();
}

/* -------------------------------------------------------------- rendu ---- */
function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.add('hidden'), 2600);
}

function go(tab) { S.tab = tab; window.scrollTo(0, 0); render(); }

function monthBar(allowAll = false) {
  return `<div class="monthbar">
    <button data-action="month" data-delta="-1" aria-label="Mois précédent">‹</button>
    <span class="label">${allowAll && S.txAll ? 'Toutes les dates' : esc(monthLabel(S.ym))}</span>
    <span>${allowAll ? `<button class="chip ${S.txAll ? 'on' : ''}" data-action="all">Tout</button> ` : ''}
    <button data-action="month" data-delta="1" aria-label="Mois suivant">›</button></span>
  </div>`;
}

function txRow(t, categories, accountNames, withDate = false) {
  const cat = categories.get(t.category);
  const where = t.type === 'transfer'
    ? `${accountNames.get(t.account) || ''} → ${accountNames.get(t.to_account) || ''}`
    : [cat ? cat.name : 'Sans catégorie', accountNames.get(t.account)].filter(Boolean).join(' · ');
  const amount = t.type === 'transfer' ? fmt(t.amount_cents)
    : fmt(t.type === 'income' ? t.amount_cents : -t.amount_cents, true);
  const cls = t.type === 'income' ? 'pos' : (t.type === 'expense' ? 'neg' : 'muted');
  return `<button class="row" data-action="edit" data-id="${esc(t.uuid)}">
    <span class="dot" style="background:${esc(cat ? cat.color : '')}"></span>
    <span class="main"><span class="name">${esc(t.label)}</span>
      <span class="sub">${withDate ? `${fmtDate(t.date)} · ` : ''}${esc(where)}</span></span>
    <span class="amt ${cls}">${amount}</span></button>`;
}

const sortedTx = (list) => [...list].sort((a, b) => (a.date === b.date
  ? (a.updated_at < b.updated_at ? 1 : -1) : (a.date < b.date ? 1 : -1)));

function renderHome() {
  const [from, to] = period(...S.ym);
  const sums = totals(from, to);
  const bal = balances();
  const total = accounts().reduce((sum, a) => sum + (bal.get(a.uuid) || 0), 0)
    + S.state.accounts.filter((a) => a.archived).reduce((sum, a) => sum + (bal.get(a.uuid) || 0), 0);
  const categories = byId(S.state.categories);
  const accountNames = new Map(S.state.accounts.map((a) => [a.uuid, a.name]));

  const byCat = new Map();
  for (const t of inPeriod(from, to)) {
    if (t.type === 'expense') byCat.set(t.category || '', (byCat.get(t.category || '') || 0) + t.amount_cents);
  }
  const top = [...byCat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  const max = top.length ? top[0][1] : 1;
  const catRows = top.map(([id, cents]) => {
    const cat = categories.get(id);
    return `<div class="budget"><div class="head"><span>${esc(cat ? cat.name : 'Sans catégorie')}</span>
      <span>${fmt(cents)}</span></div><div class="bar"><i style="width:${Math.round(cents * 100 / max)}%;
      background:${esc(cat ? cat.color : 'var(--faint)')}"></i></div></div>`;
  }).join('');

  const recent = sortedTx(S.state.transactions.filter((t) => t.date <= todayIso())).slice(0, 5);
  if (!S.state.accounts.length) {
    return `<div class="card empty"><p><b>Aucune donnée pour l'instant.</b></p>
      <p>Connectez Google Drive dans Réglages, puis synchronisez BudgetApp sur le PC :
      vos comptes, catégories et transactions apparaîtront ici.</p>
      <button class="btn primary" data-tab="settings">Ouvrir les réglages</button></div>`;
  }
  return `${monthBar()}
    <div class="card hero"><div class="cap">Solde total</div><div class="big">${fmt(total)}</div></div>
    <div class="kpis">
      <div class="kpi"><div class="cap">Revenus</div><div class="val pos">${bare(sums.income)}</div><div class="unit">${esc(currency())}</div></div>
      <div class="kpi"><div class="cap">Dépenses</div><div class="val neg">${bare(sums.expense)}</div><div class="unit">${esc(currency())}</div></div>
      <div class="kpi"><div class="cap">Épargne</div><div class="val">${bare(sums.savings, true)}</div><div class="unit">${esc(currency())}</div></div>
    </div>
    <div class="card"><h2>Dépenses par catégorie</h2>${catRows || '<div class="muted small">Aucune dépense sur ce mois.</div>'}</div>
    <div class="card"><h2>Comptes</h2>${accounts().map((a) => `<div class="row">
      <span class="main"><span class="name">${esc(a.name)}</span></span>
      <span class="amt ${bal.get(a.uuid) < 0 ? 'neg' : ''}">${fmt(bal.get(a.uuid) || 0)}</span></div>`).join('')}</div>
    <div class="card"><h2>Dernières transactions</h2>${recent.map((t) => txRow(t, categories, accountNames, true)).join('')
      || '<div class="muted small">Aucune transaction.</div>'}</div>`;
}

function txListHtml() {
  const categories = byId(S.state.categories);
  const accountNames = new Map(S.state.accounts.map((a) => [a.uuid, a.name]));
  let list = S.state.transactions;
  if (!S.txAll) { const [from, to] = period(...S.ym); list = inPeriod(from, to); }
  const query = S.query.trim().toLocaleLowerCase('fr');
  if (query) {
    list = list.filter((t) => `${t.label} ${t.note || ''} ${t.tags || ''} ${(categories.get(t.category) || {}).name || ''}`
      .toLocaleLowerCase('fr').includes(query));
  }
  if (!list.length) return '<div class="card empty">Aucune transaction.</div>';
  let html = '', day = '';
  const shown = sortedTx(list).slice(0, 400);
  for (const t of shown) {
    if (t.date !== day) {
      if (day) html += '</div>';
      day = t.date;
      const label = new Date(`${day}T12:00:00`).toLocaleDateString('fr-CH',
        { weekday: 'long', day: 'numeric', month: 'long' });
      html += `<div class="daytitle">${esc(label)}</div><div class="card">`;
    }
    html += txRow(t, categories, accountNames);
  }
  return `${html}</div>${list.length > shown.length ? '<div class="muted small empty">Affinez la recherche pour voir la suite.</div>' : ''}`;
}

function renderTx() {
  return `<input class="search" id="search" type="search" placeholder="Rechercher…" value="${esc(S.query)}"
    autocomplete="off">${monthBar(true)}<div id="txList">${txListHtml()}</div>`;
}

function renderBudgets() {
  const [y, m] = S.ym;
  const categories = byId(S.state.categories);
  const items = S.state.budgets.filter((b) => categories.has(b.category))
    .sort((a, b) => categories.get(a.category).name.localeCompare(categories.get(b.category).name, 'fr'));
  if (!items.length) {
    return `${monthBar()}<div class="card empty">Aucun budget. Les budgets se définissent dans
      BudgetApp sur le PC.</div>`;
  }
  let totalAvailable = 0, totalSpent = 0;
  const rows = items.map((b) => {
    const available = b.amount_cents + carry(b, y, m);
    const used = spent(b.category, y, m);
    totalAvailable += available; totalSpent += used;
    const level = budgetLevel(used, available);
    const ratio = available > 0 ? used / available : (used > 0 ? 1 : 0);
    const cat = categories.get(b.category);
    return `<div class="budget"><div class="head"><span>${esc(cat.name)}</span>
      <span class="${level === 'over' ? 'neg' : ''}">${Math.round(ratio * 100)} %</span></div>
      <div class="bar ${level}"><i style="width:${Math.min(100, Math.round(ratio * 100))}%"></i></div>
      <div class="foot"><span>${fmt(used)} sur ${fmt(available)}</span>
      <span class="${level === 'over' ? 'neg' : ''}">${available - used >= 0 ? 'Reste ' : 'Dépassé de '}${fmt(Math.abs(available - used))}</span></div></div>`;
  }).join('');
  return `${monthBar()}<div class="card hero"><div class="cap">Reste à dépenser</div>
    <div class="big">${fmt(totalAvailable - totalSpent)}</div></div><div class="card">${rows}</div>`;
}

function renderSettings() {
  const last = cfg.lastSync ? new Date(cfg.lastSync).toLocaleString('fr-CH',
    { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'jamais';
  const messages = {
    setup: "Indiquez l'identifiant client Google ci-dessous, puis connectez-vous.",
    login: 'Touchez « Se connecter » pour reprendre la synchronisation.',
    busy: 'Synchronisation en cours…', ok: 'Tout est synchronisé.',
    pending: 'Des modifications attendent d\'être envoyées.',
    offline: 'Hors ligne : les modifications seront envoyées au retour du réseau.',
    error: S.syncError,
  };
  const missing = S.sync === 'error' && /introuvable/.test(S.syncError);
  return `<div class="card"><h2>Synchronisation Google Drive</h2>
      <p class="${S.sync === 'error' ? 'neg' : 'muted'} small">${esc(messages[S.sync] || '')}</p>
      <p class="muted small">Dernière synchronisation : ${esc(last)}</p>
      <button class="btn primary" data-action="sync">${cfg.token && Date.now() < (cfg.tokenExp || 0)
        ? 'Synchroniser maintenant' : 'Se connecter à Google Drive'}</button>
      ${missing ? '<button class="btn" data-action="recreate">Créer un nouveau fichier de synchronisation</button>' : ''}
      ${cfg.connected ? '<button class="btn danger" data-action="disconnect">Se déconnecter</button>' : ''}
    </div>
    <div class="card"><h2>Identifiant client Google</h2>
      <label class="field"><span>Client ID (OAuth, type « Application Web »)</span>
      <input id="clientId" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false"
        placeholder="xxxxxxxx.apps.googleusercontent.com" value="${esc(cfg.clientId || '')}"></label>
      <button class="btn" data-action="saveClient">Enregistrer l'identifiant</button>
      <p class="muted small">Origine à autoriser dans Google Cloud : <code>${esc(location.origin)}</code></p>
    </div>
    <div class="card"><h2>Données sur cet appareil</h2>
      <p class="muted small">${S.state.transactions.length} transaction(s), ${S.state.accounts.length} compte(s),
        ${S.state.categories.length} catégorie(s), ${S.state.budgets.length} budget(s).</p>
      <button class="btn" data-action="export">Exporter une copie (JSON)</button>
      <button class="btn danger" data-action="wipe">Effacer les données de cet appareil</button>
    </div>
    <p class="muted small" style="text-align:center">BudgetApp mobile ${VERSION}</p>`;
}

function render() {
  const titles = { home: ['Accueil', "Vue d'ensemble"], tx: ['Transactions', 'Toutes vos opérations'],
    budgets: ['Budgets', 'Suivi du mois'], settings: ['Réglages', 'Synchronisation et données'] };
  $('#title').textContent = titles[S.tab][0];
  $('#subtitle').textContent = titles[S.tab][1];
  $('#view').innerHTML = { home: renderHome, tx: renderTx, budgets: renderBudgets,
    settings: renderSettings }[S.tab]();
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.tab));
  $('#fab').classList.toggle('hidden', S.tab === 'settings' || !accounts().length);
}

/* ------------------------------------------------------ saisie (feuille) ---- */
function options(items, selected, placeholder) {
  return (placeholder ? `<option value="">${esc(placeholder)}</option>` : '')
    + items.map((i) => `<option value="${esc(i.uuid)}" ${i.uuid === selected ? 'selected' : ''}>${esc(i.name)}</option>`).join('');
}

function openSheet(uuid) {
  const existing = uuid ? S.state.transactions.find((t) => t.uuid === uuid) : null;
  const list = accounts();
  const t = existing ? { ...existing } : {
    uuid: null, type: 'expense', date: todayIso(), label: '', amount_cents: 0,
    account: cfg.lastAccount && list.some((a) => a.uuid === cfg.lastAccount) ? cfg.lastAccount : (list[0] || {}).uuid,
    to_account: null, category: null, subcategory: null, note: '', tags: '',
  };
  S.editing = t;
  const allAccounts = S.state.accounts.filter((a) => !a.archived || a.uuid === t.account || a.uuid === t.to_account);
  $('#sheet').innerHTML = `<div class="grip"></div>
    <h2>${existing ? 'Modifier la transaction' : 'Nouvelle transaction'}</h2>
    <div class="seg" id="typeSeg">${Object.entries(TYPE_LABELS).map(([key, label]) =>
      `<button type="button" data-type="${key}" class="${t.type === key ? 'on' : ''}">${label}</button>`).join('')}</div>
    <div class="amount"><input id="fAmount" inputmode="decimal" placeholder="0.00" autocomplete="off"
      value="${t.amount_cents ? esc(fmt(t.amount_cents).replace(` ${currency()}`, '')) : ''}"><span>${esc(currency())}</span></div>
    <label class="field"><span>Libellé</span><input id="fLabel" value="${esc(t.label)}" autocomplete="off"
      placeholder="p. ex. Migros" enterkeyhint="done"></label>
    <div class="two">
      <label class="field"><span>Date</span><input id="fDate" type="date" value="${esc(t.date)}"></label>
      <label class="field"><span>Compte</span><select id="fAccount">${options(allAccounts, t.account)}</select></label>
    </div>
    <label class="field" id="toWrap"><span>Vers le compte</span><select id="fTo">${options(allAccounts, t.to_account, 'Choisir…')}</select></label>
    <div class="two" id="catWrap">
      <label class="field"><span>Catégorie</span><select id="fCat">${options(topCategories(), t.category, 'Aucune')}</select></label>
      <label class="field"><span>Sous-catégorie</span><select id="fSub"></select></label>
    </div>
    <label class="field"><span>Note</span><input id="fNote" value="${esc(t.note || '')}" autocomplete="off"></label>
    <div class="error" id="fError"></div>
    <button class="btn primary" data-action="save">Enregistrer</button>
    ${existing ? '<button class="btn danger" data-action="delete">Supprimer</button>' : ''}
    <button class="btn" data-action="close">Annuler</button>`;
  fillSubs(t.subcategory);
  syncSheetType();
  $('#sheet').classList.remove('hidden');
  $('#backdrop').classList.remove('hidden');
  if (!existing) setTimeout(() => $('#fAmount').focus(), 50);
}
function fillSubs(selected) {
  const subs = subCategories($('#fCat').value);
  $('#fSub').innerHTML = options(subs, selected, subs.length ? 'Aucune' : '—');
  $('#fSub').disabled = !subs.length;
}
function syncSheetType() {
  const transfer = S.editing.type === 'transfer';
  $('#toWrap').classList.toggle('hidden', !transfer);
  $('#catWrap').classList.toggle('hidden', transfer);
  document.querySelectorAll('#typeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.type === S.editing.type));
}
function closeSheet() {
  $('#sheet').classList.add('hidden');
  $('#backdrop').classList.add('hidden');
  S.editing = null;
}
function saveSheet() {
  const t = S.editing;
  const fail = (message) => { $('#fError').textContent = message; };
  const amount = parseAmount($('#fAmount').value);
  const label = $('#fLabel').value.trim();
  if (amount === null || amount <= 0) return fail('Indiquez un montant supérieur à zéro.');
  if (!label) return fail('Le libellé est obligatoire.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test($('#fDate').value)) return fail('Date invalide.');
  const account = $('#fAccount').value;
  if (!account) return fail('Le compte est obligatoire.');
  const transfer = t.type === 'transfer';
  const to = transfer ? $('#fTo').value : null;
  if (transfer && (!to || to === account)) return fail('Choisissez un compte de destination différent.');
  const category = transfer ? null : ($('#fCat').value || null);
  const record = {
    uuid: t.uuid || newId(), date: $('#fDate').value, label, amount_cents: amount, type: t.type,
    account, to_account: to, category, subcategory: category ? ($('#fSub').value || null) : null,
    note: $('#fNote').value.trim(), tags: t.tags || '', updated_at: nowIso(),
  };
  const index = S.state.transactions.findIndex((x) => x.uuid === record.uuid);
  if (index >= 0) S.state.transactions[index] = record; else S.state.transactions.push(record);
  cfg.lastAccount = account;
  closeSheet();
  changed();
  toast(index >= 0 ? 'Transaction modifiée' : 'Transaction ajoutée');
  return undefined;
}
function deleteEditing() {
  const t = S.editing;
  if (!t || !t.uuid || !confirm(`Supprimer « ${t.label} » ?`)) return;
  S.state.transactions = S.state.transactions.filter((x) => x.uuid !== t.uuid);
  S.state.tombstones[t.uuid] = nowIso();
  closeSheet();
  changed();
  toast('Transaction supprimée');
}

/* ---------------------------------------------------------- événements ---- */
const actions = {
  new: () => openSheet(null),
  edit: (el) => openSheet(el.dataset.id),
  close: closeSheet,
  save: saveSheet,
  delete: deleteEditing,
  sync: () => sync(true),
  recreate: () => { if (confirm('Créer un nouveau fichier dans Google Drive ? Il faudra le sélectionner à nouveau dans BudgetApp sur le PC.')) { cfg.fileId = null; saveCfg(); sync(true, true); } },
  month: (el) => { S.txAll = false; S.ym = addMonths(...S.ym, Number(el.dataset.delta)); render(); },
  all: () => { S.txAll = !S.txAll; render(); },
  saveClient: () => {
    cfg.clientId = $('#clientId').value.trim();
    cfg.token = null; saveCfg();
    toast(cfg.clientId ? 'Identifiant enregistré' : 'Identifiant effacé');
    setSync(cfg.clientId ? 'login' : 'setup');
    render();
  },
  disconnect: () => {
    if (!confirm('Se déconnecter de Google Drive ? Les données restent sur cet appareil.')) return;
    if (cfg.token && window.google) google.accounts.oauth2.revoke(cfg.token, () => {});
    cfg.token = null; cfg.connected = false; cfg.fileId = null; saveCfg();
    setSync('login'); render();
  },
  export: () => {
    const blob = new Blob([JSON.stringify(S.state, null, 1)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `budgetapp-${todayIso()}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 5000);
  },
  wipe: async () => {
    if (!confirm('Effacer toutes les données de cet appareil ? Les données du PC et du fichier Google Drive ne sont pas touchées.')) return;
    S.state = emptyState(); cfg.dirty = false; cfg.lastSync = null; saveCfg();
    await saveState(); render(); toast('Données effacées');
  },
};

document.addEventListener('click', (event) => {
  const tab = event.target.closest('[data-tab]');
  if (tab) { go(tab.dataset.tab); return; }
  const type = event.target.closest('#typeSeg [data-type]');
  if (type && S.editing) { S.editing.type = type.dataset.type; syncSheetType(); return; }
  const el = event.target.closest('[data-action]');
  if (el && actions[el.dataset.action]) actions[el.dataset.action](el);
});
document.addEventListener('input', (event) => {
  if (event.target.id === 'search') { S.query = event.target.value; $('#txList').innerHTML = txListHtml(); }
});
document.addEventListener('change', (event) => {
  if (event.target.id === 'fCat') fillSubs(null);
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(false); });
window.addEventListener('online', () => sync(false));
window.addEventListener('offline', () => setSync('offline'));

/* ----------------------------------------------------------- démarrage ---- */
function demoState() {
  const state = emptyState();
  const at = nowIso();
  const acc = { uuid: newId(), name: 'Compte courant', type: 'checking', initial_balance_cents: 250000, archived: 0, updated_at: at };
  const sav = { uuid: newId(), name: 'Épargne', type: 'savings', initial_balance_cents: 1200000, archived: 0, updated_at: at };
  state.accounts = [acc, sav];
  const cats = [['Logement', '#4E79A7'], ['Alimentation', '#59A14F'], ['Transport', '#F28E2B'],
    ['Loisirs', '#B07AA1'], ['Assurances', '#76B7B2'], ['Salaire', '#2E8B57']]
    .map(([name, color]) => ({ uuid: newId(), name, parent: null, color, icon: '', updated_at: at }));
  state.categories = [...cats, { uuid: newId(), name: 'Courses', parent: cats[1].uuid, color: '#59A14F', icon: '', updated_at: at }];
  const [y, m] = budgetMonthOf(todayIso());
  const add = (delta, day, label, cents, type, cat) => {
    const [yy, mm] = addMonths(y, m, delta);
    state.transactions.push({ uuid: newId(), date: `${yy}-${pad(mm)}-${pad(day)}`, label, amount_cents: cents, type,
      account: acc.uuid, to_account: type === 'transfer' ? sav.uuid : null, category: cat ? cat.uuid : null,
      subcategory: null, note: '', tags: '', updated_at: at });
  };
  for (const delta of [0, -1, -2]) {
    add(delta, 1, 'Salaire', 620000, 'income', cats[5]);
    add(delta, 2, 'Loyer', 165000, 'expense', cats[0]);
    add(delta, 3, 'Migros', 42000 - delta * 2500, 'expense', cats[1]);
    add(delta, 4, 'Abonnement CFF', 34000, 'expense', cats[2]);
    add(delta, 5, 'Assurance maladie', 38550, 'expense', cats[4]);
    add(delta, 6, 'Cinéma et sorties', 12000, 'expense', cats[3]);
    add(delta, 7, 'Virement épargne', 80000, 'transfer', null);
  }
  const start = `${y}-${pad(m)}`;
  state.budgets = [[cats[1], 50000, 0], [cats[3], 10000, 0], [cats[0], 200000, 1]].map(([cat, cents, rollover]) =>
    ({ uuid: newId(), category: cat.uuid, amount_cents: cents, rollover, start_month: start, updated_at: at }));
  return state;
}

async function start() {
  S.ym = budgetMonthOf(todayIso());
  try {
    await store.open();
    const saved = await store.get('state');
    if (saved && saved.accounts) S.state = { ...emptyState(), ...saved };
  } catch { toast('Stockage indisponible sur ce navigateur'); }
  if (new URLSearchParams(location.search).has('demo')
      && ['localhost', '127.0.0.1'].includes(location.hostname)) {
    S.state = demoState();
  }
  S.ym = budgetMonthOf(todayIso());
  render();
  setSync(!cfg.clientId ? 'setup' : (cfg.token && Date.now() < (cfg.tokenExp || 0) ? (cfg.dirty ? 'pending' : 'ok') : 'login'));
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  sync(false);
}
start();

// Exposé pour les tests de la fusion.
window.BudgetApp = { merge, canonical, emptyState, parseAmount, fmt, period, budgetMonthOf, S };
