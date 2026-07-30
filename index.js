(function () {
  'use strict';

  // ==================== 常量 ====================
  var STORAGE_PREFIX = 'wst_state_';
  var MAX_MEMORIES_PER_CHAR = 6;
  var MAX_MEMORY_LENGTH = 70;
  var DEBOUNCE_MS = 300;
  var PROCESSED = new WeakSet();
  var timer = null;
  var currentChatId = null;
  var lastStateSentHash = '';   // 避免重复注入

  // 重要记忆评分关键词
  var IMPORTANCE_KEYWORDS = [
    { re: /死[亡去]|丧命|逝世|去世|牺牲|杀死|杀害|处死/, weight: 100 },
    { re: /失去|丧失|永别|再也.*见不到|不复存在/, weight: 90 },
    { re: /人生.*改变|改变.*人生|命运.*转折|生命.*转折/, weight: 85 },
    { re: /觉醒|发现.*能力|获得.*力量|突破.*极限|领悟/, weight: 80 },
    { re: /第一次|初次|破处|初夜|初吻|首次/, weight: 75 },
    { re: /结婚|离婚|订婚|分手|求婚|表白|告白/, weight: 70 },
    { re: /决定.*重要|重大.*决定|选择.*道路|抉择/, weight: 65 },
    { re: /受伤|重伤|濒死|险些.*死|差点.*死|遇难/, weight: 60 },
    { re: /背叛|出卖|欺骗|被.*骗|利用/, weight: 60 },
    { re: /怀孕|生子|产子|流产|堕胎|生下/, weight: 55 },
    { re: /崩溃|绝望|无法.*接受|精神.*摧毁|心理.*阴影/, weight: 50 },
    { re: /永远.*记住|铭记|终生难忘|刻骨铭心|永生难忘/, weight: 45 },
    { re: /亲人|父母|母亲|父亲|兄妹|姐弟|子女|孩子|家庭/, weight: 35 },
    { re: /拯救|拯救者|救命之恩|救了/, weight: 35 },
    { re: /毁灭|摧毁|破坏|覆灭|灭亡/, weight: 35 },
  ];

  // 字段定义（严格按用户要求的顺序）
  var FIELDS = [
    { key: 'time',       label: '时间：' },
    { key: 'location',   label: '区域：' },
    { key: 'present',    label: '在场角色+BUFF：' },
    { key: 'absent',     label: '不在场角色：' },
    { key: 'hymen',      label: '处女膜状态：' },
    { key: 'sexCount',   label: '做爱次数：' },
    { key: 'affection',  label: '当前好感度：' },
    { key: 'appearance', label: '身体外貌：' },
    { key: 'memories',   label: '重要记忆点：' },
  ];

  // ==================== 工具函数 ====================
  function escapeHTML(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function getChatId() {
    try {
      var ctx = SillyTavern.getContext();
      if (ctx.chat && ctx.chat.metadata && ctx.chat.metadata.file_name) return ctx.chat.metadata.file_name;
      if (ctx.characters && ctx.characters.current && ctx.characters.current.name) return ctx.characters.current.name;
      return 'default';
    } catch (e) { return 'default'; }
  }

  function hasContent(state) {
    if (!state) return false;
    return !!(state.time || state.location || state.present ||
      state.absent || state.hymen || state.sexCount ||
      state.affection || state.appearance ||
      (state.memories && Object.keys(state.memories).length > 0));
  }

  function hashState(state) {
    return JSON.stringify(state).length + '_' + (state.time || '') + '_' + (state.location || '');
  }

  // ==================== 状态持久化 ====================
  function loadState() {
    try {
      var raw = localStorage.getItem(STORAGE_PREFIX + getChatId());
      return raw ? JSON.parse(raw) : createEmptyState();
    } catch (e) { return createEmptyState(); }
  }

  function createEmptyState() {
    return {
      time: '',
      location: '',
      present: '',
      absent: '',
      hymen: '',
      sexCount: '',
      affection: '',
      appearance: '',
      memories: {}
    };
  }

  function saveState(state) {
    try {
      localStorage.setItem(STORAGE_PREFIX + getChatId(), JSON.stringify(state));
    } catch (e) { console.warn('[WST] 保存状态失败:', e); }
  }

  // ==================== 世界书读取 ====================
  function getWorldBookEntries() {
    try {
      var ctx = SillyTavern.getContext();
      // 尝试多条路径读取世界书
      if (ctx.worldInfo && Array.isArray(ctx.worldInfo) && ctx.worldInfo.length > 0) {
        return ctx.worldInfo;
      }
      // 角色级别的世界书
      if (ctx.characters && ctx.characters.current && ctx.characters.current.data) {
        var ext = ctx.characters.current.data.extensions;
        if (ext && ext.world_info && Array.isArray(ext.world_info)) {
          return ext.world_info;
        }
      }
      // 聊天级别的世界书
      if (ctx.chat && ctx.chat.metadata && ctx.chat.metadata.world_info) {
        return ctx.chat.metadata.world_info;
      }
      return [];
    } catch (e) {
      console.warn('[WST] 读取世界书失败:', e.message);
      return [];
    }
  }

  function getWorldBookData() {
    var entries = getWorldBookEntries();
    var characterKeys = [];
    var favorabilityContent = null;

    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var key = (entry.key || '').trim();
      var content = (entry.content || '').trim();
      var comment = (entry.comment || '').trim();

      // 收集所有 key（可能包含角色名）
      if (key) {
        var keys = key.split(',').map(function (k) { return k.trim(); }).filter(Boolean);
        for (var j = 0; j < keys.length; j++) {
          if (characterKeys.indexOf(keys[j]) === -1) {
            characterKeys.push(keys[j]);
          }
        }
      }
      // comment 也可能是角色名
      if (comment && characterKeys.indexOf(comment) === -1) {
        characterKeys.push(comment);
      }

      // 检测好感系统
      if (!favorabilityContent) {
        var combined = key + ' ' + content + ' ' + comment;
        if (/好感系统|好感度规则|好感[机计]制|好感数值/.test(combined)) {
          favorabilityContent = content;
        }
      }
    }

    return {
      allKeys: characterKeys,
      favorabilitySystem: favorabilityContent
    };
  }

  // ==================== 默认好感度系统 ====================
  function getDefaultFavorabilitySystem() {
    return '好感度范围0-100，分档：0-20厌恶/敌意 | 21-40冷淡/陌生 | 41-60普通/友好 | 61-80信任/亲近 | 81-100深爱/忠诚。' +
           '每次互动根据对话内容增减，重大事件（背叛/告白/救命等）可引起10-30点变化，日常互动1-5点。';
  }

  // ==================== 记忆管理 ====================
  function scoreMemory(memory) {
    var score = 0;
    for (var i = 0; i < IMPORTANCE_KEYWORDS.length; i++) {
      if (IMPORTANCE_KEYWORDS[i].re.test(memory)) score += IMPORTANCE_KEYWORDS[i].weight;
    }
    score += Math.min(memory.length * 0.3, 15);
    return score;
  }

  function enforceMemoryLimits(memoriesMap) {
    var result = {};
    var chars = Object.keys(memoriesMap);
    for (var i = 0; i < chars.length; i++) {
      var charName = chars[i];
      var memories = memoriesMap[charName];
      if (!Array.isArray(memories)) continue;

      var scored = [];
      for (var j = 0; j < memories.length; j++) {
        var text = String(memories[j]).trim();
        if (!text) continue;
        if (text.length > MAX_MEMORY_LENGTH) text = text.slice(0, MAX_MEMORY_LENGTH);
        scored.push({ text: text, score: scoreMemory(text) });
      }

      var seen = {};
      var unique = [];
      for (var k = 0; k < scored.length; k++) {
        if (!seen[scored[k].text]) {
          seen[scored[k].text] = true;
          unique.push(scored[k]);
        }
      }

      unique.sort(function (a, b) { return b.score - a.score; });
      result[charName] = unique.slice(0, MAX_MEMORIES_PER_CHAR).map(function (m) { return m.text; });
    }
    return result;
  }

  // ==================== S-summary 解析 ====================
  function parseSummary(text) {
    var state = createEmptyState();
    if (!text || typeof text !== 'string') return state;

    text = text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    text = text.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');

    var lines = text.split('\n');

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;

      if (line.indexOf('时间：') === 0 || line.indexOf('时间:') === 0)
        state.time = line.replace(/^时间[：:]\s*/, '').trim();
      else if (line.indexOf('区域：') === 0 || line.indexOf('区域:') === 0)
        state.location = line.replace(/^区域[：:]\s*/, '').trim();
      else if (line.indexOf('在场角色+BUFF：') === 0 || line.indexOf('在场角色+BUFF:') === 0)
        state.present = line.replace(/^在场角色\+BUFF[：:]\s*/, '').trim();
      else if (line.indexOf('不在场角色：') === 0 || line.indexOf('不在场角色:') === 0)
        state.absent = line.replace(/^不在场角色[：:]\s*/, '').trim();
      else if (line.indexOf('处女膜状态：') === 0 || line.indexOf('处女膜状态:') === 0)
        state.hymen = line.replace(/^处女膜状态[：:]\s*/, '').trim();
      else if (line.indexOf('做爱次数：') === 0 || line.indexOf('做爱次数:') === 0)
        state.sexCount = line.replace(/^做爱次数[：:]\s*/, '').trim();
      else if (line.indexOf('当前好感度：') === 0 || line.indexOf('当前好感度:') === 0)
        state.affection = line.replace(/^当前好感度[：:]\s*/, '').trim();
      else if (line.indexOf('身体外貌：') === 0 || line.indexOf('身体外貌:') === 0)
        state.appearance = line.replace(/^身体外貌[：:]\s*/, '').trim();
    }

    var memSection = text.match(/重要记忆点[：:]\s*\n?([\s\S]*?)(?=\n\S|$)/);
    if (memSection) {
      var memText = memSection[1] || memSection[0].replace(/^重要记忆点[：:]\s*/, '');
      var charPattern = /[-•●◆▪▸►]\s*(.+?)[：:]\s*(.+)/g;
      var match;
      while ((match = charPattern.exec(memText)) !== null) {
        var charName = match[1].trim();
        var memList = match[2].split(/[|｜、\n]/).map(function (m) { return m.trim(); })
          .filter(function (m) { return m && m !== '-' && m !== '•'; });
        if (charName && memList.length > 0) state.memories[charName] = memList;
      }
    }

    state.memories = enforceMemoryLimits(state.memories);
    return state;
  }

  // ==================== 合并状态 ====================
  function mergeState(oldState, newState) {
    var merged = {
      time: newState.time || oldState.time || '',
      location: newState.location || oldState.location || '',
      present: newState.present || oldState.present || '',
      absent: newState.absent || oldState.absent || '',
      hymen: newState.hymen || oldState.hymen || '',
      sexCount: newState.sexCount || oldState.sexCount || '',
      affection: newState.affection || oldState.affection || '',
      appearance: newState.appearance || oldState.appearance || '',
      memories: (newState.memories && Object.keys(newState.memories).length > 0)
        ? newState.memories : (oldState.memories || {})
    };

    if (newState.memories && Object.keys(newState.memories).length > 0) {
      var mergedMemories = {};
      var oldChars = Object.keys(oldState.memories || {});
      for (var i = 0; i < oldChars.length; i++) {
        mergedMemories[oldChars[i]] = (oldState.memories[oldChars[i]] || []).slice();
      }
      var newChars = Object.keys(newState.memories);
      for (var j = 0; j < newChars.length; j++) {
        var ch = newChars[j];
        var newMems = newState.memories[ch] || [];
        var oldMems = mergedMemories[ch] || [];
        var seen = {};
        var combined = [];
        for (var k = 0; k < newMems.length; k++) {
          if (!seen[newMems[k]]) { seen[newMems[k]] = true; combined.push(newMems[k]); }
        }
        for (var l = 0; l < oldMems.length; l++) {
          if (!seen[oldMems[l]]) { seen[oldMems[l]] = true; combined.push(oldMems[l]); }
        }
        mergedMemories[ch] = combined;
      }
      merged.memories = enforceMemoryLimits(mergedMemories);
    }
    return merged;
  }

  // ==================== 构建 Prompt 注入文本 ====================
  function buildStatePrompt(state) {
    if (!state) return '';

    var wbData = getWorldBookData();
    var wbCharKeys = wbData.allKeys;
    var favorSys = wbData.favorabilitySystem || getDefaultFavorabilitySystem();

    var lines = [];
    lines.push('<WST_世界状态>');

    if (state.time)       lines.push('时间：' + state.time);
    if (state.location)   lines.push('区域：' + state.location);
    if (state.present)    lines.push('在场角色+BUFF：' + state.present);
    if (state.absent)     lines.push('不在场角色：' + state.absent);
    if (state.hymen)      lines.push('处女膜状态：' + state.hymen);
    if (state.sexCount)   lines.push('做爱次数：' + state.sexCount);
    if (state.affection)  lines.push('当前好感度：' + state.affection);
    if (state.appearance) lines.push('身体外貌：' + state.appearance);

    if (state.memories && Object.keys(state.memories).length > 0) {
      lines.push('重要记忆点：');
      var chars = Object.keys(state.memories);
      for (var i = 0; i < chars.length; i++) {
        var ch = chars[i];
        var mems = state.memories[ch];
        if (mems && mems.length > 0) lines.push('- ' + ch + '：' + mems.join('|'));
      }
    }

    // 世界书角色清单
    if (wbCharKeys.length > 0) {
      lines.push('');
      lines.push('[世界书角色]：' + wbCharKeys.join('、'));
      lines.push('规则：「在场角色+BUFF」和「不在场角色」中只能出现上述世界书中的角色名。');
    }

    // 好感度系统
    lines.push('');
    lines.push('[好感度系统]：' + favorSys);
    lines.push('规则：「当前好感度」必须严格按照上述好感度系统来计算和更新。');

    // 输出指令
    lines.push('');
    lines.push('请在回复末尾用 <S-summary> 标签输出更新后的世界状态。');
    lines.push('时间 = 上一轮时间 + 本轮事件大致经历的时长。');
    lines.push('重要记忆点每人最多6条，只记录改变人生的重要事件，每条不超过70字。');
    lines.push('</WST_世界状态>');

    return lines.join('\n');
  }

  // ==================== 卡片渲染 ====================
  function buildCardHTML(state) {
    var valueHTML = [];
    for (var i = 0; i < FIELDS.length; i++) {
      var f = FIELDS[i];
      var key = f.key;
      var value = '';

      if (key === 'memories') {
        if (state.memories && Object.keys(state.memories).length > 0) {
          var chars = Object.keys(state.memories);
          var parts = [];
          for (var j = 0; j < chars.length; j++) {
            var ch = chars[j];
            var mems = state.memories[ch];
            parts.push('<span class="wst-char-name">' + escapeHTML(ch) + '</span>：' + escapeHTML(mems.join('|')));
          }
          value = parts.join('<br>');
        }
      } else {
        value = escapeHTML(state[key] || '');
      }

      valueHTML.push(
        '<div class="wst-body__line" data-wst-key="' + key + '" title="点击编辑">' +
          f.label + value +
        '</div>'
      );
    }

    return (
      '<div class="wst-header">' +
        '<span class="wst-triangle"></span>' +
        '📋 状态追踪' +
      '</div>' +
      '<div class="wst-body">' + valueHTML.join('') + '</div>'
    );
  }

  function populateCard(cardBody, state) {
    if (!cardBody || !state) return;
    var lines = cardBody.querySelectorAll('.wst-body__line');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var key = line.getAttribute('data-wst-key');
      if (!key) continue;

      // IE-safe find
      var f = null;
      for (var fi = 0; fi < FIELDS.length; fi++) {
        if (FIELDS[fi].key === key) { f = FIELDS[fi]; break; }
      }
      if (!f) continue;

      if (key === 'memories') {
        if (state.memories && Object.keys(state.memories).length > 0) {
          var chars = Object.keys(state.memories);
          var parts = [];
          for (var j = 0; j < chars.length; j++) {
            var ch = chars[j];
            var mems = state.memories[ch];
            parts.push('<span class="wst-char-name">' + escapeHTML(ch) + '</span>：' + escapeHTML(mems.join('|')));
          }
          line.innerHTML = f.label + parts.join('<br>');
        } else {
          line.innerHTML = f.label;
        }
      } else {
        line.innerHTML = f.label + escapeHTML(state[key] || '');
      }
    }
  }

  // ==================== 从消息 DOM 提取 S-summary ====================
  function extractSummaryFromDOM(mesTextEl) {
    if (!mesTextEl) return null;

    var html = mesTextEl.innerHTML || '';
    var patterns = [
      /<S-summary>([\s\S]*?)<\/S-summary>/i,
      /&lt;S-summary&gt;([\s\S]*?)&lt;\/S-summary&gt;/i,
      /&lt;S-summary>([\s\S]*?)<\/S-summary>/i,
      /<S-summary>([\s\S]*?)&lt;\/S-summary&gt;/i,
    ];

    var match = null;
    for (var i = 0; i < patterns.length; i++) {
      match = html.match(patterns[i]);
      if (match) break;
    }
    if (!match) return null;

    mesTextEl.innerHTML = html.replace(match[0],
      '<span class="wst-raw-summary" style="display:none;">' + escapeHTML(match[0]) + '</span>'
    );

    console.log('[WST] 提取到 S-summary，长度:', match[1].length);
    return parseSummary(match[1]);
  }

  // ==================== 处理单条消息 ====================
  function processMessage(msg) {
    if (PROCESSED.has(msg)) return;
    PROCESSED.add(msg);

    var mesText = msg.querySelector('.mes_text');
    if (!mesText) return;

    var newState = extractSummaryFromDOM(mesText);

    if (newState) {
      var oldState = loadState();
      var merged = mergeState(oldState, newState);
      saveState(merged);
      console.log('[WST] 状态已更新');

      var existingBody = msg.querySelector('.wst-body');
      if (existingBody) {
        populateCard(existingBody, merged);
      } else {
        var temp = document.createElement('div');
        temp.innerHTML = buildCardHTML(merged);
        while (temp.firstChild) msg.appendChild(temp.firstChild);
      }
    } else {
      var existingState = loadState();
      if (hasContent(existingState)) {
        var existingBody = msg.querySelector('.wst-body');
        if (existingBody) {
          populateCard(existingBody, existingState);
        } else {
          var temp = document.createElement('div');
          temp.innerHTML = buildCardHTML(existingState);
          while (temp.firstChild) msg.appendChild(temp.firstChild);
        }
      }
    }
  }

  function scan() {
    var allMessages = document.querySelectorAll('.mes');
    for (var i = 0; i < allMessages.length; i++) {
      processMessage(allMessages[i]);
    }
  }

  // ==================== Prompt 注入（核心） ====================

  // 方法 A：DOM 捕获阶段拦截 — 在酒馆读取文本框之前注入状态
  function injectStateToTextarea() {
    var textarea = document.querySelector('#send_textarea');
    if (!textarea) return;

    // 如果内容为空（没有用户实际输入），不注入
    var userText = textarea.value.trim();
    if (!userText) return;

    // 如果已经包含 WST 标记，不再重复注入
    if (textarea.value.indexOf('<WST_世界状态>') !== -1) return;

    var state = loadState();
    if (!hasContent(state)) return;

    // 检查是否和上次注入的状态相同（避免连续重复注入）
    var currentHash = hashState(state);
    if (currentHash === lastStateSentHash && lastStateSentHash !== '') return;

    var stateText = buildStatePrompt(state);
    textarea.value = stateText + '\n\n' + textarea.value;
    lastStateSentHash = currentHash;
    console.log('[WST] ✅ 状态已注入到发送框 (' + stateText.length + ' chars)');
  }

  // 方法 B：修改聊天数组（兜底）
  function injectStateToChatArray() {
    try {
      var ctx = SillyTavern.getContext();
      if (!ctx.chat || !Array.isArray(ctx.chat)) return false;

      var state = loadState();
      if (!hasContent(state)) return false;

      var stateText = buildStatePrompt(state);

      // 先尝试 Extension Prompt API
      if (typeof ctx.setExtensionPrompt === 'function') {
        ctx.setExtensionPrompt('wst', stateText, 0);
        console.log('[WST] ✅ 状态通过 Extension Prompt API 注入');
        return true;
      }

      // 修改最后一条用户消息
      for (var i = ctx.chat.length - 1; i >= 0; i--) {
        if (ctx.chat[i].is_user) {
          var cleanMes = ctx.chat[i].mes.replace(/<WST_世界状态>[\s\S]*?<\/WST_世界状态>\n*/g, '');
          if (cleanMes.indexOf('<WST_世界状态>') === -1) {
            ctx.chat[i].mes = stateText + '\n\n' + cleanMes;
            console.log('[WST] ✅ 状态已注入到聊天数组[' + i + ']');
          }
          return true;
        }
      }
    } catch (e) {
      console.warn('[WST] 聊天数组注入失败:', e.message);
    }
    return false;
  }

  // ==================== DOM 事件拦截 ====================

  // 捕获 Enter 键（在酒馆处理之前修改文本框）
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    var textarea = document.querySelector('#send_textarea');
    if (!textarea || document.activeElement !== textarea) return;
    if (!textarea.value.trim()) return;
    injectStateToTextarea();
  }, true); // capture phase = 先于酒馆处理

  // 捕获发送按钮点击
  document.addEventListener('mousedown', function (e) {
    var sendBtn = e.target.closest('#send_but');
    if (!sendBtn) return;
    injectStateToTextarea();
  }, true);

  // ==================== 点击交互 ====================
  document.addEventListener('click', function (e) {
    // 折叠/展开
    var header = e.target.closest('.wst-header');
    if (header) {
      var body = header.nextElementSibling;
      if (body && body.classList.contains('wst-body')) {
        header.classList.toggle('wst-collapsed');
      }
      return;
    }

    // 手动编辑字段
    var line = e.target.closest('.wst-body__line');
    if (!line) return;
    var key = line.getAttribute('data-wst-key');
    if (!key) return;
    e.stopPropagation();

    var f = null;
    for (var fi = 0; fi < FIELDS.length; fi++) {
      if (FIELDS[fi].key === key) { f = FIELDS[fi]; break; }
    }
    if (!f) return;

    var state = loadState();
    var currentVal = '';

    if (key === 'memories') {
      var memPreview = [];
      var chars = Object.keys(state.memories || {});
      for (var i = 0; i < chars.length; i++) {
        var ch = chars[i];
        memPreview.push(ch + '：' + (state.memories[ch] || []).join('|'));
      }
      currentVal = memPreview.join('\n');
    } else {
      currentVal = state[key] || '';
    }

    var newVal = prompt('编辑 [' + f.label + ']', currentVal);
    if (newVal !== null) {
      if (key === 'memories') {
        var parsed = parseSummary('重要记忆点：\n' + newVal);
        state.memories = parsed.memories;
      } else {
        state[key] = newVal;
      }
      saveState(state);
      lastStateSentHash = ''; // 强制下次发送

      var allBodies = document.querySelectorAll('.wst-body');
      for (var j = 0; j < allBodies.length; j++) {
        populateCard(allBodies[j], state);
      }
    }
  });

  // ==================== 初始化 ====================
  jQuery(async function () {
    console.log('[WST] 🚀 世界状态追踪器 v2.1.0 初始化...');
    currentChatId = getChatId();

    // 打印世界书信息
    var wbData = getWorldBookData();
    if (wbData.allKeys.length > 0) {
      console.log('[WST] 📖 检测到世界书角色:', wbData.allKeys.join(', '));
    }
    if (wbData.favorabilitySystem) {
      console.log('[WST] 💕 检测到世界书好感系统 (长度:' + wbData.favorabilitySystem.length + ')');
    } else {
      console.log('[WST] 💕 未检测到好感系统，将使用默认规则');
    }

    try {
      var ctx = SillyTavern.getContext();
      var es = ctx.eventSource;
      var et = ctx.event_types;

      es.on(et.CHARACTER_MESSAGE_RENDERED, function () {
        clearTimeout(timer);
        lastStateSentHash = '';
        timer = setTimeout(scan, DEBOUNCE_MS);
      });

      es.on(et.MESSAGE_SENT, function () {
        lastStateSentHash = '';
        // 兜底：如果 DOM 拦截没生效，用聊天数组注入
        setTimeout(function () {
          injectStateToChatArray();
        }, 150);
      });

      es.on(et.GENERATION_STARTED, function () {
        injectStateToChatArray();
      });

      es.on(et.CHAT_CHANGED, function () {
        currentChatId = getChatId();
        lastStateSentHash = '';
        clearTimeout(timer);
        timer = setTimeout(scan, 500);
        console.log('[WST] 聊天已切换');
      });

      es.on(et.MESSAGE_UPDATED, function () {
        clearTimeout(timer);
        lastStateSentHash = '';
        timer = setTimeout(scan, DEBOUNCE_MS);
      });

      console.log('[WST] ✅ 全部事件监听已注册');

    } catch (e) {
      console.warn('[WST] 事件系统初始化失败，使用 MutationObserver:', e.message);
      var chat = document.querySelector('#chat') || document.body;
      var observer = new MutationObserver(function () {
        clearTimeout(timer);
        timer = setTimeout(scan, DEBOUNCE_MS);
      });
      observer.observe(chat, { childList: true, subtree: true });
    }

    setTimeout(scan, 1000);
  });
})();
