'use strict';

/**
 * 路线约束模块：把固定产品约束与用户硬约束编译成一次排程所需的状态机。
 *
 * 当前固定约束：同一物理路段不可重复使用（正反向视为同一 edgeId）。
 * 用户硬约束：最大步行距离、最大已知费用。
 *
 * 图适配器只需支持 route(fromId, toId, { forbiddenEdgeIds })，约束状态与
 * 求解器其余实现保持隔离。商业地图没有稳定道路 ID 时，edgeId 只能表达
 * “同一对点的同一条 Provider 路线”，折线级重叠需由地图适配器继续深化。
 */

function hardConstraintsOf(intent) {
  return {
    // 产品固定约束。只有显式传 false 才允许诊断/兼容旧路线时放宽。
    noRepeatedEdges: intent.hard?.noRepeatedEdges !== false,
    maxDistanceM: Number.isFinite(intent.hard?.maxDistanceM) ? intent.hard.maxDistanceM : null,
    maxCostCny: Number.isFinite(intent.hard?.maxCostCny) ? intent.hard.maxCostCny : null,
  };
}

/**
 * 将 Provider polyline 重采样到约 6m 网格，生成与方向无关的物理分段键。
 * 这是会话内重叠估计，不是永久道路 ID：能识别大部分反向折返，但不能证明道路级零重叠。
 */
function geometrySegmentKeys(geometry) {
  if (!Array.isArray(geometry) || geometry.length < 2) return [];
  const grid = 0.00006;
  const cells = [];
  const pushCell = (lng, lat) => {
    const cell = `${Math.round(lng / grid)},${Math.round(lat / grid)}`;
    if (cells[cells.length - 1] !== cell) cells.push(cell);
  };
  for (let i = 1; i < geometry.length; i++) {
    const [lng0, lat0] = geometry[i - 1];
    const [lng1, lat1] = geometry[i];
    if (![lng0, lat0, lng1, lat1].every(Number.isFinite)) continue;
    const dx = (lng1 - lng0) * 111320 * Math.cos(((lat0 + lat1) * Math.PI) / 360);
    const dy = (lat1 - lat0) * 110940;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 4));
    for (let s = 0; s <= steps; s++) {
      const p = s / steps;
      pushCell(lng0 + (lng1 - lng0) * p, lat0 + (lat1 - lat0) * p);
    }
  }
  const keys = [];
  for (let i = 1; i < cells.length; i++) {
    const a = cells[i - 1], b = cells[i];
    if (a !== b) keys.push(a < b ? `g:${a}|${b}` : `g:${b}|${a}`);
  }
  return [...new Set(keys)];
}

function physicalKeysOf(route) {
  if (Array.isArray(route.physicalSegmentKeys) && route.physicalSegmentKeys.length) return route.physicalSegmentKeys;
  return (route.edgeIds || []).map((eid) => `e:${eid}`);
}

function createTraversalConstraintState(intent, graph) {
  const hard = hardConstraintsOf(intent);
  const usedEdgeIds = new Set();
  const usedPhysicalKeys = new Set();
  const repeatedEdgeIds = new Set();
  let distanceM = 0;

  function route(fromId, toId, callOpts = {}) {
    const forbiddenEdgeIds = hard.noRepeatedEdges && !callOpts.allowRepeat ? usedEdgeIds : null;
    const result = graph.route(fromId, toId, { forbiddenEdgeIds });
    if (!result || result.status !== 'ok') {
      return result || { status: 'unreachable', distanceM: null, nodeIds: [], edgeIds: [], geometry: [] };
    }

    const keys = physicalKeysOf(result);
    const repeated = keys.filter((key) => usedPhysicalKeys.has(key));
    for (const key of repeated) repeatedEdgeIds.add(key);
    // allowRepeat：返程回起点等通勤段允许沿去程走回，只记录不拦截（游览段仍严格不重复）
    if (hard.noRepeatedEdges && repeated.length && !callOpts.allowRepeat) {
      return {
        status: 'constraint_violation', code: 'REPEATED_EDGE',
        distanceM: null, nodeIds: [], edgeIds: repeated, geometry: [],
      };
    }

    for (const eid of result.edgeIds || []) usedEdgeIds.add(eid);
    for (const key of keys) usedPhysicalKeys.add(key);
    distanceM += result.distanceM || 0;
    return result;
  }

  function validateFinal(stops) {
    if (hard.maxDistanceM != null && distanceM > hard.maxDistanceM) {
      return { ok: false, code: 'MAX_DISTANCE_EXCEEDED', details: { actualM: distanceM, limitM: hard.maxDistanceM } };
    }
    if (hard.maxCostCny != null) {
      const knownCostCny = stops.reduce((sum, s) => sum + (s.poi.ticketKnown ? Math.max(0, s.poi.ticketCny || 0) : 0), 0);
      if (knownCostCny > hard.maxCostCny) {
        return { ok: false, code: 'MAX_COST_EXCEEDED', details: { actualCny: knownCostCny, limitCny: hard.maxCostCny } };
      }
    }
    return { ok: true };
  }

  function metrics() {
    return {
      noRepeatedEdges: hard.noRepeatedEdges,
      usedEdgeIds: [...usedEdgeIds],
      usedPhysicalKeys: [...usedPhysicalKeys], repeatedEdgeIds: [...repeatedEdgeIds],
      distanceM,
    };
  }

  return { hard, route, validateFinal, metrics };
}

function repeatedEdgeMetrics(legs, graph) {
  const counts = new Map();
  for (const leg of legs) {
    const keys = physicalKeysOf(leg);
    const unitLengthM = keys.length ? (leg.distanceM || 0) / keys.length : 0;
    for (const key of keys) {
      const prev = counts.get(key) || { count: 0, lengthM: key.startsWith('e:')
        ? Number(graph.edgeById.get(key.slice(2))?.lengthM) || unitLengthM : unitLengthM };
      prev.count++;
      counts.set(key, prev);
    }
  }
  let totalDistanceM = 0;
  let repeatedDistanceM = 0;
  const repeatedEdgeIds = [];
  for (const [key, item] of counts) {
    totalDistanceM += item.lengthM * item.count;
    if (item.count > 1) {
      repeatedDistanceM += item.lengthM * (item.count - 1);
      repeatedEdgeIds.push(key);
    }
  }
  return {
    repeatedEdgeIds,
    repeatedDistanceM,
    repeatRatio: totalDistanceM > 0 ? repeatedDistanceM / totalDistanceM : 0,
  };
}

module.exports = { hardConstraintsOf, createTraversalConstraintState, repeatedEdgeMetrics, geometrySegmentKeys };
