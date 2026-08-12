<!-- Generated: 2026-08-01 | Updated: 2026-08-11 -->

# wpb

## 用途
跨平台 WordPress 发布 CLI 工具（wpb.mjs），兼容 11 种 AI 工具（Claude Code、Hermes、OpenAI Codex、Gemini CLI、Antigravity CLI、OpenClaw、Cursor、GitHub Copilot、OpenCode、小U同学、ZCode）。单命令工作流：从 CSV/TXT/XLSX/XLS/URL 随机选取关键词 → 生成内容 → 混排图片 → 通过 WP REST API 发布。通过 `npm i -g github:lopinx/wpb` 全局安装，package.json `bin` 字段自动注册 `wpb` 命令。

## 关键文件

| 文件 | 说明 |
|------|------|
| `skills/wpb/scripts/wpb.mjs` | 核心单文件 ES 模块，包含全部功能：TOML 解析、数据表读取、S3 SigV4 签名、WP REST API、图片搜索（Serper.dev 多 key 轮询）、图片混排、质量检查、去重检测、指数退避重试、缓存、首次运行自动初始化（initConfig）、手动安装（doInstall）。`readTable` 使用 SheetJS (xlsx 0.20.3) 统一解析 CSV/TXT/XLSX/XLS/URL |
| `skills/wpb/scripts/__TEST__/selftest.mjs` | 自动化测试 (155/155 通过)，覆盖语法、pick、TOML 解析（含边界情况）、去重哈希、图片混排（含避开小标题/首段前/尾段后）、图片函数、WP API 函数、错误处理、文档验证、安装逻辑（doInstall、initConfig、postinstall.mjs 已移除）、CSV/TXT/XLSX/URL 解析、边缘情况（BOM、空行、日期、合并单元格、大数字） |
| `package.json` | Node.js 项目清单；`bin` 字段注册全局 `wpb` 命令；无 `postinstall` 钩子（npm 安装不执行脚本，首次运行时自动初始化）；`dependencies` 包含 xlsx (SheetJS 0.20.3, CDN) |
| `README.md` | 完整用户文档 |

## 子目录

| 目录 | 用途 |
|------|------|
| `skills/wpb/references/data/` | 仓库内输入数据文件：关键词、产品、提示词、扩展知识（安装时复制到 `~/.wpb/data/`） |
| `skills/wpb/scripts/__TEST__/` | 自检测试目录 |

## 给 AI 代理的指引

### 在此目录工作
- **单文件架构**：所有逻辑集中在 `wpb.mjs`，不拆分内部模块（Node 标准库 import + SheetJS 依赖）
- **仅 ES 模块**：使用 `import`/`export`，通过 `node wpb.mjs` 直接运行
- **跨平台路径**：使用 `path.join` 和 `os.homedir()` 兼容 Windows/Unix
- **无构建步骤**：直接运行源码，无需打包或编译
- **安装方式**：`npm i -g github:lopinx/wpb`（bin 字段自动注册 wpb 命令），升级用 `npm update -g @lopinx/wpb`
- **提交规范**：每次任务完成使用 `rtk git` 提交到 GitHub

### 测试要求
- `node --check skills/wpb/scripts/wpb.mjs` 验证语法
- `node skills/wpb/scripts/__TEST__/selftest.mjs` 运行完整测试套件 (152/152 通过)
- 测试覆盖：语法、pick、TOML 解析（含边界情况）、去重（含 CJK）、图片混排（含属性保留、避开小标题/首段前/尾段后）、图片函数、WP API 函数、helper 函数、错误处理、文档验证、数据文件完整性、错误边界、CSV/TXT/XLSX/URL 解析、边缘情况（BOM、空行、日期、合并单元格、大数字）

### 常用模式
- 迷你 TOML 解析器，支持内联注释、单引号、转义字符、点号键（site.myblog.name）
- **无 postinstall 钩子，首次运行时自动初始化**：npm 全局安装 git 依赖时用 symlink，postinstall 脚本在 symlink 目标被清理后无法执行。因此 `package.json` 不设 postinstall 钩子，改为 `wpb.mjs` 的 `initConfig()` 在首次 `wpb pick`/`publish` 时检测 `~/.wpb/setting.toml` 不存在则自动创建配置 + 复制数据。`doInstall`（`wpb install` 命令，手动）额外做 AI CLI 检测 + 命令文件生成。DEFAULT_CFG 单一定义于 wpb.mjs，无脱钩风险
- S3 SigV4 签名，支持 prefix 前缀筛选、endpoint 可选、domain 自定义、环境变量覆盖密钥
- WordPress REST API 基础认证（应用程序密码）
- 通过段落位置重构实现图片混排
- 质量验证：词数（≥5000）、段落（≥10）、H3（≥3）、标题（≥10）、摘要（≥50）、标签（3-10）、死链、内链（≥3 警告）、关键词命中（警告）、E-E-A-T 外链（警告）
- 数据表读取：SheetJS (xlsx 0.20.3) 统一解析 CSV/TXT/XLSX/XLS/URL，自动检测格式、分隔符、编码
- 四种图片模式：S3（混排）、图片搜索（Serper.dev 多 key 轮询）、CDN（直传）、媒体库（回退）

### 数据文件格式兼容性

**完全兼容主流 SEO 平台导出格式**：

| 平台 | CSV (逗号) | CSV (分号) | XLSX | 中文表头 | 说明 |
|------|-----------|-----------|------|---------|------|
| **Google Search Console** | ✅ | ✅ | ✅ | ✅ | 标准导出、带引号/特殊字符、多工作表 XLSX |
| **Bing Webmaster Tools** | ✅ | ✅ | ✅ | ✅ | 欧洲 locale 分号分隔、标准 CSV |
| **百度站长平台** | ✅ | ✅ | ✅ | ✅ | 中文表头、UTF-8/BOM、分号/逗号分隔 |

**支持的文件格式**：

| 格式 | 扩展名 | 编码 | 分隔符自动检测 | 备注 |
|------|--------|------|---------------|------|
| CSV | `.csv` | UTF-8 / UTF-8 BOM | 逗号、分号、制表符 | RFC 4180 标准 |
| TXT | `.txt` | UTF-8 / UTF-8 BOM | 制表符、分号、逗号 | 表头行检测 |
| Excel | `.xlsx` / `.xls` | 二进制 | N/A (SheetJS 自动) | 多工作表取第一个 |
| URL | `https://...` | HTTP/HTTPS | N/A | Google Sheets 发布链接 |

**边缘情况处理**：
- 空行自动过滤
- UTF-8 BOM 自动剥离
- 日期格式保持为字符串（raw:false）
- 合并单元格取左上角值
- 大数字防科学计数法 (raw:false)
- 引号/转义/逗号/换行 RFC 4180 标准解析

## 依赖关系

### 内部
- `skills/wpb/references/data/keywords.csv` - 关键词池，随机选取主题
- `skills/wpb/references/data/products.csv` - 产品数据，用于内容丰富
- `skills/wpb/references/data/prompts.md` - 写作指令（波兰语）
- `skills/wpb/references/data/extensions/` - 扩展知识文件（wiedza.md）

### 运行时
- `xlsx@0.20.3` (SheetJS, CDN tarball) - 数据表读取核心依赖
- Node.js ≥18.0 标准库

<!-- MANUAL: 核心工具是 wpb.mjs，其他文件均为辅助工具。设计目标为单命令跨 11 个 AI 平台运行，依赖 SheetJS (xlsx)，通过 npm 全局安装分发。 -->
