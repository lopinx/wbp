# WordPress AI Publisher (wbp)

> 跨平台 WordPress 发布 CLI 工具 — 单命令完成：选取关键词 → 生成内容 → 混排图片 → 通过 WP REST API 发布

## 项目简介

**wbp** (WordPress Publisher) 是一个单文件 Node.js CLI 工具，专为 AI 辅助内容发布设计。兼容 5 种 AI 工具（Claude Code、OpenAI Codex、OpenCode、Hermes、OpenClaw）。

### 核心工作流

```
1. node wbp.mjs pick       → 随机选取关键词 + 获取配置上下文
2. AI 撰写文章             → 基于关键词 + 产品数据 + 写作指令
3. node wbp.mjs publish    → 去重检查 → 质量检查 → 图片处理 → 发布
```

## 关键文件

| 文件 | 说明 |
|------|------|
| `wbp.mjs` | 核心单文件 ES 模块：TOML 解析、Excel 读取、S3 SigV4、WP REST API、图片混排、质量检查、去重、重试 |
| `install.mjs` | 一键安装脚本，自动检测 AI CLI 创建命令文件 |
| `selftest.mjs` | 88 项自动化测试 |
| `package.json` | ESM 模块，依赖 xlsx |
| `AGENTS.md` | AI 代理指引 |
| `README.md` | 完整文档 |

## 图片处理模式

- **S3** — `mode = "s3"`，从 S3 兼容存储混排图片
- **图片搜索** — `mode = "search"`，通过 Serper.dev API 搜索图片（配置 `[site.x.images]`，多 key 随机轮询）
- **CDN** — `mode = "cdn"`，保留远程图片 URL
- **媒体库** — 不配 cdn 节点，自动上传到 WP 媒体库

## 提交规范

每次任务完成时，使用 `rtk git` 命令提交变更到 GitHub：
- `rtk git status` 查看变更
- `rtk git add <files>` 暂存
- `rtk git commit -m "type: description"` 提交
- `rtk git push` 推送

## 测试

- `node --check wbp.mjs` 语法检查
- `node selftest.mjs` 运行 88 项测试
- 测试覆盖：语法、init、pick、TOML 解析、去重（含 CJK）、图片混排、图片函数、WP API、错误处理、文档验证

## 代码约定

- 单文件架构，所有逻辑在 `wbp.mjs` 中
- 仅 ES 模块（`import`/`export`）
- 跨平台路径（`path.join` + `os.homedir()`）
- 无构建步骤，直接运行
- 配置在 `~/.wbp/setting.toml`（TOML 格式）
- 草稿 JSON 在 `~/.wbp/_draft.json`