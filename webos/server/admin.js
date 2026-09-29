'use strict';
/**
 * 管理后台 API（PC 端 /admin.html 使用）。
 * 鉴权：x-admin-token 请求头（或 ?token=）。令牌来源优先级：
 *   环境变量 ADMIN_TOKEN > config.json 的 admin.token > 首次启动自动生成并写入 data/admin-token.txt。
 * 安全说明：令牌等同于管理凭据，生产环境务必自行配置强令牌并限制来源 IP（见部署指南）。
 * 路由均 auth:false（不走访客会话），由 checkAdmin 自行校验管理令牌。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { nowIso, ApiError, E } = require('./util');

const STORE_COLLECTIONS_VIEWABLE = [
  'users', 'sessions', 'intents', 'plans', 'route_versions', 'jobs',
  'trips', 'trip_events', 'feedback', 'preference_evidence', 'preferences',
  'orders', 'itineraries', 'idempotency_keys',
];

const CONTENT_SETS = ['cities', 'venues', 'narrations', 'articles'];

function ensureAdminToken(rootDir, fileCfg) {
  const envToken = process.env.ADMIN_TOKEN;
  if (envToken) return { token: envToken, source: 'env' };
  const cfgToken = fileCfg && fileCfg.token;
  if (cfgToken) return { token: String(cfgToken), source: 'config' };
  const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(rootDir, 'data');
  const tokenFile = path.join(dataDir, 'admin-token.txt');
  try {
    if (fs.existsSync(tokenFile)) {
      const t = fs.readFileSync(tokenFile, 'utf8').trim();
      if (t) return { token: t, source: 'generated-file' };
    }
  } catch (e) { /* fallthrough */ }
  const token = crypto.randomBytes(18).toString('base64url');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(tokenFile, token, 'utf8');
  } catch (e) {
    console.error('[admin] 令牌写入失败（将以本次启动临时令牌运行）:', e.message);
    return { token, source: 'ephemeral' };
  }
  return { token, source: 'generated-file' };
}

function checkAdmin(req, query, cfg) {
  const h = req.headers['x-admin-token'] || '';
  const q = query && query.token;
  const provided = (typeof h === 'string' && h) || q || '';
  if (!cfg.adminToken || provided !== cfg.adminToken) {
    throw new ApiError('ADMIN_UNAUTHORIZED', '管理令牌缺失或不正确', { status: 401 });
  }
}

