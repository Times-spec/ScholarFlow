'use strict';
/**
 * 高德真实 Provider（Web 服务）：
 * - 周边候选检索、文本搜索、逆地理、坐标转换、步行路由。
 * - 设计约束（文档 §8.6）：直线距离仅粗筛；发布的路段必须有真实路由（步行 API 折线）；
 *   路由调用计入预算 maxRoutingCalls；请求失败的边标 unreachable，绝不用直线顶替。
 * - 与场所包同构输出（VenueGraph 接口 + pack 结构），求解/校验层零改动复用。
 */
const { haversineM } = require('./geo');
const { geometrySegmentKeys } = require('./route_constraints');

const AMAP = 'https://restapi.amap.com';

/**
 * 全局限速门：高德个人账号约 3 QPS，被限流时自动加大间隔、平稳时缓慢回落。
 * 所有高德请求都经过这里，避免并发任务把配额打爆（§17.3 成本与配额控制）。
 */
const rateGate = {
  minIntervalMs: 360,
  lastAt: 0,
  _waiting: Promise.resolve(),
  async pass() {
    const run = this._waiting.then(async () => {
      const wait = Math.max(0, this.minIntervalMs - (Date.now() - this.lastAt));
      if (wait) await new Promise((r) => setTimeout(r, wait));
      this.lastAt = Date.now();
    });
    this._waiting = run.catch(() => {});
    return run;
  },
  penalize() { this.minIntervalMs = Math.min(1600, Math.round(this.minIntervalMs * 1.6)); },
  relax() { this.minIntervalMs = Math.max(360, Math.round(this.minIntervalMs * 0.97)); },
};

/**
 * 路由矩阵配额 → 最多能覆盖几个候选。
 * n 个候选 + 起点 = n+1 个节点，两两 C(n+1,2) 对，另留约 10% 重试余量。
 *
 * 2026-09-30 修：此前是 `maxCalls = maxRoutingCalls − 8`，配上 config.json 里的 60，
 * 12 个候选（13 节点）需要 78 对却只抓得到 52 对。抓取顺序是 for i / for j>i，
 * 于是质量分最低的 5 个候选互相之间一条路都没有：插入一个点需要 prev→点 与 点→next 同时存在，
 * 所以它们永远插不进多站路线，2-opt 里涉及它们的交换也只会静默失败。
 * 最终顺序被"配额恰好覆盖了哪些点对"决定，而不是被地理决定。
 */
function maxCandidatesForQuota(maxRoutingCalls, reserveRatio = 0.1) {
  const budget = Math.max(6, Math.floor((Number(maxRoutingCalls) || 60) * (1 - reserveRatio)));
  let c = 1;
  while (((c + 1) * c) / 2 <= budget) c++;
  return Math.max(1, c - 1);
}

/** 步行路由矩阵缓存：同一场所 10 分钟内反复规划不再重抓同一批 OD（只有首次慢） */
const matrixCache = new Map();
const MATRIX_TTL_MS = 10 * 60 * 1000;
const MATRIX_CACHE_MAX = 12;
function matrixCacheGet(key) {
  if (!key) return null;
  const hit = matrixCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > MATRIX_TTL_MS) { matrixCache.delete(key); return null; }
  return hit.value;
}
function matrixCacheSet(key, value) {
  if (!key) return;
  matrixCache.set(key, { at: Date.now(), value });
  while (matrixCache.size > MATRIX_CACHE_MAX) matrixCache.delete(matrixCache.keys().next().value);
}
/** 起点按约 50m 网格取整后再进缓存键：GPS 轻微漂移不该让整张矩阵失效 */
function matrixCacheKeyOf(prefix, origin, ids) {
  const grid = 0.0005;
  return `${prefix}|${Math.round(origin.lng / grid)}|${Math.round(origin.lat / grid)}|${ids.join(',')}`;
}

async function amapGetOnce(cfg, path, params) {
  await rateGate.pass();
  const qs = new URLSearchParams({ key: cfg.amap.webServiceKey, ...params }).toString();
  const resp = await fetch(`${AMAP}${path}?${qs}`, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) { const e = new Error('amap http ' + resp.status); e.code = 'PROVIDER_RATE_LIMITED'; throw e; }
  const json = await resp.json();
  if (json.status !== '1') {
    const e = new Error('amap: ' + (json.info || 'error') + ' (' + json.infocode + ')');
    e.code = ['10021', '10003', '10044', '10019', '10020'].includes(String(json.infocode)) ? 'PROVIDER_RATE_LIMITED' : 'PROVIDER_ERROR';
    e.infocode = String(json.infocode);
    throw e;
  }
  rateGate.relax();
  return json;
}

