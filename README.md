# Knowledge AI for SiYuan

一个无单独后端的思源笔记 AI 助手。每台机器安装同一个插件，索引数据写入思源工作区：

```text
data/storage/petal/siyuan-knowledge-ai/index/
```

如果你的思源工作区通过官方 S3 同步，多台机器会同步这份索引分片。插件只通过当前机器的思源 API 读取和写入笔记，不直接修改 `.sy` 文件，也不直接操作 S3 对象。

## 能力

- 基于全库笔记建立本地向量索引
- 索引分片随思源数据同步
- 支持 ChatGPT/OpenAI API
- 支持通用 OpenAI-compatible API
- 基于笔记片段问答并显示引用来源
- 将回答保存为新文档
- 将回答追加到当前文档

## 模型接口

默认配置：

- Base URL: `https://api.openai.com/v1`
- Chat model: `gpt-4.1-mini`
- Embedding model: `text-embedding-3-small`

也可以填写任何兼容 OpenAI API 的服务，例如 DeepSeek、OpenRouter、硅基流动、Ollama OpenAI-compatible endpoint 等。服务需要同时提供：

- `POST /chat/completions`
- `POST /embeddings`

## 隐私与同步

- API Key 存在当前浏览器/思源运行环境的 `localStorage`，不会写入插件同步目录。
- 索引分片包含笔记文本片段和 embedding，会跟随思源同步。
- 如果你的 S3 同步目录是端到端加密的，索引会和其他思源数据一起被保护。
- 如果不希望索引同步到其他机器，请不要使用本插件的索引同步目录。

## 安装

1. 下载或构建 `package.zip`。
2. 解压到思源工作区：

```text
data/plugins/siyuan-knowledge-ai/
```

3. 重启思源。
4. 在集市/插件列表中启用 `Knowledge AI`。

## 使用

1. 打开顶部栏的 `Knowledge AI`。
2. 填写 Base URL、Chat 模型、Embedding 模型和 API Key。
3. 点击 `保存`。
4. 点击 `更新索引`。
5. 提问。

## 多机器使用建议

- 只在一台机器上更新索引，等待思源 S3 同步完成后，其他机器直接使用同步后的索引。
- 如果多台机器同时更新索引，最后同步成功的一份会覆盖旧索引。
- 所有写入笔记的操作都在当前机器通过思源 API 执行，然后由思源 S3 同步到其他机器。

## 开发

这个插件没有构建步骤，源码就是插件运行文件。

```bash
npm run check
npm test
npm run pack
```

## 当前限制

- v0.1.0 使用分片全量索引，尚未实现块级增量更新。
- 回答采用非流式输出。
- 写入能力只提供保存回答为新文档、追加到当前文档。
