# wbp Skill 标准规范重构设计

> 日期：2026-08-07
> 状态：已确认（§1-§4 经用户默认认可）
> 目标：让 wbp skill 真正零运行时依赖、单文件可跑，严格遵守 skills 开放标准；清理历史 tag 与残留文件，以新基线重新提交。

## 背景与动机

当前仓库虽具备 skills 开放标准骨架（`skills/wbp/SKILL.md` + `references/data/` + `scripts/wbp.mjs`），但存在三处与标准、与「单文件自包含」声称相违的实质问题：

1. **运行时强依赖 exceljs**：`wbp.mjs:179,545` 用 `await import('exceljs')` 动态加载，离了 `node_modules` 不能跑。`AGENTS.md` 称「无构建步骤、直接运行」「不依赖运行时单文件运行」与事实矛盾。
2. **文档与实现脱节**：`SKILL.md:41` 与 `wbp.mjs:622` 写「未全局化时改用 `node ~/.wbp/wbp.mjs pick`」，但安装流程实际不复制 `wbp.mjs` 到 `~/.wbp/` —— 文案是误导性历史残留。
3. **历史 tag 与残留物**：`v1.2.0 / v2.0.0 / v2.1.0` 三个 tag、`wbp-skill-v1.2.0.zip`、`.claude/worktrees/...`、`selftest.mjs.backup` 反映前几次打包实验痕迹。

此外，数据源格式不固定：用户真实场景中关键词/产品文件**可能是 txt、可能是 csv、可能是 xlsx**。这决定了数据读取层需多格式支持，但 xlsx 是唯一引入运行时依赖的格式 —— 放弃 xlsx 原生支持即可彻底卸载依赖。

## 方案决策

经三方案对比（A′ 内联 zip+xml 解析 / B′ xlsx→JSON 中转 / C′ 保留 exceljs 懒加载），最终选定 **方案 A′′：仅支持 csv + txt 双格式，放弃 xlsx，删除 exceljs 依赖**。

**决策理由**：
- txt/csv 两种格式已完全覆盖用户真实场景（「文件有可能是 txt 文档，有可能是 csv」）；
- 放弃 xlsx 即彻底消除 zip 解压技术风险与 exceljs 运行时依赖；
- 纯 Node 标准库即可 `node wbp.mjs pick`，AI 工具发现 skill 即可调用，最贴合 skills 自包含标准；
- 用户编辑体验几乎无损（CSV UTF-8 BOM 在 Excel 中文直开无乱码）。

## §1 架构与数据流

### 1.1 单文件边界不变
`skills/wbp/scripts/wbp.mjs` 仍是唯一可执行入口，仅依赖 Node 标准库（`fs`/`os`/`path`/`url`/`child_process`/`crypto`/`readline`）+ 全局 `fetch`。**删除 `exceljs` 运行时依赖**。

### 1.2 数据读取层改造
用 `readTable(p)` 替换 `readExcel(p)`，按扩展名分发，输出与原 `readExcel` **同构的 `string[][]`**（二维字符串数组，跳过表头首行，空行过滤）：

```
readTable(p)
  ├─ .csv → parseCSV(content)      // RFC 4180 子集：引号包裹、逗号分隔、"转义为""
  ├─ .txt → parseTXT(content)     // 行解析：制表符/分号优先，否则整行为单列
  └─ .xlsx → throw                // 显式报错 "请另存为 CSV/TXT"
```

**输出契约（与原 readExcel 完全一致，下游零改动）**：
- 返回 `string[][]`，每行是字段数组
- 跳过表头（第 1 行）
- 过滤完全空行
- 不做类型推断，全部为字符串

`pick` 逻辑（`wbp.mjs:1062,1067`）原样不动：`readTable` 产出与 `readExcel` 同构 → `keywordRow`/`products` 结构不变。

