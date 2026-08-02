<!-- Generated: 2026-08-01 | Updated: 2026-08-02 -->

# wordpress-skills

## 用途
跨平台 WordPress 发布 CLI 工具 (wbp.mjs)，兼容多种 AI 工具（Claude Code、OpenAI Codex、OpenCode、Hermes、OpenClaw）。单命令工作流：从 Excel 随机选取关键词 → 生成内容 → 混排图片 → 通过 WP REST API 发布。

## 关键文件

| 文件 | 说明 |
|------|------|
| `wbp.mjs` | 核心单文件 ES 模块，包含全部功能：TOML 解析、Excel 读取、S3 SigV4 签名、WP REST API、图片搜索（Serper.dev 多 key 轮询）、图片混排、质量检查、去重检测、指数退避重试、缓存 |
| `install.mjs` | 一键安装脚本，智能检测本地已安装的 AI CLI，仅为检测到的工具创建命令文件 |
| `selftest.mjs` | 88 项自动化测试，覆盖语法、TOML 解析（含边界情况）、去重哈希、图片混排、图片函数、WP API 函数、错误处理、文档验证 |
| `package.json` | Node.js 项目清单，依赖 xlsx 库 |
| `CLAUDE.md` | Claude Code 项目记忆，含提交规范 |
| `README.md` | 完整用户文档 |

## 子目录

| 目录 | 用途 |
|------|------|
| `data/` | 输入数据文件：关键词、产品、提示词、扩展知识 |
| `.omc/skills/` | OMC 项目级技能，wbp 发布技能（见 `.omc/skills/wbp/SKILL.md`） |

## 给 AI 代理的指引

### 在此目录工作
- **单文件架构**：所有逻辑集中在 `wbp.mjs`，无模块化导入
- **仅 ES 模块**：使用 `import`/`export`，通过 `node wbp.mjs` 直接运行
- **跨平台路径**：使用 `path.join` 和 `os.homedir()` 兼容 Windows/Unix
- **无构建步骤**：直接执行，无需转译
- **提交规范**：每次任务完成使用 `rtk git` 提交到 GitHub

### 测试要求
- `node --check wbp.mjs` 验证语法
- `node selftest.mjs` 运行完整测试套件（88 项）
- 测试覆盖：语法、init、pick、TOML 解析（含边界情况）、去重（含 CJK）、图片混排（含属性保留）、图片函数、WP API 函数、helper 函数、错误处理、文档验证、数据文件完整性、错误边界

### 常用模式
- 迷你 TOML 解析器，支持内联注释、单引号、转义字符
- S3 SigV4 签名，支持分页和 XML 实体反转义
- WordPress REST API 基础认证（应用程序密码）
- 通过段落位置重构实现图片混排
- 质量验证：词数（60 波兰语）、段落（3）、H2（2）、标题（20）、摘要（50）、标签（2-10）、死链、内链（警告）
- 四种图片模式：S3（混排）、图片搜索（Serper.dev 多 key 轮询）、CDN（直传）、媒体库（回退）

## 依赖关系

### 内部
- `data/keywords.xlsx` - 关键词池，随机选取主题
- `data/products.xlsx` - 产品数据，用于内容丰富
- `data/prompts.md` - 写作指令（波兰语）
- `data/extensions/` - 扩展知识文件（wiedza.md）

### 外部
- `xlsx` (npm) - Excel 文件读取，通过 sheet_to_json

<!-- MANUAL: 核心工具是 wbp.mjs，其他文件均为辅助工具。设计目标为单命令跨 5 个 AI 平台运行。 -->