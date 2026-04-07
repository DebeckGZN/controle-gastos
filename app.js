// ╔══════════════════════════════════════════════════════════════╗
// ║  CONFIGURE AQUI — cole seu Client ID do Google Cloud Console ║
// ╚══════════════════════════════════════════════════════════════╝
const CLIENT_ID = 'SEU_CLIENT_ID_AQUI.apps.googleusercontent.com';

// ── Constantes ────────────────────────────────────────────────────────────────
const SCOPES       = 'https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email';
const FILE_NAME    = 'gastos.json';
const COLORS       = ['#c8f060','#60d0f0','#f060c8','#f0c060','#60f0a0','#f07060','#a060f0','#60f0d0','#f0a060','#6090f0'];
const DRIVE_FOLDER = 'appDataFolder'; // pasta oculta privada do app no Drive

const DEFAULT_STATE = {
  banks: [],
  categories: ['Alimentação','Transporte','Moradia','Saúde','Lazer','Educação','Outros'],
  transactions: []
};

// ── Estado da aplicação ───────────────────────────────────────────────────────
let state       = deepClone(DEFAULT_STATE);
let accessToken = null;
let driveFileId = null;
let userProfile = null;
let syncTimer   = null;
let isSyncing   = false;

function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

// ── Boot ──────────────────────────────────────────────────────────────────────
window.addEventListener('load', () => {
  if (!CLIENT_ID || CLIENT_ID === 'SEU_CLIENT_ID_AQUI.apps.googleusercontent.com') {
    show('config-warning');
    return;
  }
  // Tenta token salvo
  const saved = sessionStorage.getItem('g_token');
  if (saved) {
    accessToken = saved;
    bootApp();
  } else {
    show('login-screen');
  }
});

// ── Auth ──────────────────────────────────────────────────────────────────────
function signIn() {
  const client = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: async (resp) => {
      if (resp.error) { toast('Erro no login: ' + resp.error, 'error'); return; }
      accessToken = resp.access_token;
      sessionStorage.setItem('g_token', accessToken);
      bootApp();
    }
  });
  client.requestAccessToken();
}

function signOut() {
  if (!confirm('Sair da conta Google? Os dados locais não serão apagados.')) return;
  if (accessToken) google.accounts.oauth2.revoke(accessToken, () => {});
  accessToken = null;
  driveFileId = null;
  userProfile = null;
  sessionStorage.removeItem('g_token');
  show('login-screen');
}

async function bootApp() {
  show('app');
  setSyncState('syncing', 'carregando...');
  try {
    await fetchUserProfile();
    await loadFromDrive();
    renderAll();
    setSyncState('ok', 'sincronizado');
  } catch(e) {
    console.error(e);
    // Fallback: usa localStorage se Drive falhar
    const local = localStorage.getItem('gastos_local');
    if (local) state = JSON.parse(local);
    renderAll();
    setSyncState('err', 'offline');
    toast('Sem conexão — usando dados locais', 'info');
  }
}

