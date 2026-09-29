'use strict';

/**
 * 方案 A（算法直接求解）与方案 B（有界智能体编排）的同场景实测。
 * 不启服务、不访问网络，使用真实青湖公园场所包。
 */
const assert = require('assert');
const path = require('path');
const { performance } = require('perf_hooks');
const { loadPacks } = require('../server/providers');
const { VenueGraph, solveAlternatives, solveOnce, buildRoutePlan } = require('../server/planner');
const { RoutePlanningAgent, verifyRoutePlan } = require('../server/route_planning_agent');

const ROOT = path.join(__dirname, '..');
const pack = loadPacks(ROOT).find((p) => p.venue.id === 'venue_qinghu');
const startNode = pack.venue.entrances[0];
const startAtMs = Date.parse('2026-10-01T01:00:00Z'); // Asia/Shanghai 09:00

function intentOf({ mustVisitIds = [], maxDistanceM = null } = {}) {
  return {
    intentId: 'int_compare', revision: 1, objective: 'highlights', venueId: pack.venue.id,
    origin: { point: { lng: 104.062, lat: 30.659, crs: 'GCJ02' }, entranceId: startNode, label: '南门' },
    endpoint: { mode: 'return_to_origin' },
    startAtMs, latestEndAtMs: startAtMs + 7200000, budgetSec: 7200,
    startAt: '2026-10-01T09:00:00+08:00', latestEndAt: '2026-10-01T11:00:00+08:00',
    timezone: 'Asia/Shanghai', pace: 'normal', interests: [{ tag: '自然', weight: 1 }],
    hard: { mustVisitIds, avoidPoiIds: [], noRepeatedEdges: true, maxDistanceM, maxCostCny: null, stepFreeRequired: false },
    soft: { freePreferred: false, repeatRoadPenalty: 1, restPreferred: false, quietPreferred: false, stepFewPreferred: false },
  };
}

function runAlgorithm(intent) {
  const graph = new VenueGraph(pack);
  const t0 = performance.now();
  const results = solveAlternatives(pack, intent, graph);
  let route = null, conflict = null;
  if (results.length) route = buildRoutePlan(pack, intent, graph, results[0].solved, { version: 1, planId: 'algorithm' });
  else conflict = solveOnce(pack, intent, graph, { interestW: 1, timeCostW: 0.55, dwellFactor: 1 }).conflict;
  return { status: route ? 'ready' : 'infeasible', route, conflict, proposals: [], ms: performance.now() - t0 };
}

function runAgent(intent) {
  const graph = new VenueGraph(pack);
  const t0 = performance.now();
  const result = new RoutePlanningAgent().plan({ pack, intent, graph, planId: 'agent' });
  return { ...result, ms: performance.now() - t0 };
}

const scenarios = [
  { name: '标准两小时闭环', intent: intentOf() },
  { name: '湖心岛死胡同必去', intent: intentOf({ mustVisitIds: ['poi_island'] }) },
  { name: '多重约束：必去两点+2.2km上限', intent: intentOf({ mustVisitIds: ['poi_tower', 'poi_bonsai'], maxDistanceM: 2200 }) },
];

console.log('场景'.padEnd(24), '算法方案'.padEnd(16), '智能体方案'.padEnd(22), '算法/智能体耗时');
const rows = [];
for (const scenario of scenarios) {
  const algorithm = runAlgorithm(scenario.intent);
  const agent = runAgent(scenario.intent);
  if (algorithm.route) assert(verifyRoutePlan(algorithm.route).ok, '算法方案不得发布违反物理约束的路线');
  if (agent.route) assert(agent.verification.ok, '智能体方案必须通过独立 verifier');
  rows.push({ scenario: scenario.name, algorithm, agent });
  const a = algorithm.status;
  const b = agent.status + (agent.proposals?.length ? `(${agent.proposals.length}条提议)` : '');
  console.log(scenario.name.padEnd(24), a.padEnd(16), b.padEnd(22), `${algorithm.ms.toFixed(2)}ms / ${agent.ms.toFixed(2)}ms`);
}

const normal = rows[0];
assert.equal(normal.algorithm.route.repeatRatio, 0);
assert.equal(normal.agent.route.repeatRatio, 0);
const deadEnd = rows[1];
assert.equal(deadEnd.algorithm.conflict.code, 'NO_NON_REPEATING_ROUTE');
assert.equal(deadEnd.agent.status, 'needs_user_decision');
assert(deadEnd.agent.proposals.some((p) => p.previewRoute && verifyRoutePlan(p.previewRoute).ok), '智能体应给出保持零重复的可行修复提议');
const multi = rows[2];
assert(multi.algorithm.route && multi.algorithm.route.totals.distanceM <= 2200);
assert(multi.agent.route && multi.agent.route.totals.distanceM <= 2200);

const summary = {
  scenarios: rows.length,
  noBacktrackingCompliance: {
    algorithm: rows.filter((r) => !r.algorithm.route || verifyRoutePlan(r.algorithm.route).ok).length,
    agent: rows.filter((r) => !r.agent.route || r.agent.verification.ok).length,
  },
  actionableOutcome: {
    algorithm: rows.filter((r) => r.algorithm.route).length,
    agent: rows.filter((r) => r.agent.route || r.agent.proposals?.length).length,
  },
  conclusion: '算法方案更适合直接保证硬约束；智能体方案在保持相同硬约束的同时，能把无解转成需要用户确认的可行调整。',
};
console.log('\n' + JSON.stringify(summary, null, 2));
console.log('✅ 两方案对照测试通过');
