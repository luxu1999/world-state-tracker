# 世界状态追踪器 — 重构需求文档

> 创建时间：2026-07-31 | 版本：v1.0

---

## 一、保留的现有内容

### 1.1 状态卡片 UI

蓝色可折叠头部 + 粉色内容区，**默认折叠状态**，点击头部展开。包含以下字段：

- **时间**：当前剧情时间
- **区域**：主角所在位置
- **在场角色+BUFF**：当前场景中出现的女性角色及状态
- **不在场角色**：出现过但当前不在场的女性角色（格式：角色名-在做什么）
- **处女膜状态**：女性角色的处女膜状态
- **做爱次数**：女性角色的性行为次数
- **当前好感度**：女性角色对主角的好感度
- **身体外貌**：女性角色的当前外貌
- **重要记忆点**：改变人生的重要事件（每人≤6条，每条≤70字）

### 1.2 现有功能框架

- `chatMetadata` 数据存储（跟随聊天对象，跨聊天不污染）
- `CHAT_COMPLETION_PROMPT_READY` Prompt 注入
- HTML 注释（`<!-- WST -->`）+ 纯文本兜底提取
- 世界书角色读取 + 好感度系统集成
- 用户角色排除 + 泛称条目过滤
- 重要记忆评分排序管理
- 手动点击编辑字段

---

## 二、核心需求

### 2.1 卡片显示规则

**仅最新 2 条消息显示状态卡片**，其余消息不显示：

```
...（更早的消息无卡片）
#104 AI回复 → 状态追踪(B)  ← 显示
#105 用户消息 → 状态追踪(b) ← 显示
```

### 2.2 状态继承逻辑（关键）

```
B（AI 消息上的状态） → b（用户消息上的状态）

b 必须 ≠ B
b 必须是 B 经过 #105 消息中发生的事件后线性逻辑发展的结果
```

**具体规则：**

| 状态 | 位置 | 说明 |
|------|------|------|
| A | AI 消息 #102 | AI 回复后提取的状态 |
| a | 用户消息 #103 | 基于 A，经过 #103 用户输入中发生的事件演化 |
| B | AI 消息 #104 | 基于 a，经过 #104 AI 回复中发生的事件演化 |
| b | 用户消息 #105 | 基于 B，经过 #105 用户输入中发生的事件演化 |

**核心约束：**
- 相邻两个卡片（B 和 b）的内容**不能相同**
- 每个新卡片必须在前一个卡片基础上有**可观察的变化**（时间推进、位置移动、角色加入/离开、好感变化等）
- 变化必须符合聊天内容的**线性逻辑**

### 2.3 数据隔离

- 每个聊天文件只保存 **2 个状态快照**（最新 AI + 最新用户）
- 新状态产生时，旧状态被顶替（替换而非追加）
- 每个聊天文件独立，互不污染

### 2.4 版本更新清理

- 每次扩展版本号变更时，自动清理旧版本残留数据
- 清理后重新开始记录，防止跨版本数据格式不兼容导致的污染

### 2.5 聊天记录读取规则（核心）

> 目的：保证状态信息的正确性和连续性，增强 AI 的短期、细节记忆

**首次读取（插件刚安装 / 版本更新后 / 聊天首次打开）：**
- 读取**全部**上下文信息（所有聊天历史），不只最后 N 条
- 根据完整聊天历史自动分析并注入相关状态信息（首次回溯填充）
- 生成准确的初始状态 B，作为后续演化的基线

**后续读取（正常对话流程）：**
- 基于**上一段状态追踪** + **新消息**（用户消息或 AI 回复）生成新的状态追踪
- 不重新扫描全部历史，只做增量演化，保证连续性和效率
- 新状态 = 上一状态经过新消息事件的线性逻辑发展

**记忆增强机制：**
- 状态追踪信息作为 AI 的短期记忆注入到每次生成的 Prompt 中（`CHAT_COMPLETION_PROMPT_READY`）
- 保证 AI 在每轮对话都能看到当前世界状态，增强对细节的把握
- 重要记忆点字段持续积累关键事件，形成长期上下文

```
首次：全部聊天历史 ──→ 分析 ──→ 初始状态 B
后续：上一状态 B + 新消息 ──→ 演化 ──→ 新状态 b（→ 再演化 B'）
```

---

## 三、技术约束

- 纯 ES5 兼容语法
- SillyTavern 扩展机制（manifest.json + index.js + style.css）
- 数据存储在 `ctx.chatMetadata` 中（跟随聊天对象）
- 不依赖外部 API 调用（避免 Android 兼容问题）
- DOMPurify 兼容（不使用会被过滤的自定义 HTML 标签）

---

## 四、验收标准

1. 发送消息后，最后 2 条消息（AI + 用户）下方各出现一个状态追踪卡片，**默认折叠**
2. 点击蓝色头部可展开/折叠内容区
3. 历史消息不显示卡片
4. 切换聊天后，各聊天状态独立不污染
5. 扩展更新（版本号变更）后，旧数据被清理
6. 手动点击卡片字段可以编辑
7. 首次打开聊天时，自动读取全部聊天历史并填入初始状态
8. 后续对话基于上一状态 + 新消息增量演化，状态保持连续
9. 状态追踪信息注入到每次 AI 生成的 Prompt（短期记忆）

---

## 五、参考项目

| 模块 | 参考来源 | 说明 |
|------|---------|------|
| 数据存储（`chatMetadata`） | [st-memory-enhancement](https://github.com/muyoou/st-memory-enhancement) | 状态跟随聊天对象，天然跨聊天隔离 |
| Prompt 注入（`CHAT_COMPLETION_PROMPT_READY`） | [st-memory-enhancement](https://github.com/muyoou/st-memory-enhancement) + [ST 文档](https://sillytaverncn.com/for-contributors/writing-extensions/) | 直接操作 `eventData.chat` 数组注入 |
| Chat 切换自动回填 | [st-memory-enhancement](https://github.com/muyoou/st-memory-enhancement) | `onChatChanged` 检测空数据 → 触发回溯 |
| `generateRaw` 消息数组格式 | [narrative-agent](https://github.com/Lol1p0p/narrative-agent) | `{ prompt: [{role, content}] }` 无聊天上下文提取 |
| 生成完成后处理（`GENERATION_ENDED`） | [narrative-agent](https://github.com/Lol1p0p/narrative-agent) + [ST 文档](https://sillytaverncn.com/for-contributors/writing-extensions/) | 正文输出完毕 → 触发状态提取 |
| JSON Schema 结构化输出 | [ST 功能调用文档](https://sillytaverncn.com/for-contributors/function-calling/) | `generateRaw({ jsonSchema })` 强制 JSON 输出 |
| 扩展 manifest 规范 | [ST 扩展开发文档](https://sillytaverncn.com/for-contributors/writing-extensions/) | `generate_interceptor`、事件系统、状态管理 |
| 函数工具注册 | [ST 功能调用文档](https://sillytaverncn.com/for-contributors/function-calling/) | `registerFunctionTool`、`isToolCallingSupported` |
