import { eventSource, event_types } from '../../../../script.js';

const PROCESSED = new WeakSet();
const DEBOUNCE_MS = 300;
let timer = null;

const FIELDS = [
  '时间：',
  '区域：',
  '在场角色+BUFF：',
  '不在场角色：',
  '处女膜状态：',
  '做爱次数：',
  '当前好感度：',
  '重要记忆点：',
  '身体外貌：',
];

function buildCardHTML() {
  const lines = FIELDS.map(f => `<div class="wst-card__line">${f}</div>`).join('');
  return `
    <div class="wst-card">
      <div class="wst-card__title">状态追踪</div>
      ${lines}
    </div>
  `;
}

function scan() {
  const allMessages = document.querySelectorAll('.mes');

  for (const msg of allMessages) {
    if (PROCESSED.has(msg)) continue;
    if (msg.querySelector('.wst-card')) continue;

    PROCESSED.add(msg);

    const temp = document.createElement('div');
    temp.innerHTML = buildCardHTML();
    const card = temp.firstChild;
    msg.appendChild(card);
  }
}

eventSource.on(event_types.MESSAGE_RECEIVED, () => {
  clearTimeout(timer);
  timer = setTimeout(scan, DEBOUNCE_MS);
});

eventSource.on(event_types.CHAT_CHANGED, () => {
  clearTimeout(timer);
  timer = setTimeout(scan, 500);
});

jQuery(() => {
  setTimeout(scan, 1000);
});