/** §17.1：限流/超时有上限重试 + 指数退避与抖动；不补造数据 */
async function amapGet(cfg, path, params) {
  let lastErr = null;
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      return await amapGetOnce(cfg, path, params);
    } catch (e) {
      lastErr = e;
      if (e.code !== 'PROVIDER_RATE_LIMITED' || attempt === 2) throw e;
      rateGate.penalize(); // 被限流 → 后续请求整体放慢
      const backoff = 700 * Math.pow(2, attempt) + Math.floor(Math.random() * 300);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

/* ---------- 类型映射：高德 typecode → 本产品兴趣标签/停留 ---------- */
function mapType(typecode, name) {
  const tc = String(typecode || '');
  if (/^1101/.test(tc)) return { tags: ['自然'], dwellSec: 1500, scenic: 0.7 };   // 公园广场
  if (/^1102/.test(tc)) return { tags: ['自然', '人文'], dwellSec: 1200, scenic: 0.75 }; // 风景名胜
  if (/^14/.test(tc)) return { tags: ['人文', '建筑'], dwellSec: 1800, scenic: 0.6 };    // 科教文化
  if (/^05/.test(tc)) return { tags: ['美食'], dwellSec: 1500, scenic: 0.5 };            // 餐饮
  if (/^06/.test(tc)) return { tags: ['街区'], dwellSec: 900, scenic: 0.45 };            // 购物/街区
  if (/^08/.test(tc)) return { tags: ['街区'], dwellSec: 900, scenic: 0.45 };            // 体育休闲
  if (/^07/.test(tc)) return { tags: ['人文'], dwellSec: 1200, scenic: 0.55 };           // 风景名胜其他
  void name;
  return { tags: ['街区'], dwellSec: 900, scenic: 0.4 };
}

/* ---------- 周边候选（§7.4：覆盖几个不同类别，去重后评分压缩） ---------- */
async function searchAround(cfg, point, radiusM) {
  const types = ['110100', '110200', '050000', '140000', '060000', '080000']; // 公园/风景名胜/餐饮/科教文化/购物/体育休闲
  const seen = new Map();
  for (const t of types) {
    const json = await amapGet(cfg, '/v3/place/around', {
      location: `${point.lng},${point.lat}`, types: t, radius: String(Math.min(radiusM, 4000)),
      offset: '15', page: '1', extensions: 'base',
    });
    for (const p of json.pois || []) {
      if (!seen.has(p.id)) seen.set(p.id, p);
    }
  }
  return [...seen.values()].map((p) => {
    const [lng, lat] = p.location.split(',').map(Number);
    const m = mapType(p.typecode, p.name);
    return {
      id: 'am_' + p.id, name: p.name, providerPoiId: p.id,
      address: typeof p.address === 'string' ? p.address : '',
      lng, lat, type: p.type, typecode: p.typecode,
      distanceM: Number(p.distance) || Math.round(haversineM(point, { lng, lat })),
      ...m,
    };
  });
}

/* ---------- 步行路由（真实路段折线，§8.6） ---------- */
async function walkingRoute(cfg, from, to) {
  const json = await amapGet(cfg, '/v3/direction/walking', {
    origin: `${from.lng},${from.lat}`, destination: `${to.lng},${to.lat}`,
  });
  const p = json.route.paths[0];
  const coords = [];
  for (const s of p.steps || []) {
    for (const pair of String(s.polyline || '').split(';')) {
      const [lng, lat] = pair.split(',').map(Number);
      if (Number.isFinite(lng) && Number.isFinite(lat)) coords.push([lng, lat]);
    }
  }
  return { distanceM: Number(p.distance), durationSec: Number(p.duration), geometry: coords, provider: 'amap-walking' };
}

/* ---------- 文本搜索 / 逆地理 / 坐标转换 ---------- */
async function textSearch(cfg, q, city) {
  const json = await amapGet(cfg, '/v3/place/text', {
    keywords: q, city: city || '', citylimit: city ? 'true' : 'false', offset: '10', page: '1', extensions: 'base',
  });
  return (json.pois || []).map((p) => {
    const [lng, lat] = String(p.location || ',').split(',').map(Number);
    return {
      kind: 'poi', id: 'am_' + p.id, providerPoiId: p.id, name: p.name,
      city: (p.cityname || '') + '', address: typeof p.address === 'string' ? p.address : '',
      disambiguation: `${p.cityname || ''} ${p.adname || ''}`.trim(),
      coord: Number.isFinite(lng) ? { lng, lat, crs: 'GCJ02' } : null,
      status: 'unknown', tags: mapType(p.typecode).tags, provider: 'amap', demo: false,
    };
  }).filter((x) => x.coord);
}

async function regeo(cfg, point) {
  const json = await amapGet(cfg, '/v3/geocode/regeo', {
    location: `${point.lng},${point.lat}`, radius: '300', extensions: 'base',
  });
  const r = json.regeocode || {};
  const a = r.addressComponent || {};
  const label = r.formatted_address && typeof r.formatted_address === 'string'
    ? r.formatted_address
    : `${a.province || ''}${a.city || ''}${a.district || ''}${a.township || ''}`;
  return { ok: true, label: label || '所选位置', provider: 'amap', demo: false };
}

async function convertCoord(cfg, lng, lat) {
  const json = await amapGet(cfg, '/v3/assistant/coordinate/convert', {
    locations: `${lng},${lat}`, coordsys: 'gps',
  });
  const [glng, glat] = String(json.locations).split(',').map(Number);
  return { lng: glng, lat: glat };
}

/* ---------- 真实闲逛区域：与 VenueGraph/pack 同构的适配器 ---------- */
class AmapAreaGraph {
  constructor(cfg, origin, budgetSec) {
    this.cfg = cfg;
    this.origin = origin; // {lng,lat,crs:'GCJ02'}
    this.budgetSec = budgetSec;
    this.nodes = new Map();
    this._routeCache = new Map();
    this._edgeSeq = 0;
    this._edges = new Map();
    this.routingCalls = 0;
  }
  get nodeById() { return this.nodes; }
  get edgeById() { return this._edges; }

  async init(cands, opts = {}) {
    this.nodes.set('am_origin', {
      id: 'am_origin', name: this.origin.label || '起点', type: 'entrance',
      lng: this.origin.lng, lat: this.origin.lat, status: 'open',
    });
    for (const c of cands) {
      this.nodes.set(c.id, { id: c.id, name: c.name, type: 'poi', lng: c.lng, lat: c.lat, status: 'open' });
    }
    const ids = ['am_origin', ...cands.map((c) => c.id)];

    // 命中缓存：矩阵直接复原，一次网络请求都不发（同一场所反复规划只有首次慢）
    const cached = matrixCacheGet(opts.cacheKey);
    if (cached && cached.ids === ids.join('|')) {
      this._restoreMatrix(cached, ids);
      this._dropUnreachable(cands);
      return;
    }

    // 预取路由矩阵（起点 + 候选），受配额约束；全局限速门已保证 QPS。
    // 配额按"尝试次数"计：失败的请求同样占配额，否则被限流时会一直重试拖垮任务。
    const maxCalls = Math.max(6, this.cfg.limits.maxRoutingCalls || 60);
    let attempts = 0;
    const fetchPair = async (i, j) => {
      if (attempts >= maxCalls) return false;
      attempts++;
      const a = this.nodes.get(ids[i]), b = this.nodes.get(ids[j]);
      try {
        const r = await walkingRoute(this.cfg, a, b);
        this.routingCalls++;
        const eid = 'ame_' + (++this._edgeSeq);
        const physicalSegmentKeys = geometrySegmentKeys(r.geometry);
        this._edges.set(eid, { id: eid, from: ids[i], to: ids[j], lengthM: r.distanceM, walkAllowed: true, stepsKnown: false, steps: null, physicalSegmentKeys });
        this._storePair(ids[i], ids[j], eid, r.distanceM, r.geometry, physicalSegmentKeys, true);
        return true;
      } catch (e) {
        this._storePair(ids[i], ids[j], null, null, [], [], false, e.message);
        return false;
      }
    };
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        if (attempts >= maxCalls) break;
        await fetchPair(i, j);
      }
      if (attempts >= maxCalls) break;
    }
    // 二次重试：起点↔候选的边必须拿到真实路由，否则候选会被误判不可达。
    // （此前这里是 `calls < maxCalls`，而 calls 早已等于上限，重试一次都没跑过。）
    for (let j = 1; j < ids.length && attempts < maxCalls; j++) {
      const cur = this._routeCache.get(ids[0] + '>' + ids[j]);
      if (!cur || cur.status !== 'ok') await fetchPair(0, j);
    }
    this._dropUnreachable(cands);
    matrixCacheSet(opts.cacheKey, this._snapshot(ids));
  }

  /** 写入一对 OD 的正反两条缓存（无向：正反共用距离，折线反向） */
  _storePair(a, b, eid, distanceM, geometry, physicalSegmentKeys, ok, error) {
    if (!ok) {
      const miss = { status: 'unreachable', distanceM: null, nodeIds: [], edgeIds: [], geometry: [], error: error || 'amap route failed' };
      this._routeCache.set(a + '>' + b, miss);
      this._routeCache.set(b + '>' + a, miss);
      return;
    }
    const base = { status: 'ok', distanceM, nodeIds: [a, b], edgeIds: [eid], geometry, physicalSegmentKeys, repeatDetection: 'geometry-grid-approx', provider: 'amap-walking' };
    this._routeCache.set(a + '>' + b, base);
    this._routeCache.set(b + '>' + a, { ...base, nodeIds: [b, a], geometry: [...geometry].reverse() });
  }

  /** 仍不可达的点位剔除（诚实：无真实路由就不参与规划） */
  _dropUnreachable(cands) {
    for (const c of cands) {
      const r = this._routeCache.get('am_origin>' + c.id);
      if (!r || r.status !== 'ok') this.nodes.delete(c.id);
    }
  }

  _snapshot(ids) {
    const legs = [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const r = this._routeCache.get(ids[i] + '>' + ids[j]);
        if (!r) continue;
        legs.push({
          i, j, ok: r.status === 'ok', eid: (r.edgeIds && r.edgeIds[0]) || null,
          distanceM: r.distanceM, geometry: r.geometry, physicalSegmentKeys: r.physicalSegmentKeys || null,
        });
      }
    }
    return { ids: ids.join('|'), edgeSeq: this._edgeSeq, legs };
  }

  _restoreMatrix(snap, ids) {
    this._edgeSeq = snap.edgeSeq || 0;
    for (const L of snap.legs) {
      if (!ids[L.i] || !ids[L.j]) continue;
      if (L.ok && L.eid) {
        this._edges.set(L.eid, { id: L.eid, from: ids[L.i], to: ids[L.j], lengthM: L.distanceM, walkAllowed: true, stepsKnown: false, steps: null, physicalSegmentKeys: L.physicalSegmentKeys });
        this._storePair(ids[L.i], ids[L.j], L.eid, L.distanceM, L.geometry, L.physicalSegmentKeys, true);
      } else {
        this._storePair(ids[L.i], ids[L.j], null, null, [], [], false);
      }
    }
  }

  route(fromId, toId, opts = {}) {
    if (fromId === toId) {
      const n = this.nodes.get(fromId);
      return { status: 'ok', distanceM: 0, nodeIds: [fromId], edgeIds: [], geometry: n ? [[n.lng, n.lat]] : [] };
    }
    const hit = this._routeCache.get(fromId + '>' + toId);
    if (hit) {
      const forbidden = opts.forbiddenEdgeIds;
      if (forbidden && (hit.edgeIds || []).some((eid) => forbidden.has(eid))) {
        return { status: 'constraint_violation', code: 'REPEATED_EDGE', distanceM: null, nodeIds: [], edgeIds: hit.edgeIds, geometry: [] };
      }
      return hit;
    }
    return { status: 'unreachable', distanceM: null, nodeIds: [], edgeIds: [], geometry: [] }; // 无真实路由的边不伪造
  }
  nearestNode(point, types) {
    let best = null, bestD = Infinity;
    for (const n of this.nodes.values()) {
      if (types && !types.includes(n.type)) continue;
      const d = haversineM(point, n) * 1.3; // 直线粗筛系数，仅用于粗筛
      if (d < bestD) { bestD = d; best = n; }
    }
    return best ? { node: best, distanceM: Math.round(bestD) } : null;
  }
}

