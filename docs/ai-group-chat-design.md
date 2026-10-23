# Darling AI 群聊设计方案

状态：实施中；第一、二阶段（独立文字群聊、Echo 流式文字回答）已完成本地实现与自动化验证，尚未部署
记录日期：2026-10-23

## 1. 目标与确定边界

在现有 Darling 双人私聊基础上，并行新增一个由 D.Va、Mercy 和 AI 助手 Echo 组成的群聊。群聊支持文字、附件、图片理解、文档问答和 AI 流式回复。

现有双人私聊必须完整保留，不迁移、不删除，也不改变现有行为：

- 现有 `messages`、`attachments` 数据和历史记录保持不变。
- 现有 `message.send`、`message.sync`、`message.stored` 协议保持不变。
- 现有文字聊天、文件、截图、语音通话和远程桌面继续只按当前逻辑运行。
- AI 群聊故障不得影响私聊连接、消息同步、通话或远程桌面。
- 私聊消息和附件不得自动进入 AI 上下文。

产品入口如下：

```text
消息
├── Mercy                     原有双人私聊
└── D.Va、Mercy 与 Echo        新增 AI 群聊
```

初版群聊仅提供文字、附件和 AI 问答，不加入语音通话和远程桌面按钮。架构保留未来扩展群语音、视频通话和更多助手的能力。

## 2. 总体架构

```text
DVa 客户端 ─┐
             ├─ 现有 WebSocket/HTTP ─ Darling 服务端
Mercy 客户端 ┘                         │
                                      ├─ 原私聊模块（不改动）
                                      ├─ 新群聊消息与附件模块
                                      ├─ AI 请求编排与上下文构建
                                      ├─ 图片上传、文档解析与检索
                                      └─ DeepSeek API
                                           ├─ Chat Completions
                                           └─ Files API（图片）
```

客户端仍使用一条现有 WebSocket 连接，通过新增协议包承载群聊事件。DeepSeek API Key 只能保存在 Debian 服务端环境变量中，不能下发到 Electron 客户端。

## 3. 固定群聊与成员模型

第一版只创建一个内置群聊：

```ts
const AI_GROUP = {
  id: 'dva-mercy-echo',
  title: 'D.Va、Mercy 与 Echo',
  members: ['dva', 'mercy', 'echo']
};

type GroupActor = 'dva' | 'mercy' | 'echo';

type GroupMember = {
  id: GroupActor;
  kind: 'human' | 'assistant';
  displayName: string;
  avatarKey: string;
};
```

- `dva` 和 `mercy` 是经过现有配置文件认证的真人用户。
- `echo` 是服务端生成消息的虚拟成员，客户端不能伪造 Echo 消息。
- Echo 的显示名称、人设、头像和模型以后允许通过服务端配置调整。

## 4. 独立数据模型

新增群聊数据表，不改变现有私聊表。

```sql
CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  createdAt TEXT NOT NULL
);

CREATE TABLE group_members (
  groupId TEXT NOT NULL,
  memberId TEXT NOT NULL,
  memberType TEXT NOT NULL,
  displayName TEXT NOT NULL,
  PRIMARY KEY (groupId, memberId)
);

CREATE TABLE group_messages (
  id TEXT PRIMARY KEY,
  groupId TEXT NOT NULL,
  clientId TEXT,
  sender TEXT NOT NULL,
  messageType TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  attachmentId TEXT,
  replyToMessageId TEXT,
  seq INTEGER NOT NULL,
  createdAt TEXT NOT NULL,
  aiRequestId TEXT,
  aiModel TEXT,
  aiFinishReason TEXT,
  UNIQUE (groupId, seq),
  UNIQUE (sender, clientId)
);

CREATE TABLE group_attachments (
  id TEXT PRIMARY KEY,
  groupId TEXT NOT NULL,
  uploader TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  path TEXT NOT NULL,
  analysisStatus TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
```

群聊消息类型初期为 `text | attachment | assistant`。AI 流式增量只作为临时事件广播，完整回答完成后才作为正式消息落库。

附件分析状态为：

```text
not_requested → queued → extracting → ready
                              ├── unsupported
                              └── failed
```

## 5. 增量协议

### 5.1 客户端请求

