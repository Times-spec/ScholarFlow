// 语音导览播放器：浏览器 speechSynthesis 播报（页面明确标注"浏览器语音"，非真人录音/TTS 服务）
import { h, toast } from './ui.js';

/**
 * 讲解条组件：播放/停止/语速，支持多条讲解自动连播。
 * narration: {poiName, teaser, shortScript, detail}
 * 返回 {el, destroy}
 */
export function createNarrator(narration, { autoPlay = false } = {}) {
  const supported = 'speechSynthesis' in window;
  let playing = false;
  let rate = 1;
  let queue = [];
  let destroyed = false;

  const statusEl = h('span', { class: 'narr-status' }, supported ? '' : '当前浏览器不支持语音');
  const playBtn = h('button', { class: 'btn btn-primary btn-sm narr-play' }, supported ? '▶ 播放讲解' : '语音不可用');

  const scripts = () => {
    const parts = [];
    if (narration.poiName) parts.push(`现在来到${narration.poiName}。`);
    if (narration.shortScript) parts.push(narration.shortScript);
    if (narration.detail) parts.push(narration.detail);
    return parts.length ? parts : ['（该讲解暂无内容）'];
  };

  function speakNext(i) {
    if (destroyed || !playing) return;
    if (i >= queue.length) { stop(); return; }
    const u = new SpeechSynthesisUtterance(queue[i]);
    u.lang = 'zh-CN';
    u.rate = rate;
    u.onend = () => speakNext(i + 1);
    u.onerror = () => { stop(); toast('语音播报中断', 2000); };
    speechSynthesis.speak(u);
  }

  function play() {
    if (!supported) return;
    playing = true;
    queue = scripts();
    speechSynthesis.cancel();
    statusEl.textContent = '正在播报…（浏览器语音）';
    playBtn.textContent = '■ 停止';
    speakNext(0);
  }
  function stop() {
    playing = false;
    if (supported) speechSynthesis.cancel();
    statusEl.textContent = '';
    playBtn.textContent = '▶ 播放讲解';
  }

  playBtn.addEventListener('click', () => (playing ? stop() : play()));
  if (autoPlay && supported) setTimeout(play, 300);

  const el = h('div', { class: 'narrator' },
    h('div', { class: 'narrator-bar' },
      playBtn,
      h('label', { class: 'narr-rate' }, '语速 ',
        h('select', {
          onchange: (e) => { rate = Number(e.target.value); if (playing) { const keep = playing; stop(); if (keep) play(); } },
        },
        h('option', { value: '0.8' }, '慢'),
        h('option', { value: '1', selected: true }, '正常'),
        h('option', { value: '1.25' }, '快'))),
      statusEl),
    h('div', { class: 'narr-note' }, '讲解播报使用浏览器语音合成（演示方式），非真人录音；文字稿全文见下。'),
  );

  return {
    el,
    destroy() { destroyed = true; stop(); },
  };
}

/** 讲解卡：到了看什么 / 简短讲解 / 深入了解 / 出处与传说标注 */
export function narrationCard(narration, { autoPlay = false, compact = false } = {}) {
  const card = h('div', { class: 'card narration-card' });
  if (!narration) {
    card.append(h('div', { class: 'tl-meta' }, '该点位暂无已核验讲解内容，我们不凭空介绍。'));
    return card;
  }
  const narrator = createNarrator(narration, { autoPlay });
  card.append(
    h('p', { class: 'card-title' }, (narration.poiName || '场所导览') + ' · 讲解'),
    narrator.el,
    h('div', { class: 'guide-teaser' },
      h('span', { class: 'tag' }, '到了看什么'), ' ', narration.teaser || ''),
    h('div', { class: 'guide-block' }, narration.shortScript || ''),
  );
  if (!compact && narration.detail) {
    const det = h('div', { class: 'guide-detail hidden' }, narration.detail);
    card.append(
      h('button', {
        class: 'link-btn',
        onclick: () => { det.classList.toggle('hidden'); btn.textContent = det.classList.contains('hidden') ? '深入了解 ▾' : '收起 ▴'; },
      }, '深入了解 ▾'),
      det);
  }
  const claims = narration.claims || [];
  if (claims.length) {
    card.append(h('div', { class: 'narr-claims' },
      h('p', { class: 'card-title' }, '看点与典故（含来源与传说标注）'),
      ...claims.map((c) => h('div', { class: 'claim-item' },
        c.legend ? h('span', { class: 'tag warn' }, '传说') : h('span', { class: 'tag' }, '史实'),
        ' ', c.text)),
    ));
  }
  const sources = narration.sources || [];
  if (sources.length) {
    card.append(h('div', { class: 'tl-meta' },
      '资料来源：', sources.map((s) => s.title).filter(Boolean).join('、'),
      ' · 内容库 v1（公开资料整理，未实地核验）'));
  }
  return card;
}