/** 构建真实闲逛"场所包"（结构同演示包，数据来源标注为高德实时查询） */
async function buildAmapAreaPack(cfg, origin, budgetSec) {
  const radiusM = Math.min(4000, Math.max(1200, Math.round((budgetSec / 3600) * 2500)));
  const rawCands = await searchAround(cfg, origin, radiusM);
  // 粗筛：按类型分桶保证多样性，每桶取最近 4 个，再按预算取前 8~12 进精算（§7.4 评分压缩）。
  // 候选数同时受路由矩阵配额约束：配额必须够抓满"起点 + 候选"的两两组合，
  // 否则末尾的候选拿不到任何 OD 边、永远排不进多站路线（2026-09-30 修）。
  const buckets = new Map();
  for (const c of rawCands.sort((a, b) => a.distanceM - b.distanceM)) {
    const key = c.tags[0];
    if (!buckets.has(key)) buckets.set(key, []);
    if (buckets.get(key).length < 4) buckets.get(key).push(c);
  }
  const capByBudget = budgetSec >= 10800 ? 12 : 8; // 3 小时以上放宽池子，半天不该只有五六个可选点
  const cap = Math.min(capByBudget, maxCandidatesForQuota(cfg.limits.maxRoutingCalls));
  const cands = [...buckets.values()].flat()
    .sort((a, b) => b.scenic - a.scenic || a.distanceM - b.distanceM)
    .slice(0, cap);
  const graph = new AmapAreaGraph(cfg, origin, budgetSec);
  await graph.init(cands, { cacheKey: matrixCacheKeyOf('area', origin, cands.map((c) => c.id)) });
  const usable = cands.filter((c) => graph.nodes.has(c.id));
  const pack = {
    venue: {
      id: 'area_amap', name: '周边片区（高德实时数据）', nameNote: '候选点与路段来自高德 Web 服务实时查询',
      city: '', timezone: 'Asia/Shanghai', packVersion: 'amap-live-' + new Date().toISOString().slice(0, 10),
      coverageScope: { kind: 'poi', scopeLabel: `周边 ${radiusM}m 内检索到的 ${usable.length} 个候选点` },
      center: { lng: origin.lng, lat: origin.lat, crs: 'GCJ02' },
      entrances: ['am_origin'], openWindows: [['00:00', '24:00']],
    },
    nodes: [...graph.nodes.values()],
    edges: [...graph._edges.values()].map((e) => ({ ...e, bikeAllowed: false, closed: false, evidenceIds: ['ev_amap_live'] })),
    pois: usable.map((c) => ({
      id: c.id, name: c.name, entranceNode: c.id,
      tags: c.tags, indoor: c.tags.includes('美食') || c.tags.includes('人文'),
      scenic: c.scenic, dwellMinSec: 600, dwellSec: c.dwellSec,
      openWindows: null, // 开放时间未核验 → 校验层标 unknown，绝不假装已知（§7.1）
      ticketCny: null, ticketKnown: false, costNote: '门票/消费未核验',
      reservation: 'unknown', hoursEvidenceIds: ['ev_amap_live'],
      providerPoiId: c.providerPoiId, address: c.address,
      guide: null, // 真实内容需资料检索管线（未配置 LLM 时不虚构，§11.2）
    })),
    evidence: [{
      id: 'ev_amap_live', sourceTitle: '高德地图 Web 服务实时查询', sourceUrl: 'https://restapi.amap.com',
      retrievedAt: new Date().toISOString(), effectiveFrom: null, expiresAt: null,
      license: '高德平台数据（按许可展示，不持久化）', reviewStatus: 'provider',
    }],
    _poiById: new Map(),
    _nodeById: graph.nodes,
    _evById: new Map(),
  };
  pack._poiById = new Map(pack.pois.map((p) => [p.id, p]));
  pack._evById = new Map(pack.evidence.map((e) => [e.id, e]));
  return { pack, graph };
}

module.exports = { searchAround, walkingRoute, textSearch, regeo, convertCoord, buildAmapAreaPack, AmapAreaGraph, amapGet, mapType, maxCandidatesForQuota, matrixCacheKeyOf };
