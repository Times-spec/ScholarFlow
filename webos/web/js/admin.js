// 随行 · 管理后台 SPA（无构建步骤，原生 ES Module）
const TOKEN_KEY = 'st_admin_token';
const $ = (sel) => document.querySelector(sel);

function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
function setToken(t) { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); }

let toastTimer = null;
function toast(msg, ms = 2400) {
  const t = $('#admin-toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

async function api(method, path, body) {
  const opts = { method, headers: { 'x-admin-token': getToken() } };
  if (body !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401 && path !== '/v1/admin/login') { showLogin('登录已失效，请重新输入令牌'); }
    const e = new Error(j.message || ('请求失败 ' + r.status));
    e.code = j.code;
    throw e;
  }
  return j;
}

/* ==================== 登录 ==================== */
function showLogin(errText) {
  $('#login-view').classList.remove('hidden');
  $('#main-view').classList.add('hidden');
  if (errText) { const e = $('#login-err'); e.textContent = errText; e.classList.remove('hidden'); }
}

async function tryLogin(token) {
  const r = await fetch('/v1/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || '登录失败');
  setToken(token);
  $('#login-view').classList.add('hidden');
  $('#main-view').classList.remove('hidden');
  switchTab('overview');
}

$('#login-btn').addEventListener('click', async () => {
  try { await tryLogin($('#token-input').value.trim()); }
  catch (e) { const el = $('#login-err'); el.textContent = e.message; el.classList.remove('hidden'); }
});
$('#token-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#login-btn').click(); });
$('#logout-btn').addEventListener('click', () => { setToken(''); showLogin(); });

/* ==================== Tab 框架 ==================== */
const tabs = { overview: renderOverview, content: renderContent, orders: renderOrders, users: renderUsers, data: renderData };
function switchTab(name) {
  document.querySelectorAll('.side-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  const view = $('#main-view');
  view.innerHTML = '';
  tabs[name](view).catch((e) => { view.innerHTML = ''; view.append(el('div', { class: 'panel empty' }, '加载失败：' + e.message)); });
}
document.querySelectorAll('.side-btn').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    e.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return e;
}
function fmtJson(v) { return JSON.stringify(v); }
function statusTag(s) {
  const cls = { paid: 'g', finished: 'g', created: 'w', planned: 'b', cancelled: 'd', active: 'w', completed: 'g' }[s] || '';
  return el('span', { class: 'tag ' + cls }, s);
}

/* ==================== 数据看板 ==================== */
async function renderOverview(view) {
  view.append(el('h2', { class: 'tab-title' }, '数据看板'));
  view.append(el('p', { class: 'tab-sub' }, '平台运行与业务总览（实时计算）'));
  const o = await api('GET', '/v1/admin/overview');

  view.append(el('div', { class: 'stat-grid' },
    statCard(o.users.total, '用户（访客）', `${o.users.activeSessions} 个活跃会话`),
    statCard(o.trips.total, '游览行程', `${o.trips.active} 进行中 / ${o.trips.completed} 已完成`),
    statCard(o.orders.total, '行程单', `保存的多日行程 ${o.orders.byType.itinerary || 0} 份`),
    statCard(o.content.counts.venues, '内容库场所', `${o.content.counts.cities} 城 · ${o.content.counts.narrations} 条讲解`),
  ));

  view.append(el('div', { class: 'panel-row' },
    el('div', { class: 'panel' }, el('h3', {}, '近 7 天趋势'), chartCanvas(o.trend, 'trend')),
    el('div', { class: 'panel' }, el('h3', {}, '城市热度（订单数）'), cityHeatBars(o.cityHeat)),
  ));

  view.append(el('div', { class: 'panel' },
    el('h3', {}, '订单构成'),
    el('div', {}, '按类型：', ...Object.entries(o.orders.byType).map(([k, v]) => el('span', { class: 'tag b', style: 'margin-right:6px' }, `${typeTxt(k)} ${v}`)), Object.keys(o.orders.byType).length ? null : el('span', { class: 'muted' }, '暂无')),
    el('div', { style: 'margin-top:8px' }, '按状态：',
      ...Object.entries(o.orders.byStatus).map(([k, v]) => el('span', { class: 'tag', style: 'margin-right:6px' }, `${k} ${v}`)),
      Object.keys(o.orders.byStatus).length ? null : el('span', { class: 'muted' }, '暂无')),
    el('div', { class: 'tab-sub', style: 'margin-top:10px' }, `内容库加载于 ${o.content.loadedAt} · 状态 ${o.content.reviewStatus}`),
  ));
}
function statCard(num, label, sub) {
  return el('div', { class: 'stat-card' }, el('div', { class: 'stat-num' }, String(num)), el('div', { class: 'stat-label' }, label), el('div', { class: 'stat-sub' }, sub || ''));
}
function typeTxt(t) { return t === 'itinerary' ? '行程单' : t; }

