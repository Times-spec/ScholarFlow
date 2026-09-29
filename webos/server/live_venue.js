'use strict';
/**
 * 真实场所（公园/景区/校园）数据构建 —— 让"逛这里"完全由真实数据驱动。
 *
 * 数据来源与诚实边界（文档 §2.1/§7.1）：
 * - 场内点位来自高德周边检索（110209 景区打卡点、1102xx 风景名胜、1412xx 文化/学校、0500xx 餐饮）；
 * - 覆盖分母明确写为"高德检索到的 N 个点位（非园区完整清单）"，不谎称逛完全园；
 * - 开放时间/门票高德不提供 → 标记 unknown，方案标为条件性；
 * - 路段一律走高德步行路径规划（真实折线），没有真实路由的边标 unreachable，绝不用直线顶替。
 */
const { AmapAreaGraph, amapGet, mapType, textSearch, maxCandidatesForQuota, matrixCacheKeyOf } = require('./amap');
const { haversineM } = require('./geo');

const VENUE_TYPECODES = ['110101', '110102', '110103', '110105', '110200', '110202', '141201', '141200'];
const INNER_TYPECODES = ['110209', '110200', '110202', '110204', '110205', '141201', '141203', '141204', '050000', '060000'];

const cache = new Map(); // key -> { at, value }（10 分钟，降低重复检索与配额消耗）

function cacheGet(key, ttlMs = 10 * 60 * 1000) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  return null;
}
function cacheSet(key, value) { cache.set(key, { at: Date.now(), value }); return value; }

/** 搜索真实场所（公园/景区/校园），带城市消歧 */
async function searchVenues(cfg, q, city) {
  if (!q || !q.trim()) return [];
  // 不传 types（带 types 会改变关键词匹配行为），改为结果侧按类型码白名单过滤
  const json = await amapGet(cfg, '/v3/place/text', {
    keywords: q.trim(), city: city || '', citylimit: city ? 'true' : 'false',
    offset: '20', page: '1', extensions: 'base',
  });
  // 场所类型白名单：按完整类型码前缀匹配（110209 景点打卡点等场内点位不算"场所"）
  const allow = (tc) => VENUE_TYPECODES.some((p) => String(tc || '').startsWith(p));
  const mapped = (json.pois || []).map((p) => {
    const [lng, lat] = String(p.location || ',').split(',').map(Number);
    return {
      kind: 'venue', id: 'live:' + p.id, providerPoiId: p.id,
      name: p.name, city: p.cityname || '', district: p.adname || '',
      typecode: p.typecode,
      address: typeof p.address === 'string' ? p.address : '',
      disambiguation: [p.cityname, p.adname, typeof p.address === 'string' ? p.address : ''].filter(Boolean).join(' · '),
      coord: { lng, lat, crs: 'GCJ02' },
      provider: 'amap', live: true, demo: false,
    };
  }).filter((x) => Number.isFinite(x.coord.lng) && allow(x.typecode));
  // 名称完全包含关键词的排前面（"人民公园"优先于"人民公园地铁站"这类同名前缀）
  const kw = q.trim();
  mapped.sort((a, b) => {
    const sa = a.name === kw ? 0 : a.name.startsWith(kw) ? 1 : a.name.includes(kw) ? 2 : 3;
    const sb = b.name === kw ? 0 : b.name.startsWith(kw) ? 1 : b.name.includes(kw) ? 2 : 3;
    return sa - sb;
  });
  return mapped;
}

