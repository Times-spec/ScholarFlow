'use strict';
/** 真实模式 UI 探针：真实场所（逛这里）与周边（随便逛逛）两条链路，含 AI 一句话识别场所 */
const { open, checker, sleep } = require('C:/Users/24800/.workbuddy/skills/web-ui-bug-repro/scripts/cdp.js');
const BASE = 'http://127.0.0.1:8080';
const c = checker();

async function waitFor(page, expr, ms = 60000, step = 1000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await page.evaluate(expr)) return true; } catch (e) {}
    await sleep(step);
  }
  return false;
}
async function clickText(page, text, sel = 'button') {
  return page.evaluate(`(() => {
    const el = [...document.querySelectorAll('${sel}')].find((b) => b.textContent.includes('${text}') && !b.disabled);
    if (!el) return false; el.click(); return true;
  })()`);
}
async function clickCond(page, keyword) {
  return page.evaluate(`(() => {
    const el = [...document.querySelectorAll('.cond-chip')].find((c) => c.textContent.includes('${keyword}'));
    if (!el) return false; el.click(); return true;
  })()`);
}
async function typeIn(page, value, sel) {
  return page.evaluate(`(() => {
    const el = document.querySelector('${sel}');
    if (!el) return false;
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
}

async function main() {
  const page = await open({ url: BASE + '/#/', width: 420, height: 860, settleMs: 2500 });
  try {
    /* ============ 链路 A：一句话 → AI 识别场所 → 真实路线 ============ */
    await page.evaluate(`(() => {
      localStorage.setItem('st_draft_v1', JSON.stringify({
        scene: 'auto', venueId: null, venueRef: null, objective: 'highlights',
        origin: { lng: 104.0809, lat: 30.657, crs: 'GCJ02', label: '春熙路(测试起点)', source: 'map_pick' },
        timeMode: 'duration', durationSec: 7200, endpointMode: 'return_to_origin',
        mobility: 'walk', pace: 'normal', interests: [], text: '',
        mustVisit: [], avoid: [], startMode: 'now', guideStyle: 'normal',
      }));
      location.reload();
    })()`);
    await sleep(2500);
    // 默认是"先选择"的向导；AI 作为可选助手（展开后一句话让 AI 填）
    c.check('首页为向导式（先选择）', await page.evaluate(`document.querySelectorAll('.choice-card').length === 2 && document.querySelectorAll('.steps .step').length === 3`));
    await clickText(page, '说不清楚');
    await sleep(600);
    await typeIn(page, '想去人民公园逛逛，两小时，看看有特色的地方，回到起点', '.ai-input');
    c.check('让 AI 理解并规划', await clickText(page, '让 AI 帮我填好并规划'));
    const planOk = await waitFor(page, `document.querySelectorAll('.route-card').length >= 1`, 120000);
    c.check('AI 一句话直接出真实场所路线', planOk);
    const info = await page.json(`({
      venue: /人民公园/.test(document.body.textContent),
      coverage: /高德在园内检索到/.test(document.body.textContent),
      conditional: /条件性方案|未核验/.test(document.body.textContent),
      amapBase: !!document.querySelector('.map-wrap .amap-container, .map-wrap canvas'),
      stops: document.querySelectorAll('.tl-item').length,
    })`);
    c.check('场所来自 AI 识别（人民公园）', info.venue, JSON.stringify(info));
    c.check('覆盖分母诚实标注', info.coverage);
    c.check('未知项标注为条件性方案', info.conditional);
    await waitFor(page, `document.querySelectorAll('.tl-item').length >= 1`, 30000);
    await waitFor(page, `!!document.querySelector('.map-wrap .amap-container, .map-wrap svg, .map-wrap canvas')`, 30000);
    c.check('高德真实底图 + 站点渲染', await page.evaluate(`!!document.querySelector('.map-wrap .amap-container, .map-wrap canvas') && document.querySelectorAll('.tl-item').length >= 1`));
    await page.screenshot('F:/webos/shots/real-venue.png');

    /* ============ 链路 B：搜场所 + 搜起点（手动路径仍可用） ============ */
    await page.evaluate(`(() => {
      // 重置为"随便逛逛"，再通过胶囊切到"逛这里"，保证点击语义确定
      const raw = localStorage.getItem('st_draft_v1'); const d = raw ? JSON.parse(raw) : {};
      Object.assign(d, { scene: 'wander', venueId: null, venueRef: null, text: '' });
      localStorage.setItem('st_draft_v1', JSON.stringify(d));
      location.hash = '#/';
      location.reload();
    })()`);
    await sleep(2500);
    c.check('第一步选"逛一个地方"', await clickText(page, '逛一个地方', '.choice-card'));
    await sleep(900);
    c.check('第二步提供搜索入口', await clickText(page, '搜索公园'));
    await sleep(700);
    await typeIn(page, '人民公园', '#sheet input');
    c.check('场所搜索结果出现', await waitFor(page, `[...document.querySelectorAll('#sheet .poi-result')].length > 0`, 30000));
    c.check('首选结果为人民公园', await page.evaluate(`/人民公园/.test((document.querySelector('#sheet .poi-result .n')||{}).textContent||'')`));
    await page.evaluate(`document.querySelector('#sheet .poi-result').click()`);
    await sleep(1200);
    c.check('选定后进入第三步并显示场所', await page.evaluate(`document.body.textContent.includes('人民公园') && document.body.textContent.includes('怎么安排')`));

    c.check('打开起点弹层', await clickText(page, '更改'));
    await sleep(600);
    c.check('选择搜索地点', await clickText(page, '搜索地点'));
    await sleep(700);
    await typeIn(page, '鹤鸣茶社', '#sheet input');
    c.check('真实 POI 搜索命中', await waitFor(page, `[...document.querySelectorAll('#sheet .poi-result')].length > 0`, 30000));
    await page.evaluate(`document.querySelector('#sheet .poi-result').click()`);
    await sleep(1000);
    c.check('起点已写入第三步', await page.evaluate(`document.body.textContent.includes('鹤鸣茶社')`));
    c.check('再次生成路线', await page.evaluate(`(() => { const b = document.querySelector('.bottom-bar .btn'); if (!b || b.disabled) return false; b.click(); return true; })()`));
    c.check('手动路径也能出路线', await waitFor(page, `document.querySelectorAll('.route-card').length >= 1`, 120000));

    /* ============ 链路 C：随便逛逛（周边真实检索） ============ */
    await page.evaluate(`(() => {
      const raw = localStorage.getItem('st_draft_v1'); const d = raw ? JSON.parse(raw) : {};
      Object.assign(d, {
        step: 1, scene: null, venueId: null, venueRef: null,
        origin: { lng: 104.0809, lat: 30.657, crs: 'GCJ02', label: '春熙路(测试起点)', source: 'map_pick' },
        text: '',
      });
      localStorage.setItem('st_draft_v1', JSON.stringify(d));
      location.hash = '#/';
      location.reload();
    })()`);
    await sleep(2500);
    c.check('第一步选"随便走走"', await clickText(page, '随便走走', '.choice-card'));
    await sleep(900);
    c.check('随便走走直接进入第三步', await page.evaluate(`document.body.textContent.includes('怎么安排')`));
    await page.evaluate(`(() => { const b = document.querySelector('.bottom-bar .btn'); if (!b || b.disabled) return false; b.click(); return true; })()`);
    c.check('随便逛逛出真实周边路线', await waitFor(page, `document.querySelectorAll('.route-card').length >= 1`, 120000));

    const errs = await page.errors();
    c.check('无未捕获 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | '));
  } finally {
    await page.close();
  }
  process.exit(c.done() ? 0 : 1);
}

main().catch((e) => { console.error('PROBE ERROR', e); process.exit(1); });
