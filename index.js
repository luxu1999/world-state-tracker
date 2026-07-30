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

  // 每消息独立状态快照（避免所有卡片同步更新）
  var MESSAGE_STATES = new WeakMap();

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
    // 保存前过滤用户扮演角色
    var clean = filterUserFromState(state);
    try {
      localStorage.setItem(STORAGE_PREFIX + getChatId(), JSON.stringify(clean));
    } catch (e) { console.warn('[WST] 保存状态失败:', e); }
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
      lines.push('你必须查看上方聊天历史，推导当前世界状态，在回复末尾用<S-summary>标签输出。');
      lines.push('格式：时间：xxx / 区域：xxx / 在场角色+BUFF：xxx / 不在场角色：xxx /');
      lines.push('处女膜状态：xxx / 做爱次数：xxx / 当前好感度：xxx / 身体外貌：xxx /');
      lines.push('重要记忆点：- 角色名：记忆1|记忆2。所有字段必须填写，禁止省略。');
      lines.push('注意：仅追踪女性角色；' + (userName ? '排除用户角色「' + userName + '」；' : '') + '在场角色=当前场景中的女性角色。');
    }

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

  // ==================== 处理单条消息 ====================

  // 通过对比聊天数组判断消息是否来自用户
  function isUserMessage(msgEl) {
    try {
      var ctx = SillyTavern.getContext();
      if (!ctx.chat || !Array.isArray(ctx.chat)) return false;
      var mesText = msgEl.querySelector('.mes_text');
      var text = mesText ? (mesText.textContent || '').trim() : '';
      if (!text) return false;
      // 取前50字做匹配
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

  function processMessage(msg) {
    if (PROCESSED.has(msg)) return;
    PROCESSED.add(msg);

    // 跳过用户消息和系统消息
    if (isUserMessage(msg)) return;
    if (msg.classList.contains('system_mes')) return;

    var mesText = msg.querySelector('.mes_text');
    if (!mesText) return;

    var newState = extractSummaryFromDOM(mesText);

    if (!newState) {
      // 诊断：提取失败时记录原始内容前100字符
      var rawSample = (mesText.textContent || '').substring(0, 100);
      if (rawSample.indexOf('S-summary') !== -1 || rawSample.indexOf('summary') !== -1) {
        console.log('[WST] ⚠️ 检测到可能含S-summary但提取失败，原文片段:', rawSample);
      }
    }

    if (newState) {
      // 新状态：存储到该消息（作为历史快照）并更新全局
      MESSAGE_STATES.set(msg, newState);
      var oldState = loadState();
      var merged = mergeState(oldState, newState);
      saveState(merged);
      console.log('[WST] 消息状态已存储（快照）');

      var existingBody = msg.querySelector('.wst-body');
      if (existingBody) {
        populateCard(existingBody, merged);
      } else {
        var temp = document.createElement('div');
        temp.innerHTML = buildCardHTML(merged);
        while (temp.firstChild) msg.appendChild(temp.firstChild);
      }
    } else {
      // 没有 S-summary：检查该消息是否有历史快照
      var snapState = MESSAGE_STATES.get(msg);
      if (!snapState) {
        // 没有快照：使用当前全局状态（仅对最新消息）
        snapState = loadState();
        if (hasContent(snapState)) MESSAGE_STATES.set(msg, snapState);
      }
      if (hasContent(snapState)) {
        var existingBody = msg.querySelector('.wst-body');
        if (existingBody) {
          populateCard(existingBody, snapState);
        } else {
          var temp = document.createElement('div');
          temp.innerHTML = buildCardHTML(snapState);
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

  // ==================== 静默状态总结 ====================

  // 使用 generateQuietPrompt 静默生成世界状态（不显示在聊天中）
  var summarizeLock = false;

  async function summarizeChatHistory() {
    if (summarizeLock) { console.log('[WST] 已有总结任务进行中，跳过'); return; }
    summarizeLock = true;

    try {
      var ctx = SillyTavern.getContext();
      if (!ctx.chat || !Array.isArray(ctx.chat) || ctx.chat.length < 1) {
        console.log('[WST] 聊天记录不足，跳过总结');
        return;
      }

      // 构建聊天历史文本（最后15条，控制token）
      var recentMessages = ctx.chat.slice(-15);
      var historyText = '';
      for (var i = 0; i < recentMessages.length; i++) {
        var m = recentMessages[i];
        var role = m.is_user ? (ctx.name1 || '用户') : (m.name || 'AI');
        var text = (m.mes || '').replace(/<WST_世界状态>[\s\S]*?<\/WST_世界状态>/g, '').trim();
        if (text) historyText += role + '：' + text + '\n';
      }

      if (!historyText.trim()) { console.log('[WST] 无有效聊天文本'); return; }

      var wbData = getWorldBookData();
      var favorSys = wbData.favorabilitySystem || getDefaultFavorabilitySystem();
      var wbNote = wbData.allKeys.length > 0 ? '仅限世界书角色：' + wbData.allKeys.join('、') + '。' : '';

      var systemMsg = '你是世界状态追踪器。根据聊天记录提取当前世界状态。只输出状态，不要解释。';

      // 获取用户名用于排除说明
      var userName = getUserPersonaName();
      var userExcludeNote = userName ? '用户扮演的角色「' + userName + '」不追踪，所有字段中都不出现。' : '';

      var userMsg = '聊天记录：\n' + historyText + '\n\n' +
        '请按以下格式输出当前世界状态：\n' +
        '时间：（格式：xxxx年xx月xx日xx时xx分。如无明确时间，根据剧情合理推断，不要留空）\n' +
        '区域：\n' +
        '在场角色+BUFF：\n' +
        '不在场角色：\n' +
        '处女膜状态：\n' +
        '做爱次数：\n' +
        '当前好感度：\n' +
        '身体外貌：\n' +
        '重要记忆点：\n' +
        '- 角色名：记忆1|记忆2\n\n' +
        '★★★ 核心规则（必须严格遵守）★★★\n\n' +
        '【规则0：仅追踪女性角色】\n' +
        '   所有字段（在场角色、不在场角色、处女膜状态、做爱次数、身体外貌、当前好感度、重要记忆点）\n' +
        '   仅记录女性角色信息。男性角色不出现。\n\n' +
        (userName ? '【规则0.5：排除用户角色】\n   「' + userName + '」是用户扮演的角色，无论男女，任何字段中都不出现此角色。\n\n' : '') +
        '【规则1：在场/不在场的核心判断标准】\n' +
        '  在场角色 = 查看最近几条消息的对话场景，在该场景中出现的所有女性角色都是在场角色。\n' +
        '  判断方法：如果角色在说话、被他人对话、在场景中有动作描写，她就在场。\n' +
        '  关键：主角当前所处的场景就是"在场"场景。场景中所有女性均是在场角色。\n' +
        '  示例：\n' +
        '    消息中琴和主角在骑士团办公室对话，芭芭拉走进来打招呼 → 在场角色=琴、芭芭拉\n' +
        '    消息中主角和琴在野外战斗，芭芭拉在远处施法 → 在场角色=琴、芭芭拉\n' +
        '    消息中主角独自在酒馆，回想起昨天和琴的对话 → 在场角色=无（琴不在场景中）\n\n' +
        '【规则2：不在场角色的判断标准】\n' +
        '  不在场角色 = 之前在正文中出现过的女性角色，但当前不在主角所在场景。\n' +
        '  当前场景中出现的角色绝不能被误判为不在场！\n' +
        '  从未在正文中出现过的角色一律不列入不在场。\n' +
        '  格式：角色名-在做什么（每个角色≤10字），如"琴-在骑士团办公"。\n' +
        '  【严禁】不允许出现泛称条目！禁止写"七神及各国角色""其他角色""众人"等非具体角色名的条目。\n' +
        '  不在场角色必须是世界书中的具体女性角色名，每个一行。\n\n' +
        '【规则3：在场与不在场互斥】\n' +
        '  同一角色绝对不能同时出现在两边。如果在场角色列了某角色，不在场绝对不能列她。\n\n' +
        (wbData.allKeys.length > 0 ? '【规则4：世界书角色约束】\n   在场/不在场中只能出现世界书角色：' + wbData.allKeys.join('、') + '。\n   非世界书角色不列入。\n\n' : '') +
        '【规则5：好感度系统】\n' +
        '  好感度系统=' + favorSys + '。\n\n' +
        '【规则6：重要记忆点】\n' +
        '  每人≤6条，只记改变人生的事件（死亡、初吻、觉醒、背叛、重伤等），每条≤70字。\n' +
        '  日常琐事（吃了什么、走了几步路等）不记录。\n\n' +
        '【输出前自检】在你输出<S-summary>之前，请再次确认：\n' +
        '  □ 是否所有在场角色都正确识别了？（检查最近消息中所有出现的女性角色）\n' +
        '  □ 当前场景中的角色是否被错误分到了"不在场角色"？\n' +
        '  □ 不在场角色是否为"之前出现过但现在不在"的具体角色名？是否有泛称（如"七神""众人"）？\n' +
        '  □ 是否排除了用户角色和所有男性角色？';

      console.log('[WST] 🤖 开始静默总结 (历史长度:' + historyText.length + ' chars)...');

      var result = await ctx.generateQuietPrompt({
        quietPrompt: systemMsg + '\n\n' + userMsg,
        skipWIAN: true
      });

      // generateQuietPrompt 返回字符串或 { mes: "..." } 对象
      var resultText = '';
      if (typeof result === 'string') {
        resultText = result;
      } else if (result && typeof result === 'object') {
        resultText = result.mes || result.text || result.content || '';
        // 有些版本返回 chat 数组
        if (!resultText && Array.isArray(result) && result.length > 0) {
          resultText = result[result.length - 1].mes || result[result.length - 1].content || '';
        }
        if (!resultText && result.message) resultText = result.message;
        if (!resultText) resultText = JSON.stringify(result);
      }

      console.log('[WST] 总结原始返回 (' + resultText.length + ' chars):', resultText.substring(0, 200));

      if (resultText && resultText.length > 10) {
        var newState = parseSummary(resultText);
        if (newState && (newState.time || newState.location || newState.present || newState.absent)) {
          var oldState = loadState();
          var merged = mergeState(oldState, newState);
          // 过滤用户扮演角色
          merged = filterUserFromState(merged);
          saveState(merged);
          console.log('[WST] ✅ 状态已更新 - 时间:', merged.time, '| 区域:', merged.location, '| 在场:', merged.present, '| 不在场:', merged.absent);

          // 只更新最后一条AI消息的卡片（不碰历史消息）
          var allMes = document.querySelectorAll('.mes');
          for (var j = allMes.length - 1; j >= 0; j--) {
            var card = allMes[j].querySelector('.wst-body');
            if (card) {
              MESSAGE_STATES.set(allMes[j], merged);
              populateCard(card, merged);
              break;
            }
          }
          lastStateSentHash = '';
        } else {
          console.log('[WST] ⚠️ 解析后状态仍为空，可能需要调整Prompt。解析结果:', JSON.stringify(newState).substring(0, 200));
        }
      } else {
        console.log('[WST] ⚠️ 总结返回内容过短或为空');
      }
    } catch (e) {
      console.warn('[WST] 静默总结失败:', e.message, e.stack);
    } finally {
      summarizeLock = false;
    }
  }

  // 每次AI回复后触发静默总结
  function triggerSummarize() {
    var ctx;
    try { ctx = SillyTavern.getContext(); } catch(e) { return; }
    if (!ctx.chat || !Array.isArray(ctx.chat) || ctx.chat.length < 1) return;
    // 总是触发，让generateQuietPrompt决定是否需要更新
    summarizeChatHistory();
  }

  // 方法 A：DOM 捕获阶段拦截 — 在酒馆读取文本框之前注入状态
  // ⚠️ 已禁用：会导致二次点击才能发送的bug
  function injectStateToTextarea() { /* disabled */ }

  // 使用 setExtensionPrompt 注入状态（不修改聊天数组，不修改文本框）
  function injectStateToPrompt() {
    var state = loadState();
    if (!hasContent(state)) return;
    var stateText = buildStatePrompt(state);
    try {
      var ctx = SillyTavern.getContext();
      if (typeof ctx.setExtensionPrompt === 'function') {
        ctx.setExtensionPrompt('wst', stateText, 0);
        console.log('[WST] ✅ 状态已注入到Prompt (' + stateText.length + ' chars)');
      }
    } catch (e) {
      console.warn('[WST] Prompt注入失败:', e.message);
    }
  }

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
      lastStateSentHash = '';

      // 只刷新当前编辑所在消息的卡片
      var msgEl = line.closest('.mes');
      if (msgEl) {
        MESSAGE_STATES.set(msgEl, state);
        var card = msgEl.querySelector('.wst-body');
        if (card) populateCard(card, state);
      }
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
    console.log('[WST] 🚀 世界状态追踪器 v3.2.0 初始化...');
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

      es.on(et.CHARACTER_MESSAGE_RENDERED, function () {
        clearTimeout(timer);
        lastStateSentHash = '';
        timer = setTimeout(function () {
          scan();
          // 角色消息渲染完成后触发静默总结（仅主对话，不会被generateQuietPrompt触发）
          triggerSummarize();
        }, DEBOUNCE_MS);
      });

      es.on(et.MESSAGE_SENT, function () {
        lastStateSentHash = '';
        injectStateToPrompt();
      });

      es.on(et.CHAT_CHANGED, function () {
        currentChatId = getChatId();
        clearUserNameCache();
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