/** 解析场所并拉取场内点位（1~2 次检索调用，结果缓存） */
async function resolveVenue(cfg, venueRef) {
  // venueRef: {id:'live:<amapPoiId>', name, lng, lat | coord:{lng,lat}, city}
  const key = 'venue:' + venueRef.id;
  const cached = cacheGet(key);
  if (cached) return cached;

  let pois = [];
  const center = venueRef.coord
    || (Number.isFinite(venueRef.lng) && Number.isFinite(venueRef.lat) ? { lng: venueRef.lng, lat: venueRef.lat } : null)
    || venueRef.center
    || null;
  if (!center) throw Object.assign(new Error('缺少场所坐标，无法检索场内点位'), { code: 'VENUE_DATA_INSUFFICIENT' });

  const json = await amapGet(cfg, '/v3/place/around', {
    location: `${center.lng},${center.lat}`,
    types: INNER_TYPECODES.join('|'),
    radius: '700', offset: '25', page: '1', extensions: 'base',
  });
  for (const p of json.pois || []) {
    if (p.id === venueRef.providerPoiId) continue; // 场所本身不作为游览点
    const [lng, lat] = String(p.location || ',').split(',').map(Number);
    if (!Number.isFinite(lng)) continue;
    const dist = haversineM(center, { lng, lat });
    if (dist < 25) continue; // 与场所中心重合的噪声
    const m = mapType(p.typecode, p.name);
    const isEntrance = /门$|大门|入口|正门|东门|南门|西门|北门/.test(p.name);
    pois.push({
      id: 'lv_' + p.id, providerPoiId: p.id, name: p.name,
      lng, lat, distanceM: Math.round(Number(p.distance) || dist),
      typecode: p.typecode, address: typeof p.address === 'string' ? p.address : '',
      isEntrance, ...m,
      // 名称已含场所前缀的（"人民公园-xxx"）截短显示
      shortName: p.name.includes('-') ? p.name.split('-').slice(1).join('-') || p.name : p.name,
    });
  }

  // 分桶保多样性（打卡点/文化/餐饮/其他各取最近若干），再取前 10 进精算
  const bucket = (x) => {
    const tc = String(x.typecode || '');
    if (/^110209/.test(tc)) return 'spot';
    if (/^05/.test(tc)) return 'food';
    if (/^14/.test(tc)) return 'culture';
    if (/^06/.test(tc)) return 'shop';
    return 'other';
  };
  // 点位质量评分：① 名称含场所名（说明确在园内）② 名称像常设景点 ③ 负向：季节性装置/摆件
  const nameBonus = (name) => {
    let s = 0;
    if (/茶社|茶馆|码头|亭|桥|碑|塔|楼|阁|祠|寺|馆|堂|园|广场|纪念|遗址|故居|湖|池|山|林|平台|长廊|拱门|照壁/.test(name)) s += 0.35;
    if (/装置|立牌|摆件|花丛|装饰|海报|广告|指示牌|灯箱/.test(name)) s -= 0.45;
    if (/停车场|地铁站|公交站|出入口$|厕所|卫生间|配电|管理用房/.test(name)) s -= 0.8;
    return s;
  };
  for (const p of pois) {
    const insideSignal = p.name.includes(venueRef.name) ? 0.3 : (p.distanceM < 150 ? 0.1 : -0.15);
    p.quality = (p.scenic || 0.5) + insideSignal + nameBonus(p.name) - Math.min(0.3, p.distanceM / 2000);
  }
  const buckets = new Map();
  const seenCore = new Set();
  const coreOf = (n) => n.replace(/[（(][^）)]*[）)]/g, '').replace(/(打卡点|拍照|合影|背景|装置|立牌|摆件|视角|机位|墙画|正门|门口|附近)/g, '').replace(/[-—·\s]/g, '');
  for (const p of pois.sort((a, b) => b.quality - a.quality)) {
    const b = bucket(p);
    const cap = b === 'spot' ? 5 : b === 'food' ? 3 : b === 'culture' ? 3 : b === 'shop' ? 2 : 3;
    if (!buckets.has(b)) buckets.set(b, []);
    if (buckets.get(b).length >= cap) continue;
    const core = coreOf(p.shortName);
    if (core && seenCore.has(core)) continue; // 同质点位去重（"xx装置(打卡点)" 类）
    seenCore.add(core);
    buckets.get(b).push(p);
  }
  const picked = [...buckets.values()].flat()
    .sort((a, b) => b.quality - a.quality)
    // 半天预算装得下更多点；上限同时受路由矩阵配额约束（候选 + 起点两两成对都要抓得到），
    // 否则末尾的候选拿不到任何 OD 边、永远排不进多站路线（2026-09-30 修）
    .slice(0, Math.min(12, maxCandidatesForQuota(cfg.limits.maxRoutingCalls)));

  const value = { venueRef, center, pois: picked, entrances: picked.filter((p) => p.isEntrance) };
  return cacheSet(key, value);
}

