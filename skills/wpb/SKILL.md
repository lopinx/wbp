---
name: wpb
description: WordPress AI publisher — pick keyword, generate, mix images, publish via REST API
triggers:
  - wordpress
  - publish
  - wp
  - 发布
  - 文章
argument-hint: "<任务描述> [数量]"
---

# WordPress Publisher Skill

## Purpose
跨平台 WordPress 发布 CLI 工具，兼容 11 种 AI 工具（Claude Code、OpenAI Codex、Gemini CLI、Antigravity CLI、OpenClaw、小U同学、Cursor、GitHub Copilot、OpenCode、Hermes、ZCode）。工作流：从关键词池随机选取主题 → AI 撰写内容 → 自动混排图片 → 通过 WP REST API 发布。支持通过 `wpb fetch` 拉取已发布文章并改写更新。

## When to Activate
- 用户说 "发布文章"、"写博客"、"publish"、"wordpress"
- 用户说 "更新文章"、"改写文章"、"刷新旧文"
- 需要自动生成并发布 WordPress 文章

## Workflow

### 0. 安装和配置（首次使用）

```bash
# npm 全局安装（自动生成默认配置 + 复制数据文件）
npm i -g github:lopinx/wpb
```

npm 安装会自动完成：
1. 生成默认配置文件 `~/.wpb/setting.toml`（可后续手动编辑）
2. 复制示例数据文件到 `~/.wpb/data/`

如需检测本地 AI CLI 并为已安装的工具创建命令文件，安装后运行：

```bash
wpb install
```

### 1. 选取关键词

```bash
wpb pick
```

从关键词文件中随机选取一行，输出包含以下字段的 JSON：
- `site`：当前随机选取的站点配置（名称、URL、分类、图片配置）
- `keyword`：本次选取的关键词（首列值）
- `keywordRow`：该关键词的整行数据（含关键词、搜索量等所有列）
- `products`：产品列表（供 AI 参考，配置了 products 时才有）
- `prompts`：写作指令内容（配置了 prompts 时才有）
- `extensions`：扩展知识内容（配置了 extensions 时才有）
- `images`：图片源配置（脱敏，不含 key/keys）
- `_warnings`：告警列表（仅在有告警时出现，如 S3 图片池为空）

> 多站点配置时，每次 `pick` 随机选取一个站点，因此建议每次 pick 后立即撰写并发布该站点文章。

### 2. 撰写文章

基于 `wpb pick` 输出的全部上下文信息撰写文章：

- **关键词**（`keyword`）是文章主题
- **产品信息**（`products`）可用于在文章中介绍相关产品
- **写作指令**（`prompts`）定义了文章的风格和结构要求
- **扩展知识**（`extensions`）提供额外的背景信息

严格按照用户指令词撰写文章内容。语言、风格、结构、字数等均由用户指令决定，工具不预设固定模板。如用户未指定，则参考 `prompts` 中的写作指令。

文章 `content` 应为 HTML 格式，包含段落 `<p>`、小标题 `<h3>`，可包含图片 `<img>` 和链接 `<a>`。

### 3. 保存草稿并发布

将撰写好的文章保存为草稿 JSON 文件，然后运行发布命令：

```bash
# 保存草稿
# 将文章写入任意 JSON 文件，格式如下：

# 草稿格式
{
  "title": "文章标题",
  "excerpt": "文章摘要",
  "content": "<p>HTML正文内容</p><h3>小标题</h3><p>...</p>",
  "tags": ["标签1", "标签2", "标签3"],
  "postId": 123,          // 可选，更新已有文章时必填（由 wpb fetch 输出）
  "site": "myblog"        // 可选，多站点更新时必填（由 wpb fetch 输出）
}

# 发布
wpb publish <草稿文件路径>
```

发布命令会自动执行以下流程：
1. 验证草稿字段完整性（`title`、`content`、`excerpt` 必填）
2. 去重检查：搜索 WordPress 是否已有相同标题的文章（更新时排除自身）
3. 质量检查：验证词数（≥5000）、段落（≥10）、H3 标题（≥3）、标题/摘要长度、标签数量（3-10）、失效链接等（不通过则拒绝发布）
4. 自动创建不存在的分类和标签
5. 图片处理：根据配置的图片模式（S3/搜索/CDN/媒体库）处理图片
6. 通过 WP REST API 发布文章（草稿含 `postId` 时走更新路径，否则新建）

