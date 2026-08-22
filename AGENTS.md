<!-- Generated: 2026-08-01 | Updated: 2026-08-22 (project-local .wpb) -->

# wpb

## 用途
跨平台 WordPress 发布 CLI 工具（wpb.mjs），兼容 11 种 AI 工具（Claude Code、Hermes、OpenAI Codex、Gemini CLI、Antigravity CLI、OpenClaw、Cursor、GitHub Copilot、OpenCode、小U同学、ZCode）。单命令工作流：从 CSV/TXT/XLSX/XLS/URL 随机选取关键词 → 生成内容 → 混排图片 → 通过 WP REST API 发布。支持 `wpb fetch <URL>` 拉取已发布文章并改写更新（草稿含 postId 时走更新路径）。通过 `npm i -g github:lopinx/wpb` 全局安装，package.json `bin` 字段自动注册 `wpb` 命令。

## 关键文件

| 文件 | 说明 |
|------|------|
| `skills/wpb/scripts/wpb.mjs` | 核心单文件 ES 模块，包含全部功能：TOML 解析、数据表读取、S3 SigV4 签名、WP REST API、图片搜索（Serper.dev 多 key 轮询，gl/hl/tbs 按需传参）、图片混排、质量检查、去重检测（含更新时排除自身）、指数退避重试（fetchWithRetry 每次重试新建 signal、外部 signal abort 不重试、opts 默认空对象防 crash、AbortSignal.any polyfill 兼容 Node 18）、缓存、手动安装（doInstall，仅 AI CLI 检测 + 命令文件创建，无初始化逻辑）、`wpb fetch` 命令（按 URL 域名匹配站点、拉取原文供改写）、publish 更新路径（多站点安全绑定 site + postId，更新时 tags 缺失保留原标签、categories 缺失保留原分类，创建时 categories 优先 draft 回退 site，s3 模式保留 S3 图片 URL 但仍上传非 S3 域外链图片）。`readTable` 使用 SheetJS (xlsx 0.20.3) 统一解析 CSV/TXT/XLSX/XLS/URL |
| `skills/wpb/scripts/__TEST__/selftest.mjs` | 自动化测试 (344/344 通过)，覆盖语法、pick、TOML 解析（含边界情况、数组引号内逗号、混用单双引号、多行数组）、去重哈希、图片混排（含避开小标题/首段前/尾段后、alt/title 派生与 HTML 转义、NitroPack CDN URL 清理）、图片函数（含 searchImages gl/hl/tbs 按需传参与 query 字段功能测试、非 2xx 退避、uploadImage decodeURI 回退与 content-type 校验与缓冲大小二次校验、uploadExternalImages origin 精确比较防伪前缀）、WP API 函数（含 wpFetch JSON 解析错误处理、findOrCreate 分页上限防护、checkDuplicate 标题截断保护与 excludeID 排除自身与 normTitle 实体解码归一化去重、checkQuality 关键词正则转义防护与 CJK 词数统计、fetchWithRetry 每次重试新建 signal 与超时后重试 mock 测试、opts 默认空对象防 crash、外部 signal abort 不重试、AbortSignal.any polyfill 兼容 Node 18、UA 大小写不敏感注入、validateSite WP_PASSWORD 环境变量分支）、fetch 命令与 publish 更新路径（含 validateDraft postId/site 校验、findSiteByOrigin 域名匹配、processImagesAndTags 公共函数、多站点安全绑定、更新 tags 缺失保留原标签、创建 categories 优先 draft 空数组回退 site、draft.site 创建/更新路径通用绑定、parseSelection 功能单测）、s3 模式 publish 保留 S3 URL 但上传非 S3 外链、s3List endpoint 配置时 region 兜底、readTable URL 分支 Uint8Array 与空工作簿防护、loadDocSnippet 公共函数消除 isUrl ? fetch : readFileSync 重复、validateBeforePublish 公共函数消除更新/创建路径重复、main 拆分为 runFetch/runPick/runPublish 路由、loadProducts/loadPromptDoc/loadExtDocs 错误降级保护、setting-reference.toml 字段验证、错误处理（含站点字段校验、JSON 解析错误、validateDraft 非对象防护）、文档验证、安装逻辑（doInstall 仅 AI CLI 检测、无配置报错真实测试）、CSV/TXT/XLSX/URL 解析、边缘情况（BOM、空行、日期、合并单元格、大数字） |
| `package.json` | Node.js 项目清单；`bin` 字段注册全局 `wpb` 命令；无 `postinstall` 钩子（npm 安装不执行脚本，无自动初始化）；`dependencies` 包含 xlsx (SheetJS 0.20.3, CDN) |
| `skills/wpb/references/setting-reference.toml` | 完整配置字段参考示例（随仓库分发，供用户参照手动创建 `.wpb/setting.toml`） |
| `README.md` | 完整用户文档 |

