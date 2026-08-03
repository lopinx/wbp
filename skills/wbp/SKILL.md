---
name: wbp
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
跨平台 WordPress 发布 CLI 工具，兼容多种 AI 工具（Claude Code、OpenAI Codex、OpenCode、Hermes、OpenClaw）。单命令工作流：从 Excel 随机选取关键词 → 生成内容 → 混排图片 → 通过 WP REST API 发布。

## When to Activate
- 用户说 "发布文章"、"写博客"、"publish"、"wordpress"
- 需要自动生成并发布 WordPress 文章

## Workflow

### 1. 选取关键词
```bash
node C:/Users/Administrator/.wbp/wbp.mjs pick
```
输出 JSON 包含：`site`、`keyword`、`keywordRow`、`products`、`prompts`、`extensions`、`images`

### 2. 撰写文章
基于关键词、产品数据、写作提示词和扩展知识，撰写文章草稿。

### 3. 保存草稿
写入 `C:/Users/Administrator/.wbp/_draft.json`：
```json
{
  "title": "文章标题（40-70字符）",
  "excerpt": "摘要（120-160字符）",
  "content": "<p>HTML内容</p><h3>小标题</h3><p>...</p>",
  "tags": ["标签1", "标签2", "标签3"]
}
```

### 4. 发布文章
```bash
node C:/Users/Administrator/.wbp/wbp.mjs publish C:/Users/Administrator/.wbp/_draft.json
```

自动流程：去重检查 → 质量检查 → 分类/标签创建 → 图片处理 → 发布

## 内容要求

### 语言
- 使用波兰语（polski）撰写
- 风格：informacyjny, praktyczny, przyjazny
- 语气：ekspercki ale przystępny

### 标题风格
- 以问题形式开头：Jak...? Czy...? Dlaczego...?
- 或包含关键词+冒号+承诺
- 标题长度 40-70 znaków

### 内容结构
1. **Wstęp**（引言 1-2段）：hook 式开头
2. **Rozwinięcie**（主体 3-5 个小标题 H3）
3. **Podsumowanie**（总结 1段 + CTA）

### SEO 要求
- 摘要（excerpt）120-160 znaków
- 标签 3-5 个，波兰语，小写
- 正文自然嵌入关键词，每100词1-2次
- 800-1500 słów

## 质量检查标准
- 词数 ≥ 60（波兰语）
- 段落数 ≥ 8
- H3标题 ≥ 3
- 标题长度 ≥ 10 字符
- 摘要长度 ≥ 50 字符
- 标签数 3-10 个
- 死链检查
- 内链警告
- 内链 ≥ 3（指向站内产品、服务、分类页、文章详情页，锚文本含关键词）
- 关键词密度：主词 5-8 次，次词 2-4 次
- E-E-A-T 外部权威外链 ≥ 1（指向政府/行业机构/权威媒体）

## 图片处理模式
| 模式 | 配置 | 行为 |
|------|------|------|
| S3 | `mode = "s3"` | 从 S3 列出图片，随机混排插入段落间 |
| CDN | `mode = "cdn"` | 保留内容中的远程图片 URL 不变 |
| 媒体库 | 无 cdn 配置 | 下载外部图片上传到 WP 媒体库，替换 URL |

## 多站点支持
在 `setting.toml` 中配置多个 `[site.xxx]` 节点，`pick` 时随机选择一个站点。

## 示例

```
/wbp 发布一篇关于电子烟的文章
/wbp 发布5篇关于一次性电子烟的文章
/wbp publish an article about Elf Bar
```

## 注意事项
- 始终先执行 `node wbp.mjs pick` 获取关键词和配置
- 草稿 JSON 必须包含 title、content/excerpt、tags
- 发布前会自动检查重复标题和质量
- 如果质量检查不通过，需要补充内容后再发布
- 安装脚本会自动检测本地 AI CLI，仅为已安装的工具创建命令文件