// ── Google Drive ──────────────────────────────────────────────────────────────
async function driveReq(url, options = {}) {
  const resp = await fetch(url, {
    ...options,
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (resp.status === 401) {
    // Token expirado — pede novo login
    sessionStorage.removeItem('g_token');
    show('login-screen');
    throw new Error('token_expired');
  }
  return resp;
}

async function findFile() {
  const r = await driveReq(
    `https://www.googleapis.com/drive/v3/files?spaces=${DRIVE_FOLDER}&q=name='${FILE_NAME}'&fields=files(id,name,modifiedTime)`
  );
  const data = await r.json();
  return data.files?.[0] || null;
}

async function loadFromDrive() {
  const file = await findFile();
  if (!file) {
    // Primeiro uso — cria arquivo vazio
    await pushToDrive();
    return;
  }
  driveFileId = file.id;
  const r = await driveReq(
    `https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`
  );
  const text = await r.text();
  if (text) {
    state = JSON.parse(text);
    localStorage.setItem('gastos_local', text);
  }
}

async function pushToDrive() {
  const body = JSON.stringify(state, null, 2);
  localStorage.setItem('gastos_local', body);

  if (!driveFileId) {
    // Cria o arquivo
    const meta = await driveReq(
      'https://www.googleapis.com/drive/v3/files?fields=id',
      {
        method: 'POST',
        body: JSON.stringify({ name: FILE_NAME, parents: [DRIVE_FOLDER] })
      }
    );
    const { id } = await meta.json();
    driveFileId = id;
  }

  // Upload multipart
  const boundary = 'gastos_boundary_42';
  const metadata = JSON.stringify({ name: FILE_NAME });
  const multipart = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    metadata,
    `--${boundary}`,
    'Content-Type: application/json',
    '',
    body,
    `--${boundary}--`
  ].join('\r\n');

  await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${driveFileId}?uploadType=multipart`,
    {
      method: 'PATCH',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Content-Type': `multipart/related; boundary=${boundary}`
      },
      body: multipart
    }
  );
}

async function fetchUserProfile() {
  const r = await driveReq('https://www.googleapis.com/oauth2/v2/userinfo');
  userProfile = await r.json();
}

// ── Sync debounced ────────────────────────────────────────────────────────────
function scheduleSave() {
  clearTimeout(syncTimer);
  setSyncState('syncing', 'salvando...');
  syncTimer = setTimeout(async () => {
    if (isSyncing) return;
    isSyncing = true;
    try {
      await pushToDrive();
      setSyncState('ok', 'sincronizado');
    } catch(e) {
      setSyncState('err', 'erro ao salvar');
      toast('Erro ao salvar no Drive', 'error');
    } finally {
      isSyncing = false;
    }
  }, 1200);
}

async function manualSync() {
  if (isSyncing) return;
  isSyncing = true;
  setSyncState('syncing', 'sincronizando...');
  try {
    await loadFromDrive();
    renderAll();
    setSyncState('ok', 'sincronizado');
    toast('Dados atualizados do Drive', 'success');
  } catch(e) {
    setSyncState('err', 'sem conexão');
    toast('Sem conexão com Drive', 'error');
  } finally {
    isSyncing = false;
  }
}

async function forcePull() {
  if (!confirm('Baixar dados do Drive? Substituirá os dados locais.')) return;
  await manualSync();
}

async function forcePush() {
  if (!confirm('Enviar dados locais ao Drive? Substituirá o arquivo remoto.')) return;
  setSyncState('syncing', 'enviando...');
  try {
    await pushToDrive();
    setSyncState('ok', 'enviado');
    toast('Dados enviados ao Drive', 'success');
  } catch(e) {
    setSyncState('err', 'falhou');
    toast('Erro ao enviar', 'error');
  }
}

function setSyncState(type, label) {
  const btn = el('sync-btn');
  btn.className = 'sync-' + type;
  el('sync-label').textContent = label;
  // rebuild id
  btn.id = 'sync-btn';
}

// ── Utilitários ───────────────────────────────────────────────────────────────
function el(id) { return document.getElementById(id); }
function show(id) {
  ['config-warning','login-screen','app'].forEach(i => {
    const e = el(i);
    if (e) e.style.display = i === id ? (id === 'app' ? 'flex' : 'flex') : 'none';
  });
  if (id === 'app') el('app').style.flexDirection = 'column';
}

function fmt(v) {
  return 'R$ ' + Math.abs(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(d) {
  if (!d) return '';
  const [y, m, day] = d.split('-');
  return `${day}/${m}`;
}
function today() { return new Date().toISOString().substring(0, 10); }

// ── Cálculos ──────────────────────────────────────────────────────────────────
function bankBalance(name) {
  const b = state.banks.find(b => b.name === name);
  if (!b) return 0;
  return b.initial + state.transactions
    .filter(t => t.bank === name)
    .reduce((s, t) => s + (t.type === 'entrada' ? t.val : -t.val), 0);
}
function totalBalance()  { return state.banks.reduce((s, b) => s + bankBalance(b.name), 0); }
function totalInitial()  { return state.banks.reduce((s, b) => s + b.initial, 0); }
function totalSpent()    { return state.transactions.filter(t => t.type !== 'entrada').reduce((s, t) => s + t.val, 0); }
function catTotals(txs) {
  const map = {};
  (txs || state.transactions).filter(t => t.type !== 'entrada').forEach(t => {
    map[t.cat] = (map[t.cat] || 0) + t.val;
  });
  return Object.entries(map).sort((a, b) => b[1] - a[1]);
}
function getMonths() {
  const set = new Set([today().substring(0, 7)]);
  state.transactions.forEach(t => set.add(t.date.substring(0, 7)));
  return [...set].sort().reverse();
}
function balanceBeforeMonth(ym) {
  const cutoff = ym + '-01';
  return totalInitial() + state.transactions
    .filter(t => t.date < cutoff)
    .reduce((s, t) => s + (t.type === 'entrada' ? t.val : -t.val), 0);
}

// ── Render helpers ────────────────────────────────────────────────────────────
function renderBars(cats, containerId) {
  const c = el(containerId);
  if (!cats.length) { c.innerHTML = '<div class="empty">Nenhum gasto no período</div>'; return; }
  const max = Math.max(...cats.map(x => x[1]));
  c.innerHTML = cats.map(([cat, val], i) => `
    <div class="bar-wrap">
      <div class="bar-top"><span>${cat}</span><span>${fmt(val)}</span></div>
      <div class="bar-bg"><div class="bar-fill" style="width:${(val/max*100).toFixed(1)}%;background:${COLORS[i%COLORS.length]}"></div></div>
    </div>`).join('');
}

function txHtml(t, idx, showDel = true) {
  return `<div class="tx-item">
    <div>
      <div class="tx-name">${t.desc || t.cat}</div>
      <div class="tx-meta">${t.bank} · ${fmtDate(t.date)} · ${t.cat}</div>
    </div>
    <div style="display:flex;align-items:center;flex-shrink:0;margin-left:12px">
      <div style="text-align:right">
        <div class="tx-val ${t.type === 'entrada' ? 'pos' : 'neg'}">${t.type === 'entrada' ? '+' : '-'}${fmt(t.val)}</div>
      </div>
      ${showDel ? `<button class="del-btn" onclick="deleteTx(${idx})">✕</button>` : ''}
    </div>
  </div>`;
}

// ── Render sections ───────────────────────────────────────────────────────────
function renderHome() {
  const gc = el('home-bank-cards');
  gc.innerHTML = state.banks.map(b => {
    const bal = bankBalance(b.name);
    return `<div class="card-sm">
      <div class="card-label">${b.name}</div>
      <div class="card-value" style="font-size:18px;color:${bal<0?'var(--red)':'var(--txt)'}">${fmt(bal)}</div>
    </div>`;
  }).join('') || '';

  el('total-card').innerHTML = `<div class="card card-accent" style="margin-bottom:16px">
    <div class="card-label">Saldo total</div>
    <div class="card-value">${fmt(totalBalance())}</div>
    <div class="card-sub">Gasto total: ${fmt(totalSpent())}</div>
  </div>`;

  renderBars(catTotals().slice(0, 5), 'home-cats');

  const recent = [...state.transactions].reverse().slice(0, 6);
  el('home-recent').innerHTML = recent.length
    ? recent.map((t, i) => txHtml(t, state.transactions.length - 1 - i, false)).join('')
    : '<div class="empty">Nenhuma transação ainda</div>';

  const d = new Date();
  el('header-sub').textContent = d.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
}

function renderTx() {
  const txs = [...state.transactions].reverse();
  el('all-tx-list').innerHTML = txs.length
    ? txs.map((t, i) => txHtml(t, state.transactions.length - 1 - i)).join('')
    : '<div class="empty">Nenhuma transação registrada</div>';
}

let selectedMonth = null;
function renderMensal() {
  const months = getMonths();
  if (!selectedMonth || !months.includes(selectedMonth)) selectedMonth = months[0];

  el('month-chips').innerHTML = months.map(m => {
    const [y, mo] = m.split('-');
    const label = new Date(+y, +mo-1, 1).toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' });
    return `<button class="month-chip${m===selectedMonth?' active':''}" onclick="selectMonth('${m}')">${label}</button>`;
  }).join('');

  const txs   = state.transactions.filter(t => t.date.startsWith(selectedMonth));
  const gastos = txs.filter(t => t.type !== 'entrada');
  const entradas = txs.filter(t => t.type === 'entrada');
  const totalG = gastos.reduce((s, t) => s + t.val, 0);
  const totalE = entradas.reduce((s, t) => s + t.val, 0);
  const balStart = balanceBeforeMonth(selectedMonth);
  const balEnd   = balStart + totalE - totalG;

  el('monthly-cards').innerHTML = `
    <div class="card-sm"><div class="card-label">Entradas</div><div class="card-value" style="font-size:16px;color:var(--green)">${fmt(totalE)}</div></div>
    <div class="card-sm"><div class="card-label">Saídas</div><div class="card-value" style="font-size:16px;color:var(--red)">${fmt(totalG)}</div></div>
    <div class="card-sm"><div class="card-label">Saldo final</div><div class="card-value" style="font-size:16px;color:${balEnd<0?'var(--red)':'var(--txt)'}">${fmt(balEnd)}</div></div>`;

  el('monthly-flow').innerHTML = `
    <span style="color:var(--txt2)">${fmt(balStart)}</span>
    <span style="color:var(--txt3);font-size:16px;margin:0 8px">→</span>
    <span style="color:${balEnd<0?'var(--red)':'var(--accent)'}">${fmt(balEnd)}</span>`;

  renderBars(catTotals(gastos), 'monthly-cats');

  const mb = el('monthly-banks');
  if (!state.banks.length) { mb.innerHTML = '<div class="empty">Nenhum banco</div>'; return; }
  mb.innerHTML = state.banks.map((b, i) => {
    const spent  = txs.filter(t => t.bank===b.name && t.type!=='entrada').reduce((s,t)=>s+t.val,0);
    const earned = txs.filter(t => t.bank===b.name && t.type==='entrada').reduce((s,t)=>s+t.val,0);
    const pct    = totalG > 0 ? Math.min(spent/totalG*100, 100) : 0;
    return `<div class="bar-wrap">
      <div class="bar-top"><span>${b.name}</span>
        <span>${spent>0?'-'+fmt(spent):''}${earned>0?(spent>0?' / ':'')+'+'+fmt(earned):''}</span>
      </div>
      <div class="bar-bg"><div class="bar-fill" style="width:${pct.toFixed(1)}%;background:${COLORS[i%COLORS.length]}"></div></div>
    </div>`;
  }).join('');
}

function selectMonth(m) { selectedMonth = m; renderMensal(); }

function renderConfig() {
  // user info
  el('user-info').innerHTML = userProfile
    ? `<div class="user-pill">${userProfile.picture?`<img src="${userProfile.picture}"/>`:''}
        <span>${userProfile.email || userProfile.name}</span></div>`
    : '';

  el('bank-cfg-list').innerHTML = state.banks.length
    ? state.banks.map((b, i) => `<div class="config-row">
        <div><div class="config-name">${b.name}</div><div class="config-meta">Inicial: ${fmt(b.initial)}</div></div>
        <button class="del-btn" onclick="deleteBank(${i})" style="font-size:18px">✕</button>
      </div>`).join('')
    : '<div class="empty">Nenhuma conta configurada</div>';

  el('cat-tags').innerHTML = state.categories.map((c, i) => `
    <span class="tag">${c}<button onclick="deleteCat(${i})">✕</button></span>`).join('');
}

function renderSelects() {
  el('tx-bank').innerHTML = state.banks.map(b => `<option>${b.name}</option>`).join('');
  el('tx-cat').innerHTML  = state.categories.map(c => `<option>${c}</option>`).join('');
}

function renderAll() {
  renderHome();
  renderTx();
  renderConfig();
  renderSelects();
}

// ── Actions ───────────────────────────────────────────────────────────────────
function addTx() {
  const bank = el('tx-bank').value;
  const val  = parseFloat(el('tx-val').value);
  const cat  = el('tx-cat').value;
  const type = el('tx-type').value;
  const desc = el('tx-desc').value.trim();
  const date = el('tx-date').value || today();
  if (!bank || !val || val <= 0) { toast('Preencha banco e valor', 'error'); return; }
  state.transactions.push({ bank, val, cat, type, desc, date });
  el('tx-val').value  = '';
  el('tx-desc').value = '';
  renderAll();
  scheduleSave();
  toast('Transação registrada!', 'success');
}

function deleteTx(i) {
  if (!confirm('Remover esta transação?')) return;
  state.transactions.splice(i, 1);
  renderAll();
  scheduleSave();
}

function addBank() {
  const name = el('new-bank-name').value.trim();
  const bal  = parseFloat(el('new-bank-bal').value) || 0;
  if (!name) { toast('Informe o nome do banco', 'error'); return; }
  state.banks.push({ name, initial: bal });
  el('new-bank-name').value = '';
  el('new-bank-bal').value  = '';
  renderAll();
  scheduleSave();
  toast(`${name} adicionado`, 'success');
}

function deleteBank(i) {
  if (!confirm(`Remover "${state.banks[i].name}"?`)) return;
  state.banks.splice(i, 1);
  renderAll();
  scheduleSave();
}

function addCat() {
  const c = el('new-cat-name').value.trim();
  if (!c) return;
  state.categories.push(c);
  el('new-cat-name').value = '';
  renderConfig();
  renderSelects();
  scheduleSave();
}

function deleteCat(i) {
  if (!confirm('Remover categoria?')) return;
  state.categories.splice(i, 1);
  renderConfig();
  renderSelects();
  scheduleSave();
}

// ── Toast ─────────────────────────────────────────────────────────────────────
let toastTimer;
function toast(msg, type = 'success') {
  const t = el('toast');
  t.textContent = msg;
  t.className   = 'show ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.className = '', 2500);
}

// ── Tab navigation ────────────────────────────────────────────────────────────
function switchTab(name) {
  ['home','tx','mensal','config'].forEach(k => {
    el('sec-'  + k)?.classList.remove('active');
    el('nav-'  + k)?.classList.remove('active');
  });
  el('sec-' + name)?.classList.add('active');
  el('nav-' + name)?.classList.add('active');
  if (name === 'mensal') renderMensal();
  if (name === 'tx')     renderTx();
}

// ── Init ──────────────────────────────────────────────────────────────────────
el('tx-date').value = today();

// Service Worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