## 子目录

| 目录 | 用途 |
|------|------|
| `skills/wpb/references/data/` | 仓库内输入数据文件：关键词、产品、提示词、扩展知识（仓库内参考，不自动复制到 `.wpb/`） |
| `skills/wpb/scripts/__TEST__/` | 自检测试目录 |

## 给 AI 代理的指引

### 在此目录工作
- **单文件架构**：所有逻辑集中在 `wpb.mjs`，不拆分内部模块（Node 标准库 import + SheetJS 依赖）
- **仅 ES 模块**：使用 `import`/`export`，通过 `node wpb.mjs` 直接运行
- **跨平台路径**：使用 `path.join` 和 `process.cwd()` 兼容 Windows/Unix
- **无构建步骤**：直接运行源码，无需打包或编译
- **安装方式**：`npm i -g github:lopinx/wpb`（bin 字段自动注册 wpb 命令），升级用 `npm update -g @lopinx/wpb`，卸载用 `npm uninstall -g @lopinx/wpb`（手动清理项目 `.wpb`）
- **提交规范**：每次任务完成使用 `rtk git` 提交到 GitHub

### 测试要求
- `node --check skills/wpb/scripts/wpb.mjs` 验证语法
- `node skills/wpb/scripts/__TEST__/selftest.mjs` 运行完整测试套件 (344/344 通过)
- 测试覆盖：语法、pick、TOML 解析（含边界情况）、去重（含 CJK）、图片混排（含属性保留、避开小标题/首段前/尾段后）、图片函数（含 searchImages gl/hl/tbs 按需传参）、WP API 函数（含 fetchWithRetry 每次重试新建 signal、超时后重试 mock 测试、opts 默认空对象防 crash、外部 signal abort 不重试、AbortSignal.any polyfill 兼容 Node 18、UA 大小写不敏感注入、validateSite WP_PASSWORD 环境变量分支）、helper 函数、parseSelection 功能单测、findWpDir 向上查找不自动创建、初始化逻辑已完全移除、无配置报错真实测试、错误处理、文档验证、数据文件完整性、错误边界、CSV/TXT/XLSX/URL 解析、边缘情况（BOM、空行、日期、合并单元格、大数字）、fetch 命令与 publish 更新路径（含 validateDraft postId/site 校验、findSiteByOrigin 域名匹配、processImagesAndTags 公共函数、多站点安全绑定、更新 tags 缺失保留原标签、创建 categories 优先 draft 空数组回退 site、s3 模式保留 S3 URL 但上传非 S3 外链）

### 常用模式
- 迷你 TOML 解析器，支持内联注释、单引号、转义字符、点号键（site.myblog.name）
- **项目本地配置，无初始化逻辑**：`findWpDir()` 从 CWD 向上查找含 `setting.toml` 的 `.wpb` 目录（类 git `.git`），未找到返回 CWD 预期路径（**不自动创建**）。用户手动创建 `.wpb/setting.toml`（参考 `skills/wpb/references/setting-reference.toml`），无配置时直接报错。`safePath` 相对路径解析基址为项目 `.wpb`。`doInstall`（`wpb install` 命令，手动）仅做 AI CLI 检测 + 命令文件生成（`createCommandFile` 内容相同时跳过写入），不做任何配置/数据初始化
- S3 SigV4 签名，支持 prefix 前缀筛选、endpoint 可选、domain 自定义、环境变量覆盖密钥
- WordPress REST API 基础认证（应用程序密码）
- 通过段落位置重构实现图片混排
- 质量验证：词数（≥5000）、段落（≥10）、H3（≥3）、标题（≥10）、摘要（≥50）、标签（3-10）、死链、内链（≥3 警告）、关键词命中（警告）、E-E-A-T 外链（警告）
- **文章更新**：`wpb fetch <URL>` 按 URL 域名匹配站点（多站点不随机），拉取原文供 AI 改写；草稿含 `postId`+`site` 时 publish 走更新路径（POST /posts/{id}），多站点安全绑定 site 字段，无绑定且多站点时拒绝执行
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