```ts
type GroupClientPacket =
  | { type: 'group.sync'; payload: { groupId: string; after: number } }
  | { type: 'group.message.send'; payload: {
      groupId: string;
      clientId: string;
      text: string;
      replyToMessageId?: string;
    } }
  | { type: 'group.ai.cancel'; payload: {
      groupId: string;
      requestId: string;
    } };
```

群聊附件使用独立 HTTP 路由，例如：

```text
POST /groups/:groupId/attachments
GET  /groups/:groupId/attachments/:attachmentId
```

### 5.2 服务端事件

```ts
type GroupServerPacket =
  | { type: 'group.message.page'; payload: {
      groupId: string;
      messages: GroupMessage[];
      hasMore: boolean;
      next: number;
    } }
  | { type: 'group.message.stored'; payload: GroupMessage }
  | { type: 'group.ai.started'; payload: {
      groupId: string;
      requestId: string;
      triggerMessageId: string;
    } }
  | { type: 'group.ai.delta'; payload: {
      groupId: string;
      requestId: string;
      delta: string;
    } }
  | { type: 'group.ai.completed'; payload: {
      groupId: string;
      requestId: string;
      message: GroupMessage;
    } }
  | { type: 'group.ai.failed'; payload: {
      groupId: string;
      requestId: string;
      error: string;
    } };
```

所有新增包必须携带 `groupId`，且不得进入现有私聊状态机。

## 6. AI 触发规则

第一版采用明确触发，普通群聊不会自动消耗 API：

1. 消息包含 `@Echo`。
2. 用户引用一条消息并选择“询问 Echo”。
3. 用户对附件选择“询问 Echo”。
4. 输入框已明确选择 Echo 为提问对象。

输入 `@` 时显示成员菜单。`@Echo` 具有触发能力，`@D.Va` 和 `@Mercy` 初期只作为普通提及。

## 7. AI 请求流程

```text
用户发送含 @Echo 的群聊消息
  → 服务端验证身份、群组成员关系和 clientId
  → 先持久化用户消息并广播给双方
  → 创建 ai_requests 记录并锁定触发消息 seq
  → 按 groupId 进入串行队列
  → 构建人设、历史、引用消息和相关文件上下文
  → 广播 group.ai.started
  → 调用 DeepSeek 流式 Chat Completions
  → 持续广播 group.ai.delta
  → 完整回答以 echo 身份落库
  → 广播 group.ai.completed
```

必须先保存用户消息，再调用 AI。DeepSeek 失败时，用户消息仍正常存在。

同一个群组只允许一个 AI 请求运行，后续请求排队。请求记录至少包含：

```ts
type AiRequest = {
  id: string;
  groupId: string;
  triggerMessageId: string;
  triggerSeq: number;
  requestedBy: 'dva' | 'mercy';
  model: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
};
```

## 8. 区分 D.Va 与 Mercy

DeepSeek Chat Completions 的 `user` 消息支持 `name`，应将两个真人用户转换为不同名称：

```json
[
  {
    "role": "system",
    "content": "你是群聊助手 Echo。群内真人用户为 D.Va 和 Mercy。dva 对应 D.Va，mercy 对应 Mercy。必须准确区分两人的身份、观点、要求和上传内容。"
  },
  { "role": "user", "name": "dva", "content": "我支持方案 A。" },
  { "role": "user", "name": "mercy", "content": "我担心方案 A 的性能占用。" },
  { "role": "user", "name": "dva", "content": "@Echo 总结我们的分歧。" }
]
```

映射规则：

| Darling 成员 | DeepSeek role | DeepSeek name |
| --- | --- | --- |
| D.Va | `user` | `dva` |
| Mercy | `user` | `mercy` |
| Echo | `assistant` | 省略 |

系统提示必须要求 Echo：

- 不得混淆两人的观点、要求和文件。
- 引用观点时注明说话人。
- “你们”代表两位真人成员。
- 不得声称读取过解析失败或不支持的附件。
- 不主动抢占普通聊天，只有明确触发才回答。

## 9. 上下文管理

每次请求由四层内容组成：

1. 固定层：Echo 人设、成员映射和行为约束。
2. 摘要层：较早群聊历史的滚动摘要。
3. 近期层：最近约 40～60 条原始群聊消息，最终以 token 预算裁剪。
4. 关联层：当前问题、被引用消息、选中附件和相关文档片段。

长期摘要必须保存观点归属，例如：