function chartCanvas(trend, kind) {
  const c = el('canvas', { width: 520, height: 220 });
  requestAnimationFrame(() => drawTrend(c, trend));
  return el('div', {},
    c,
    el('div', { class: 'legend' },
      el('span', {}, el('i', { class: 'dot', style: 'background:#0f6f4f' }), '订单'),
      el('span', {}, el('i', { class: 'dot', style: 'background:#e8a13c' }), '行程')));
}
function drawTrend(canvas, trend) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height, pad = 30;
  ctx.clearRect(0, 0, W, H);
  const maxV = Math.max(1, ...trend.map((t) => Math.max(t.orders, t.trips)));
  const stepX = (W - pad * 2) / Math.max(1, trend.length - 1);
  // 网格
  ctx.strokeStyle = '#e5eeea'; ctx.fillStyle = '#8a9a92'; ctx.font = '11px sans-serif';
  for (let g = 0; g <= 3; g++) {
    const y = pad + (H - pad * 2) * g / 3;
    ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(W - pad, y); ctx.stroke();
    ctx.fillText(String(Math.round(maxV * (1 - g / 3))), 4, y + 4);
  }
  const line = (key, color) => {
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
    trend.forEach((t, i) => {
      const x = pad + stepX * i, y = H - pad - (H - pad * 2) * (t[key] / maxV);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
    ctx.fillStyle = color;
    trend.forEach((t, i) => {
      const x = pad + stepX * i, y = H - pad - (H - pad * 2) * (t[key] / maxV);
      ctx.beginPath(); ctx.arc(x, y, 3, 0, 7); ctx.fill();
    });
  };
  line('orders', '#0f6f4f');
  line('trips', '#e8a13c');
  ctx.fillStyle = '#8a9a92';
  trend.forEach((t, i) => ctx.fillText(t.date.slice(5), pad + stepX * i - 12, H - 8));
}
function cityHeatBars(list) {
  if (!list.length) return el('div', { class: 'empty' }, '暂无订单数据');
  const max = Math.max(...list.map((x) => x.count));
  return el('div', {}, ...list.map((x) => el('div', { style: 'display:flex;align-items:center;gap:10px;margin:6px 0' },
    el('span', { style: 'width:56px;flex:none;font-size:13px' }, x.cityName),
    el('div', { style: 'flex:1;height:14px;background:#eef3f0;border-radius:7px;overflow:hidden' },
      el('div', { style: `width:${Math.round(x.count / max * 100)}%;height:100%;background:linear-gradient(90deg,#0f6f4f,#3aa07a)` })),
    el('span', { style: 'width:30px;text-align:right;font-size:12px;color:var(--ink-2)' }, String(x.count)))));
}

/* ==================== 内容管理 ==================== */
const CONTENT_SETS = [
  ['cities', '城市'], ['venues', '场所'], ['narrations', '讲解'], ['articles', '攻略'],
];
let curContentSet = 'venues';

async function renderContent(view) {
  view.append(el('h2', { class: 'tab-title' }, '内容管理'));
  view.append(el('p', { class: 'tab-sub' }, '目的地/讲解/攻略的增删改；保存会写回 data/content/*.json 并重载内存索引'));
  const tabsBar = el('div', { class: 'content-tabs' },
    ...CONTENT_SETS.map(([k, label]) => el('button', {
      class: k === curContentSet ? 'active' : '',
      onclick: (e) => { curContentSet = k; tabsBar.querySelectorAll('button').forEach((b) => b.classList.remove('active')); e.target.classList.add('active'); loadList(); },
    }, label + '')));
  view.append(tabsBar);
  const toolbar = el('div', { class: 'toolbar' },
    el('input', { class: 'input', placeholder: '按 id / 名称过滤…', oninput: () => loadList() }),
    el('button', { class: 'btn btn-ghost btn-sm', onclick: async () => { await api('POST', '/v1/admin/content/reload'); toast('内容库已重载'); loadList(); } }, '重载'),
    el('button', { class: 'btn btn-primary btn-sm', onclick: () => editRow(null) }, '＋ 新增'));
  view.append(toolbar);
  const listBox = el('div', {});
  view.append(listBox);

  async function loadList() {
    listBox.innerHTML = '';
    listBox.append(el('div', { class: 'empty' }, '加载中…'));
    const r = await api('GET', `/v1/admin/content/${curContentSet}`);
    const q = toolbar.querySelector('input').value.trim();
    let rows = r.rows;
    if (q) rows = rows.filter((x) => JSON.stringify(x).includes(q));
    listBox.innerHTML = '';
    listBox.append(el('div', { class: 'tab-sub' }, `共 ${r.total} 条，显示 ${rows.length} 条`));
    const showCols = { cities: ['id', 'name', 'slogan'], venues: ['id', 'cityId', 'name', 'kind', 'level', 'rating'], narrations: ['id', 'venueId', 'poiName', 'kind'], articles: ['id', 'cityId', 'title', 'readMin'] }[curContentSet] || ['id', 'name'];
    const table = el('table', { class: 'table' },
      el('thead', {}, el('tr', {}, ...showCols.map((c) => el('th', {}, c)), el('th', {}, '操作'))),
      el('tbody', {}, ...rows.map((row) => el('tr', {},
        ...showCols.map((c) => el('td', { class: typeof row[c] === 'number' ? 'mono' : '' }, fmtCell(row[c]))),
        el('td', {},
          el('button', { class: 'btn btn-ghost btn-sm', onclick: () => editRow(row) }, '编辑'),
          ' ',
          el('button', { class: 'btn btn-danger btn-sm', onclick: async () => {
            if (!confirm(`确认删除 ${row.id}？（将写回内容文件）`)) return;
            try { await api('DELETE', `/v1/admin/content/${curContentSet}/${row.id}`); toast('已删除'); loadList(); } catch (e) { toast(e.message); }
          } }, '删除'))))));
    listBox.append(table);
  }
  function fmtCell(v) {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'object') return fmtJson(v).slice(0, 60) + '…';
    return String(v).slice(0, 60);
  }
  function editRow(row) {
    const isNew = !row;
    const body = el('div', {},
      el('h3', {}, (isNew ? '新增' : '编辑') + ' · ' + curContentSet),
      el('p', { class: 'muted' }, '以 JSON 编辑整行（含全部字段）。id 不可重复；保存即写回内容文件。'),
      el('textarea', { class: 'input', id: 'row-json', spellcheck: 'false' }),
      el('div', { style: 'margin-top:12px;display:flex;gap:8px' },
        el('button', { class: 'btn btn-primary', onclick: async () => {
          let parsed;
          try { parsed = JSON.parse($('#row-json').value); } catch (e) { toast('JSON 解析失败：' + e.message, 3200); return; }
          if (!parsed.id) { toast('缺少 id 字段'); return; }
          try {
            await api('PUT', `/v1/admin/content/${curContentSet}/${parsed.id}`, { row: parsed });
            closeModal(); toast('已保存并重载'); loadList();
          } catch (e) { toast(e.message, 3200); }
        } }, '保存'),
        el('button', { class: 'btn btn-ghost', onclick: closeModal }, '取消')));
    openModal(body);
    $('#row-json').value = JSON.stringify(isNew ? { id: curContentSet === 'cities' ? 'new_city' : curContentSet === 'venues' ? 'v_new_venue' : curContentSet === 'narrations' ? 'n_new' : curContentSet === 'articles' ? 'a_new' : 'g_new' } : row, null, 2);
  }
  loadList();
}

