'use strict';

/** 纯算法回归：不启服务、不访问外网。 */
const assert = require('assert');
const { VenueGraph, solveOnce, buildRoutePlan } = require('../server/planner');
const { createTraversalConstraintState, geometrySegmentKeys } = require('../server/route_constraints');

function packOf({ loop }) {
  const nodes = [
    { id: 's', name: '起点', type: 'entrance', lng: 104, lat: 30, status: 'open' },
    { id: 'a', name: '景点 A', type: 'poi', lng: 104.001, lat: 30, status: 'open' },
  ];
  const edges = [{ id: 'e_sa', from: 's', to: 'a', lengthM: 100, walkAllowed: true, closed: false }];
  if (loop) {
    nodes.push({ id: 'b', name: '环路节点', type: 'junction', lng: 104.001, lat: 30.001, status: 'open' });
    edges.push(
      { id: 'e_ab', from: 'a', to: 'b', lengthM: 100, walkAllowed: true, closed: false },
      { id: 'e_bs', from: 'b', to: 's', lengthM: 100, walkAllowed: true, closed: false },
    );
  }
  const pois = [{
    id: 'a', name: '景点 A', entranceNode: 'a', tags: ['自然'], scenic: 1,
    indoor: false, dwellSec: 300, openWindows: null, ticketKnown: true, ticketCny: 0,
  }];
  return {
    venue: {
      id: loop ? 'loop' : 'dead_end', name: loop ? '环路' : '死胡同', timezone: 'Asia/Shanghai',
      entrances: ['s'], packVersion: 'test', coverageScope: { kind: 'poi', scopeLabel: '测试点位' },
    },
    nodes, edges, pois,
    evidence: [{ id: 'ev_test', retrievedAt: '2026-09-30T00:00:00Z' }],
    _poiById: new Map(pois.map((p) => [p.id, p])),
    _nodeById: new Map(nodes.map((n) => [n.id, n])),
    _evById: new Map(),
  };
}

function intentOf(overrides = {}) {
  const startAtMs = Date.parse('2026-09-30T01:00:00Z');
  return {
    intentId: 'int_test', revision: 1, objective: 'highlights',
    origin: { point: { lng: 104, lat: 30 }, entranceId: 's', label: '起点' },
    endpoint: { mode: 'return_to_origin' },
    startAtMs, latestEndAtMs: startAtMs + 7200000, budgetSec: 7200,
    startAt: new Date(startAtMs).toISOString(), latestEndAt: new Date(startAtMs + 7200000).toISOString(),
    timezone: 'Asia/Shanghai', pace: 'normal', interests: [{ tag: '自然', weight: 1 }],
    hard: { mustVisitIds: [], avoidPoiIds: [], noRepeatedEdges: true, maxDistanceM: null, maxCostCny: null, stepFreeRequired: false },
    soft: { freePreferred: false, repeatRoadPenalty: 1, restPreferred: false, quietPreferred: false, stepFewPreferred: false },
    ...overrides,
  };
}

const policy = { interestW: 1, timeCostW: 0.55, dwellFactor: 1 };

{
  const pack = packOf({ loop: true });
  const graph = new VenueGraph(pack);
  const intent = intentOf();
  const solved = solveOnce(pack, intent, graph, policy);
  assert.equal(solved.status, 'ok', '有环路时应找到不重复物理边的返回路线');
  const allEdgeIds = [...solved.schedule.legs, solved.schedule.endLeg].filter(Boolean).flatMap((l) => l.edgeIds);
  assert.equal(new Set(allEdgeIds).size, allEdgeIds.length, '任何物理边都不得重复');
  const plan = buildRoutePlan(pack, intent, graph, solved, { version: 1, planId: 'p' });
  assert.equal(plan.repeatRatio, 0);
  assert.equal(plan.constraints.find((c) => c.key === 'no_repeated_edges').result, 'pass');
}

{
  const pack = packOf({ loop: false });
  const graph = new VenueGraph(pack);
  const solved = solveOnce(pack, intentOf(), graph, policy);
  assert.equal(solved.status, 'infeasible', '死胡同往返不能伪装成无回头路方案');
  assert.equal(solved.conflict.code, 'NO_NON_REPEATING_ROUTE');
}

{
  const pack = packOf({ loop: false });
  const graph = new VenueGraph(pack);
  const base = intentOf();
  const intent = { ...base, hard: { ...base.hard, noRepeatedEdges: false } };
  const solved = solveOnce(pack, intent, graph, policy);
  assert.equal(solved.status, 'ok', '显式放宽约束后允许死胡同往返');
  const plan = buildRoutePlan(pack, intent, graph, solved, { version: 1, planId: 'p' });
  assert(plan.repeatRatio > 0, '放宽后必须如实计算重复路段率');
}

{
  const forward = [[104, 30], [104.001, 30], [104.002, 30]];
  const reverse = [...forward].reverse();
  assert.deepEqual(new Set(geometrySegmentKeys(forward)), new Set(geometrySegmentKeys(reverse)), '折线分段键必须与行走方向无关');

  const routes = new Map([
    ['s>a', { status: 'ok', distanceM: 200, edgeIds: ['od_1'], geometry: forward, physicalSegmentKeys: geometrySegmentKeys(forward) }],
    ['a>b', { status: 'ok', distanceM: 200, edgeIds: ['od_2'], geometry: reverse, physicalSegmentKeys: geometrySegmentKeys(reverse) }],
  ]);
  const graph = { route: (from, to) => routes.get(`${from}>${to}`), edgeById: new Map() };
  const state = createTraversalConstraintState(intentOf(), graph);
  assert.equal(state.route('s', 'a').status, 'ok');
  assert.equal(state.route('a', 'b').code, 'REPEATED_EDGE', '不同 OD 人工边共享同一折线时也必须识别回头路');
}

console.log('✅ 路线约束回归通过：环路无重复 / 死胡同冲突 / 显式放宽 / Provider 折线重叠');
