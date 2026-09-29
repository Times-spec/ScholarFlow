'use strict';
/**
 * 坐标模块（文档 §5.4 契约）：
 * - 内部位置对象固定 {lng, lat, crs}；数组接口固定 [lng, lat]。
 * - 面向大陆高德展示/路由统一 GCJ02；设备原始 WGS84 只在适配器入口转换一次，严禁二次偏移。
 * - 演示模式下的转换使用公开近似算法，并在结果中标注 approximate:true（诚实标注，不冒充官方转换服务）。
 */

const PI = Math.PI;
const A = 6378245.0;
const EE = 0.00669342162296594323;

function outOfChina(lng, lat) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}
function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * PI) + 320 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}
function transformLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0;
  return ret;
}

/** WGS84 → GCJ02（仅适配器入口调用；结果带 approximate 标记） */
function wgs84ToGcj02(lng, lat) {
  if (outOfChina(lng, lat)) return { lng, lat };
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI);
  dLng = (dLng * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * PI);
  return { lat: lat + dLat, lng: lng + dLng };
}

/**
 * 坐标规范化入口（文档 §5.1 步骤 4）：只转换一次。
 * 已是 GCJ02 的输入直接透传，绝不二次偏移。
 */
function normalizeCoordinate(raw) {
  const { lng, lat, crs } = raw;
  if (typeof lng !== 'number' || typeof lat !== 'number' || Math.abs(lng) > 180 || Math.abs(lat) > 90) {
    const err = new Error('坐标非法'); err.code = 'CRS_UNSUPPORTED'; throw err;
  }
  if (crs === 'GCJ02') {
    return { lng, lat, crs: 'GCJ02', converted: false, approximate: false, source: raw.source || 'unknown' };
  }
  if (crs === 'WGS84') {
    const g = wgs84ToGcj02(lng, lat);
    return { lng: g.lng, lat: g.lat, crs: 'GCJ02', converted: true, approximate: true, source: raw.source || 'unknown' };
  }
  const err = new Error('不支持的坐标系: ' + crs); err.code = 'CRS_UNSUPPORTED'; throw err;
}

/** 米制投影：以某参考点为原点的局部平面坐标（演示地图渲染与距离估算用） */
function makeProjector(origin) {
  const mPerDegLat = 110940;
  const mPerDegLng = 111320 * Math.cos((origin.lat * PI) / 180);
  return {
    toXY(p) { return { x: (p.lng - origin.lng) * mPerDegLng, y: (p.lat - origin.lat) * mPerDegLat }; },
    toLngLat(x, y) { return { lng: origin.lng + x / mPerDegLng, lat: origin.lat + y / mPerDegLat }; },
  };
}

/** 直线距离（haversine，米）。仅用于粗筛/候选排序，禁止充当可执行路段（文档 §8.6）。 */
function haversineM(a, b) {
  const rad = PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(s));
}

module.exports = { normalizeCoordinate, wgs84ToGcj02, makeProjector, haversineM };
