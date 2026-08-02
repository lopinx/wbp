# WordPress AI Publisher (wbp)

> 跨平台 WordPress 发布 CLI 工具 — 单命令完成：选取关键词 → 生成内容 → 混排图片 → 通过 WP REST API 发布

[![Node.js](https://img.shields.io/badge/Node.js-≥18.0-green)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-WTFPL-blue)](LICENSE)

---

## 项目简介

**wbp** (WordPress Publisher) 是一个单文件 Node.js CLI 工具，专为 AI 辅助内容发布设计。兼容 5 种 AI 工具：

| AI 工具 | 调用方式 | 命令文件位置 |
|---------|----------|-------------|
| **Claude Code** | `/wbp` | `~/.claude/commands/wbp.md` |
| **OpenAI Codex** | `@wbp` | `~/.codex/prompts/wbp.md` |
| **OpenCode** | `/wbp` | `~/.config/opencode/commands/wbp.md` |
| **Hermes** | `/wbp` | `~/.hermes/commands/wbp.md` |
| **OpenClaw** | `/wbp` | `~/.openclaw/commands/wbp.md` |

### 核心工作流

```
1. node wbp.mjs pick       → 随机选取关键词 + 获取配置上下文
2. AI 撰写文章             → 基于关键词 + 产品数据 + 写作指令
3. node wbp.mjs publish    → 去重检查 → 质量检查 → 图片处理 → 发布
```

## 安装

```bash
git clone https://github.com/lopinx/wbp.git
cd wbp
npm install
node install.mjs      # 自动检测 AI CLI 并创建命令文件
node wbp.mjs init     # 生成配置模板
```

安装脚本自动检测本地已安装的 AI CLI（Claude Code、Codex、OpenCode、Hermes、OpenClaw），仅为已安装的工具创建命令文件。

### npx 直接运行（无需安装）

```bash
npx github:lopinx/wbp pick
npx github:lopinx/wbp publish ~/.wbp/_draft.json
npx github:lopinx/wbp init
```

## CLI 使用

| 命令 | 说明 | 示例 |
|------|------|------|
| `node wbp.mjs init` | 创建配置模板 | `node wbp.mjs init` |
| `node wbp.mjs pick` | 随机选取关键词 | `node wbp.mjs pick` |
| `node wbp.mjs publish <draft.json>` | 发布草稿 | `node wbp.mjs publish ~/.wbp/_draft.json` |

### npm scripts

```bash
npm start        # node wbp.mjs
npm run init     # node wbp.mjs init
npm run pick     # node wbp.mjs pick
npm run test     # 87 项自检测试
```

### 草稿 JSON 格式

```json
{
  "title": "文章标题（40-70 字符，波兰语）",
  "excerpt": "摘要 120-160 字符，包含主要关键词",
  "content": "<p>引言段落...</p><h2>小标题</h2><p>正文...</p><p>总结...</p>",
  "tags": ["标签1", "标签2", "标签3"]
}
```

## 配置

编辑 `~/.wbp/setting.toml` 配置站点：

```toml
[site.mojblog]
name = "Mój Blog"
url = "https://example.com/wp-json/wp/v2"
user = "admin"
pass = "xxxx xxxx xxxx xxxx"
categories = [1, "news", "vape"]          # 多分类支持（ID 或名称）
keywords = ["data/keywords.xlsx"]
products = "data/products.xlsx"
prompts = "data/prompts.md"
extensions = ["data/extensions/wiedza.md"]

# S3 兼容存储（AWS/七牛/MinIO/Ceph 等）
[site.mojblog.cdn]
mode = "s3"
bucket = "my-bucket"
region = "us-east-1"
key = "AKIA..."
secret = "..."
prefix = "images/"
# endpoint 可选，不填则自动使用 AWS S3 地址
#endpoint = "https://s3.us-east-1.qiniucs.com"
#domain = "cdn.example.com"

	# 图片搜索 API（配合 cdn.mode="search" 使用）
	[site.mojblog.search]
	key = "your-serper-dev-api-key"
	#query = ""              # 可选，默认使用文章标题
```

### 多站点配置

```toml
[site.blog1]
name = "Blog 1"
url = "https://blog1.com/wp-json/wp/v2"
keywords = ["data/blog1-keywords.xlsx"]
# ...

[site.blog2]
name = "Blog 2"
url = "https://blog2.com/wp-json/wp/v2"
keywords = ["data/blog2-keywords.xlsx"]
# ...
```

## 图片处理模式

| 模式 | 配置 | 行为 |
|------|------|------|
| **S3 兼容** | `mode = "s3"` + endpoint（可选） | 从任意 S3 兼容存储（AWS/七牛/MinIO/Ceph）列出图片，随机混排插入段落间 |
| **图片搜索** | `mode = "search"` + `[search]` 节 | 通过 Serper.dev 等 API 搜索图片，随机混排插入段落间 |
| **CDN 直传** | `mode = "cdn"` + domain | 保留远程图片 URL |
| **媒体库** | 不配置 cdn 节点 | 自动下载外部图片上传到 WP 媒体库，替换 URL |

## 质量检查标准

| 指标 | 最低要求 | 类型 |
|------|----------|------|
| 词数 | ≥ 60（波兰语） | 必须 |
| 段落数 | ≥ 3 | 必须 |
| H2 标题 | ≥ 2 | 必须 |
| 标题长度 | ≥ 20 字符 | 必须 |
| 摘要长度 | ≥ 50 字符 | 必须 |
| 标签数 | 2-10 个 | 必须 |
| 死链 | 0（抽样检测前 3 个外链） | 必须 |
| 内链 | ≥ 1 | 警告 |

## 故障排查

| 问题 | 解决方法 |
|------|----------|
| S3 列表失败 | 检查 AK/SK、Bucket、Region、Prefix、endpoint |
| WP 认证失败 | 确认应用程序密码正确，用户有发布权限 |
| WP API 返回 HTML | 检查 `site.url` 配置为 `/wp-json/wp/v2` |
| 质量检查不通过 | 补充内容长度、段落、标题、标签 |
| 死链误报 | 检查外链可访问性，或移除不可达链接 |
| 重复标题 | 修改标题或删除原文章 |

## 开发指南

```
wbp/
├── wbp.mjs              # 核心 CLI (371 行)
├── install.mjs          # 一键安装脚本
├── selftest.mjs         # 87 项自检测试
├── package.json         # ESM 模块
├── AGENTS.md            # AI 代理指引
├── data/
│   ├── keywords.xlsx    # 关键词池
│   ├── products.xlsx    # 产品数据
│   ├── prompts.md       # 写作指令
│   └── extensions/
│       └── wiedza.md    # 行业知识
└── .omc/skills/wbp/
    └── SKILL.md         # OMC 项目级技能
```

```bash
node selftest.mjs    # 87/87 通过
node --check wbp.mjs # 语法检查
```

## 许可

WTFPL — Do What The Fuck You Want To Public License