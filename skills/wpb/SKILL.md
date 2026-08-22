---
name: wpb
description: WordPress AI publisher CLI — pick keyword, write article, mix images, publish via WP REST API. Use when the user says "publish", "wordpress", "发布文章", "写博客", "更新文章", or wants to generate and publish a WordPress article. Single-article workflow: pick → write → publish. Also supports updating existing posts via wpb fetch.
---

# WordPress Publisher Skill

## Workflow

### 1. 选取关键词

```bash
wpb pick
```

从关键词文件随机选取一行，输出 JSON：
- `site`：随机站点配置（名称、URL、分类、图片配置）
- `keyword`：关键词（取该行第一个字段的值）
- `keywordRow`：整行数据
- `products`：产品列表（配置了 products 时才有）
- `prompts`：写作指令（配置了 prompts 时才有）
- `extensions`：扩展知识（配置了 extensions 时才有）
- `images`：图片源配置（脱敏，不含 key/keys）
- `_warnings`：告警列表（仅在有告警时出现）

> 多站点配置时，每次 pick 随机选取一个站点，建议 pick 后立即撰写并发布。

### 2. 撰写文章

基于 `wpb pick` 输出的全部上下文撰写文章：
- `keyword` 是文章主题
- `products` 可用于介绍相关产品
- `prompts` 定义文章风格和结构要求
- `extensions` 提供额外背景信息

严格按照用户指令词撰写。如用户未指定，参考 `prompts` 中的写作指令。

文章 `content` 为 HTML 格式，含段落 `<p>`、小标题 `<h3>`，可含图片 `<img>` 和链接 `<a>`。

### 3. 保存草稿并发布

```bash
# 草稿格式
{
  "title": "文章标题",
  "excerpt": "文章摘要",
  "content": "<p>HTML正文内容</p><h3>小标题</h3><p>...</p>",
  "tags": ["标签1", "标签2", "标签3"],
  "postId": 123,          // 可选，更新已有文章时必填（由 wpb fetch 输出）
  "site": "myblog"        // 可选，多站点更新时必填（由 wpb fetch 输出）
}

wpb publish <草稿文件路径>
```

发布自动执行：
1. 验证字段完整性（`title`、`content`、`excerpt` 必填）
2. 去重检查（更新时排除自身）
3. 质量检查：词数 ≥5000、段落 ≥10、H3 ≥3、标题/摘要长度、标签 3-10、死链等
4. 自动创建不存在的分类和标签
5. 图片处理：S3/搜索/CDN/媒体库四模式
6. 发布（草稿含 `postId` 走更新路径，否则新建）

> 更新时 `tags` 缺失则保留原文章标签，`categories` 缺失则保留原分类。

### 4. 更新已存在文章

```bash
# 1. 拉取原文（仅接受文章 URL）
wpb fetch <文章URL>
```

输出 JSON 含 `postId`、`site`、`title`、`excerpt`、`content`、`tags`、`categories`、`instructions`。草稿 JSON **必须保留** `postId` 和 `site` 字段。

```bash
# 2. AI 改写原文，保存草稿（保留 postId 和 site）
# 3. 发布（自动检测 postId 走更新路径）
wpb publish <草稿文件路径>
```

> **多站点安全**：更新路径绝不随机选站点。草稿含 `site` 时按名称精确匹配；无 `site` 且单站点时回退；无 `site` 且多站点时拒绝执行。

## 图片处理模式

| 模式 | 配置 | 行为 |
|------|------|------|
| S3 | `mode = "s3"` | S3 图片保留原 URL，非 S3 域外链图片上传到媒体库 |
| 图片搜索 | `mode = "search"` | Serper.dev API 搜索图片混排插入段落间 |
| CDN | `mode = "cdn"` | 保留远程图片 URL 不变 |
| 媒体库 | 不配置 cdn | 外部图片上传到 WordPress 媒体库并替换 URL |
