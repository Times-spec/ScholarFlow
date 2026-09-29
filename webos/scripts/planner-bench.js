'use strict';
/**
 * 规划器回归基准（不启服务、不调外网）：直连本地场所包，按 目标×时长 矩阵
 * 打印各政策的站点数/总时长，用于验证"半天只排 3-4 个点"类问题的修复与回归。
 * 运行：node scripts/planner-bench.js [场所包文件名，默认 qinghu-park.json]
 */
const path = require('path');
const { loadPacks } = require('../server/providers');
const { VenueGraph, solveAlternatives, buildRoutePlan } = require('../server/planner');

const file = process.argv[2] || '';
const ROOT = path.join(__dirname, '..');
const packs = loadPacks(ROOT).filter((p) => p.venue.id && p.venue.name);
const pack = (file && packs.find((p) => file === path.basename(p.__file || '') || p.venue.name.includes(file)))
  || packs.find((p) => p.venue.name.includes('青湖'))
  || packs[0];
if (!pack) { console.error('未找到场所包'); process.exit(1); }

const graph = new VenueGraph(pack);
const startNode = pack.venue.entrances[0];
const startMs = (() => { const d = new Date(); d.setHours(14, 0, 0, 0); return d.getTime(); })();

function makeIntent(objective, budgetSec) {
  return {
    schemaVersion: '1.0', intentId: 'int_bench', revision: 1, scene: 'venue',
    objective,
    venueId: pack.venue.id, venueRef: null,
    origin: { point: { lng: 104.062, lat: 30.659, crs: 'GCJ02' }, poiId: null, entranceId: startNode, label: '入口' },
    endpoint: { mode: 'return_to_origin' },
    startAt: new Date(startMs).toISOString(), latestEndAt: new Date(startMs + budgetSec * 1000).toISOString(),
    startAtMs: startMs, latestEndAtMs: startMs + budgetSec * 1000,
    budgetSec, dualConstraint: false,
    timezone: 'Asia/Shanghai', mobility: 'walk', pace: 'normal',
    interests: [{ tag: '自然', weight: 1 }],
    hard: { mustVisitIds: [], avoidPoiIds: [], maxDistanceM: null, maxCostCny: null, stepFreeRequired: false },
    soft: { freePreferred: false, repeatRoadPenalty: 1, restPreferred: false, quietPreferred: false, stepFewPreferred: false },
    guideStyle: 'normal', rawText: '', textEngine: 'rules', unresolved: [],
  };
}

console.log(`场所包: ${pack.venue.name}（POI ${pack.pois.length}，图节点 ${pack.nodes.length}）`);
console.log('政策说明: balanced=主推荐, light=轻松版, full=全览版\n');
let worst = Infinity;
for (const objective of ['highlights', 'poi_coverage', 'relax']) {
  for (const budgetSec of [7200, 14400]) {
    const intent = makeIntent(objective, budgetSec);
    const results = solveAlternatives(pack, intent, graph);
    const label = `${objective.padEnd(12)} ${(budgetSec / 3600).toFixed(0)}h`;
    if (!results.length) { console.log(`${label}  无可行方案`); continue; }
    const line = results.map((r) => {
      const plan = buildRoutePlan(pack, intent, graph, r.solved, { version: 1, planId: 'plan_bench' });
      return `${r.policy.name}: ${plan.stops.length}站/${Math.round(plan.totals.totalSec / 60)}min/${(plan.totals.distanceM / 1000).toFixed(1)}km`;
    }).join('  |  ');
    const main = results[0];
    const mainPlan = buildRoutePlan(pack, intent, graph, main.solved, { version: 1, planId: 'plan_bench' });
    if (mainPlan.stops.length < worst) worst = mainPlan.stops.length;
    console.log(`${label}  ${line}`);
  }
}
console.log(`\n主推荐最少站数（2h 档预期 2-4，半天 4h 档预期 ≥5）`);
