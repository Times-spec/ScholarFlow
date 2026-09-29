'use strict';
/** UI 端到端探针（夹具回归）：向导式首页 → 规划 → 导游模式游览 → AI 调整 → 游记回顾 */
const { open, checker, sleep } = require('C:/Users/24800/.workbuddy/skills/web-ui-bug-repro/scripts/cdp.js');

const BASE = 'http://127.0.0.1:8080';
const SHOTS = 'F:/webos/shots';
const c = checker();

async function waitFor(page, expr, ms = 20000, step = 400) {
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
const tomorrow9 = `(() => { const a = new Date(); a.setDate(a.getDate() + 1); a.setHours(9, 0, 0, 0); return a.getTime(); })()`;

async function main() {
  const page = await open({ url: BASE + '/#/', width: 420, height: 860, settleMs: 2500 });
  try {
    /* 1. 向导第一步：先做选择，而不是直接丢输入框 */
    await page.evaluate(`localStorage.removeItem('st_draft_v1'); location.reload()`);
    await sleep(2800);
    const step1 = await page.json(`({
      steps: document.querySelectorAll('.steps .step').length,
      choices: document.querySelectorAll('.choice-card').length,
      primary: (document.querySelector('.bottom-bar .btn')||{}).textContent || '',
      aiCollapsed: (document.getElementById('ai-assist-body')||{}).className || '',
    })`);
    c.check('第一步要求用户先选逛法（两个选择）', step1.steps === 3 && step1.choices === 2, JSON.stringify(step1));
    c.check('底部按钮为"下一步"（不是直接生成）', step1.primary.includes('下一步'), step1.primary);
    c.check('AI 输入默认收起（不再是主入口）', /hidden/.test(step1.aiCollapsed));
    await page.screenshot(SHOTS + '/wizard-1.png');

    /* 2. 选"逛一个地方" → 第二步：挑地方 */
    c.check('点击"逛一个地方"', await clickText(page, '逛一个地方', '.choice-card'));
    await sleep(900);
    const step2 = await page.json(`({
      hasSearch: document.body.textContent.includes('搜索公园'),
      hasNearby: document.body.textContent.includes('我附近有什么可逛的'),
    })`);
    c.check('第二步引导挑地方（搜索 / 附近推荐）', step2.hasSearch && step2.hasNearby, JSON.stringify(step2));
    await page.screenshot(SHOTS + '/wizard-2.png');

    /* 3. 预置夹具场所与起点 → 第三步 → 生成路线 */
    await page.evaluate(`(() => {
      localStorage.setItem('st_draft_v1', JSON.stringify({
        step: 3, scene: 'venue', venueId: 'venue_qinghu', venueRef: null, objective: 'highlights',
        origin: { lng: 104.062, lat: 30.659, crs: 'GCJ02', entranceId: 'gate_south', label: '南门', source: 'map_pick' },
        timeMode: 'duration', durationSec: 7200, latestEndClock: '17:00',
        startMode: 'later', startAtMs: ${tomorrow9},
        endpointMode: 'return_to_origin', endpointPoint: null, endpointLabel: null, endpointEntranceId: null,
        mobility: 'walk', pace: 'normal', interests: ['自然','人文'], text: '',
        mustVisit: [], avoid: [], freePreferred: false, budgetHardZero: false,
        stepFreeRequired: false, stepFew: false, restPreferred: false, quietPreferred: false, guideStyle: 'normal',
      }));
      location.reload();
    })()`);
    await sleep(2500);
    const step3 = await page.json(`({
      origin: document.body.textContent.includes('南门'),
      duration: document.body.textContent.includes('2 小时'),
      interest: document.body.textContent.includes('自然'),
      primary: (document.querySelector('.bottom-bar .btn')||{}).textContent || '',
    })`);
    c.check('第三步汇总起点/时长/兴趣并可修改', step3.origin && step3.duration && step3.interest, JSON.stringify(step3));
    c.check('第三步底部按钮为"生成路线"', step3.primary.includes('生成路线'), step3.primary);
    await page.screenshot(SHOTS + '/wizard-3.png');

    c.check('点击生成路线', await page.evaluate(`(() => {
      const btn = document.querySelector('.bottom-bar .btn');
      if (!btn || btn.disabled) return false; btn.click(); return true;
    })()`));
    c.check('主推荐路线卡出现', await waitFor(page, `document.querySelectorAll('.route-card').length >= 1`, 40000));
    c.check('进度压缩为单行状态', await page.evaluate(`document.querySelectorAll('.stage-list').length === 0`));
    await waitFor(page, `document.querySelectorAll('.tl-item').length >= 1`, 20000);
    c.check('时间轴与地图渲染', await page.evaluate(`!!document.querySelector('.map-wrap svg, .map-wrap .amap-container, .map-wrap canvas') && document.querySelectorAll('.tl-item').length >= 2`));

    /* 4. 开始游览 → 导游模式 */
    c.check('点击开始游览', await clickText(page, '开始游览'));
    c.check('进入游览页', await waitFor(page, `location.hash.startsWith('#/trip/')`, 8000));
    const guide = await page.json(`({
      title: document.body.textContent.includes('下一站 · 看点'),
      teaser: !!document.querySelector('.guide-teaser'),
      ask: document.body.textContent.includes('问导游'),
      seeGuide: document.body.textContent.includes('看讲解'),
      adjust: document.body.textContent.includes('调整行程'),
    })`);
    c.check('导游模式：下一站先讲看点', guide.title && guide.teaser, JSON.stringify(guide));
    c.check('提供"看讲解 / 问导游 / 调整行程"入口', guide.ask && guide.seeGuide && guide.adjust);
    await page.screenshot(SHOTS + '/guide-trip.png');

    /* 5. 到站确认 → 自动端上讲解 */
    c.check('点击我已到达', await clickText(page, '我已到达'));
    const guideOpened = await waitFor(page, `document.body.textContent.includes('眼前看什么')`, 25000);
    c.check('到站后自动展示讲解（导游行为）', guideOpened);
    await page.screenshot(SHOTS + '/guide-arrive.png');
    await page.evaluate(`(() => { const m=document.querySelector('#sheet .sheet-mask'); if(m) m.click(); })()`);
    await sleep(600);
    c.check('到访计数更新', await page.evaluate(`/已完成 1\\//.test(document.body.textContent)`));

    /* 6. 问导游（只依据已核验资料） */
    c.check('打开问导游', await clickText(page, '问导游'));
    await sleep(600);
    c.check('问答弹层含诚实说明', await page.evaluate(`document.body.textContent.includes('只依据该点位已核验的讲解资料回答')`));
    await page.evaluate(`(() => {
      const input = document.querySelector('#sheet input');
      if (input) { input.value = '这里有什么典故？'; input.dispatchEvent(new Event('input', { bubbles: true })); }
      const b = [...document.querySelectorAll('#sheet button')].find(x => x.textContent.trim() === '问');
      if (b) b.click();
    })()`);
    const answered = await waitFor(page, `!!document.querySelector('.ask-answer')`, 45000);
    c.check('问答返回结果', answered);
    if (answered) {
      const ans = await page.evaluate(`document.querySelector('.ask-answer').textContent`);
      c.check('回答带出处或"暂无资料"说明', /资料|来源|没有提到|暂无/.test(ans), ans.slice(0, 60));
    }
    await page.screenshot(SHOTS + '/guide-ask.png');
    await page.evaluate(`(() => { const m=document.querySelector('#sheet .sheet-mask'); if(m) m.click(); })()`);
    await sleep(500);

    /* 7. 记一笔 + AI 调整行程 */
    c.check('打开看讲解', await clickText(page, '看讲解'));
    await sleep(1500);
    if (await clickText(page, '记一笔')) {
      await sleep(700);
      await page.evaluate(`(() => {
        const ta = document.querySelector('#sheet textarea');
        if (ta) { ta.value = '湖边风很舒服，看到两只白鹭'; ta.dispatchEvent(new Event('input', { bubbles: true })); }
      })()`);
      c.check('保存现场笔记', await clickText(page, '保存'));
      await sleep(1200);
    } else {
      c.check('保存现场笔记', false, '未找到记一笔入口');
    }
    await page.evaluate(`(() => { const m=document.querySelector('#sheet .sheet-mask'); if(m) m.click(); })()`);
    await sleep(400);

    c.check('打开调整行程（含 AI）', await clickText(page, '调整行程'));
    await sleep(600);
    c.check('调整弹层含 AI 输入与兜底按钮', await page.evaluate(`!!document.querySelector('#sheet .ai-input') && document.querySelectorAll('#sheet .quick-btn').length === 8`));
    await page.evaluate(`(() => {
      const ta = document.querySelector('#sheet .ai-input');
      if (ta) { ta.value = '我有点累了'; ta.dispatchEvent(new Event('input', { bubbles: true })); }
    })()`);
    await clickText(page, '让 AI 安排');
    const proposalOk = await waitFor(page, `document.body.textContent.includes('调整方案')`, 45000);
    c.check('AI 理解"我累了"并给出调整方案', proposalOk);
    if (proposalOk) {
      c.check('接受新路线', await clickText(page, '接受新路线'));
      await sleep(1500);
    }

    /* 8. 结束 → 游记小结 */
    c.check('点击结束游览', await clickText(page, '结束游览'));
    await sleep(500);
    c.check('确认结束', await clickText(page, '结束并生成回顾'));
    c.check('进入小结页', await waitFor(page, `location.hash.startsWith('#/finish/')`, 8000));
    const fin = await page.json(`({
      title: /游览小结|先逛到这儿/.test(document.body.textContent),
      highlights: document.querySelectorAll('.highlight-item').length,
      note: document.body.textContent.includes('湖边风很舒服'),
      share: document.body.textContent.includes('复制小结'),
      honest: document.body.textContent.includes('规划距离'),
    })`);
    c.check('小结以"走过的地方"为主（导游视角）', fin.title && fin.highlights >= 1, JSON.stringify(fin));
    c.check('现场笔记进入小结', fin.note);
    c.check('可复制分享 + 距离诚实标注', fin.share && fin.honest);
    // 守卫：原生 append 传 null 会渲染成字面量 "null"（本类 bug 已出现两次）
    const strayNull = await page.evaluate(`/\\bnull\\b/.test(document.getElementById('view').textContent)`);
    c.check('页面不出现字面量 null', strayNull === false);
    await page.screenshot(SHOTS + '/travelogue.png');

    /* 9. 我的 / 数据 */
    await page.evaluate(`location.hash = '#/me'`);
    await sleep(1500);
    c.check('我的：历史/汇总/偏好', await page.evaluate(`document.body.textContent.includes('历史行程') && document.body.textContent.includes('个性化偏好')`));
    await page.evaluate(`location.hash = '#/admin'`);
    await sleep(1800);
    c.check('数据页：说明数据来源', await page.evaluate(`document.body.textContent.includes('场所数据来源')`));

    const errs = await page.errors();
    c.check('全程无未捕获 JS 异常', errs.length === 0, errs.slice(0, 3).join(' | '));
    c.check('无意外 JS 对话框阻塞', page.dialogCount() === 0);
  } finally {
    await page.close();
  }
  process.exit(c.done() ? 0 : 1);
}

main().catch((e) => { console.error('PROBE ERROR', e); process.exit(1); });
