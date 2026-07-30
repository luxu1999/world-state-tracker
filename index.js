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
    var allMessages = document.querySelectorAll('.mes');

    for (var i = 0; i < allMessages.length; i++) {
      var msg = allMessages[i];
      if (PROCESSED.has(msg)) continue;
      if (msg.querySelector('.wst-card')) continue;

      PROCESSED.add(msg);

      var temp = document.createElement('div');
      temp.innerHTML = buildCardHTML();
      msg.appendChild(temp.firstChild);
    }
  }

  // 监听 ST 事件
  if (typeof eventSource !== 'undefined' && typeof event_types !== 'undefined') {
    eventSource.on(event_types.MESSAGE_RECEIVED, function () {
      clearTimeout(timer);
      timer = setTimeout(scan, DEBOUNCE_MS);
    });

    eventSource.on(event_types.CHAT_CHANGED, function () {
      clearTimeout(timer);
      timer = setTimeout(scan, 500);
    });
  } else {
    // 兜底：MutationObserver
    var chat = document.querySelector('#chat') || document.body;
    if (chat) {
      var observer = new MutationObserver(function () {
        clearTimeout(timer);
        timer = setTimeout(scan, DEBOUNCE_MS);
      });
      observer.observe(chat, { childList: true, subtree: true });
    }
  }

  // 初始扫描
  if (typeof jQuery !== 'undefined') {
    jQuery(function () {
      setTimeout(scan, 1000);
    });
  } else {
    window.addEventListener('load', function () {
      setTimeout(scan, 1000);
    });
  }
})();
