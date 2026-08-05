<!-- Generated: 2026-08-01 | Updated: 2026-08-05 -->

# wordpress-skills

## 用途
跨平台 WordPress 发布 CLI 工具 (wbp.mjs)，兼容多种 AI 工具（Claude Code、OpenAI Codex、OpenCode、Hermes、OpenClaw、小U同学）。单命令工作流：从 Excel 随机选取关键词 → 生成内容 → 混排图片 → 通过 WP REST API 发布。

## 关键文件

| 文件 | 说明 |
|------|------|
| `wbp.mjs` | 核心单文件 ES 模块，包含全部功能：TOML 解析、Excel 读取、S3 SigV4 签名、WP REST API、图片搜索（Serper.dev 多 key 轮询）、图片混排、质量检查、去重检测、指数退避重试、缓存、交互式配置向导、tomlString、parseCategories。`wbp install` 子命令负责 npm link 全局化 + AI CLI 检测 + 命令文件生成 + 配置向导 |
| `selftest.mjs` | 108 项自动化测试，覆盖语法、init、pick、TOML 解析（含边界情况）、去重哈希、图片混排、图片函数、WP API 函数、错误处理、文档验证、配置向导、tomlString、parseCategories |
| `package.json` | Node.js 项目清单，依赖 exceljs 库 |
| `CLAUDE.md` | Claude Code 项目记忆，含提交规范 |
| `README.md` | 完整用户文档 |

## 子目录

| 目录 | 用途 |
|------|------|
| `skills/wbp/references/data/` | 仓库内输入数据文件：关键词、产品、提示词、扩展知识（安装时复制到 `~/.wbp/data/`） |
| `skills/wbp/scripts/__TEST__/` | 自检测试目录 |

## 给 AI 代理的指引

### 在此目录工作
- **单文件架构**：所有逻辑集中在 `wbp.mjs`，不拆分内部模块（仅标准库/依赖的 import）
- **仅 ES 模块**：使用 `import`/`export`，通过 `node wbp.mjs` 直接运行
- **跨平台路径**：使用 `path.join` 和 `os.homedir()` 兼容 Windows/Unix
- **无构建步骤**：直接执行，无需转译
- **提交规范**：每次任务完成使用 `rtk git` 提交到 GitHub

### 测试要求
- `node --check wbp.mjs` 验证语法
- `node selftest.mjs` 运行完整测试套件（108 项，93% 覆盖率）
- 测试覆盖：语法、init、pick、TOML 解析（含边界情况）、去重（含 CJK）、图片混排（含属性保留）、图片函数、WP API 函数、helper 函数、错误处理、文档验证、数据文件完整性、错误边界、配置向导、tomlString、parseCategories

### 常用模式
- 迷你 TOML 解析器，支持内联注释、单引号、转义字符
- TOML 字符串生成器（tomlString），使用点表示法生成标准 TOML 格式
- 分类解析器（parseCategories），支持数字和字符串混合分类
- 交互式配置向导（doConfigWizard），10 个配置问题 + TTY 检测
- S3 SigV4 签名，支持分页和 XML 实体反转义
- WordPress REST API 基础认证（应用程序密码）
- 通过段落位置重构实现图片混排
- 质量验证：词数（≥60 波兰语）、段落（≥8）、H3（≥3）、标题（≥10）、摘要（≥50）、标签（3-10）、死链、内链（≥3 警告）、关键词命中（警告）、E-E-A-T 外链（警告）
- 四种图片模式：S3（混排）、图片搜索（Serper.dev 多 key 轮询）、CDN（直传）、媒体库（回退）

## 依赖关系

### 内部
- `data/keywords.xlsx` - 关键词池，随机选取主题
- `data/products.xlsx` - 产品数据，用于内容丰富
- `data/prompts.md` - 写作指令（波兰语）
- `data/extensions/` - 扩展知识文件（wiedza.md）

### 外部
- `exceljs` (npm) - Excel 文件读取，通过 eachRow

<!-- MANUAL: 核心工具是 wbp.mjs，其他文件均为辅助工具。设计目标为单命令跨 5 个 AI 平台运行。 -->