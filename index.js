(function () {
  'use strict';

  // ==================== 常量 ====================
  var DEBOUNCE_MS = 300;
  var MAX_MEMORIES_PER_CHAR = 6;
  var MAX_MEMORY_LENGTH = 70;
  var timer = null;
  var currentChatId = null;
  var lastStateSentHash = '';   // 避免重复注入
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

  // 每消息独立状态快照 — 已废弃，使用 processMessageChain 按顺序维护状态链

  // ==================== 工具函数 ====================
  function escapeHTML(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function getChatId() {
    try {
      var ctx = SillyTavern.getContext();
      // 路径1：ST的chat_id（最可靠唯一ID）
      if (ctx.chatId) return 'chat_' + ctx.chatId;
      // 路径2：聊天文件名
      if (ctx.chat && ctx.chat.metadata) {
        if (ctx.chat.metadata.file_name) return ctx.chat.metadata.file_name;
        if (ctx.chat.metadata.id) return 'chat_' + ctx.chat.metadata.id;
      }
      // 路径3：角色ID+聊天ID组合
      var charId = ctx.characterId || (ctx.characters && ctx.characters.current && ctx.characters.current.id) || '';
      if (charId && ctx.chatId) return charId + '_' + ctx.chatId;
      // 路径4：角色名+聊天文件名（比纯角色名更唯一）
      var charName = ctx.characters && ctx.characters.current && ctx.characters.current.name ? ctx.characters.current.name : '';
      var chatFile = ctx.chat && ctx.chat.metadata && ctx.chat.metadata.file_name ? ctx.chat.metadata.file_name : '';
      if (charName && chatFile) return charName + '_' + chatFile;
      // 路径5：兜底，加聊天长度做区分（不同聊天长度通常不同）
      if (charName) return charName + '_' + (ctx.chat ? ctx.chat.length : 0);
      return 'default';
    } catch (e) { return 'default'; }
  }

  // 获取用户扮演的角色名（排除用）— 尝试多种路径
  var _cachedUserName = null;
  var _cachedUserNameChatId = null;
  function getUserPersonaName() {
    try {
      var ctx = SillyTavern.getContext();
      var cid = getChatId();
      if (_cachedUserName && _cachedUserNameChatId === cid) return _cachedUserName;

      // 路径1: ctx.name1（酒馆用户显示名）
      var name = ctx.name1 || '';
      if (name && name !== '用户' && name !== 'User' && name !== 'You') {
        _cachedUserName = name.trim();
        _cachedUserNameChatId = cid;
        return _cachedUserName;
      }

      // 路径2: persona 对象
      if (ctx.persona && ctx.persona.name && ctx.persona.name.trim()) {
        name = ctx.persona.name.trim();
        if (name !== '用户' && name !== 'User') {
          _cachedUserName = name;
          _cachedUserNameChatId = cid;
          return _cachedUserName;
        }
      }

      // 路径3: 从聊天记录中找用户消息的 name（最可靠）
      if (ctx.chat && Array.isArray(ctx.chat)) {
        for (var i = ctx.chat.length - 1; i >= 0; i--) {
          if (ctx.chat[i].is_user && ctx.chat[i].name) {
            var uname = ctx.chat[i].name.trim();
            if (uname && uname !== '用户' && uname !== 'User' && uname !== 'You') {
              _cachedUserName = uname;
              _cachedUserNameChatId = cid;
              console.log('[WST] 从聊天记录中检测到用户名:', uname);
              return _cachedUserName;
            }
          }
        }
      }

      _cachedUserName = '';
      _cachedUserNameChatId = cid;
      return '';
    } catch(e) { return ''; }
  }

  // 清除用户名缓存
  function clearUserNameCache() {
    _cachedUserName = null;
    _cachedUserNameChatId = null;
  }

  // 从文本中过滤掉用户扮演的角色名
  // 支持精确匹配和部分匹配（如"魔王·黯蚀" → "魔王"也能匹配）
  function removeUserFromText(text) {
    var userName = getUserPersonaName();
    if (!userName || !text) return text;

    // 提取基本名（去掉·后面的后缀）
    var baseName = userName.split(/[·•]/)[0].trim();
    var namesToRemove = [userName];
    if (baseName && baseName !== userName && baseName.length >= 1) {
      namesToRemove.push(baseName);
    }

    for (var ni = 0; ni < namesToRemove.length; ni++) {
      var n = namesToRemove[ni];
      if (n.length < 2) continue;
      var esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // 匹配完整角色名（含后缀和BUFF）
      var fullRe = new RegExp(
        esc +
        '(?:[·•][^，,、\\s(（)]+)?' +          // 可选·后缀
        '(?:[（(][^)）]*[)）])?' +                // 可选BUFF括号
        '(?:-[^，,、\\s]+)?' +                    // 可选-描述
        '(?=[，,、\\s]|$)',
        'g'
      );
      text = text.replace(fullRe, '');
    }

    // 清理残留：连续分隔符、首尾分隔符
    text = text.replace(/[，,、]{2,}/g, '，').replace(/[，,、]{2,}/g, '，');
    text = text.replace(/^[，,、\s]+/, '').replace(/[，,、\s]+$/, '');
    return text;
  }

  function hasContent(state) {
    if (!state) return false;
    return !!(state.time || state.location || state.present ||
      state.absent || state.hymen || state.sexCount ||
      state.affection || state.appearance ||
      (state.memories && Object.keys(state.memories).length > 0));
  }

  // 状态完全为空（从未被填充过）
  function isFirstTimeState(state) {
    if (!state) return true;
    return !state.time && !state.location && !state.present &&
      !state.absent && !state.hymen && !state.sexCount &&
      !state.affection && !state.appearance &&
      (!state.memories || Object.keys(state.memories).length === 0);
  }

  // 聊天是否有对话历史（不只是初始问候）
  function hasChatHistory() {
    try {
      var ctx = SillyTavern.getContext();
      if (ctx.chat && Array.isArray(ctx.chat)) {
        var count = 0;
        for (var i = 0; i < ctx.chat.length; i++) {
          if (ctx.chat[i].mes && ctx.chat[i].mes.trim()) count++;
        }
        return count >= 2;
      }
      return false;
    } catch (e) { return false; }
  }

  // 是否需要注入状态（有内容 或 首次回溯触发）
  function shouldInject(state) {
    return hasContent(state) || (isFirstTimeState(state) && hasChatHistory());
  }

  function hashState(state) {
    return JSON.stringify(state).length + '_' + (state.time || '') + '_' + (state.location || '');
  }

  // ==================== 状态持久化（对标st-memory-enhancement：存在chatMetadata中） ====================
  // 数据跟随聊天对象，切换聊天时ST自动加载/保存，天然不污染
  var WST_VERSION = '3.5.1'; // 版本号：更新后首次使用自动清理旧数据

  function getChatMetadata() {
    try {
      var ctx = SillyTavern.getContext();
      if (!ctx.chatMetadata) ctx.chatMetadata = {};
      return ctx.chatMetadata;
    } catch(e) { return {}; }
  }

  function triggerChatSave() {
    try {
      var ctx = SillyTavern.getContext();
      if (typeof ctx.saveChat === 'function') ctx.saveChat();
    } catch(e) {}
  }

  function loadState() {
    try {
      var meta = getChatMetadata();
      // 版本检查：更新后首次使用，清理旧数据
      if (meta.wst_version !== WST_VERSION) {
        console.log('[WST] 🔄 版本更新 (' + (meta.wst_version || '无') + ' → ' + WST_VERSION + ')，清理旧数据');
        delete meta.wst_state;
        delete meta.wst_msg_states;
        meta.wst_version = WST_VERSION;
        triggerChatSave();
        // 同时清理localStorage旧格式
        try { localStorage.removeItem('wst_state_' + getChatId()); } catch(e) {}
        return createEmptyState();
      }

      if (meta.wst_state) {
        var state = typeof meta.wst_state === 'string' ? JSON.parse(meta.wst_state) : meta.wst_state;
        var hasData = hasContent(state);
        console.log('[WST] loadState: chatMetadata读取成功 (hasContent=' + hasData + ')');
        return sanitizeState(state);
      }

      // 回退：尝试从localStorage旧格式读取
      try {
        var cid = getChatId();
        var raw = localStorage.getItem('wst_state_' + cid);
        if (raw) {
          var lsState = JSON.parse(raw);
          console.log('[WST] loadState: localStorage回退读取成功 (cid=' + cid + ')');
          // 迁移到chatMetadata
          meta.wst_state = lsState;
          meta.wst_version = WST_VERSION;
          triggerChatSave();
          localStorage.removeItem('wst_state_' + cid);
          return sanitizeState(lsState);
        }
      } catch(lsErr) {}

      console.log('[WST] loadState: 无缓存');
      return createEmptyState();
    } catch (e) {
      console.warn('[WST] loadState 失败:', e.message);
      return createEmptyState();
    }
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
    var clean = filterUserFromState(state);
    try {
      var meta = getChatMetadata();
      meta.wst_state = clean;
      meta.wst_version = WST_VERSION;
      triggerChatSave();
    } catch (e) { console.warn('[WST] 保存状态失败:', e); }
  }

  // ==================== 逐消息状态快照（存在chatMetadata中，跟随聊天对象） ====================

  function getMsgStatesMap() {
    try {
      var meta = getChatMetadata();
      return meta.wst_msg_states || {};
    } catch(e) { return {}; }
  }

  function saveMsgStatesMap(map) {
    try {
      var meta = getChatMetadata();
      meta.wst_msg_states = map;
      meta.wst_version = WST_VERSION;
      triggerChatSave();
    } catch(e) { console.warn('[WST] 保存消息状态快照失败:', e); }
  }

  function getMessageIndex(msgEl) {
    var mesid = msgEl.getAttribute('mesid');
    if (mesid !== null && mesid !== undefined) {
      var idx = parseInt(mesid, 10);
      if (!isNaN(idx)) return idx;
    }
    return -1;
  }

  // 过滤掉用户扮演角色
  function filterUserFromState(state) {
    var userName = getUserPersonaName();
    if (!userName || !state) return state;
    var copy = {
      time: state.time || '',
      location: state.location || '',
      present: removeUserFromText(state.present || ''),
      absent: removeUserFromText(state.absent || ''),
      hymen: state.hymen || '',
      sexCount: state.sexCount || '',
      affection: state.affection || '',
      appearance: state.appearance || '',
      memories: {}
    };
    // 过滤记忆中的用户角色
    var chars = Object.keys(state.memories || {});
    for (var i = 0; i < chars.length; i++) {
      if (chars[i] !== userName) {
        copy.memories[chars[i]] = (state.memories[chars[i]] || []).slice();
      }
    }
    return copy;
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

  // 预处理：强制将每个字段标签移到新行开头（防止AI把多个字段写在同一行）
  function normalizeSummaryLines(text) {
    var labels = [
      '时间：', '时间:',
      '区域：', '区域:',
      '在场角色\\+BUFF：', '在场角色\\+BUFF:',
      '在场角色：', '在场角色:',
      '不在场角色：', '不在场角色:',
      '处女膜状态：', '处女膜状态:',
      '做爱次数：', '做爱次数:',
      '当前好感度：', '当前好感度:',
      '身体外貌：', '身体外貌:',
      '重要记忆点：', '重要记忆点:',
    ];
    for (var i = 0; i < labels.length; i++) {
      var label = labels[i];
      // 在标签前插入换行符（如果前面不是换行或开头）
      var re = new RegExp('(.)(' + label + ')', 'g');
      text = text.replace(re, '$1\n$2');
    }
    return text;
  }

  function parseSummary(text) {
    var state = createEmptyState();
    if (!text || typeof text !== 'string') return state;

    text = text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    text = text.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');

    // 预处理：确保每个字段标签独占一行
    text = normalizeSummaryLines(text);

    // 关键修复：先按字段标签拆分（处理AI把所有字段写在同一行的情况）
    // 注意：长标签必须在短标签前面，确保"在场角色+BUFF："优先匹配
    var FIELD_LABELS = [
      '时间：', '时间:',
      '区域：', '区域:',
      '在场角色+BUFF：', '在场角色+BUFF:',
      '在场角色：', '在场角色:',
      '不在场角色：', '不在场角色:',
      '处女膜状态：', '处女膜状态:',
      '做爱次数：', '做爱次数:',
      '当前好感度：', '当前好感度:',
      '身体外貌：', '身体外貌:',
      '重要记忆点：', '重要记忆点:',
    ];

    // 构建正则切割：在每个字段标签前插入换行符
    var splitRe = new RegExp('(' + FIELD_LABELS.map(function(l) {
      return l.replace(/[+]/g, '\\+');
    }).join('|') + ')', 'g');

    // 先按换行拆分，每行再按字段标签拆分
    var lines = text.split('\n');
    var allSegments = [];
    for (var li = 0; li < lines.length; li++) {
      var l = lines[li].trim();
      if (!l) continue;
      // 把一行中紧密相连的字段切开
      var parts = l.split(splitRe).filter(function(s) { return s.trim(); });
      for (var pi = 0; pi < parts.length; pi++) {
        allSegments.push(parts[pi].trim());
      }
    }

    // 合并回带字段标签的行：找到标签开头，和其后面的值
    var currentLabel = null;
    var currentValue = '';

    function flushField() {
      if (!currentLabel) return;
      if (currentLabel.indexOf('时间') === 0) state.time = (state.time ? state.time + ' ' : '') + currentValue;
      else if (currentLabel.indexOf('区域') === 0) state.location = (state.location ? state.location + ' ' : '') + currentValue;
      else if (currentLabel.indexOf('在场角色+BUFF') === 0 || currentLabel.indexOf('在场角色') === 0) state.present = (state.present ? state.present + ' ' : '') + currentValue;
      else if (currentLabel.indexOf('不在场角色') === 0) state.absent = (state.absent ? state.absent + ' ' : '') + currentValue;
      else if (currentLabel.indexOf('处女膜') === 0) state.hymen = (state.hymen ? state.hymen + ' ' : '') + currentValue;
      else if (currentLabel.indexOf('做爱') === 0) state.sexCount = (state.sexCount ? state.sexCount + ' ' : '') + currentValue;
      else if (currentLabel.indexOf('当前好感') === 0) state.affection = (state.affection ? state.affection + ' ' : '') + currentValue;
      else if (currentLabel.indexOf('身体外貌') === 0) state.appearance = (state.appearance ? state.appearance + ' ' : '') + currentValue;
      currentLabel = null;
      currentValue = '';
    }

    for (var si = 0; si < allSegments.length; si++) {
      var seg = allSegments[si];
      var matchedLabel = null;
      for (var fi = 0; fi < FIELD_LABELS.length; fi++) {
        if (seg.indexOf(FIELD_LABELS[fi]) === 0) {
          matchedLabel = FIELD_LABELS[fi];
          break;
        }
      }

      if (matchedLabel) {
        flushField();
        currentLabel = matchedLabel;
        currentValue = seg.substring(matchedLabel.length).trim();
      } else {
        // 续行：追加到当前字段
        if (currentLabel) {
          currentValue += (currentValue ? ' ' : '') + seg;
        }
      }
    }
    flushField();

    // 解析重要记忆点（可能在 currentValue 中，也可能在多行中）
    var allText = text;
    var memSection = allText.match(/重要记忆点[：:]\s*\n?([\s\S]*?)$/);
    if (memSection) {
      var memText = memSection[1];
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
    state = fixFieldAssignments(state);
    return state;
  }

  // ==================== 合并状态 ====================
  // 从文本中提取角色名列表（去掉BUFF括号和分隔符）
  function extractCharacterNames(text) {
    if (!text) return [];
    // 去掉所有括号内容（BUFF）
    var clean = text.replace(/[（(][^)）]*[)）]/g, '');
    // 按分隔符拆开
    var parts = clean.split(/[|｜,，、\s]+/).filter(Boolean);
    var names = [];
    for (var i = 0; i < parts.length; i++) {
      var n = parts[i].trim();
      if (n && n.length >= 1 && !/^[-·•]$/.test(n)) names.push(n);
    }
    return names;
  }

  // 检查文本是否是泛称条目（非具体角色名）
  var GENERIC_PATTERNS = [
    /七神/, /各国角色/, /众人/, /所有人/, /其他人/, /其他角色/,
    /全城/, /全体/, /各路/, /各方/, /诸位/, /各位/, /大家/,
    /等[人角色]/, /一众/, /群[众臣英]/,
    /^艾莉丝$/   // 常见于AI瞎编的非世界书角色
  ];
  function isGenericEntry(name) {
    if (!name || name.length < 1) return true;
    for (var i = 0; i < GENERIC_PATTERNS.length; i++) {
      if (GENERIC_PATTERNS[i].test(name)) return true;
    }
    return false;
  }

  // 安全网：清理状态中的矛盾
  // - 在场角色中出现的角色，强制从不在场角色中移除
  // - 清理不在场角色中的泛称条目
  function sanitizeState(state) {
    if (!state) return state;

    // 从在场角色中提取角色名
    var presentNames = extractCharacterNames(state.present || '');

    // 清理不在场角色
    if (state.absent) {
      // 按分隔符拆开每个条目
      var absentParts = (state.absent || '').split(/[，,、]+/).map(function(s) { return s.trim(); }).filter(Boolean);
      var cleanedAbsent = [];
      for (var i = 0; i < absentParts.length; i++) {
        var part = absentParts[i];
        // 提取该条目的角色名（去掉"-在做什么"后缀）
        var charName = part.split(/[-—]/)[0].trim();
        // 去掉角色名中的BUFF括号
        charName = charName.replace(/[（(][^)）]*[)）]/g, '').trim();

        // 检查1: 是否泛称条目
        if (isGenericEntry(charName)) {
          console.log('[WST] 🧹 剔除泛称条目:', part);
          continue;
        }

        // 检查2: 是否已经在在场角色中
        var isPresent = false;
        for (var j = 0; j < presentNames.length; j++) {
          // 模糊匹配："琴·古恩希尔德"包含"琴"
          if (charName.indexOf(presentNames[j]) !== -1 || presentNames[j].indexOf(charName) !== -1) {
            isPresent = true;
            console.log('[WST] 🧹 从不在场中剔除（已在在场）:', part, '←→', presentNames[j]);
            break;
          }
        }

        if (!isPresent) {
          cleanedAbsent.push(part);
        }
      }
      state.absent = cleanedAbsent.join('、');
    }

    return state;
  }

  // 修复字段串行：检测在场角色中误入的「名字-在做什么」条目，移到不在场角色
  function fixFieldAssignments(state) {
    if (!state || !state.present) return state;
    // 检测在场角色中是否有不在场格式的条目（名字-描述）
    var presentParts = state.present.split(/[，,、\s]+/).filter(Boolean);
    var cleanPresent = [];
    var movedToAbsent = [];
    for (var i = 0; i < presentParts.length; i++) {
      var part = presentParts[i];
      // 跳过纯分隔符和短词
      if (part === '不' || part.length < 2) continue;
      // 检测「名字-在做什么」格式（不在场角色特征）
      if (part.indexOf('-') !== -1 && !/[（(]/.test(part.split('-')[0])) {
        // 名字后面有-但没有括号BUFF → 可能是不在场条目
        var namePart = part.split('-')[0];
        if (namePart.length >= 1) {
          movedToAbsent.push(part);
          console.log('[WST] 🔧 从在场移至不在场:', part);
          continue;
        }
      }
      cleanPresent.push(part);
    }
    if (movedToAbsent.length > 0) {
      state.present = cleanPresent.join('、');
      state.absent = (state.absent ? state.absent + '、' : '') + movedToAbsent.join('、');
    }
    return state;
  }

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

    // 安全网：清理在场/不在场矛盾 + 泛称条目
    merged = fixFieldAssignments(merged);
    merged = sanitizeState(merged);
    return merged;
  }

  // ==================== 构建 Prompt 注入文本 ====================
  function buildStatePrompt(state) {
    if (!state) return '';

    var wbData = getWorldBookData();
    var wbCharKeys = wbData.allKeys;
    var favorSys = wbData.favorabilitySystem || getDefaultFavorabilitySystem();
    var userName = getUserPersonaName();

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

    // 核心约束规则
    lines.push('');
    lines.push('[追踪规则]：');
    lines.push('1. 仅追踪女性角色，男性角色不出现在任何字段中。');
    if (userName) lines.push('2. 用户扮演的角色「' + userName + '」不追踪，任何字段不出现。');
    lines.push('3. 在场角色 = 当前场景（最近消息对话场景）中出现的所有女性角色。');
    lines.push('4. 不在场角色 = 之前出现过但当前不在主角所在场景的女性角色。');
    lines.push('   格式：角色名-在做什么（≤10字）。当前场景中的角色绝不能误判为不在场。');
    lines.push('   禁止泛称！不允许写"七神""众人""其他角色"等非具体角色名。');

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

    // 首次回溯：状态全空但有聊天历史时，让AI根据已有剧情补齐
    if (isFirstTimeState(state) && hasChatHistory()) {
      lines.push('');
      lines.push('【系统指令：首次状态回溯】');
      lines.push('请根据上方聊天历史，用HTML注释格式输出当前世界的完整状态。格式：<!-- WST -->时间：xxx / 区域：xxx / ... -->');
    }

    // 输出指令
    lines.push('');
    lines.push('在回复末尾用以下HTML注释格式输出更新后的世界状态（每个字段必须独占一行）：');
    lines.push('<!-- WST');
    lines.push('时间：xxx');
    lines.push('区域：xxx');
    lines.push('在场角色+BUFF：xxx');
    lines.push('不在场角色：xxx');
    lines.push('处女膜状态：xxx');
    lines.push('做爱次数：xxx');
    lines.push('当前好感度：xxx');
    lines.push('身体外貌：xxx');
    lines.push('重要记忆点：');
    lines.push('- 角色名：记忆1|记忆2');
    lines.push('-->');
    lines.push('时间 = 上一轮时间 + 本轮事件大致经历的时长。重要记忆点每人最多6条，每条不超过70字。');
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
      '<div class="wst-header wst-collapsed">' +
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
      // HTML注释格式（DOMPurify不拦截，优先匹配）
      /<!--\s*WST\s*-->?\s*\n?([\s\S]*?)<!--\s*\/?WST\s*-->/i,
      /<!--\s*WST\s*\n?([\s\S]*?)-->/i,
      // 旧版S-summary标签
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

    // 兜底：从纯文本提取（某些酒馆版本会去掉HTML标签）
    if (!match) {
      var rawText = mesTextEl.textContent || mesTextEl.innerText || '';
      var textPatterns = [
        /<S-summary>([\s\S]*?)<\/S-summary>/i,
        /S-summary[：:]\s*\n?([\s\S]*?)(?=\n\n\S|$)/i
      ];
      for (var j = 0; j < textPatterns.length; j++) {
        match = rawText.match(textPatterns[j]);
        if (match) { console.log('[WST] 纯文本兜底匹配成功'); break; }
      }
    }

    if (!match) return null;

    mesTextEl.innerHTML = html.replace(match[0],
      '<span class="wst-raw-summary" style="display:none;">' + escapeHTML(match[0]) + '</span>'
    );

    console.log('[WST] 提取到 S-summary，长度:', match[1].length);
    return parseSummary(match[1]);
  }

  // ==================== 处理消息（按时间顺序维护状态链） ====================

  // 通过 mesid 属性精确定位消息在聊天数组中的位置
  function isUserMessage(msgEl) {
    var mesid = msgEl.getAttribute('mesid');
    if (mesid === null || mesid === undefined) {
      // 回退到文本匹配（兼容极旧版ST）
      return isUserMessageByText(msgEl);
    }
    var idx = parseInt(mesid, 10);
    if (isNaN(idx)) return false;
    try {
      var ctx = SillyTavern.getContext();
      return !!(ctx.chat && ctx.chat[idx] && ctx.chat[idx].is_user);
    } catch(e) { return false; }
  }

  // 文本匹配回退（仅供无mesid属性的旧版ST使用）
  function isUserMessageByText(msgEl) {
    try {
      var ctx = SillyTavern.getContext();
      if (!ctx.chat || !Array.isArray(ctx.chat)) return false;
      var mesText = msgEl.querySelector('.mes_text');
      var text = mesText ? (mesText.textContent || '').trim() : '';
      if (!text) return false;
      var prefix = text.substring(0, 50);
      for (var i = ctx.chat.length - 1; i >= 0; i--) {
        var chatMsg = ctx.chat[i].mes || '';
        if (chatMsg.trim().substring(0, 50) === prefix) {
          return !!ctx.chat[i].is_user;
        }
      }
      return false;
    } catch(e) { return false; }
  }

  // 为单条消息渲染卡片
  function renderCardOnMessage(msgEl, state) {
    if (!msgEl || !state || !hasContent(state)) return;
    var existingBody = msgEl.querySelector('.wst-body');
    if (existingBody) {
      populateCard(existingBody, state);
    } else {
      var temp = document.createElement('div');
      temp.innerHTML = buildCardHTML(state);
      while (temp.firstChild) msgEl.appendChild(temp.firstChild);
    }
  }

  // 删除消息上的卡片
  function removeCardFromMessage(msgEl) {
    if (!msgEl) return;
    var header = msgEl.querySelector('.wst-header');
    var body = msgEl.querySelector('.wst-body');
    if (header) header.remove();
    if (body) body.remove();
  }

  // 按时间顺序处理所有消息，维护状态链（仅最后2条渲染卡片）
  function processMessageChain(allMessages) {
    var runningState = loadState(); // 从持久化存储加载最新基线
    var msgStatesMap = getMsgStatesMap(); // 逐消息快照
    var total = allMessages.length;
    var last2Start = Math.max(0, total - 2);
    var updatedGlobal = false;
    var updatedMsgs = false;
    var rendered = 0;

    for (var i = 0; i < total; i++) {
      var msg = allMessages[i];
      var msgIdx = getMessageIndex(msg);
      if (msgIdx < 0) continue;

      if (msg.classList.contains('system_mes')) continue;

      // 优先从快照恢复
      var storedState = msgStatesMap[msgIdx];
      if (storedState && hasContent(storedState)) {
        runningState = storedState;
        if (i >= last2Start) {
          renderCardOnMessage(msg, storedState);
          rendered++;
        } else {
          removeCardFromMessage(msg);
        }
        continue;
      }

      var mesText = msg.querySelector('.mes_text');
      if (!mesText) continue;

      var isUser = isUserMessage(msg);

      if (!isUser) {
        var newState = extractSummaryFromDOM(mesText);
        if (newState) {
          runningState = mergeState(runningState, newState);
          runningState = filterUserFromState(runningState);
          saveState(runningState);
          updatedGlobal = true;
        }
      }

      // 仅最后2条渲染卡片，旧消息清除卡片
      if (i >= last2Start && hasContent(runningState)) {
        renderCardOnMessage(msg, runningState);
        msgStatesMap[msgIdx] = runningState;
        updatedMsgs = true;
        rendered++;
      } else if (i < last2Start) {
        removeCardFromMessage(msg);
      }
    }

    // 持久化快照
    if (updatedMsgs) saveMsgStatesMap(msgStatesMap);
    if (updatedGlobal) lastStateSentHash = '';
    return rendered;
  }

  // 处理最新消息（debounce后触发，render loading → extract → update）
  function processLatestMessage() {
    var allMessages = document.querySelectorAll('.mes');
    if (allMessages.length === 0) return;

    var lastMsg = allMessages[allMessages.length - 1];
    if (lastMsg.classList.contains('system_mes')) return;

    var isUser = isUserMessage(lastMsg);

    if (isUser) {
      var s = loadState();
      if (hasContent(s)) {
        renderCardOnMessage(lastMsg, s, false);
        var lidx = getMessageIndex(lastMsg);
        if (lidx >= 0) { var m = getMsgStatesMap(); m[lidx] = s; saveMsgStatesMap(m); }
      }
    } else {
      // AI回复：先显示loading卡片
      var aiIdx = getMessageIndex(lastMsg);
      renderLoadingCard(lastMsg);

      if (allMessages.length >= 2) {
        var userMsg = allMessages[allMessages.length - 2];
        if (isUserMessage(userMsg)) {
          renderLoadingCard(userMsg);
        }
      }
      cleanupOldCards(allMessages);

      // 提取HTML注释格式的状态（DOMPurify不拦截）
      var mesText = lastMsg.querySelector('.mes_text');
      if (mesText) {
        var newState = extractSummaryFromDOM(mesText);
        if (newState && (newState.time || newState.location || newState.present)) {
          var oldState = loadState();
          var merged = mergeState(oldState, newState);
          merged = filterUserFromState(merged);
          saveState(merged);
          lastStateSentHash = '';
          console.log('[WST] 🤖 状态已提取 - 时间:', merged.time, '| 区域:', merged.location);

          var total = allMessages.length;
          var map = getMsgStatesMap();
          for (var j = Math.max(0, total - 2); j < total; j++) {
            var idx = getMessageIndex(allMessages[j]);
            if (idx >= 0) {
              renderCardOnMessage(allMessages[j], merged, false);
              map[idx] = merged;
            }
          }
          saveMsgStatesMap(map);
        } else {
          console.log('[WST] ⚠️ 未提取到状态，使用旧状态');
          var curState = loadState();
          if (hasContent(curState) && aiIdx >= 0) {
            renderCardOnMessage(lastMsg, curState, false);
          } else {
            removeCardFromMessage(lastMsg);
          }
        }
      }
    }
  }

  // 渲染loading卡片
  function renderLoadingCard(msgEl) {
    if (!msgEl) return;
    removeCardFromMessage(msgEl);
    var temp = document.createElement('div');
    temp.innerHTML =
      '<div class="wst-header wst-loading">' +
        '<span class="wst-triangle"></span>' +
        '📋 状态追踪 ⏳ 正在整理...' +
      '</div>' +
      '<div class="wst-body" style="display:none;"></div>';
    while (temp.firstChild) msgEl.appendChild(temp.firstChild);
  }

  function cleanupOldCards(allMessages) {
    var total = allMessages.length;
    var keepStart = Math.max(0, total - 2);
    for (var i = 0; i < keepStart; i++) {
      removeCardFromMessage(allMessages[i]);
    }
  }

  function scan() {
    var allMessages = document.querySelectorAll('.mes');
    console.log('[WST] scan() 发现 ' + allMessages.length + ' 条消息');
    if (allMessages.length === 0) return 0;
    var rendered = processMessageChain(allMessages);
    console.log('[WST] 状态链处理完成，渲染了 ' + rendered + ' 条消息的卡片');
    return allMessages.length;
  }

  // 带重试的扫描：安卓上消息DOM可能延迟加载
  var _scanRetries = 0;
  var _scanMaxRetries = 10;
  function scanWithRetry(delay) {
    delay = delay || 1000;
    var count = scan();
    _scanRetries++;
    if (count === 0 && _scanRetries < _scanMaxRetries) {
      console.log('[WST] 未找到消息DOM，' + (delay/1000) + '秒后重试 (第' + _scanRetries + '/' + _scanMaxRetries + '次)');
      setTimeout(function() { scanWithRetry(delay + 500); }, delay);
    } else if (count === 0) {
      console.log('[WST] ⚠️ 重试' + _scanMaxRetries + '次后仍未找到消息DOM，请检查选择器');
    } else {
      console.log('[WST] ✅ 初始扫描完成，共处理 ' + count + ' 条消息');
    }
  }

  // ==================== 独立 LLM 状态提取（generateRaw + JSON Schema） ====================

  var summarizeLock = false;

  // 状态字段的 JSON Schema（强制结构化输出）
  function getStateJsonSchema() {
    return {
      name: 'WorldState',
      description: '当前角色扮演世界状态',
      strict: true,
      value: {
        '$schema': 'http://json-schema.org/draft-04/schema#',
        type: 'object',
        properties: {
          time: { type: 'string', description: '当前剧情时间，格式：第X天 HH:MM' },
          location: { type: 'string', description: '主角所在位置' },
          present: { type: 'string', description: '在场女性角色及BUFF' },
          absent: { type: 'string', description: '不在场女性角色，格式：角色名-在做什么' },
          hymen: { type: 'string', description: '女性角色处女膜状态' },
          sexCount: { type: 'string', description: '女性角色做爱次数' },
          affection: { type: 'string', description: '女性角色当前好感度' },
          appearance: { type: 'string', description: '女性角色当前身体外貌' },
          memories: { type: 'string', description: '重要记忆点，格式：角色名：记忆1|记忆2，每行一个角色' }
        },
        required: ['time', 'location', 'present', 'absent', 'hymen', 'sexCount', 'affection', 'appearance', 'memories']
      }
    };
  }

  async function summarizeChatHistory() {
    if (summarizeLock) { console.log('[WST] 总结进行中，跳过'); return; }
    summarizeLock = true;

    try {
      var ctx = SillyTavern.getContext();
      if (!ctx.chat || !Array.isArray(ctx.chat) || ctx.chat.length < 1) {
        summarizeLock = false; return;
      }

      // 取最近30条聊天记录
      var recentMessages = ctx.chat.slice(-30);
      var historyText = '';
      for (var i = 0; i < recentMessages.length; i++) {
        var m = recentMessages[i];
        var role = m.is_user ? (ctx.name1 || '用户') : (m.name || 'AI');
        var text = (m.mes || '').replace(/<WST_世界状态>[\s\S]*?<\/WST_世界状态>/g, '').replace(/<!--\s*WST[\s\S]*?-->/gi, '').trim();
        if (text) historyText += role + '：' + text + '\n';
      }
      if (!historyText.trim()) { summarizeLock = false; return; }

      var wbData = getWorldBookData();
      var favorSys = wbData.favorabilitySystem || getDefaultFavorabilitySystem();
      var userName = getUserPersonaName();
      var userExclude = userName ? '用户扮演的角色「' + userName + '」不出现在任何字段中。' : '';
      var wbConstraint = wbData.allKeys.length > 0 ? '在场/不在场角色仅限世界书角色：' + wbData.allKeys.join('、') + '。' : '';

      var systemPrompt = '你是一个世界状态数据提取器。根据聊天记录提取当前世界状态，严格按照JSON Schema输出。禁止续写故事。';
      var userPrompt = [
        '【聊天记录】',
        historyText,
        '【结束】',
        '',
        '【规则】',
        '1. 仅追踪女性角色（排除男性）。' + userExclude,
        '2. ' + wbConstraint,
        '3. 在场角色 = 最近消息场景中出现的所有女性角色及BUFF。',
        '4. 不在场角色 = 之前出现过但当前不在场景的女角色，格式「名字-在做什么」。禁止泛称。',
        '5. 好感度系统：' + favorSys,
        '6. 重要记忆每人≤6条，只记录改变人生的重大事件，每条≤70字。格式：角色名：记忆1|记忆2',
        '7. 时间格式：第X天 HH:MM'
      ].join('\n');

      var resultText = '';

      // 方式1：generateRaw（无聊天上下文，prompt中要求JSON输出）
      try {
        console.log('[WST] 🤖 generateRaw 提取状态... (60s超时计时开始)');
        var rawResult = await Promise.race([
          ctx.generateRaw({
            systemPrompt: systemPrompt,
            prompt: userPrompt + '\n\n请严格输出JSON格式，不要任何额外文字：{"time":"","location":"","present":"","absent":"","hymen":"","sexCount":"","affection":"","appearance":"","memories":""}'
          }),
          new Promise(function(_, reject) { setTimeout(function() { reject(new Error('generateRaw 超时(60s)')); }, 60000); })
        ]);
        if (typeof rawResult === 'string') resultText = rawResult;
        else if (rawResult && typeof rawResult === 'object') {
          resultText = rawResult.mes || rawResult.text || rawResult.content || '';
          if (!resultText) resultText = JSON.stringify(rawResult);
        }
        console.log('[WST] generateRaw 返回 (' + resultText.length + ' chars)');
      } catch(e) {
        console.warn('[WST] generateRaw 失败:', e.message);
      }

      // 方式2 回退：generateQuietPrompt
      if (!resultText || resultText.length < 10) {
        try {
          console.log('[WST] 回退到 generateQuietPrompt... (60s超时)');
          var qResult = await Promise.race([
            ctx.generateQuietPrompt({
              quietPrompt: userPrompt + '\n\n只用JSON输出：{"time":"...","location":"...",...}',
              skipWIAN: true
            }),
            new Promise(function(_, reject) { setTimeout(function() { reject(new Error('generateQuietPrompt 超时(60s)')); }, 60000); })
          ]);
          if (typeof qResult === 'string') resultText = qResult;
          else if (qResult && typeof qResult === 'object') {
            resultText = qResult.mes || qResult.text || qResult.content || '';
            if (!resultText && Array.isArray(qResult) && qResult.length > 0) {
              resultText = qResult[qResult.length - 1].mes || qResult[qResult.length - 1].content || '';
            }
          }
          console.log('[WST] generateQuietPrompt 返回 (' + (resultText || '').length + ' chars)');
        } catch(e2) {
          console.warn('[WST] generateQuietPrompt 失败:', e2.message);
        }
      }

      if (resultText && resultText.length > 10) {
        // 尝试解析JSON
        var parsedState = null;
        try {
          // 从返回文本中提取JSON对象
          var jsonMatch = resultText.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            parsedState = JSON.parse(jsonMatch[0]);
          } else {
            parsedState = JSON.parse(resultText);
          }
        } catch(jsonErr) {
          // JSON解析失败，尝试用文本parseSummary
          console.log('[WST] JSON解析失败，尝试文本解析');
          parsedState = parseSummary(resultText);
        }

        if (parsedState && (parsedState.time || parsedState.location || parsedState.present)) {
          // JSON Schema 可能返回不同格式的字段名，标准化
          var newState = createEmptyState();
          newState.time = parsedState.time || '';
          newState.location = parsedState.location || '';
          newState.present = parsedState.present || '';
          newState.absent = parsedState.absent || '';
          newState.hymen = parsedState.hymen || '';
          newState.sexCount = parsedState.sexCount || '';
          newState.affection = parsedState.affection || '';
          newState.appearance = parsedState.appearance || '';
          // memories 可能是字符串或对象
          if (typeof parsedState.memories === 'string' && parsedState.memories) {
            var memParsed = parseSummary('重要记忆点：\n' + parsedState.memories);
            newState.memories = memParsed.memories;
          } else if (parsedState.memories && typeof parsedState.memories === 'object') {
            newState.memories = parsedState.memories;
          }
          newState = filterUserFromState(newState);
          saveState(newState);
          console.log('[WST] ✅ JSON Schema提取成功 - 时间:', newState.time, '| 区域:', newState.location);
          lastStateSentHash = '';

          // 渲染最后2条消息
          var allMes = document.querySelectorAll('.mes');
          var total = allMes.length;
          var map = getMsgStatesMap();
          for (var j = Math.max(0, total - 2); j < total; j++) {
            var idx = getMessageIndex(allMes[j]);
            if (idx >= 0) {
              renderCardOnMessage(allMes[j], newState, false);
              map[idx] = newState;
            }
          }
          saveMsgStatesMap(map);
          cleanupOldCards(allMes);
        } else {
          console.log('[WST] ⚠️ 提取的状态为空');
          recoverFromLoading();
        }
      } else {
        console.log('[WST] ⚠️ 提取返回内容过短');
        recoverFromLoading();
      }
    } catch (e) {
      console.warn('[WST] 状态提取失败:', e.message);
      // 超时/失败：尝试用已获取的部分数据
      if (resultText && resultText.length > 10) {
        console.log('[WST] ⚡ 尝试解析部分结果 (已获取 ' + resultText.length + ' chars)...');
        var ps = parseSummary(resultText);
        if (ps && (ps.time || ps.location || ps.present)) {
          ps = filterUserFromState(ps);
          saveState(ps);
          lastStateSentHash = '';
          var allMes2 = document.querySelectorAll('.mes');
          var total2 = allMes2.length;
          for (var j2 = Math.max(0, total2 - 2); j2 < total2; j2++) {
            var idx2 = getMessageIndex(allMes2[j2]);
            if (idx2 >= 0) renderCardOnMessage(allMes2[j2], ps, false);
          }
          console.log('[WST] ⚡ 部分结果已应用');
        } else {
          recoverFromLoading();
        }
      } else {
        recoverFromLoading();
      }
    } finally {
      summarizeLock = false;
    }
  }

  // 当总结失败时，用旧状态替换loading卡片
  function recoverFromLoading() {
    var curState = loadState();
    var allMes = document.querySelectorAll('.mes');
    if (hasContent(curState)) {
      var total = allMes.length;
      for (var j = Math.max(0, total - 2); j < total; j++) {
        var idx = getMessageIndex(allMes[j]);
        if (idx >= 0) renderCardOnMessage(allMes[j], curState, false);
      }
    } else {
      // 完全没有状态：移除loading卡片
      for (var j = 0; j < allMes.length; j++) {
        var header = allMes[j].querySelector('.wst-header.wst-loading');
        if (header) {
          var body = allMes[j].querySelector('.wst-body');
          if (header) header.remove();
          if (body) body.remove();
        }
      }
    }
  }

  function triggerSummarize() {
    var ctx;
    try { ctx = SillyTavern.getContext(); } catch(e) { return; }
    if (!ctx.chat || !Array.isArray(ctx.chat) || ctx.chat.length < 1) return;
    summarizeChatHistory();
  }

  // 方法 A：DOM 捕获阶段拦截 — 在酒馆读取文本框之前注入状态
  // ⚠️ 已禁用：会导致二次点击才能发送的bug
  function injectStateToTextarea() { /* disabled */ }

  // 使用 setExtensionPrompt 注入状态（不修改聊天数组，不修改文本框）
  // 方式A：通过 setExtensionPrompt 注入（兼容旧版）
  function injectStateViaExtensionPrompt() {
    var state = loadState();
    if (!shouldInject(state)) return;
    var firstTime = isFirstTimeState(state) && hasChatHistory();
    if (firstTime) console.log('[WST] 🆕 首次注入（状态为空，将触发AI回溯）');
    var stateText = buildStatePrompt(state);
    try {
      var ctx = SillyTavern.getContext();
      if (typeof ctx.setExtensionPrompt === 'function') {
        ctx.setExtensionPrompt('wst', stateText, 0);
        console.log('[WST] ✅ 状态已注入到ExtensionPrompt (' + stateText.length + ' chars)');
      }
    } catch (e) {
      console.warn('[WST] ExtensionPrompt注入失败:', e.message);
    }
  }

  // 方式B：通过 CHAT_COMPLETION_PROMPT_READY 注入（对标st-memory-enhancement，直接操作chat数组）
  function injectStateToChatArray(eventData) {
    if (eventData.dryRun) return;
    var state = loadState();
    if (!shouldInject(state)) return;
    var firstTime = isFirstTimeState(state) && hasChatHistory();
    if (firstTime) console.log('[WST] 🆕 Chat数组注入（首次回溯）');
    var stateText = buildStatePrompt(state);
    try {
      // 对标st-memory-enhancement：直接push到chat数组末尾
      eventData.chat.push({ role: 'system', content: stateText });
      console.log('[WST] ✅ 状态已注入到Chat数组 (' + stateText.length + ' chars)');
    } catch (e) {
      console.warn('[WST] Chat数组注入失败:', e.message);
    }
  }

  // 兼容入口：优先用Chat数组注入，回退到ExtensionPrompt
  function injectStateToPrompt() {
    injectStateViaExtensionPrompt();
  }

  // ==================== 点击交互 ====================
  document.addEventListener('click', function (e) {
    // 折叠/展开
    var header = e.target.closest('.wst-header');
    if (header) {
      // loading中的卡片不可交互
      if (header.classList.contains('wst-loading')) return;
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
        memPreview.push('- ' + ch + '：' + (state.memories[ch] || []).join('|'));
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
      lastStateSentHash = '';

      // 清除逐消息快照，让全量重算以反映编辑
      try {
        var meta = getChatMetadata();
        delete meta.wst_msg_states;
        triggerChatSave();
      } catch(e) {}

      // 重新扫描所有消息，用编辑后的状态刷新卡片
      scan();
    }
  });

  // ==================== 初始化 ====================

  // 清理旧版本在聊天数组中残留的WST标签
  function cleanLegacyWSTTags() {
    try {
      var ctx = SillyTavern.getContext();
      if (!ctx.chat || !Array.isArray(ctx.chat)) return;
      var cleaned = 0;
      for (var i = 0; i < ctx.chat.length; i++) {
        if (ctx.chat[i].mes && ctx.chat[i].mes.indexOf('<WST_世界状态>') !== -1) {
          ctx.chat[i].mes = ctx.chat[i].mes.replace(/<WST_世界状态>[\s\S]*?<\/WST_世界状态>\n*/g, '');
          cleaned++;
        }
      }
      if (cleaned > 0) console.log('[WST] 🧹 清理了 ' + cleaned + ' 条消息中的旧WST标签');
    } catch(e) {}
  }

  jQuery(async function () {
    console.log('[WST] 🚀 世界状态追踪器 v3.5.1 初始化...');
    currentChatId = getChatId();
    cleanLegacyWSTTags();

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

      // 即时提取：AI消息渲染后尝试提取HTML注释
      es.on(et.CHARACTER_MESSAGE_RENDERED, function () {
        clearTimeout(timer);
        lastStateSentHash = '';
        timer = setTimeout(function () {
          processLatestMessage();
        }, DEBOUNCE_MS);
      });

      // 异步提取：生成完成后用generateRaw+JSON Schema提取状态（可靠回退）
      if (et.GENERATION_ENDED) {
        es.on(et.GENERATION_ENDED, function () {
          // 延迟一下确保DOM完全渲染
          setTimeout(function() {
            triggerSummarize();
          }, 500);
        });
        console.log('[WST] 使用 GENERATION_ENDED 事件触发异步提取');
      }

      // 对标st-memory-enhancement：用CHAT_COMPLETION_PROMPT_READY注入（直接操作chat数组）
      if (et.CHAT_COMPLETION_PROMPT_READY) {
        es.on(et.CHAT_COMPLETION_PROMPT_READY, function (eventData) {
          injectStateToChatArray(eventData);
        });
        console.log('[WST] 使用 CHAT_COMPLETION_PROMPT_READY 事件注入');
      } else {
        // 回退到 MESSAGE_SENT + ExtensionPrompt（旧版ST）
        es.on(et.MESSAGE_SENT, function () {
          lastStateSentHash = '';
          injectStateToPrompt();
        });
        console.log('[WST] 使用 MESSAGE_SENT 事件注入（旧版兼容）');
      }

      es.on(et.CHAT_CHANGED, function () {
        currentChatId = getChatId();
        clearUserNameCache();
        lastStateSentHash = '';
        clearTimeout(timer);
        timer = setTimeout(function() {
          scan();
          // 切换到历史聊天时，如果状态为空且有聊天记录，立即注入首次回溯指令
          var state = loadState();
          if (shouldInject(state) && !hasContent(state)) {
            console.log('[WST] 🆕 检测到历史聊天无状态，立即注入回溯指令');
            injectStateToPrompt();
          }
        }, 500);
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

    // 初始化扫描（带重试，适配安卓消息延迟加载）
    _scanRetries = 0;
    scanWithRetry(1000);

    // 额外保险：3秒后再扫一次（安卓上聊天切换后消息可能二次加载）
    setTimeout(function() {
      var count = scan();
      console.log('[WST] 兜底扫描完成，处理 ' + count + ' 条消息');
    }, 3000);
  });
})();
