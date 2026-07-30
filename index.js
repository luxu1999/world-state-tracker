(function () {
  'use strict';

  const PROCESSED = new WeakSet();
  const DEBOUNCE_MS = 300;
  let observer = null;
  let timer = null;

  /** 扫描聊天区中新出现的 AI 消息，给每条追加粉色空框 */
  function scan() {
    // 酒馆消息容器的选择器
    const allMessages = document.querySelectorAll('.mes');

    for (const msg of allMessages) {
      // 跳过已处理过的
      if (PROCESSED.has(msg)) continue;
      // 跳过已有卡片的
      if (msg.querySelector('.wst-card')) continue;

      PROCESSED.add(msg);

      const card = document.createElement('div');
      card.className = 'wst-card';
      msg.appendChild(card);
    }
  }

  /** 启动 MutationObserver */
  function start() {
    const chat = document.querySelector('#chat') || document.body;

    observer = new MutationObserver(function () {
      clearTimeout(timer);
      timer = setTimeout(scan, DEBOUNCE_MS);
    });

    observer.observe(chat, { childList: true, subtree: true });

    // 立即扫描已存在的消息
    setTimeout(scan, 500);
  }

  // 等 DOM 就绪后启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