**parseCSV 细节**：
- 处理引号包裹字段内含逗号
- 处理引号转义（`""` → `"`）
- 处理 UTF-8 BOM 头（`\uFEFF`）
- 处理 `\r\n` 与 `\n` 行尾
- 过滤完全空行（仅空白字符的行）

**parseTXT 细节**（分列判定基于首行检测，整文件统一）：
- 检测首行：含 `\t` → 整文件用 `\t` 分列
- 否则首行含 `;` → 整文件用 `;` 分列
- 否则 → 整文件每行作为单列
- 过滤空行、跳过表头首行

### 1.3 仓库内数据源迁移
`skills/wbp/references/data/` 下：
- `keywords.xlsx` → `keywords.csv`（UTF-8 with BOM，Excel 中文直开）
- `products.xlsx` → `products.csv`（同上）
- `.xlsx` 原文件从仓库删除

转换在实施阶段用一次性临时脚本完成（临时脚本不入库）。需保留原 xlsx 的列结构：表头 + 数据行，转 CSV 时首行写表头。

### 1.4 安装路径简化
`wbp install`（`wbp.mjs:499-511`）：
- **删除 `npm install` 步骤**（不再有依赖可装）
- 保留 `npm link` 作「全局命令注册」可选项；失败时不再伪造 `~/.wbp/wbp.mjs` 文案，改为提示「直接 `node <仓库>/skills/wbp/scripts/wbp.mjs`」
- `REF_FILES`（`wbp.mjs:515`）从 `['keywords.xlsx','products.xlsx','prompts.md']` → `['keywords.csv','products.csv','prompts.md']`
- 示例文件生成（`wbp.mjs:546,553`）从 `wb.xlsx.writeFile` → `writeFileSync(csv)`
- 删除安装内的 `await import('exceljs')`（`wbp.mjs:545`）

### 1.5 配置默认值对齐
`setting.toml` 默认与配置向导（`wbp.mjs:863,888,951,958`）中所有 `data/keywords.xlsx`/`data/products.xlsx` → `.csv`。

## §2 SKILL.md 标准对齐

### 2.1 SKILL.md 修订
当前 `SKILL.md` 文案与实现脱节（`SKILL.md:41` 写 `node ~/.wbp/wbp.mjs pick`，但该文件不存在）。修订要点：

- **frontmatter 保留**：`name`/`description`/`triggers`/`argument-hint` 不变（已合规）
- **Workflow §0 安装**：去掉「未全局化时改用 `node ~/.wbp/wbp.mjs pick`」误导文案，改为「未全局化时直接 `node <仓库>/skills/wbp/scripts/wbp.mjs pick`」
- **数据文件引用**：全文 `keywords.xlsx`/`products.xlsx` → `.csv`
- **补充数据格式说明**：新增小节说明支持 `.csv`（RFC 4180，UTF-8 BOM）和 `.txt`（行/分隔符解析），不支持 `.xlsx`

### 2.2 generatePromptContent 同源化
`wbp.mjs:592` 的 `generatePromptContent(tool)` 内嵌了一份重复的 SKILL 文案（`wbp.mjs:622` 同样有误导文案）。安装时写给 AI 工具的 prompt 必须与仓库 `SKILL.md` **同源**，而非手抄副本。

**改造**：`generatePromptContent` 改为读取仓库 `SKILL.md` 内容（`join(SRC_DIR, '../SKILL.md')`），而非内联硬编码副本。这消除「SKILL.md 改了但 prompt 副本没改」的长期漂移风险。

### 2.3 两份 package.json 收敛
当前根 `package.json` 与 `scripts/package.json` 重复且字段不一致（`main`/`bin` 路径不同、`keywords` 数组不同）。

**改造**：
- `scripts/package.json` 删除 `dependencies.exceljs`（运行时无依赖）
- 根 `package.json` 同步删 `dependencies`（发布到 npm 时也声明零依赖）
- `scripts` 字段中 `wbp:install` 保留（npm 保留 `install` lifecycle hook 的约定不变）

## §3 历史 tag 与残留文件清理

