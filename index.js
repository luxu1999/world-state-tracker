(function () {
  'use strict';

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
    const lines = FIELDS.map(function (f) {
      return '<div class="wst-card__line">' + f + '</div>';
    }).join('');
    return '<div class="wst-card"><div class="wst-card__title">状态追踪</div>' + lines + '</div>';
  }

  function scan() {
    const allMessages = document.querySelectorAll('.mes');
    for (let i = 0; i < allMessages.length; i++) {
      const msg = allMessages[i];
      if (PROCESSED.has(msg)) continue;
      if (msg.querySelector('.wst-card')) continue;
      PROCESSED.add(msg);

      const temp = document.createElement('div');
      temp.innerHTML = buildCardHTML();
      msg.appendChild(temp.firstChild);
    }
  }

  // 官方示例使用 jQuery 初始化
  jQuery(async function () {
    console.log('[WST] jQuery ready');

    // 通过 SillyTavern.getContext() 获取事件系统
    try {
      const ctx = SillyTavern.getContext();
      const { eventSource, event_types } = ctx;

      eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, function () {
        clearTimeout(timer);
        timer = setTimeout(scan, DEBOUNCE_MS);
      });

      eventSource.on(event_types.CHAT_CHANGED, function () {
        clearTimeout(timer);
        timer = setTimeout(scan, 500);
      });

      console.log('[WST] 事件监听已注册');
    } catch (e) {
      console.warn('[WST] getContext 失败，使用 MutationObserver 兜底:', e);

      const chat = document.querySelector('#chat') || document.body;
      const observer = new MutationObserver(function () {
        clearTimeout(timer);
        timer = setTimeout(scan, DEBOUNCE_MS);
      });
      observer.observe(chat, { childList: true, subtree: true });
    }

    // 初始扫描
    setTimeout(scan, 1000);
  });
})();
