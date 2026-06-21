# Knowledge AI for SiYuan

一个无单独后端的思源笔记全库 AI 助手。插件通过思源 API 读取和写入笔记，并把 Markdown/思源块结构感知的多层索引分片写入思源工作区：

```text
data/storage/petal/siyuan-knowledge-ai/index/
```

如果你的思源工作区通过官方同步或 S3 同步，多台机器会同步这份索引。其他设备只要模型配置一致，就可以直接读取索引问答，不需要重复消耗 Embedding token 重建索引。

## 能力

- 全库笔记手动建立本地向量索引
- 更新索引时复用未变化知识单元的旧 AI 摘要和 embedding，减少重复模型调用
- v3 结构化 Memory Unit：普通文档按块、章节、文档建索引，日记按整天明细、事件、事项、明细和可选 AI 主题建索引
- 基于 Markdown 标题层级，把标题下的连续块识别为章节主题
- 索引纳入路径、标签、属性、块引用和反链关系；`custom-tags`、重要度/紧急度/难度、项目 ID 会转成检索标签
- 三轴检索：按笔记本意图收窄范围，按标签/元数据加权，按 daily note 时间范围补充时间线记录
- 索引 manifest 与分片随思源数据同步
- 支持 OpenAI 官方和 OpenAI-compatible API
- 支持 Google Gemini OpenAI-compatible API
- 支持可留空 API Key 的本地兼容服务，例如 Ollama OpenAI-compatible endpoint
- 支持多个模型配置 profile，索引/检索和日常问答可使用不同服务商
- 基于全库知识单元问答并显示引用来源
- 右侧 Dock 面板进行多轮问答
- 思源插件设置页管理模型、索引和写入选项
- 设置页可直接测试聊天模型和 Embedding 模型
- 将回答保存为新文档或追加到当前文档
- 根据指令生成新笔记草稿，确认后创建文档
- 根据指令改写指定块，确认后覆盖目标块

## 在思源中使用

1. 将插件安装到思源工作区：

```text
data/plugins/siyuan-knowledge-ai/
```

2. 重启思源。
3. 打开 `设置 -> 集市 -> 已下载 -> 插件`。
4. 启用 `Knowledge AI`。
5. 在插件列表中点击 `设置`，填写模型配置、API Key，并选择索引配置和问答配置。
6. 点击右侧 Dock 的 `Knowledge AI` 图标，打开问答面板。
7. 在插件设置的 `索引` 页点击 `更新索引`。
8. 等待索引写入完成后开始提问。

## v3 索引逻辑

Knowledge AI 不再只把笔记当成一堆文本片段，而是按思源和 Markdown 的真实结构建立 Memory Unit：

- `block`：具体内容块，用于精确引用和安全改写。
- `section`：标题下面直到同级或更高级标题前的块，作为小主题。
- `document`：整篇文档主题。
- `daily_event`：日记里的时间点事件，保留日期、时间和上层主题。
- `daily_item`：日记事件下面的清单事项，适合记录临时想法、问题和待办。
- `daily_detail`：日记整天内容、事项或事件里的长段落、代码块、表格等明细内容，会按长度切片，避免长周报或脚本只命中前半段。
- `daily_topic`：点击 `更新索引+摘要` 且开启 `日记 AI 主题分类` 时，由问答配置把变化过的 daily note 分类成若干当天主题，例如 `2026-06-18 / [技术] Markdown 渲染`。
- `notebook`：单个笔记本主题。
- `vault`：整个知识库主题。

普通文档倾向于保留 Markdown 标题结构：一篇文档通常就是一个完整主题，标题下内容会形成章节。日记倾向于拆得更细：同一天里可能混有运维、插件开发、学习记录和临时问题，因此会优先按“上层主题 -> 时间事件 -> 事项/明细”组织。

检索时会混合使用向量相似度、标题、路径、标签、关键词、同文档聚合和引用关系。普通问题优先返回具体块、章节、日记事项和日记明细证据；“整个知识库主要有哪些主题”这类宏观问题会更多使用文档、日记主题、日记事件、笔记本和全库主题单元。

普通 `更新索引` 不会生成 AI 摘要或日记 AI 主题，只会建立结构化索引和 embedding。需要做宏观整理时，可以点击 `更新索引+摘要`，此时插件会调用索引配置的聊天模型为章节、文档、笔记本和全库单元生成摘要，并在开启 `日记 AI 主题分类` 时为变化过的 daily note 生成 `daily_topic`。摘要和主题只写入同步索引，不写回你的思源笔记。本地聊天模型生成摘要通常比 embedding 慢很多，建议把 `AI 摘要上限` 设为 10-30；`日记 AI 分类天数` 默认 30 天，优先处理较新的变化日记。

点击 `更新索引` 时，插件会重新扫描当前可索引块并重写同步索引分片，以保证删除、移动、改名和结构变化都能被反映；但会按知识单元 `id + 原始内容 hash` 复用旧索引中的 AI 摘要，再按 `id + 最终内容 hash` 复用 embedding。只有新增或内容变化的主题才会重新生成摘要，只有最终索引文本变化的知识单元才会重新请求 Embedding API。切换 Embedding 模型或索引版本变化时，旧向量可能无法复用。

