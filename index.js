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

// activate 钩子：扩展加载时初始化
export function onActivate() {
  console.log('[WST] 扩展激活');

  var ctx = SillyTavern.getContext();
  var eventSource = ctx.eventSource;
  var event_types = ctx.event_types;

  // 监听 AI 消息渲染完成
  eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, function () {
    console.log('[WST] CHARACTER_MESSAGE_RENDERED');
    clearTimeout(timer);
    timer = setTimeout(scan, DEBOUNCE_MS);
  });

  // 切换聊天时重新扫描
  eventSource.on(event_types.CHAT_CHANGED, function () {
    console.log('[WST] CHAT_CHANGED');
    clearTimeout(timer);
    timer = setTimeout(scan, 500);
  });

  // 初始扫描
  setTimeout(scan, 1000);
}