/** 构建真实场所的路网/图（含路由矩阵；起点由调用方给出） */
async function buildLiveVenue(cfg, venueRef, origin, budgetSec) {
  const resolved = await resolveVenue(cfg, venueRef);
  const originPoint = origin && Number.isFinite(origin.lng) ? origin : { ...resolved.center, label: venueRef.name };
  const graph = new AmapAreaGraph(cfg, { ...originPoint, label: originPoint.label || '当前位置' }, budgetSec);

  // 节点 = 起点 + 场内点位（含入口）；入口作为可选"起点/终点"节点
  const cands = resolved.pois.map((p) => ({
    id: p.id, name: p.shortName, lng: p.lng, lat: p.lat,
  }));
  await graph.init(cands, { cacheKey: matrixCacheKeyOf('venue:' + venueRef.id, originPoint, cands.map((c) => c.id)) });

  const usable = resolved.pois.filter((p) => graph.nodes.has(p.id));
  const venueId = venueRef.id;
  const pack = {
    venue: {
      id: venueId,
      name: venueRef.name,
      nameNote: `真实场所（高德数据）· ${venueRef.district || venueRef.city || ''}`.trim(),
      city: venueRef.city || '', timezone: 'Asia/Shanghai',
      packVersion: 'amap-live-' + new Date().toISOString().slice(0, 10),
      coverageScope: {
        kind: 'poi',
        scopeLabel: `高德在园内检索到的 ${usable.length} 个点位（非园区完整清单）`,
      },
      center: { lng: resolved.center.lng, lat: resolved.center.lat, crs: 'GCJ02' },
      entrances: ['am_origin'],
      openWindows: null,
      live: true,
    },
    nodes: [...graph.nodes.values()].map((n) => {
      const src = resolved.pois.find((p) => p.id === n.id);
      return src && src.isEntrance ? { ...n, type: 'entrance' } : n;
    }),
    edges: [...graph._edges.values()].map((e) => ({ ...e, bikeAllowed: false, closed: false, evidenceIds: ['ev_amap_live'] })),
    pois: usable.map((p) => ({
      id: p.id, name: p.shortName, entranceNode: p.id,
      tags: p.tags, indoor: /^14/.test(String(p.typecode)) || p.tags.includes('美食'),
      scenic: p.scenic, dwellMinSec: 300, dwellSec: p.dwellSec,
      openWindows: null,            // 高德不提供营业时间 → 校验层标 unknown（诚实）
      ticketCny: null, ticketKnown: false, costNote: '门票/消费未核验',
      reservation: 'unknown', hoursEvidenceIds: ['ev_amap_live'],
      providerPoiId: p.providerPoiId, address: p.address, isEntrance: p.isEntrance,
      guide: null,                  // 真实内容由 LLM 生成并标注未核验，或等待资料管线
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
  return { pack, graph, resolved };
}

/** 供需求解析层做实体消歧的轻量包（不建图，省调用） */
async function lightPackForResolve(cfg, venueRef) {
  const resolved = await resolveVenue(cfg, venueRef);
  return {
    venue: { id: venueRef.id, name: venueRef.name, city: venueRef.city || '', timezone: 'Asia/Shanghai', live: true },
    pois: resolved.pois.map((p) => ({ id: p.id, name: p.shortName, tags: p.tags })),
  };
}

/** 附近可逛的场所（公园/景区/校园）：用于"发现"入口，帮用户先选地方再规划 */
async function searchVenuesAround(cfg, point, radiusM = 3000) {
  const json = await amapGet(cfg, '/v3/place/around', {
    location: `${point.lng},${point.lat}`,
    types: VENUE_TYPECODES.join('|'),
    radius: String(Math.min(radiusM, 5000)),
    offset: '20', page: '1', extensions: 'base',
  });
  return (json.pois || []).map((p) => {
    const [lng, lat] = String(p.location || ',').split(',').map(Number);
    return {
      kind: 'venue', id: 'live:' + p.id, providerPoiId: p.id,
      name: p.name, city: p.cityname || '', district: p.adname || '',
      typecode: p.typecode,
      address: typeof p.address === 'string' ? p.address : '',
      disambiguation: [p.cityname, p.adname].filter(Boolean).join(' · '),
      distanceM: Math.round(Number(p.distance) || haversineM(point, { lng, lat })),
      coord: { lng, lat, crs: 'GCJ02' },
      provider: 'amap', live: true, demo: false,
    };
  }).filter((x) => Number.isFinite(x.coord.lng))
    .sort((a, b) => a.distanceM - b.distanceM);
}

module.exports = { searchVenues, searchVenuesAround, resolveVenue, buildLiveVenue, lightPackForResolve, VENUE_TYPECODES };