```text
D.Va 希望……
Mercy 担心……
双方已经确认……
尚未解决……
```

私聊历史永远不参与群聊上下文。当前问题、被引用消息和相关附件的优先级高于普通历史。

## 10. 文件与图片处理

### 10.1 图片

DeepSeek 当前支持 JPEG、PNG、GIF 和 WebP。图片流程为：

```text
群聊保存原图
  → 用户询问 Echo
  → 查询 ai_file_bindings
  → 没有有效 file_id 时上传 DeepSeek Files API
  → 保存 providerFileId 和 expiresAt
  → 在 Chat Completions 中使用 file 内容块
```

```sql
CREATE TABLE ai_file_bindings (
  attachmentId TEXT NOT NULL,
  provider TEXT NOT NULL,
  providerFileId TEXT NOT NULL,
  expiresAt TEXT,
  createdAt TEXT NOT NULL,
  PRIMARY KEY (attachmentId, provider)
);
```

建议 DeepSeek 文件有效期设为 7 天；过期后按需重新上传。Darling 本地原文件不受该有效期影响。

### 10.2 文本文档

第一批支持 TXT、Markdown、JSON、CSV 和常见源码文件：

```text
读取文本 → 检测编码 → 限制解析大小 → 分段分块 → 建立检索索引
```

第二批增加 PDF 和 DOCX 文本提取，并保留页码、章节或段落位置：

```sql
CREATE TABLE document_chunks (
  id TEXT PRIMARY KEY,
  attachmentId TEXT NOT NULL,
  chunkIndex INTEGER NOT NULL,
  content TEXT NOT NULL,
  location TEXT,
  tokenEstimate INTEGER NOT NULL
);
```

初版使用 SQLite FTS5 或 BM25 检索，不立即引入向量数据库。EXE、压缩包、音视频等仍可正常发送和下载，但标记为“不支持 AI 内容分析”，不得将二进制 Base64 直接塞入聊天请求。

## 11. 流式输出与断线恢复

流式内容只保存在客户端临时状态：

```text
group.ai.started
group.ai.delta × N
group.ai.completed
```

- 收到 `completed` 后用服务端正式消息替换临时气泡。
- 只有完整回答落库，不保存半截回答。
- 客户端断线重连后通过 `group.sync` 获取已完成的 Echo 消息。
- 未完成的 delta 不做恢复。
- 失败时显示简洁错误状态，并允许重新提问。

## 12. 服务端模块划分

```text
apps/server/src/group/
├── group-store.ts
├── group-service.ts
├── group-attachments.ts
└── group-routes.ts

apps/server/src/ai/
├── ai-config.ts
├── deepseek-client.ts
├── ai-orchestrator.ts
├── context-builder.ts
├── persona-builder.ts
├── image-file-bridge.ts
├── document-parser.ts
├── document-index.ts
└── token-budget.ts
```

- `group-service` 只负责群聊收发，不了解供应商 API。
- `ai-orchestrator` 负责触发、队列、取消、幂等和状态。
- `context-builder` 将 Darling 群聊转换为模型消息。
- `deepseek-client` 负责 HTTP、SSE、超时、重试和错误转换。
- `image-file-bridge` 管理 DeepSeek `file_id`。
- `document-parser/index` 负责本地文档内容提取和检索。

## 13. 客户端结构与交互

```text
apps/desktop/src/group/
├── GroupChat.tsx
├── GroupHeader.tsx
├── GroupMessageList.tsx
├── GroupMessage.tsx
├── GroupComposer.tsx
├── MentionMenu.tsx
├── AiStreamingBubble.tsx
└── GroupAttachmentMessage.tsx
```

主界面增加视图选择，但现有私聊视图保持原实现：

```ts
type ActiveConversation =
  | { type: 'direct'; id: 'dva-mercy' }
  | { type: 'group'; id: 'dva-mercy-echo' };
```

群聊顶部显示群名、三位成员和 Echo 可用状态。AI 消息显示独立头像和轻量“AI”标识；生成过程中显示流式文字与“停止生成”。群聊沿用现有附件视觉风格，但必须调用群聊附件接口，不能错误发送到私聊。

## 14. 服务端配置

