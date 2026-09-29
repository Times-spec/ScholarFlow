'use strict';
/**
 * 路线顺序回归（纯算法，不启服务、不调外网）。
 *
 * 针对用户反馈「生成出来的路线经常不是按序号展开、经常走回头路」的四条不变式：
 *   1. 环路可达时，返程必须绕环走回，不得为了省几步路原路返回；
 *   2. 用户按顺序指定的必去点，其先后不得被最近邻或局部换序改掉；
 *   3. 死胡同点位要么排在最后，要么不排——游览段一律零重复；
 *   4. 路由矩阵配额必须抓得满"起点 + 候选"的两两组合（否则会有候选永远排不进多站路线）。
 *
 * 运行：node scripts/planner-ordering.js
 */
const assert = require('assert');
const { VenueGraph, solveOnce, buildRoutePlan } = require('../server/planner');
const { maxCandidatesForQuota } = require('../server/amap');

function packOf(nodes, edges, pois) {
  return {
    venue: {
      id: 'fixture', name: '测试场所', timezone: 'Asia/Shanghai',
      entrances: ['s'], packVersion: 'test', coverageScope: { kind: 'poi', scopeLabel: '测试点位' },
    },
    nodes, edges, pois,
    evidence: [{ id: 'ev_test', retrievedAt: '2026-09-30T00:00:00Z' }],
    _poiById: new Map(pois.map((p) => [p.id, p])),
    _nodeById: new Map(nodes.map((n) => [n.id, n])),
    _evById: new Map(),
  };
}
const poi = (id, lng, lat, scenic = 0.9, tags = ['自然']) => ({
  id, name: id, entranceNode: id, tags, scenic,
  indoor: false, dwellSec: 300, openWindows: null, ticketKnown: true, ticketCny: 0,
});

function intentOf(o = {}) {
  const s = Date.parse('2026-09-30T01:00:00Z');
  return Object.assign({
    intentId: 'i', revision: 1, objective: 'highlights',
    origin: { point: { lng: 104, lat: 30 }, entranceId: 's', label: '起点' },
    endpoint: { mode: 'return_to_origin' },
    startAtMs: s, latestEndAtMs: s + 14400000, budgetSec: 14400,
    startAt: new Date(s).toISOString(), latestEndAt: new Date(s + 14400000).toISOString(),
    timezone: 'Asia/Shanghai', pace: 'normal', interests: [{ tag: '自然', weight: 1 }],
    hard: { mustVisitIds: [], avoidPoiIds: [], noRepeatedEdges: true, maxDistanceM: null, maxCostCny: null, stepFreeRequired: false },
    soft: { freePreferred: false, repeatRoadPenalty: 1, restPreferred: false, quietPreferred: false, stepFewPreferred: false },
  }, o);
}
const policy = { interestW: 1, timeCostW: 0.55, dwellFactor: 1 };

/* ---------- 1. 环路：返程不得原路返回 ---------- */
{
  // 三角形环路：起点 s — 景点 a — 节点 b — 起点（每边 100m）
  const nodes = [
    { id: 's', name: '起点', type: 'entrance', lng: 104, lat: 30, status: 'open' },
    { id: 'a', name: '景点 A', type: 'poi', lng: 104.001, lat: 30, status: 'open' },
    { id: 'b', name: '环路节点', type: 'junction', lng: 104.001, lat: 30.001, status: 'open' },
  ];
  const edges = [
    { id: 'e_sa', from: 's', to: 'a', lengthM: 100, walkAllowed: true, closed: false },
    { id: 'e_ab', from: 'a', to: 'b', lengthM: 100, walkAllowed: true, closed: false },
    { id: 'e_bs', from: 'b', to: 's', lengthM: 100, walkAllowed: true, closed: false },
  ];
  const pack = packOf(nodes, edges, [poi('a', 104.001, 30)]);
  const solved = solveOnce(pack, intentOf(), new VenueGraph(pack), policy);
  assert.equal(solved.status, 'ok');
  const { legs, endLeg } = solved.schedule;
  const all = [...legs, endLeg].filter(Boolean).flatMap((l) => l.edgeIds);
  assert.equal(new Set(all).size, all.length, '环路可达时全程不得出现重复物理边');
  assert(!endLeg.edgeIds.includes('e_sa'), '返程必须绕环走回，不得沿去程原路返回');
  assert.equal(solved.schedule.totals.repeatAllM, 0, '存在无重复环路时全程重复距离应为 0');
}

