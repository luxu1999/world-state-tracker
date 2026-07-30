import { eventSource, event_types } from '../../../../script.js';

const PROCESSED = new WeakSet();
const DEBOUNCE_MS = 300;
let timer = null;

console.log('[WST] 扩展脚本已加载');

/**
 * 扫描所有 .mes 元素，给未处理的追加粉色框
 */
function scan() {
  const allMessages = document.querySelectorAll('.mes');
  console.log('[WST] scan() 发现消息数:', allMessages.length);

  for (const msg of allMessages) {
    if (PROCESSED.has(msg)) continue;
    if (msg.querySelector('.wst-card')) continue;

    PROCESSED.add(msg);

    const card = document.createElement('div');
    card.className = 'wst-card';
    card.textContent = 'WST';
    msg.appendChild(card);

    console.log('[WST] 已追加粉色框到一条消息');
  }
}

/**
 * 监听 ST 事件：消息渲染完成
 */
eventSource.on(event_types.MESSAGE_RECEIVED, () => {
  console.log('[WST] MESSAGE_RECEIVED 事件触发');
  clearTimeout(timer);
  timer = setTimeout(scan, DEBOUNCE_MS);
});

eventSource.on(event_types.CHAT_CHANGED, () => {
  console.log('[WST] CHAT_CHANGED 事件触发');
  clearTimeout(timer);
  timer = setTimeout(scan, 500);
});

// 页面加载完也扫一遍
jQuery(() => {
  console.log('[WST] jQuery ready，开始初始扫描');
  setTimeout(scan, 1000);
});