```json
{
  "ai": {
    "enabled": true,
    "provider": "deepseek",
    "baseUrl": "https://api.deepseek.com",
    "model": "deepseek-flash",
    "apiKeyEnv": "DEEPSEEK_API_KEY",
    "triggerMode": "mention",
    "reasoningEffort": "low",
    "maxOutputTokens": 4096,
    "contextTokenBudget": 24000,
    "requestTimeoutMs": 90000,
    "imageFileExpirationSeconds": 604800
  }
}
```

API Key 通过 Debian 服务环境变量提供：

```text
DEEPSEEK_API_KEY=实际密钥
```

客户端只接收 AI 是否可用、助手名称和状态，不接收密钥。

## 15. 错误、重试与日志

用户可见错误保持简洁：

- Echo 暂时不可用。
- 图片上传到 AI 服务失败。
- 文件解析失败。
- 该文件类型暂不支持 AI 分析。
- 回答超时，请重试。

请求策略：

- HTTP 429：退避后最多重试一次。
- 5xx：最多重试一次。
- 4xx：不自动重试。
- 请求超时：主动终止。
- 流式请求中断：标记失败，不保存半截回答。

日志不得记录 API Key、完整请求正文或用户文件全文。

## 16. 测试与验收标准

### 协议与隔离

- 原私聊协议和状态机行为不变。
- 群聊包不能进入私聊消息状态。
- 私聊消息和附件不能进入 AI 上下文。
- 非群成员不能读写群聊。
- 客户端不能伪造 Echo 消息。

### AI 上下文

- D.Va 和 Mercy 的 `name` 映射正确。
- Echo 历史转换为 `assistant`。
- 被引用消息必定进入上下文。
- 超出预算时优先保留当前问题和关联内容。
- 同时提问时严格串行，回答不会错位或重复。

### 文件

- 图片 `file_id` 可缓存复用，过期后重新上传。
- 文档可以分块并检索。
- 不支持的二进制文件不会进入模型上下文。
- 文件分析失败不影响普通群聊和下载。

### 断线与回归

- 重连后可通过 `group.sync` 恢复正式群聊消息。
- 未完成的流式片段不会污染历史记录。
- 当前私聊、附件、语音和远程桌面全部测试继续通过。

## 17. 实施阶段

### 第一阶段：纯群聊

- 增加独立群聊表、Store 和协议。
- 增加客户端群聊入口和视图。
- D.Va 与 Mercy 可以收发群聊文字。
- 不接入 DeepSeek。

本地实现记录（2026-10-23）：已完成独立群聊表、增量 WebSocket 协议、客户端状态同步、会话入口和双用户文字收发；已验证群聊持久化、去重及与原私聊隔离。群聊附件仍按计划留到第三阶段，不复用私聊附件发送目标。

### 第二阶段：AI 文字回答

- 接入 DeepSeek SSE。
- 实现 `@Echo` 触发、用户区分、串行队列、流式显示、停止和失败处理。

本地实现记录（2026-10-23）：已接入服务端 DeepSeek SSE 客户端、`@Echo` 明确触发、按群组串行执行、D.Va/Mercy `name` 映射、流式增量广播、停止生成、完整回答落库和不可用/超时状态。

### 第三阶段：图片问答

- 增加群聊图片附件、DeepSeek Files API、图片关联提问及 `file_id` 生命周期管理。

### 第四阶段：文档问答

- 支持文本和源码文件。
- 增加 PDF、DOCX 提取、分块、FTS 检索及来源位置。

### 第五阶段：长期上下文

- 增加滚动摘要、严格 token 预算、用量统计、人设配置和模型切换。

每一阶段都应独立构建、测试、打包和回退。任何阶段均以“不破坏现有双人私聊及其实时功能”为硬性门槛。

## 18. 官方接口依据

- DeepSeek 图像理解：<https://api-docs.deepseek.com/zh-cn/guides/vision/>
- DeepSeek Chat Completions：<https://api-docs.deepseek.com/zh-cn/api/create-chat-completion/>
- DeepSeek Files API：<https://api-docs.deepseek.com/zh-cn/guides/files_api/>

截至记录日期，Chat Completions 支持通过 `name` 区分同为 `user` 角色的参与者，并支持流式输出；`deepseek-flash` 支持图片理解。Files API 当前面向 JPEG、PNG、GIF 和 WebP 图片，普通文档必须由 Darling 服务端自行提取和检索。