/* ---------- 2. 用户指定的必去点顺序必须被尊重 ---------- */
{
  // 一条直线：s — C — B — A。最近邻从 s 出发必然给出 C、B、A；
  // 用户显式指定的顺序是 A、B、C，结果就必须是 A、B、C。
  // 用软约束场景（不重复=None），两种顺序都可行、代价相同，此时只有"顺序来源"在决定结果。
  const nodes = [
    { id: 's', name: '起点', type: 'entrance', lng: 104, lat: 30, status: 'open' },
    { id: 'C', name: '景点 C', type: 'poi', lng: 104.001, lat: 30, status: 'open' },
    { id: 'B', name: '景点 B', type: 'poi', lng: 104.002, lat: 30, status: 'open' },
    { id: 'A', name: '景点 A', type: 'poi', lng: 104.003, lat: 30, status: 'open' },
  ];
  const edges = [
    { id: 'e_sC', from: 's', to: 'C', lengthM: 100, walkAllowed: true, closed: false },
    { id: 'e_CB', from: 'C', to: 'B', lengthM: 100, walkAllowed: true, closed: false },
    { id: 'e_BA', from: 'B', to: 'A', lengthM: 100, walkAllowed: true, closed: false },
  ];
  const pack = packOf(nodes, edges, [poi('A', 104.003, 30), poi('B', 104.002, 30), poi('C', 104.001, 30)]);
  const solved = solveOnce(pack, intentOf({
    hard: { mustVisitIds: ['A', 'B', 'C'], avoidPoiIds: [], noRepeatedEdges: false, maxDistanceM: null, maxCostCny: null, stepFreeRequired: false },
  }), new VenueGraph(pack), policy);
  assert.equal(solved.status, 'ok');
  assert.deepEqual(solved.schedule.stops.map((s) => s.nodeId), ['A', 'B', 'C'],
    '必去点必须按用户给定顺序展开，而不是被最近邻重排');
}

/* ---------- 3. 死胡同点位：排在最后，且游览段零重复 ---------- */
{
  // s — m — a（景点），m 上挂一条死胡同支路到 p（低分死胡同打卡点）
  const nodes = [
    { id: 's', name: '起点', type: 'entrance', lng: 104, lat: 30, status: 'open' },
    { id: 'm', name: '岔口', type: 'junction', lng: 104.001, lat: 30, status: 'open' },
    { id: 'a', name: '景点 A', type: 'poi', lng: 104.002, lat: 30, status: 'open' },
    { id: 'p', name: '死胡同点位', type: 'poi', lng: 104.001, lat: 30.002, status: 'open' },
  ];
  const edges = [
    { id: 'e_sm', from: 's', to: 'm', lengthM: 100, walkAllowed: true, closed: false },
    { id: 'e_ma', from: 'm', to: 'a', lengthM: 100, walkAllowed: true, closed: false },
    { id: 'e_mp', from: 'm', to: 'p', lengthM: 100, walkAllowed: true, closed: false },
  ];
  const pack = packOf(nodes, edges, [poi('a', 104.002, 30, 0.9), poi('p', 104.001, 30.002, 0.5)]);
  const solved = solveOnce(pack, intentOf(), new VenueGraph(pack), policy);
  assert.equal(solved.status, 'ok');
  assert.equal(solved.schedule.totals.repeatSightM, 0, '游览段不得重复任何物理边');
  const plan = buildRoutePlan(pack, intentOf(), new VenueGraph(pack), solved, { version: 1, planId: 'p' });
  const names = plan.stops.map((s) => s.nodeId);
  const pip = names.indexOf('p');
  if (pip >= 0) assert.equal(pip, names.length - 1, '死胡同点位若被排入，只能是最后一站');
}

/* ---------- 4. 路由矩阵配额：候选数必须与配额自洽 ---------- */
{
  for (const quota of [60, 78, 110, 200]) {
    const c = maxCandidatesForQuota(quota);
    const need = ((c + 1) * c) / 2;          // 候选 + 起点两两成对
    const tooMany = ((c + 2) * (c + 1)) / 2; // 再多一个候选
    assert(need <= quota, `配额 ${quota}：${c} 个候选需要 ${need} 对，不应超过配额`);
    // 留出约 10% 重试余量，同时取到留余量之后的最大候选数
    assert(need <= quota * 0.9, `配额 ${quota}：${c} 个候选（${need} 对）应仍在 90% 预算内`);
    assert(tooMany > quota * 0.9, `配额 ${quota}：应已取到留余量后的最大候选数`);
  }
  // 生产配置必须足够覆盖 12 个候选（半天档的池子上限）
  assert(maxCandidatesForQuota(110) >= 12, '配额 110 至少要能覆盖 12 个候选');
  assert(maxCandidatesForQuota(60) < 12, '配额 60 覆盖不到 12 个候选——这正是此前候选成"哑点"的原因');
}

console.log('✅ 路线顺序回归通过：返程绕环不原路返回 / 必去顺序被尊重 / 死胡同排最后 / 配额与候选数自洽');
