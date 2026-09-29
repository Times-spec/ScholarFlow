// 城市多日行程规划器：表单 → 确定性规划结果 → 保存为行程单 / 预约导游
import { get, post } from './api.js';
import { h, toast } from './ui.js';

const INTERESTS = ['人文', '自然', '建筑', '街区', '美食', '公园湿地', '亲子', '夜景'];
const PACE_TXT = { easy: '轻松（一天 1 处主游）', normal: '适中（1-2 处/天）', active: '紧凑（2-3 处/天）' };
const BUDGET_TXT = { economy: '经济（餐饮约 ¥80/天）', comfort: '舒适（约 ¥150/天）', premium: '品质（约 ¥260/天）' };

export async function renderItinerary(view, ctx, query) {
  const citiesData = await get('/v1/hub/cities');
  const form = {
    cityId: query.get('city') || 'beijing',
    days: 3, interests: [], pace: 'normal', budget: 'comfort', people: 2,
  };

  const resultBox = h('div', {});

  view.append(
    h('div', { class: 'card' },
      h('h3', {}, '城市多日行程规划'),
      h('div', { class: 'tl-meta' }, '确定性算法：按评分+兴趣权重选场所，按地理就近串每日动线；票价为参考值（未核验）'),
      h('div', { class: 'field', style: 'margin-top:10px' }, h('label', { class: 'field-label' }, '目的地'),
        h('select', { class: 'input', id: 'it-city' },
          ...citiesData.cities.map((c) => h('option', { value: c.id, selected: c.id === form.cityId }, `${c.name}（${c.venueCount} 处场所）`)))),
      h('div', { class: 'field' }, h('label', { class: 'field-label' }, '天数'),
        h('select', { class: 'input', id: 'it-days' },
          ...[1, 2, 3, 4, 5, 6, 7].map((n) => h('option', { value: String(n), selected: n === form.days }, `${n} 天`)))),
      h('div', { class: 'field' }, h('label', { class: 'field-label' }, '兴趣（不选 = 综合）'),
        h('div', { class: 'chips', id: 'it-interests' },
          ...INTERESTS.map((t) => h('button', {
            class: 'chip',
            onclick: (e) => {
              e.target.classList.toggle('sel');
              if (form.interests.includes(t)) form.interests = form.interests.filter((x) => x !== t);
              else form.interests.push(t);
            },
          }, t)))),
      h('div', { class: 'field' }, h('label', { class: 'field-label' }, '节奏'),
        h('select', { class: 'input', id: 'it-pace' },
          ...Object.keys(PACE_TXT).map((k) => h('option', { value: k }, PACE_TXT[k])))),
      h('div', { class: 'field' }, h('label', { class: 'field-label' }, '预算档'),
        h('select', { class: 'input', id: 'it-budget' },
          ...Object.keys(BUDGET_TXT).map((k) => h('option', { value: k }, BUDGET_TXT[k])))),
      h('div', { class: 'field' }, h('label', { class: 'field-label' }, '人数'),
        h('select', { class: 'input', id: 'it-people' },
          ...[1, 2, 3, 4, 5, 6, 8, 10].map((n) => h('option', { value: String(n) }, `${n} 人`)))),
      h('button', { class: 'btn btn-primary btn-lg', onclick: generate }, '生成行程')),
    resultBox,
  );

  async function generate() {
    form.cityId = document.getElementById('it-city').value;
    form.days = Number(document.getElementById('it-days').value);
    form.pace = document.getElementById('it-pace').value;
    form.budget = document.getElementById('it-budget').value;
    form.people = Number(document.getElementById('it-people').value);
    resultBox.innerHTML = '';
    resultBox.append(h('div', { class: 'card empty' }, '正在计算行程…'));
    try {
      const plan = await post('/v1/itineraries/preview', form);
      renderResult(plan);
    } catch (e) {
      resultBox.innerHTML = '';
      resultBox.append(h('div', { class: 'card empty' }, '生成失败：' + e.message));
    }
  }

  function renderResult(plan) {
    resultBox.innerHTML = '';
    resultBox.append(
      h('div', { class: 'card itin-hero' },
        h('h3', { style: 'margin:0' }, `${plan.cityName} · ${plan.days} 日行程`),
        h('div', { class: 'tl-meta' }, `${PACE_TXT[plan.pace]} · ${plan.people} 人 · 人均预估 ¥${Math.round(plan.totals.total / plan.people)} / 总预估 ¥${plan.totals.total}`),
        h('div', { class: 'itin-total' },
          h('div', {}, '门票参考 ', h('b', {}, `¥${plan.totals.tickets}`)),
          h('div', {}, '餐饮 ', h('b', {}, `¥${plan.totals.meals}`)),
          h('div', {}, '市内交通 ', h('b', {}, `¥${plan.totals.transport}`))),
        h('div', { class: 'tl-actions' },
          h('button', {
            class: 'btn btn-primary btn-sm',
            onclick: async () => {
              try {
                await post('/v1/orders', { type: 'itinerary', cityId: plan.cityId, people: plan.people, itinerary: plan });
                toast('已保存到「我的行程单」', 2500);
                location.hash = '#/me';
              } catch (e) { toast(e.message, 3000); }
            },
          }, '保存为行程单'))),
      ...plan.itinerary.map((d) => h('div', { class: 'card itin-day' },
        h('div', { class: 'itin-day-head' },
          h('span', { class: 'itin-day-num' }, `D${d.day}`),
          h('b', {}, d.theme || '自由活动')),
        ...d.slots.map((s) => h('div', { class: 'itin-slot' },
          h('div', { class: 'itin-slot-tag' }, s.slot),
          h('div', { class: 'itin-slot-body' },
            h('div', { class: 'itin-slot-name' },
              s.name,
              h('span', { class: 'tag' }, s.kind),
              s.level ? h('span', { class: 'tag' }, s.level) : null,
              h('span', { class: 'tag', style: 'background:#eef3f0' }, `约 ${s.suggestedHours}h`),
              h('button', { class: 'btn btn-ghost btn-sm', style: 'margin-left:auto', onclick: () => { location.hash = '#/venue/' + s.venueId; } }, '详情')),
            h('div', { class: 'itin-pois' }, ...(s.pois || []).map((p) => h('div', { class: 'itin-poi' },
              p.mustSee ? h('span', { class: 'tag', style: 'background:var(--warn-bg);color:var(--warn)' }, '必看') : h('span', { class: 'tag' }, '看点'),
              ' ', p.name, p.brief ? ` — ${p.brief}` : ''))),
            h('div', { class: 'tl-meta' }, `门票：${s.ticket.referencePriceCny === 0 ? '免费' : s.ticket.referencePriceCny ? `约 ¥${s.ticket.referencePriceCny}/人` : '未知'}${s.ticket.known ? '' : '（未核验）'}${s.ticket.note ? ' · ' + s.ticket.note : ''}`)))),
        d.transferTips && d.transferTips.length ? h('div', { class: 'itin-transfer' }, ...d.transferTips.map((t) => h('div', {}, '🚶 ' + t))) : null,
        h('div', { class: 'itin-day-budget' }, `当日预估 ¥${d.budgetCny.total}（门票 ¥${d.budgetCny.tickets} · 餐饮 ¥${d.budgetCny.meals} · 交通 ¥${d.budgetCny.transport}）`))),
      h('div', { class: 'card' },
        h('p', { class: 'card-title' }, '诚实边界'),
        ...plan.notices.map((n) => h('div', { class: 'warn-line' }, 'ℹ ' + n))),
    );
    resultBox.scrollIntoView({ behavior: 'smooth' });
  }
}
