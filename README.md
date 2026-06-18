# Knowledge AI for SiYuan

一个无单独后端的思源笔记全库 AI 助手。插件通过思源 API 读取和写入笔记，索引分片写入思源工作区：

```text
data/storage/petal/siyuan-knowledge-ai/index/
```

如果你的思源工作区通过官方同步或 S3 同步，多台机器会同步这份索引。其他设备只要模型配置一致，就可以直接读取索引问答，不需要重复消耗 Embedding token 重建索引。

## 能力

- 全库笔记手动建立本地向量索引
- 索引 manifest 与分片随思源数据同步
- 支持 OpenAI 官方和 OpenAI-compatible API
- 支持 Google Gemini OpenAI-compatible API
- 支持可留空 API Key 的本地兼容服务，例如 Ollama OpenAI-compatible endpoint
- 基于全库笔记片段问答并显示引用来源
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

## 多设备同步

- 只需要在一台机器上点击 `更新全库索引`。
- 等待思源同步完成后，其他设备打开工作台并点击 `刷新状态`。
- 其他设备的 `Embedding 模型` 必须和索引 manifest 中记录的模型一致。
- API Key 只保存在当前设备的 `localStorage`，不会写入同步目录。

## 模型接口

默认配置：

- Base URL: `https://api.openai.com/v1`
- Chat model: `gpt-4.1-mini`
- Embedding model: `text-embedding-3-small`

设置页内置 OpenAI、Google Gemini、Ollama 三个预设，也可以填写任何兼容 OpenAI API 的服务。服务需要提供：

- `POST /chat/completions`
- `POST /embeddings`

远程服务通过思源 `/api/network/forwardProxy` 调用，避免浏览器前端直接请求第三方 API 时的 CORS 问题。本地 Ollama 等回环地址会由插件直接请求，并把 `localhost`、`::1` 规范为 `127.0.0.1`，避免思源 v3.6.5 的代理安全策略拦截本机地址。

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
- 索引分片包含笔记文本片段和 embedding，会跟随思源同步。
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