> **提示**：质量检查包含硬性阈值（如词数、段落数、H3 数量等），文章需满足这些要求才能发布。发布前如有警告信息（如内链不足、关键词命中不足），可酌情补充内容后重新发布。

### 4. 更新已存在文章

当需要更新（改写/优化）已发布的站内文章时：

```bash
# 1. 拉取原文（仅接受文章 URL，不接受 ID）
wpb fetch <文章URL>
```

`wpb fetch` 从 URL 的域名自动匹配配置站点（多站点场景下不随机选取），输出包含以下字段的 JSON：
- `postId`：文章 ID（保存草稿时**必须保留**此字段）
- `site`：站点名（保存草稿时**必须保留**此字段，多站点下 publish 据此绑定站点）
- `title`、`excerpt`、`content`：文章原始内容（HTML）
- `tags`、`categories`：原标签和分类名称
- `instructions`：更新操作指引

```bash
# 2. AI 基于原文改写，保存草稿 JSON（保留 postId 和 site 字段）
# 3. 发布（自动检测 postId 走更新路径）
wpb publish <草稿文件路径>
```

> **多站点安全**：更新路径绝不随机选站点。草稿含 `site` 字段时按名称精确匹配；无 `site` 且单站点配置时回退使用该站点；无 `site` 且多站点配置时拒绝执行并提示先用 `wpb fetch` 获取完整上下文。

## 内容要求

严格按照用户指令词撰写文章内容。语言、风格、结构、字数等均由用户指令决定，工具不预设固定模板。

如用户未指定，则参考 `prompts`（即 `wpb pick` 输出中的写作指令）中的写作要求。

## 图片处理模式

| 模式 | 配置 | 行为 |
|------|------|------|
| S3 | `mode = "s3"` | 从 S3 兼容存储列出图片池，随机选取混排插入段落间 |
| 图片搜索 | `mode = "search"` | 调用 Serper.dev API 搜索图片，随机选取混排插入段落间 |
| CDN | `mode = "cdn"` | 保留文章中的远程图片 URL 不变 |
| 媒体库 | 不配置 cdn | 下载文章中所有外部图片，上传到 WordPress 媒体库并替换 URL |

## 数据文件格式

- 支持 **CSV、TXT、XLSX、XLS** 等格式（自动检测，无需手动分派）
- 首行为表头（解析时跳过），表头名称随意
- **关键词文件**：`pick` 取每行第一列作为关键词
- **产品文件**：所有列输出到 `products`，供 AI 参考
- 支持 **Google Sheets 发布为 CSV 的 URL**：直接在配置中填写 HTTPS 链接
- 自动处理：UTF-8 BOM、空行过滤、合并单元格、大数字防科学计数法

## 多站点支持

在 `setting.toml` 中配置多个 `[site.<slug>]` 节点，`wpb pick` 和 `wpb publish` 每次随机选取一个站点。

## 示例

```
/wpb 发布一篇关于电子烟的文章
/wpb 发布5篇关于一次性电子烟的文章
/wpb publish an article about Elf Bar
/wpb 更新 https://example.com/old-post
```

## 注意事项

- 始终先执行 `wpb pick` 获取关键词和完整上下文
- 草稿 JSON 必须包含 `title`、`content`、`excerpt` 三个必填字段，`tags` 为可选
- `tags` 字段为可选，但至少需要提供 3 个标签以满足质量检查要求
- 质量检查不通过时，需补充内容后重新发布
- `wpb publish` 接受任意路径的 JSON 文件，不局限于 `~/.wpb/_draft.json`
- 运行 `wpb install` 可检测本地 AI CLI 并为已安装的工具创建命令文件（支持 11 种工具）
- 更新已有文章时，先用 `wpb fetch <URL>` 拉取原文，草稿 JSON 必须保留 `postId` 和 `site` 字段