### 3.1 tag 清理
```
git tag -d v1.2.0 v2.0.0 v2.1.0
git push origin :refs/tags/v1.2.0 :refs/tags/v2.0.0 :refs/tags/v2.1.0
```
以新基线 `v3.0.0`（破坏性重构，数据格式从 xlsx→csv）重新打 tag。

### 3.2 残留文件清理
- `skills/wbp/scripts/__TEST__/selftest.mjs.backup` — 删除（冗余，git 已有历史）
- `wbp-skill-v1.2.0.zip` — 已在 `git status` 标 `D`，确认提交删除
- `.claude/worktrees/autopilot-install-enhancement` — 已标 `D`，确认提交删除
- `.gitignore` 中 `wbp-skill-v1.2.0.zip` 相关条目（如有）清理

### 3.3 提交策略
清理 + 重构分批提交，每批可独立验证：
1. `chore: 清理历史 tag、备份文件与 worktree 残留`（§3）
2. `refactor: 数据读取层改用 csv/txt，移除 exceljs 运行时依赖`（§1.2, 1.3, 1.5）
3. `refactor: 简化 install 路径，去除 npm install 与伪造路径文案`（§1.4）
4. `refactor: SKILL.md 与 generatePromptContent 对齐标准，消除副本漂移`（§2）
5. `test: selftest 适配 csv/txt 数据源`（§4.1）
6. `docs: 同步 README/AGENTS.md/CLAUDE.md`（§4.2）
7. 末尾 `git tag v3.0.0`

## §4 测试与文档

### 4.1 selftest 适配
`selftest.mjs` 当前断言 `keywords.xlsx`/`products.xlsx` 存在（`selftest.mjs:106,278,279`）、配置含 `data/keywords.xlsx`（`selftest.mjs:363`）。改为：
- 断言文件名 `.csv`
- 新增 **CSV 解析单元测试**（独立用例，不依赖完整 pick 流程）：
  - 基本逗号分隔
  - 引号包裹字段含逗号
  - 引号转义 `""`
  - UTF-8 BOM 头处理
  - 空行过滤
  - 表头跳过
- 新增 **TXT 解析单元测试**：
  - 制表符分隔多列
  - 整行单列（无分隔符）
- `.xlsx` 调用 `readTable` 抛错测试（确认显式报错而非静默失败）
- 现有 `pick`/`init`/配置向导集成测试改为 `.csv` 数据源，断言点不变（`keywordRow`/`products` 结构同构）

### 4.2 文档同步
- `README.md`：数据格式说明、安装方式、命令示例中 `.xlsx`→`.csv`
- `AGENTS.md`：关键文件表「`data/keywords.xlsx`」→`.csv`；删除「依赖 exceljs 库」表述（当前 `AGENTS.md` 称「依赖 exceljs 库」需修正）
- `CLAUDE.md`：同上，关键文件表与依赖说明修正

### 4.3 验证清单（完成判定）
- [ ] `node --check skills/wbp/scripts/wbp.mjs` 通过
- [ ] `node skills/wbp/scripts/__TEST__/selftest.mjs` 全绿（含新增 csv/txt 用例）
- [ ] 仓库内无 `node_modules`、无 `exceljs` 引用（`grep -r exceljs skills/` 仅剩注释或无）
- [ ] `grep -r "keywords.xlsx\|products.xlsx\|~/.wbp/wbp.mjs" .` 无残留（排除 .git）
- [ ] `git tag -l` 仅剩 `v3.0.0`
- [ ] `git status` 干净（zip/backup/worktree 残留已提交删除）

## 非目标（YAGNI）
- 不做 xlsx 原生支持（用户可另存为 CSV）
- 不做 `wbp import` 子命令（YAGNI，用户用 Excel 另存即可）
- 不重构 wbp.mjs 内部其他模块（TOML 解析、S3、WP API 等保持不动）
- 不改 skill 的功能边界（pick/publish/init/install 四命令不变）
