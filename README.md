# Knowledge AI for SiYuan

一个无单独后端的思源笔记全库 AI 助手。插件通过思源 API 读取和写入笔记，并把 Markdown/思源块结构感知的多层索引分片写入思源工作区：

```text
data/storage/petal/siyuan-knowledge-ai/index/
```

如果你的思源工作区通过官方同步或 S3 同步，多台机器会同步这份索引。其他设备只要模型配置一致，就可以直接读取索引问答，不需要重复消耗 Embedding token 重建索引。

## 能力

- 全库笔记手动建立本地向量索引
- v2 多层知识单元：块、章节、文档、笔记本、全库
- 基于 Markdown 标题层级，把标题下的连续块识别为章节主题
- 索引纳入路径、标签、属性、块引用和反链关系
- 索引 manifest 与分片随思源数据同步
- 支持 OpenAI 官方和 OpenAI-compatible API
- 支持 Google Gemini OpenAI-compatible API
- 支持可留空 API Key 的本地兼容服务，例如 Ollama OpenAI-compatible endpoint
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
5. 在插件列表中点击 `设置`，填写 Base URL、模型和 API Key。
6. 点击右侧 Dock 的 `Knowledge AI` 图标，打开问答面板。
7. 在插件设置的 `索引` 页点击 `更新索引`。
8. 等待索引写入完成后开始提问。

## v2 索引逻辑

Knowledge AI 不再只把笔记当成一堆文本片段，而是按思源和 Markdown 的真实结构建立索引：

- `block`：具体内容块，用于精确引用和安全改写。
- `section`：标题下面直到同级或更高级标题前的块，作为小主题。
- `document`：整篇文档主题。
- `notebook`：单个笔记本主题。
- `vault`：整个知识库主题。

检索时会混合使用向量相似度、标题、路径、标签、关键词、同文档聚合和引用关系。普通问题优先返回具体块和章节证据；“整个知识库主要有哪些主题”这类宏观问题会更多使用文档、笔记本和全库主题单元。

`AI 主题摘要` 默认关闭。开启后，手动更新索引时会调用聊天模型为章节、文档、笔记本和全库单元生成摘要；摘要只写入同步索引，不写回你的思源笔记。

## 多设备同步

- 只需要在一台机器上点击 `更新全库索引`。
- 等待思源同步完成后，其他设备打开工作台并点击 `刷新状态`。
- 其他设备的 `Embedding 模型` 必须和索引 manifest 中记录的模型一致。
- API Key 只保存在当前设备的 `localStorage`，不会写入同步目录。
- v1 旧索引会提示重新更新；v2 索引可在多设备之间直接读取。

## 模型接口

默认配置：

- Base URL: `https://api.openai.com/v1`
- Chat model: `gpt-4.1-mini`
- Embedding model: `text-embedding-3-small`

设置页内置 OpenAI、Google Gemini、Ollama 三个预设，也可以填写任何兼容 OpenAI API 的服务。服务需要提供：

- `POST /chat/completions`
- `POST /embeddings`

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
- Embedding model: `gemini-embedding-001`

Ollama 预设：

- Base URL: `http://127.0.0.1:11434/v1`
- API Key: 可留空

## 安全写入

写入能力默认开启，但所有写入都会先让你确认：

- 新建文档：调用 `/api/filetree/createDocWithMd`
- 追加回答：调用 `/api/block/appendBlock`
- 覆盖块内容：先生成草稿，再调用 `/api/block/updateBlock`

如果只想问答，可以在插件设置中关闭 `允许写入笔记`。

## 隐私与同步

- API Key 只保存在当前设备。
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