索引写入会先把新分片写入独立构建目录，最后切换 manifest；只有新 manifest 写入成功后才清理旧分片。这样更新中断时，上一份可用索引仍然能被读取。

索引单元数不是笔记篇数。一个文档可能同时生成块、章节、文档主题；一篇日记也可能拆成事件、事项和明细，因此 1 万多个思源块生成数千个知识单元是正常现象。使用 Gemini 免费层时，插件会自动按 100 个知识单元一批发送 Embedding 请求，并在触发 429 配额限制时按服务端建议时间等待后继续。

### 三轴检索

- 笔记本轴：问题里出现 `工作`、`技术`、`VMware`、`哲思` 等意图时，会尝试按匹配到的笔记本收窄向量检索范围；没有命中时回退到全库。
- 标签/元数据轴：`#标签#`、`custom-tags`、`custom-metric-importance/urgency/difficulty`、`custom-task-projectid` 会进入标签加权；例如 `custom-metric-importance=5` 会产生 `重要:高`。
- 时间轴：问题里出现 `今天`、`昨天`、`最近一周`、`上周三`、`6/15`、`6月15号` 等时间表达时，会从设置的 `日记路径` 拉取对应 daily note 记录，作为时间段上下文。纯“某天干了啥”类问题会直接使用时间轴，不强制依赖向量索引。

## 多设备同步

- 只需要在一台机器上点击 `更新索引`。
- 等待思源同步完成后，其他设备打开工作台并点击 `刷新状态`。
- 其他设备的 `索引配置` 里 `Embedding 模型` 必须和索引 manifest 中记录的模型一致。
- API Key 只保存在当前设备的 `localStorage`，不会写入同步目录。
- v1/v2 旧索引会提示重新更新；v3 索引可在多设备之间直接读取。

## 模型接口

默认配置：

- Base URL: `https://api.openai.com/v1`
- Chat model: `gpt-4.1-mini`
- Embedding model: `text-embedding-3-small`

设置页内置 OpenAI、Google Gemini、Ollama 三个预设，也可以填写任何兼容 OpenAI API 的服务。服务需要提供：

- `POST /chat/completions`
- `POST /embeddings`

模型页可以新增多个配置 profile。每个 profile 都有自己的 Base URL、API Key、聊天模型、Embedding 模型和代理方式。API Key 按 profile 独立保存在当前设备；旧版单一 API Key 只会作为首次迁移来源，保存新版设置后不再参与覆盖。`索引配置` 用于更新索引、问题向量化和索引一致性校验；`问答配置` 用于日常回答、生成草稿和改写笔记。常见用法是用便宜/本地的 Embedding 服务做索引，用更强的聊天模型负责回答。

远程服务通过思源 `/api/network/forwardProxy` 调用，避免浏览器前端直接请求第三方 API 时的 CORS 问题。本地 Ollama 等回环地址会由插件直接请求，并把 `localhost`、`::1` 规范为 `127.0.0.1`，避免思源 v3.6.5 的代理安全策略拦截本机地址。

### AI 请求代理

设置页的 `AI 请求代理` 只影响聊天和 Embedding 请求，不影响思源本地 API、索引文件读写或笔记写入。

- `系统代理优先`：默认模式。先尝试浏览器/Electron 网络栈直连，尽量继承系统代理；网络、CORS 或超时失败时自动回退到思源转发。
- `思源转发`：只使用思源 `/api/network/forwardProxy`。
- `浏览器直连`：只用前端 `fetch`，适合确认系统代理是否被应用网络栈接管。
- `自定义转发网关`：把与思源 `forwardProxy` 相同的 JSON payload 发送到你配置的网关 URL。

Clash、V2Ray 等如果已经设置为系统代理，优先使用 `系统代理优先`。不同平台和思源运行环境对系统代理的继承并不完全一致；如果系统代理不生效，可以改用 `思源转发` 或 `自定义转发网关`。本地 Ollama、`127.0.0.1`、`localhost` 等本地模型地址永远绕过代理。

Gemini 预设：

- Base URL: `https://generativelanguage.googleapis.com/v1beta/openai`
- Chat model: `gemini-3.5-flash`
- Embedding model: `gemini-embedding-2-preview`

Ollama 预设：

- Base URL: `http://127.0.0.1:11434/v1`
- Chat model: `qwen3:14b`
- Embedding model: `qwen3-embedding:4b`
- API Key: 可留空

## 安全写入

写入能力默认开启，但所有写入都会先让你确认：

- 新建文档：调用 `/api/filetree/createDocWithMd`
- 追加回答：调用 `/api/block/appendBlock`
- 覆盖块内容：先生成草稿，再调用 `/api/block/updateBlock`

如果只想问答，可以在插件设置中关闭 `允许写入笔记`。

## 隐私与同步

- API Key 按模型配置 profile 保存在当前设备。
- 索引分片包含笔记文本片段、标题路径、标签、属性、引用关系、可选 AI 摘要和 embedding，会跟随思源同步。
- 插件不直接修改 `.sy` 文件，也不直接操作 S3 对象。
- 所有笔记读写都通过当前设备的思源 API 完成。

## 开发

```bash
npm install
npm run check
npm test
npm run build
```

构建后会生成：

```text
dist/
package.zip
```

`package.zip` 可作为思源插件包发布或安装。