/* ==================== 订单管理 ==================== */
async function renderOrders(view) {
  view.append(el('h2', { class: 'tab-title' }, '订单管理'));
  view.append(el('p', { class: 'tab-sub' }, '全部订单；手机号脱敏展示。状态流转由状态机约束（不可跳级）'));
  const filter = el('select', { class: 'input', style: 'width:180px', onchange: () => load() },
    el('option', { value: '' }, '全部状态'),
    ...['created', 'paid', 'finished', 'cancelled', 'planned'].map((s) => el('option', { value: s }, s)));
  view.append(el('div', { class: 'toolbar' }, filter));
  const listBox = el('div', {});
  view.append(listBox);

  async function load() {
    listBox.innerHTML = '';
    const r = await api('GET', '/v1/admin/orders' + (filter.value ? '?status=' + filter.value : ''));
    listBox.innerHTML = '';
    if (!r.orders.length) { listBox.append(el('div', { class: 'empty' }, '暂无订单')); return; }
    listBox.append(el('table', { class: 'table' },
      el('thead', {}, el('tr', {}, el('th', {}, '订单号'), el('th', {}, '类型'), el('th', {}, '内容'), el('th', {}, '联系人'), el('th', {}, '金额'), el('th', {}, '状态'), el('th', {}, '操作'))),
      el('tbody', {}, ...r.orders.map((o) => el('tr', {},
        el('td', { class: 'mono' }, o.id),
        el('td', {}, typeTxt(o.type)),
        el('td', {}, orderDesc(o)),
        el('td', {}, o.contact ? `${o.contact.name} ${o.contact.phone}` : '—'),
        el('td', { class: 'mono' }, o.amountCny != null ? '¥' + o.amountCny : '—'),
        el('td', {}, statusTag(o.status)),
        el('td', {}, ...orderActions(o)))))));
  }
  function orderDesc(o) {
    return `${o.title}（${o.days} 天）`;
  }
  function orderActions(o) {
    const btns = [];
    const nextMap = { created: [['paid', '标记已支付'], ['cancelled', '取消']], paid: [['finished', '完成服务'], ['cancelled', '取消退款']], planned: [['cancelled', '取消']] };
    for (const [to, label] of (nextMap[o.status] || [])) {
      btns.push(el('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
        try { await api('POST', `/v1/admin/orders/${o.id}/state`, { status: to }); toast('已更新为 ' + to); load(); } catch (e) { toast(e.message, 3000); }
      } }, label));
    }
    return btns.length ? btns : [el('span', { class: 'muted' }, '—')];
  }
  await load();
}

