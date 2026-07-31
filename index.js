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

  // 状态快照模型：每聊天仅保存 2 个快照（最新AI→B + 最新用户→b），见下方 getSnapshot/setSnapshot

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
  var WST_VERSION = '3.8.0'; // 版本号：更新后首次使用自动清理旧数据

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
      // 版本检查：更新后首次使用，清理旧版本残留数据（需求2.4）
      if (meta.wst_version !== WST_VERSION) {
        console.log('[WST] 🔄 版本更新 (' + (meta.wst_version || '无') + ' → ' + WST_VERSION + ')，清理旧数据');
        delete meta.wst_state;
        delete meta.wst_ai_state;
        delete meta.wst_user_state;
        delete meta.wst_msg_states;
        meta.wst_version = WST_VERSION;
        triggerChatSave();
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

  // ==================== 双状态快照（需求2.3：每聊天仅保存 最新AI + 最新用户 两个快照） ====================
  // wst_ai_state   = 最新AI消息上的状态（B）
  // wst_user_state = 最新用户消息上的状态（b）
  // 新状态产生时旧状态被顶替（替换而非追加），跟随聊天对象互不污染

  function getSnapshot(kind) {
    loadState(); // 版本检查/清理优先：快照读取前确保旧数据已清（需求2.4）
    try {
      var meta = getChatMetadata();
      var key = kind === 'user' ? 'wst_user_state' : 'wst_ai_state';
      if (meta[key]) {
        var state = typeof meta[key] === 'string' ? JSON.parse(meta[key]) : meta[key];
        return sanitizeState(state);
      }
    } catch(e) { console.warn('[WST] 读取快照失败:', e.message); }
    return createEmptyState();
  }

  function setSnapshot(kind, state) {
    var clean = filterUserFromState(state);
    try {
      var meta = getChatMetadata();
      var key = kind === 'user' ? 'wst_user_state' : 'wst_ai_state';
      meta[key] = clean;
      meta.wst_version = WST_VERSION;
      triggerChatSave();
    } catch(e) { console.warn('[WST] 保存快照失败:', e); }
    return clean;
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
    lines.push('5. 每次输出的状态必须与上一状态不同：至少一个字段有可观察的变化（时间推进、位置移动、角色加入/离开、好感变化等），且变化必须符合聊天内容的线性逻辑。');
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
    lines.push('新状态必须与上一状态不同（至少一个字段有可观察变化），且变化必须符合本轮聊天内容的线性逻辑。');
    lines.push('</WST_世界状态>');

    return lines.join('\n');
  }

  // ==================== 卡片渲染 ====================
  // 空状态占位行：字段名 + 空值，保证9个字段始终可见可点击
  function buildEmptyFieldLineHTML(f) {
    return '<div class="wst-body__line wst-placeholder" data-wst-key="' + f.key + '" title="' + f.label.replace(/：$/, '') + '">' +
      f.label +
    '</div>';
  }

  function buildCardHTML(state, kind, loading) {
    var isEmpty = !hasContent(state);
    var valueHTML = [];
    for (var i = 0; i < FIELDS.length; i++) {
      var f = FIELDS[i];
      var key = f.key;
      var value = '';
      // 空状态也渲染全部字段（字段名+空值），保证9个字段始终可见可点击
      if (isEmpty) { valueHTML.push(buildEmptyFieldLineHTML(f)); continue; }

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
      '<div class="wst-header wst-collapsed' + (loading ? ' wst-loading' : '') + '" data-wst-kind="' + (kind || 'ai') + '">' +
        '<span class="wst-triangle"></span>' +
        '📋 状态追踪' +
      '</div>' +
      '<div class="wst-body">' + valueHTML.join('') + '</div>'
    );
  }

  function populateCard(cardBody, state) {
    if (!cardBody || !state) return;
    // 空状态：整卡替换为全部字段占位行（版本清理/首次使用后刷新），9个字段始终可见可点击
    if (!hasContent(state)) {
      var emptyHTML = [];
      for (var ei = 0; ei < FIELDS.length; ei++) {
        emptyHTML.push(buildEmptyFieldLineHTML(FIELDS[ei]));
      }
      cardBody.innerHTML = emptyHTML.join('');
      return;
    }
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

  // 纯文本兜底：从消息末尾提取状态字段（不需要任何HTML标签）
  function extractStateFromText(rawText) {
    if (!rawText || rawText.length < 20) return null;
    // 从文本末尾取最后2000字符（状态通常在末尾）
    var tail = rawText.length > 2000 ? rawText.substring(rawText.length - 2000) : rawText;
    // 尝试找"时间："或"时间:"作为起点
    var timeIdx = tail.search(/时间[：:]/);
    if (timeIdx === -1) return null;
    var stateText = tail.substring(timeIdx);
    console.log('[WST] 纯文本兜底提取 (' + stateText.length + ' chars):', stateText.substring(0, 100));
    return parseSummary(stateText);
  }

  // 获取消息纯文本（剔除已隐藏的原始摘要，避免兜底重复提取同一状态）
  function getCleanMessageText(mesText) {
    try {
      var clone = mesText.cloneNode(true);
      var hidden = clone.querySelectorAll('.wst-raw-summary');
      for (var i = 0; i < hidden.length; i++) {
        if (hidden[i].parentNode) hidden[i].parentNode.removeChild(hidden[i]);
      }
      return clone.textContent || clone.innerText || '';
    } catch(e) {
      return mesText.textContent || mesText.innerText || '';
    }
  }

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

  // 为单条消息渲染卡片（kind: 'ai' → B 快照，'user' → b 快照）
  function renderCardOnMessage(msgEl, state, kind, loading) {
    if (!msgEl || !state) return;
    kind = kind || 'ai';
    var existingBody = msgEl.querySelector('.wst-body');
    if (existingBody) {
      populateCard(existingBody, state);
      var existingHeader = msgEl.querySelector('.wst-header');
      if (existingHeader) {
        existingHeader.setAttribute('data-wst-kind', kind);
        if (loading) existingHeader.classList.add('wst-loading');
        else existingHeader.classList.remove('wst-loading');
      }
    } else {
      var temp = document.createElement('div');
      temp.innerHTML = buildCardHTML(state, kind, loading);
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

  // ==================== 消息处理（需求2.1/2.2：仅最后2条显示卡片，AI→B，用户→b≠B） ====================

  // 查找最后一条AI消息DOM
  function findLastAiMessageEl(allMessages) {
    for (var i = allMessages.length - 1; i >= 0; i--) {
      if (!allMessages[i].classList.contains('system_mes') && !isUserMessage(allMessages[i])) return allMessages[i];
    }
    return null;
  }

  // 从消息DOM提取状态：HTML注释/S-summary优先，纯文本兜底（跳过已隐藏的原始摘要）
  function extractStateFromMessage(mesText) {
    if (!mesText) return null;
    var state = extractSummaryFromDOM(mesText);
    if (!state || !state.time) {
      state = extractStateFromText(getCleanMessageText(mesText));
    }
    return state;
  }

  // 渲染最后2条消息的卡片：AI消息 → B快照，用户消息 → b快照（需求2.1）
  function renderLastTwo(allMessages) {
    var total = allMessages.length;
    var start = Math.max(0, total - 2);
    var aiState = getSnapshot('ai');
    var userState = getSnapshot('user');
    var latest = loadState();
    for (var i = start; i < total; i++) {
      var msg = allMessages[i];
      if (msg.classList.contains('system_mes')) continue;
      var isUser = isUserMessage(msg);
      var state = isUser
        ? (hasContent(userState) ? userState : latest)
        : (hasContent(aiState) ? aiState : latest);
      renderCardOnMessage(msg, state, isUser ? 'user' : 'ai');
    }
    cleanupOldCards(allMessages);
  }

  // 按时间顺序处理所有消息（仅最后2条渲染卡片，旧卡片清除）
  function processMessageChain(allMessages) {
    renderLastTwo(allMessages);
    return Math.min(allMessages.length, 2);
  }

  // 处理最新消息：AI回复提取 B，用户消息渲染 b 并触发演化（b = B 经用户事件线性演化，b ≠ B）
  function processLatestMessage() {
    var allMessages = document.querySelectorAll('.mes');
    if (allMessages.length === 0) return;

    var lastMsg = allMessages[allMessages.length - 1];
    if (lastMsg.classList.contains('system_mes')) return;

    var isUser = isUserMessage(lastMsg);

    if (isUser) {
      // 用户消息：先显示上一状态（loading），随后静默总结演化出 b
      renderLastTwo(allMessages);
      var userHeader = lastMsg.querySelector('.wst-header');
      if (userHeader) userHeader.classList.add('wst-loading');
      triggerSummarize();
      return;
    }

    // AI回复：提取状态（HTML注释/S-summary优先，纯文本兜底）
    var mesText = lastMsg.querySelector('.mes_text');
    var newState = extractStateFromMessage(mesText);

    if (newState && (newState.time || newState.location || newState.present)) {
      var merged = mergeState(loadState(), newState);
      merged = filterUserFromState(merged);
      saveState(merged);
      setSnapshot('ai', merged);
      lastStateSentHash = '';
      console.log('[WST] 🤖 AI状态(B)已更新 - 时间:', merged.time, '| 区域:', merged.location);
    } else {
      // 未提取到：AI快照为空时用当前状态补位，保持卡片可显示
      var aiState = getSnapshot('ai');
      if (!hasContent(aiState)) {
        var cur = loadState();
        if (hasContent(cur)) setSnapshot('ai', cur);
      }
      console.log('[WST] ⚠️ 未提取到AI状态，保留当前状态');
    }

    renderLastTwo(allMessages);
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

    // 恢复：AI快照为空但最后一条AI消息含状态标签时，提取作为B（版本清理后自动重建）
    var aiState = getSnapshot('ai');
    if (!hasContent(aiState)) {
      var lastAi = findLastAiMessageEl(allMessages);
      if (lastAi) {
        var mesText = lastAi.querySelector('.mes_text');
        var ns = extractStateFromMessage(mesText);
        if (ns && (ns.time || ns.location || ns.present)) {
          var merged = mergeState(loadState(), ns);
          merged = filterUserFromState(merged);
          saveState(merged);
          setSnapshot('ai', merged);
          lastStateSentHash = '';
          console.log('[WST] 🔄 已从最后AI消息恢复状态(B):', merged.time, merged.location);
        }
      }
    }

    // AI总结补全：标签恢复后AI快照仍为空（最后AI消息无标签/版本清理后/首次使用）→ 用AI总结补全B
    // _initialSummaryDone：初始扫描/兜底扫描只补全一次，避免重复触发API；切换聊天时重置
    if (!_initialSummaryDone && !hasContent(getSnapshot('ai')) && hasChatHistory()) {
      _initialSummaryDone = true;
      console.log('[WST] 🆕 AI快照为空，触发AI总结补全B...');
      summarizeChatHistory('ai');
    }

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

  // ==================== Prompt 注入 ====================

  // 将状态输出指令追加到用户消息末尾（AI无法忽略对话中的内容）
  function injectStateToChatArray(eventData) {
    if (eventData.dryRun) return;
    var state = loadState();
    // 需求2.2：AI回复状态(B)基于用户状态(b)演化 → 优先注入最新用户快照
    var userState = getSnapshot('user');
    if (hasContent(userState)) state = userState;
    if (!shouldInject(state)) return;
    var firstTime = isFirstTimeState(state) && hasChatHistory();
    if (firstTime) console.log('[WST] 🆕 用户消息追加：首次回溯指令');

    // 构建状态输出指令（精简版，追加到用户消息末尾）
    var wbData = getWorldBookData();
    var outLines = [
      '\n\n[在回复末尾用HTML注释格式输出更新后的世界状态，每个字段独占一行：',
      '<!-- WST',
      '时间：',
      '区域：',
      '在场角色+BUFF：',
      '不在场角色：',
      '处女膜状态：',
      '做爱次数：',
      '当前好感度：',
      '身体外貌：',
      '重要记忆点：',
      '- 角色名：记忆1|记忆2',
      '-->',
      '注意：只追踪女性角色。时间=上一轮时间+本轮事件时长。重要记忆每人≤6条≤70字。]'
    ].join('\n');

    // 注入当前状态 + 输出指令作为 system prompt
    var stateText = buildStatePrompt(state);
    try {
      eventData.chat.push({ role: 'system', content: stateText + '\n\n' + outLines });
      console.log('[WST] ✅ 状态+输出指令已注入 (' + stateText.length + ' chars)');
    } catch (e) {
      console.warn('[WST] 注入失败:', e.message);
    }
  }

  // 兼容入口：ExtensionPrompt方式（旧版ST回退）
  function injectStateToPrompt() {
    var state = loadState();
    if (!shouldInject(state)) return;
    var stateText = buildStatePrompt(state);
    try {
      var ctx = SillyTavern.getContext();
      if (typeof ctx.setExtensionPrompt === 'function') {
        ctx.setExtensionPrompt('wst', stateText, 0);
        console.log('[WST] ✅ ExtensionPrompt 注入 (' + stateText.length + ' chars)');
      }
    } catch (e) {
      console.warn('[WST] ExtensionPrompt 失败:', e.message);
    }
  }

  // ==================== 静默状态总结（需求2.2：b = B 经用户事件线性演化，b ≠ B） ====================
  var summarizeLock = false;
  var summarizeTimeout = null;
  var _initialSummaryDone = false; // scan() AI补全标记
  var SUMMARIZE_TIMEOUT_MS = 60000;

  // 归一化生成结果（兼容字符串 / {mes} / {text} / {content} / {choices}）
  function normalizeGenerateResult(r) {
    if (typeof r === 'string') return r;
    if (r && typeof r === 'object') {
      if (r.mes) return r.mes;
      if (r.text) return r.text;
      if (r.content) return r.content;
      if (r.choices && r.choices[0]) {
        var c = r.choices[0];
        if (c.message && c.message.content) return c.message.content;
        if (c.text) return c.text;
      }
    }
    return '';
  }

  // 状态对象 → 纯文本字段（用于总结Prompt）
  function stateToText(state) {
    if (!state) return '';
    var lines = [];
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
        var mems = state.memories[chars[i]];
        if (mems && mems.length > 0) lines.push('- ' + chars[i] + '：' + mems.join('|'));
      }
    }
    return lines.join('\n');
  }

  // 解析总结结果并校验有效性
  function parseSummaryResult(text) {
    if (!text || typeof text !== 'string' || text.length < 20) return null;
    var ns = parseSummary(text);
    if (ns && (ns.time || ns.location || ns.present)) return ns;
    return null;
  }

  // 构建总结Prompt：上一状态 + 最近聊天 + 演化规则（b ≠ B，线性逻辑）
  // targetKind: 'ai' → 基于用户快照(b)推演AI状态(B)；'user' → 基于AI快照(B)推演用户状态(b)
  function buildSummarizePrompt(targetKind) {
    var ctx = SillyTavern.getContext();
    if (!ctx.chat || !Array.isArray(ctx.chat) || ctx.chat.length < 2) return null;

    var msgs = ctx.chat.slice(-30);
    var hist = '';
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      var r = m.is_user ? (ctx.name1 || '用户') : (m.name || 'AI');
      var t = (m.mes || '').trim();
      if (t) hist += r + '：' + t + '\n';
    }
    if (!hist.trim()) return null;

    // 上一状态选择：AI总结用最新用户快照(b)，用户总结用最新AI快照(B)；快照为空时回退当前状态
    var prevState;
    if (targetKind === 'ai') {
      prevState = getSnapshot('user');
      if (!hasContent(prevState)) prevState = loadState();
    } else {
      prevState = getSnapshot('ai');
      if (!hasContent(prevState)) prevState = loadState();
    }
    var wb = getWorldBookData();
    var fs = wb.favorabilitySystem || getDefaultFavorabilitySystem();
    var un = getUserPersonaName();

    var p = '你是世界状态追踪器。根据「上一状态」和「聊天记录」，线性推演出当前最新状态。' +
      '新状态必须与上一状态不同：至少一个字段有可观察的变化（时间推进、位置移动、角色加入/离开、好感变化等），变化必须符合聊天内容的线性逻辑。\n\n' +
      '上一状态：\n' + (stateToText(prevState) || '（空）') + '\n\n' +
      '聊天记录：\n' + hist + '\n\n' +
      '输出格式（每字段独占一行）：\n时间：\n区域：\n在场角色+BUFF：\n不在场角色：\n处女膜状态：\n做爱次数：\n当前好感度：\n身体外貌：\n重要记忆点：\n- 角色名：记忆1|记忆2\n\n' +
      '规则：仅追踪女性角色，只输出状态数据不续写故事。' +
      '好感度系统=' + fs +
      (un ? '排除用户角色「' + un + '」。' : '') +
      (wb.allKeys.length > 0 ? '角色仅限：' + wb.allKeys.join('、') + '。' : '') +
      '重要记忆每人最多6条，每条不超过70字。';
    return p;
  }

  // 用户状态演化结果落地：保存 b 快照 + 刷新最后2条卡片
  function applyUserSnapshot(state) {
    saveState(state);
    setSnapshot('user', state);
    lastStateSentHash = '';
    console.log('[WST] ✅ 用户状态(b)已演化 - 时间:', state.time, '| 区域:', state.location);
  }

  // AI状态总结结果落地：保存 B 快照（scan() AI总结补全/演化路径）
  function applyAiSnapshot(state) {
    saveState(state);
    setSnapshot('ai', state);
    lastStateSentHash = '';
    console.log('[WST] ✅ AI状态(B)已补全 - 时间:', state.time, '| 区域:', state.location);
  }

  // ES5 Promise 链实现（不依赖 async/await）
  // 共享总结核心：targetKind 'user' → 演化b；'ai' → 补全/演化B（scan()复用）
  function runSummarizeCore(targetKind) {
    if (summarizeLock) {
      // 已有总结进行中：稍后重试，避免用户消息卡片停留在loading
      setTimeout(function () { runSummarizeCore(targetKind); }, 3000);
      return;
    }
    var ctx = SillyTavern.getContext();
    var p = buildSummarizePrompt(targetKind);
    if (!p) return;
    summarizeLock = true;
    summarizeTimeout = setTimeout(function () {
      summarizeLock = false;
      summarizeTimeout = null;
      console.warn('[WST] ⏱️ 静默总结超时，释放锁');
    }, SUMMARIZE_TIMEOUT_MS);

    var finish = function (resultText) {
      summarizeLock = false;
      if (summarizeTimeout) { clearTimeout(summarizeTimeout); summarizeTimeout = null; }
      var ns = parseSummaryResult(resultText);
      if (ns) {
        if (targetKind === 'ai') {
          // 核心约束：B 必须 ≠ b
          var userState = getSnapshot('user');
          if (hasContent(userState) && JSON.stringify(ns) === JSON.stringify(userState)) {
            console.warn('[WST] ⚠️ AI总结结果与用户状态(b)相同，未产生可观察变化');
          }
          applyAiSnapshot(ns);
        } else {
          // 核心约束：b 必须 ≠ B
          var aiState = getSnapshot('ai');
          if (hasContent(aiState) && JSON.stringify(ns) === JSON.stringify(aiState)) {
            console.warn('[WST] ⚠️ 演化结果与AI状态(B)相同，未产生可观察变化');
          }
          applyUserSnapshot(ns);
        }
      } else if (resultText) {
        console.warn('[WST] 总结返回非状态文本 (' + resultText.length + ' chars)');
      } else {
        console.warn('[WST] 总结返回为空');
      }
      // 无论如何刷新卡片，清除loading状态
      var allMes = document.querySelectorAll('.mes');
      if (allMes.length > 0) renderLastTwo(allMes);
    };

    var tryRaw = function () {
      try {
        console.log('[WST] generateRaw 回退...');
        var raw = ctx.generateRaw({
          prompt: [
            { role: 'system', content: '你是世界状态提取器。只输出状态数据，不续写故事。' },
            { role: 'user', content: p }
          ]
        });
        if (raw && typeof raw.then === 'function') {
          raw.then(function (r) {
            finish(normalizeGenerateResult(r));
          })['catch'](function (e) {
            console.warn('[WST] gR失败:', e && e.message);
            finish('');
          });
        } else {
          finish(normalizeGenerateResult(raw));
        }
      } catch (e2) {
        console.warn('[WST] gR失败:', e2 && e2.message);
        finish('');
      }
    };

    try {
      console.log('[WST] 🤖 generateQuietPrompt 提取状态...');
      var qp = ctx.generateQuietPrompt({ quietPrompt: p, skipWIAN: true });
      if (qp && typeof qp.then === 'function') {
        qp.then(function (r) {
          var t = normalizeGenerateResult(r);
          if (t && t.indexOf('时间') !== -1) finish(t);
          else tryRaw();
        })['catch'](function (e) {
          console.warn('[WST] qP失败:', e && e.message);
          tryRaw();
        });
      } else {
        // 同步返回（极少数兼容场景）
        var t2 = normalizeGenerateResult(qp);
        if (t2 && t2.indexOf('时间') !== -1) finish(t2);
        else tryRaw();
      }
    } catch (e) {
      console.warn('[WST] qP失败:', e && e.message);
      tryRaw();
    }
  }

  // 对外入口：默认演化用户状态(b)；scan()传 'ai' 复用同一核心补全AI状态(B)
  function summarizeChatHistory(targetKind) {
    runSummarizeCore(targetKind === 'ai' ? 'ai' : 'user');
  }

  function triggerSummarize() {
    summarizeChatHistory();
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

      // 同步更新对应类型快照（AI卡片 → B，用户卡片 → b）
      var cardHeader = line.closest('.wst-header');
      var kind = cardHeader ? cardHeader.getAttribute('data-wst-kind') : null;
      if (kind === 'user') setSnapshot('user', state);
      else setSnapshot('ai', state);

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

  jQuery(function () {
    console.log('[WST] 🚀 世界状态追踪器 v3.8.0 初始化...');
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
      // Prompt注入：用CHAT_COMPLETION_PROMPT_READY将状态指令注入到chat数组
      if (et.CHAT_COMPLETION_PROMPT_READY) {
        es.on(et.CHAT_COMPLETION_PROMPT_READY, function (eventData) {
          injectStateToChatArray(eventData);
        });
        console.log('[WST] CHAT_COMPLETION_PROMPT_READY 注入已注册');
      } else {
        // 回退到MESSAGE_SENT
        es.on(et.MESSAGE_SENT, function () {
          lastStateSentHash = '';
          injectStateToPrompt();
        });
        console.log('[WST] MESSAGE_SENT 注入已注册（回退）');
      }

      // 即时提取：AI消息生成/渲染后尝试提取状态（GENERATION_ENDED + CHARACTER_MESSAGE_RENDERED 双触发，提取幂等）
      var onMessageRendered = function () {
        clearTimeout(timer);
        lastStateSentHash = '';
        timer = setTimeout(function () {
          processLatestMessage();
        }, DEBOUNCE_MS);
      };

      es.on(et.CHARACTER_MESSAGE_RENDERED, onMessageRendered);
      if (et.GENERATION_ENDED) {
        es.on(et.GENERATION_ENDED, onMessageRendered);
        console.log('[WST] GENERATION_ENDED 已注册');
      }
      if (et.USER_MESSAGE_RENDERED) {
        es.on(et.USER_MESSAGE_RENDERED, onMessageRendered);
        console.log('[WST] USER_MESSAGE_RENDERED 已注册');
      }
      if (et.MESSAGE_RENDERED) {
        es.on(et.MESSAGE_RENDERED, onMessageRendered);
        console.log('[WST] MESSAGE_RENDERED 已注册');
      }

      es.on(et.CHAT_CHANGED, function () {
        var newChatId = getChatId();
        // 仅真正切换聊天时重置，避免初始加载时与scanWithRetry重复触发AI总结
        if (newChatId !== currentChatId) {
          _initialSummaryDone = false;
        }
        currentChatId = newChatId;
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
