'use strict';
/**
 * APK 端到端验收（通过 WebView 远程调试协议直接驱动页面）
 * 用法：node scripts/apk-probe.js [adbPath] [port]
 * 前提：debug 包已安装并运行、已 adb forward tcp:<port> localabstract:webview_devtools_remote_<pid>
 */
const http = require('http');

const PORT = Number(process.argv[3] || 9222);
let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail) {
  if (ok) { pass++; results.push('PASS  ' + name); }
  else { fail++; results.push('FAIL  ' + name + (detail ? '  — ' + detail : '')); }
}

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function main() {
  const list = await getJson('/json');
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('未找到可调试页面，请确认 debug 包已打开且 adb forward 已建立');
  console.log('已连接页面:', page.title, '|', page.url);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', j, { once: true });
  });
  let seq = 0;
  const pending = new Map();
  const logs = [];
  const exceptions = [];
  ws.addEventListener('message', (ev) => {
    const raw = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8');
    const msg = JSON.parse(raw);
    if (msg.method === 'Runtime.consoleAPICalled') {
      logs.push((msg.params.args || []).map((a) => a.value).join(' '));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      exceptions.push((d.exception && d.exception.description) || d.text || 'unknown');
    }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (m) => (m.error ? reject(new Error(method + ': ' + JSON.stringify(m.error))) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
  const evaluate = async (expr) => {
    const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description));
    return r.result.value;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  await call('Runtime.enable');

  // 1. 页面与原生桥
  const state = JSON.parse(await evaluate(`JSON.stringify({
    title: document.title,
    hasApp: !!document.querySelector('.ai-input'),
    pills: document.querySelectorAll('.scene-pill').length,
    conds: document.querySelectorAll('.cond-chip').length,
    bridge: !!window.SuixingNative,
    bridgeReady: !!window.__suixingGeoInstalled,
    hash: location.hash
  })`));
  check('APK 内加载的是随行应用', state.hasApp && state.title.includes('随行'), JSON.stringify(state));
  check('注入的原生能力可用', state.bridge && state.bridgeReady);
  check('极简首页结构（场景胶囊 + 条件胶囊）', state.pills === 2 && state.conds >= 4, JSON.stringify(state));

  // 2. 原生定位桥实测（GPS 坐标已由 adb emu geo fix 注入）
  const geo = await evaluate(`new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve(JSON.stringify({ ok: true, lng: p.coords.longitude, lat: p.coords.latitude, acc: p.coords.accuracy })),
      (e) => resolve(JSON.stringify({ ok: false, code: e && e.code, msg: e && e.message })),
      { enableHighAccuracy: true, timeout: 8000 });
  })`);
  const g = JSON.parse(geo);
  check('原生定位桥返回真实坐标（WGS84）', g.ok && Math.abs(g.lng - 104.08) < 0.2 && Math.abs(g.lat - 30.65) < 0.2, geo);
  const normRaw = await evaluate(`fetch('/v1/locations/normalize', { method:'POST', headers:{'content-type':'application/json','authorization':'Bearer '+(localStorage.getItem('st_session')||'')},
      body: JSON.stringify({ lng: ${g.ok ? g.lng : 0}, lat: ${g.ok ? g.lat : 0}, crs:'WGS84', source:'device', accuracyM: ${g.ok ? (g.acc || 30) : 30} }) })
      .then(r=>r.text()).catch(e=>'FETCH_FAIL:'+e.message)`);
  let normOk = false;
  try {
    const j = JSON.parse(normRaw);
    normOk = j && j.point && j.point.converted === true && j.point.crs === 'GCJ02';
  } catch (e) { normOk = false; }
  check('服务端完成 WGS84→GCJ02 一次转换', normOk, String(normRaw).slice(0, 200));

  // 3. 用"当前位置"设置起点（走完整 UI 路径）
  const clicked = await evaluate(`(() => { const c=[...document.querySelectorAll('.cond-chip')].find(x=>/📍/.test(x.textContent)); if(!c) return false; c.click(); return true; })()`);
  check('找到起点胶囊并可点击', clicked === true);
  await sleep(600);
  const sheetOpen = await evaluate(`document.querySelectorAll('#sheet .opt-row').length`);
  check('起点弹层打开', sheetOpen === 3, 'opt rows=' + sheetOpen);
  await evaluate(`(() => { const b=[...document.querySelectorAll('#sheet .opt-row')].find(x=>x.textContent.includes('使用当前位置')); b && b.click(); })()`);
  await sleep(2500);
  const originChip = await evaluate(`(() => { const c=[...document.querySelectorAll('.cond-chip')].find(x=>/📍/.test(x.textContent)); return c ? c.textContent : ''; })()`);
  check('定位结果写入起点（不再是"当前位置"占位）', /📍/.test(originChip) && !/当前位置$/.test(originChip.replace('📍','').trim()), originChip);

  // 4. 一句话规划（AI + 高德全程在 APK 内跑通）
  await evaluate(`(() => {
    const ta = document.querySelector('.ai-input');
    ta.value = '想去人民公园逛逛，两小时，看看有特色的地方，回到起点';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await evaluate(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('生成路线')); b.click(); })()`);
  let planned = false;
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    if (await evaluate(`document.querySelectorAll('.route-card').length > 0`)) { planned = true; break; }
  }
  check('APK 内完成真实场所规划（AI 识别场所 + 高德路线）', planned);
  if (planned) {
    // 地图与时间轴是异步渲染，等就绪再断言
    for (let i = 0; i < 20; i++) {
      const ready = await evaluate(`document.querySelectorAll('.tl-item').length > 0 && !!document.querySelector('.map-wrap svg, .map-wrap .amap-container, .map-wrap canvas')`);
      if (ready) break;
      await sleep(1500);
    }
    const plan = JSON.parse(await evaluate(`JSON.stringify({
      venue: /人民公园/.test(document.body.textContent),
      coverage: /高德在园内检索到/.test(document.body.textContent),
      stops: document.querySelectorAll('.tl-item').length,
      amapMap: !!document.querySelector('.amap-container, canvas')
    })`));
    check('路线来自真实场所并诚实标注覆盖分母', plan.venue && plan.coverage, JSON.stringify(plan));
    check('高德底图与站点渲染', plan.amapMap && plan.stops >= 1, JSON.stringify(plan));
  }

  // 5. 会话持久化（关闭后重开无需重新配置）
  const session = await evaluate(`!!localStorage.getItem('st_session')`);
  check('会话凭证已持久化到 WebView localStorage', session === true);
  check('原生注入日志出现', logs.some((l) => /native geo bridge ready/.test(l)), logs.slice(-2).join(' | '));
  check('页面无未捕获异常', exceptions.length === 0, exceptions.slice(0, 2).join(' || '));

  ws.close();
  console.log('\n===== APK 验收结果 =====');
  results.forEach((r) => console.log(r));
  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('PROBE ERROR', e.message); process.exit(1); });