/* ==================== 用户会话 ==================== */
async function renderUsers(view) {
  view.append(el('h2', { class: 'tab-title' }, '用户与会话'));
  view.append(el('p', { class: 'tab-sub' }, '访客会话体系（无注册密码/手机号等敏感注册信息）'));
  const r = await api('GET', '/v1/admin/users');
  view.append(el('div', { class: 'panel' },
    el('table', { class: 'table' },
      el('thead', {}, el('tr', {}, el('th', {}, '用户 ID'), el('th', {}, '类型'), el('th', {}, '创建时间'), el('th', {}, '会话数'), el('th', {}, '活跃会话'), el('th', {}, '行程'), el('th', {}, '订单'))),
      el('tbody', {}, ...r.users.map((u) => el('tr', {},
        el('td', { class: 'mono' }, u.id),
        el('td', {}, el('span', { class: 'tag b' }, u.kind)),
        el('td', { class: 'mono' }, (u.createdAt || '').slice(0, 19).replace('T', ' ')),
        el('td', { class: 'mono' }, String(u.sessionCount)),
        el('td', { class: 'mono' }, String(u.activeSessions)),
        el('td', { class: 'mono' }, String(u.trips)),
        el('td', { class: 'mono' }, String(u.orders))))))));
}

/* ==================== 数据运维 ==================== */
const DATA_SETS = ['users', 'sessions', 'intents', 'plans', 'route_versions', 'jobs', 'trips', 'trip_events', 'feedback', 'preference_evidence', 'preferences', 'orders', 'itineraries', 'idempotency_keys'];
let curDataSet = 'orders';

async function renderData(view) {
  view.append(el('h2', { class: 'tab-title' }, '数据运维'));
  view.append(el('p', { class: 'tab-sub' }, '浏览运行时 JSON 库（data/db.json）各集合的最新数据；只读'));
  const setSel = el('select', { class: 'input', style: 'width:220px', onchange: (e) => { curDataSet = e.target.value; load(); } },
    ...DATA_SETS.map((s) => el('option', { value: s, selected: s === curDataSet }, s)));
  view.append(el('div', { class: 'toolbar' }, setSel));
  const listBox = el('div', {});
  view.append(listBox);

  async function load() {
    listBox.innerHTML = '';
    listBox.append(el('div', { class: 'empty' }, '加载中…'));
    const r = await api('GET', `/v1/admin/data/${curDataSet}?limit=50`);
    listBox.innerHTML = '';
    listBox.append(el('div', { class: 'tab-sub' }, `共 ${r.total} 条（显示最新 ${r.rows.length} 条）`));
    if (!r.rows.length) { listBox.append(el('div', { class: 'empty' }, '集合为空')); return; }
    listBox.append(...r.rows.map((row) => el('div', { class: 'panel', style: 'padding:12px 14px;margin-bottom:10px' },
      el('div', { style: 'display:flex;justify-content:space-between;margin-bottom:6px' },
        el('span', { class: 'mono' }, row.id || row.eventId || row.key || '—'),
        el('span', { class: 'mono muted' }, (row.createdAt || row.occurredAt || row.startedAt || '').slice(0, 19).replace('T', ' '))),
      el('pre', { class: 'mono', style: 'margin:0;white-space:pre-wrap;word-break:break-all;font-size:11px;color:var(--ink-2);max-height:180px;overflow:auto' }, JSON.stringify(row, null, 1)))));
  }
  await load();
}

/* ==================== 弹层 ==================== */
function openModal(bodyEl) {
  $('#modal-body').innerHTML = '';
  $('#modal-body').append(bodyEl);
  $('#modal').classList.remove('hidden');
}
function closeModal() { $('#modal').classList.add('hidden'); }
document.querySelector('.modal-mask').addEventListener('click', closeModal);

/* ==================== 启动 ==================== */
if (getToken()) {
  tryLogin(getToken()).catch(() => showLogin());
} else {
  showLogin();
}