/** 在 Api 的路由注册器上追加管理端路由。R(method, pattern, handler, opts) */
function registerAdminRoutes(R, api, ctx) {
  const { cfg, store, content } = ctx;
  const A = { auth: false };

  R('POST', '/v1/admin/login', async (req, _p, _q, body) => {
    const provided = String((body && body.token) || '').trim();
    if (!cfg.adminToken || provided !== cfg.adminToken) {
      throw new ApiError('ADMIN_UNAUTHORIZED', '管理令牌不正确', { status: 401 });
    }
    return { ok: true, tokenValid: true, notice: '令牌校验通过。请保管好管理令牌，勿在前台设备保存。' };
  }, A);

  R('GET', '/v1/admin/overview', async (req, _p, query) => {
    checkAdmin(req, query, cfg);
    const users = store.data.users || [];
    const sessions = store.data.sessions || [];
    const trips = store.data.trips || [];
    const plans = store.data.plans || [];
    const orders = store.data.orders || [];
    const byStatus = {};
    const byType = {};
    for (const o of orders) {
      byStatus[o.status] = (byStatus[o.status] || 0) + 1;
      byType[o.type] = (byType[o.type] || 0) + 1;
    }
    // 近 7 天行程单/行程趋势（按日期）
    const trend = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      trend.push({
        date: d,
        orders: orders.filter((o) => (o.createdAt || '').slice(0, 10) === d).length,
        trips: trips.filter((t) => (t.startedAt || '').slice(0, 10) === d).length,
      });
    }
    // 城市热度：行程单
    const cityHeat = {};
    for (const o of orders) {
      if (!o.cityId) continue;
      cityHeat[o.cityId] = (cityHeat[o.cityId] || 0) + 1;
    }
    const cityHeatList = Object.entries(cityHeat)
      .map(([cid, n]) => {
        const c = content.getCity(cid);
        return { cityId: cid, cityName: c ? c.name : cid, count: n };
      })
      .sort((a, b) => b.count - a.count).slice(0, 8);
    return {
      users: {
        total: users.length,
        guests: users.filter((u) => u.kind === 'guest').length,
        activeSessions: sessions.filter((s) => !s.revokedAt).length,
      },
      trips: {
        total: trips.length,
        active: trips.filter((t) => t.status === 'active').length,
        completed: trips.filter((t) => t.status === 'completed').length,
      },
      plans: plans.length,
      orders: { total: orders.length, byType, byStatus },
      content: content.getMeta(),
      trend, cityHeat: cityHeatList,
      generatedAt: nowIso(),
    };
  }, A);

  R('GET', '/v1/admin/content/{name}', async (req, p, query) => {
    checkAdmin(req, query, cfg);
    if (!CONTENT_SETS.includes(p.name)) throw E.badRequest('未知内容集合', { field: 'name' });
    const list = content[p.name] || [];
    return { name: p.name, total: list.length, rows: list };
  }, A);

  R('PUT', '/v1/admin/content/{name}/{cid}', async (req, p, query, body) => {
    checkAdmin(req, query, cfg);
    if (!CONTENT_SETS.includes(p.name)) throw E.badRequest('未知内容集合', { field: 'name' });
    const row = body && body.row;
    if (!row || typeof row !== 'object' || !row.id) throw E.badRequest('需要 row 对象且含 id', { field: 'row' });
    const saved = content.upsert(p.name, row);
    return { ok: true, row: saved, note: '已写回 data/content 并重载内存索引' };
  }, A);

  R('DELETE', '/v1/admin/content/{name}/{cid}', async (req, p, query) => {
    checkAdmin(req, query, cfg);
    const ok = content.remove(p.name, p.cid);
    if (!ok) throw E.notFound('条目不存在');
    return { ok: true, deleted: p.cid };
  }, A);

  R('POST', '/v1/admin/content/reload', async (req, _p, query) => {
    checkAdmin(req, query, cfg);
    content.reload();
    return { ok: true, meta: content.getMeta() };
  }, A);

  R('GET', '/v1/admin/orders', async (req, _p, query) => {
    checkAdmin(req, query, cfg);
    let list = store.data.orders || [];
    if (query.type) list = list.filter((o) => o.type === query.type);
    if (query.status) list = list.filter((o) => o.status === query.status);
    list = [...list].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
      .slice(0, Math.min(500, Number(query.limit) || 200))
      .map((o) => {
        const u = store.byId('users', o.ownerId);
        const maskedPhone = o.contact ? (o.contact.phone || '').replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2') : null;
        return { ...o, contact: o.contact ? { name: o.contact.name, phone: maskedPhone } : null, ownerKind: u ? u.kind : null };
      });
    return { orders: list, total: list.length, note: '联系人手机号已脱敏展示' };
  }, A);

  R('POST', '/v1/admin/orders/{oid}/state', async (req, p, query, body) => {
    checkAdmin(req, query, cfg);
    const order = store.byId('orders', p.oid);
    if (!order) throw E.notFound('订单不存在');
    const to = String((body && body.status) || '');
    const allowed = {
      created: ['cancelled', 'paid'],
      paid: ['cancelled', 'finished'],
      planned: ['cancelled'],
      finished: [], cancelled: [],
    };
    if (!(allowed[order.status] || []).includes(to)) {
      throw E.conflict('ORDER_STATE_CONFLICT', `不允许从 ${order.status} 转到 ${to}`, { from: order.status, to });
    }
    store.update('orders', order.id, { status: to, updatedAt: nowIso(), adminTouched: true });
    return { ok: true, order: store.byId('orders', order.id) };
  }, A);

  R('GET', '/v1/admin/users', async (req, _p, query) => {
    checkAdmin(req, query, cfg);
    const users = (store.data.users || []).slice(-500).reverse();
    return {
      users: users.map((u) => {
        const sessions = store.find('sessions', (s) => s.userId === u.id);
        return {
          id: u.id, kind: u.kind, createdAt: u.createdAt,
          sessionCount: sessions.length,
          activeSessions: sessions.filter((s) => !s.revokedAt).length,
          trips: store.find('trips', (t) => t.ownerId === u.id).length,
          orders: store.find('orders', (o) => o.ownerId === u.id).length,
        };
      }),
      note: '仅访客会话体系，无密码/手机号等敏感注册信息',
    };
  }, A);

  R('GET', '/v1/admin/data/{name}', async (req, p, query) => {
    checkAdmin(req, query, cfg);
    if (!STORE_COLLECTIONS_VIEWABLE.includes(p.name)) throw E.badRequest('该集合不可查看', { field: 'name' });
    const all = store.data[p.name] || [];
    const offset = Number(query.offset) || 0;
    const limit = Math.min(200, Number(query.limit) || 50);
    const rows = all.slice(Math.max(0, all.length - offset - limit), Math.max(0, all.length - offset)).reverse();
    return { name: p.name, total: all.length, offset, limit, rows };
  }, A);
}

module.exports = { registerAdminRoutes, ensureAdminToken, checkAdmin };
