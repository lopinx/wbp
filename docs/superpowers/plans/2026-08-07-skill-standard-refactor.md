# wbp Skill 标准规范重构 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 wbp skill 真正零运行时依赖（删 exceljs）、数据源改用 csv/txt、单文件可跑，对齐 skills 开放标准，清理历史 tag 与残留文件，以 v3.0.0 重新打 tag 提交。

**Architecture:** 用 `readTable(p)` 替换 `readExcel(p)`，按扩展名分发到 `parseCSV`/`parseTXT`，输出与原 `readExcel` 同构的 `string[][]`。删除两处 `await import('exceljs')` 与 `exceljs` 依赖。仓库内 `keywords.xlsx`/`products.xlsx` 转为 `.csv`。`wbp install` 去掉 `npm install`、修掉伪造 `~/.wbp/wbp.mjs` 文案。`generatePromptContent` 改为读取仓库 `SKILL.md` 而非内联副本。selftest 适配 csv/txt 并新增解析单元测试。同步 README/AGENTS.md/CLAUDE.md。清理 3 个旧 tag + backup/zip/worktree 残留。

**Tech Stack:** Node.js ≥18，纯 ES 模块，仅标准库（`fs`/`os`/`path`/`url`/`child_process`/`crypto`/`readline`）+ 全局 `fetch`。无构建步骤。

## Global Constraints

- 仅 ES 模块（`import`/`export`），通过 `node wbp.mjs` 直接运行
- 跨平台路径：`path.join` + `os.homedir()`，兼容 Windows/Unix
- 运行时零依赖：`wbp.mjs` 不得 `import` 任何 npm 包
- 数据格式：仅支持 `.csv`（RFC 4180 子集，UTF-8 with BOM）与 `.txt`（行/分隔符解析）；`.xlsx` 显式报错
- `readTable` 输出 `string[][]`，跳过表头首行，过滤空行，与原 `readExcel` 同构，下游 `pick` 零改动
- 提交规范：中文 conventional commits（`refactor:`/`chore:`/`test:`/`docs:`）
- 不改 skill 功能边界：pick/publish/init/install 四命令不变

---

## File Structure

| 文件 | 责任 | 动作 |
|------|------|------|
| `skills/wbp/scripts/wbp.mjs` | 核心单文件 | 改：readExcel→readTable、删 exceljs、简化 install、generatePromptContent 同源化、默认值 xlsx→csv |
| `skills/wbp/scripts/__TEST__/selftest.mjs` | 自检测试 | 改：xlsx 断言→csv、新增 csv/txt 解析单元测试 |
| `skills/wbp/scripts/__TEST__/selftest.mjs.backup` | 冗余备份 | 删 |
| `skills/wbp/scripts/package.json` | scripts 侧清单 | 改：删 dependencies |
| `skills/wbp/references/data/keywords.xlsx` | 关键词池（旧） | 删 |
| `skills/wbp/references/data/keywords.csv` | 关键词池（新） | 建 |
| `skills/wbp/references/data/products.xlsx` | 产品数据（旧） | 删 |
| `skills/wbp/references/data/products.csv` | 产品数据（新） | 建 |
| `skills/wbp/SKILL.md` | skill 定义 | 改：xlsx→csv、删伪造路径文案、补格式说明 |
| `package.json` | 根清单 | 改：删 dependencies |
| `README.md` | 用户文档 | 改：xlsx→csv、安装说明 |
| `AGENTS.md` | AI 代理指引 | 改：删 exceljs、xlsx→csv |
| `CLAUDE.md` | Claude 项目记忆 | 改：删 exceljs、xlsx→csv |
| `.gitignore` | 忽略规则 | 改：删 zip 相关条目（如有） |

---

## Task 1: 数据读取层改造 readExcel→readTable + 删 exceljs

**Files:**
- Modify: `skills/wbp/scripts/wbp.mjs:177-192`（readExcel 函数体）
- Modify: `skills/wbp/scripts/wbp.mjs:1062,1067`（pick 调用点，readExcel→readTable）

**Interfaces:**
- Produces: `readTable(p: string): Promise<string[][]>` — 按扩展名分发，`.csv`→parseCSV，`.txt`→parseTXT，`.xlsx`→throw。返回二维字符串数组（跳表头、过滤空行）。异步签名保持（返回 Promise）以兼容现有 `await` 调用点。
- Produces: `parseCSV(content: string): string[][]` — RFC 4180 子集解析。
- Produces: `parseTXT(content: string): string[][]` — 行/分隔符解析。

- [ ] **Step 1: 替换 readExcel 为 readTable + parseCSV + parseTXT**

将 `wbp.mjs:177-192` 的 `readExcel` 函数整体替换为：

```js
// ── 数据表读取器（csv/txt，零依赖）──
function parseCSV(content) {
  if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1); // 去 UTF-8 BOM
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (inQuotes) {
      if (c === '"') {
        if (content[i + 1] === '"') { field += '"'; i++; }      // "" 转义为 "
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r') { /* 容忍 \r\n，等 \n 触发换行 */ }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
  }
  // 末行无换行符收尾
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim() !== '')).slice(1); // 过滤空行 + 跳表头
}

function parseTXT(content) {
  if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim() !== '');
  if (lines.length <= 1) return []; // 仅表头或空
  const header = lines[0];
  const sep = header.includes('\t') ? '\t' : (header.includes(';') ? ';' : null);
  return lines.slice(1).map(l => sep ? l.split(sep) : [l]);
}

async function readTable(p) {
  if (!existsSync(p)) throw new Error('文件未找到: ' + p);
  const ext = p.toLowerCase().slice(p.lastIndexOf('.'));
  const content = readFileSync(p, 'utf-8');
  if (ext === '.csv') return parseCSV(content);
  if (ext === '.txt') return parseTXT(content);
  throw new Error('不支持的数据格式 ' + ext + '，请另存为 CSV 或 TXT: ' + p);
}
```

- [ ] **Step 2: 替换 pick 调用点 readExcel→readTable**

`wbp.mjs:1062`：
```js
    const keywords = (await Promise.all(kwPaths.filter(existsSync).map(readTable))).flat();
```

`wbp.mjs:1067`：
```js
    if (prodPath && existsSync(prodPath)) products = await readTable(prodPath);
```

- [ ] **Step 3: 语法检查**

Run: `node --check skills/wbp/scripts/wbp.mjs`
Expected: 无输出，退出码 0

- [ ] **Step 4: 提交**

```bash
git add skills/wbp/scripts/wbp.mjs
git commit -m "refactor: 数据读取层改用 csv/txt，readExcel 替换为 readTable"
```

---

## Task 2: 删除 install 内 exceljs 依赖 + 示例文件改 csv + 简化 install 路径

**Files:**
- Modify: `skills/wbp/scripts/wbp.mjs:499-511`（npm install/npm link 段）
- Modify: `skills/wbp/scripts/wbp.mjs:515`（REF_FILES）
- Modify: `skills/wbp/scripts/wbp.mjs:544-560`（示例 xlsx 生成 → csv 生成）
- Modify: `skills/wbp/scripts/wbp.mjs:564-570`（安装完成提示，删伪造路径文案）

**Interfaces:**
- Consumes: Task 1 的 `readTable`（install 生成的 csv 必须可被 pick 读回）

- [ ] **Step 1: 删除 npm install，仅保留 npm link**

`wbp.mjs:502-504` 当前：
```js
    execSync('npm install', { cwd: SRC_DIR, stdio: 'inherit' });
    execSync('npm link', { cwd: SRC_DIR, stdio: 'inherit' });
```
替换为：
```js
    execSync('npm link', { cwd: SRC_DIR, stdio: 'inherit' });
```

- [ ] **Step 2: REF_FILES xlsx→csv**

`wbp.mjs:515` 当前：
```js
    const REF_FILES = ['keywords.xlsx', 'products.xlsx', 'prompts.md'];
```
替换为：
```js
    const REF_FILES = ['keywords.csv', 'products.csv', 'prompts.md'];
```

- [ ] **Step 3: 示例文件生成 xlsx→csv，删除 exceljs import**

`wbp.mjs:544-560` 当前整段（含 `const ExcelJS = (await import('exceljs')).default;` 到 `await wb.xlsx.writeFile(productsPath);`）替换为：

```js
  // ── 创建示例 keywords.csv + products.csv（仅当文件不存在）──
  const keywordsPath = join(WP_DIR, 'data', 'keywords.csv');
  if (!existsSync(keywordsPath)) {
    const rows = ['keyword', '人工智能趋势', 'Python入门指南', 'Web开发最佳实践', '云计算架构', '数据安全'];
    writeFileSync(keywordsPath, '\uFEFF' + rows.map(r => r.includes(',') ? `"${r}"` : r).join('\n') + '\n', 'utf-8');
  }
  const productsPath = join(WP_DIR, 'data', 'products.csv');
  if (!existsSync(productsPath)) {
    const lines = [
      ['name', 'price', 'desc'],
      ['产品A', '99', '基础版'],
      ['产品B', '199', '高级版']
    ];
    writeFileSync(productsPath, '\uFEFF' + lines.map(r => r.map(f => f.includes(',') ? `"${f}"` : f).join(',')).join('\n') + '\n', 'utf-8');
  }
```

- [ ] **Step 4: 修安装完成提示，删伪造路径文案**

`wbp.mjs:564-570` 当前：
```js
  if (linked) {
    console.log(`全局命令：wbp（任意目录可用：wbp pick / wbp publish / wbp init）`);
    console.log(`升级方式：cd 仓库目录 && git pull（npm link 保持有效，无需重装）`);
  } else {
    console.log(`核心文件：${join(WP_DIR, 'wbp.mjs')}`);
  }
  console.log(`配置文件：${join(WP_DIR, 'setting.toml')}（运行 wbp init 创建）`);
```
替换为：
```js
  if (linked) {
    console.log(`全局命令：wbp（任意目录可用：wbp pick / wbp publish / wbp init）`);
    console.log(`升级方式：cd 仓库目录 && git pull（npm link 保持有效，无需重装）`);
  } else {
    console.log(`未全局化：直接 node ${SRC_MJS} 调用`);
  }
  console.log(`配置文件：${join(WP_DIR, 'setting.toml')}（运行 wbp init 创建）`);
```

- [ ] **Step 5: 语法检查**

Run: `node --check skills/wbp/scripts/wbp.mjs`
Expected: 无输出，退出码 0

- [ ] **Step 6: 确认无 exceljs 残留**

Run: `grep -n "exceljs" skills/wbp/scripts/wbp.mjs`
Expected: 无输出（完全移除）

- [ ] **Step 7: 提交**

```bash
git add skills/wbp/scripts/wbp.mjs
git commit -m "refactor: 简化 install 路径，移除 npm install 与 exceljs，示例文件改 csv"
```

---

## Task 3: 配置默认值 xlsx→csv

**Files:**
- Modify: `skills/wbp/scripts/wbp.mjs:863-864`（defaultConfig）
- Modify: `skills/wbp/scripts/wbp.mjs:888-889`（第二个 defaultConfig）
- Modify: `skills/wbp/scripts/wbp.mjs:951`（配置向导 keywords default）
- Modify: `skills/wbp/scripts/wbp.mjs:958`（配置向导 products default）

- [ ] **Step 1: 改 defaultConfig（两处）**

`wbp.mjs:863-864` 与 `wbp.mjs:888-889`（内容相同），当前：
```js
          keywords: ['data/keywords.xlsx'],
          products: 'data/products.xlsx',
```
替换为：
```js
          keywords: ['data/keywords.csv'],
          products: 'data/products.csv',
```

- [ ] **Step 2: 改配置向导 default**

`wbp.mjs:951` 当前 `default: 'data/keywords.xlsx',` → `default: 'data/keywords.csv',`
`wbp.mjs:958` 当前 `default: 'data/products.xlsx',` → `default: 'data/products.csv',`

- [ ] **Step 3: 确认无 xlsx 残留于 wbp.mjs**

Run: `grep -n "xlsx" skills/wbp/scripts/wbp.mjs`
Expected: 无输出

- [ ] **Step 4: 提交**

```bash
git add skills/wbp/scripts/wbp.mjs
git commit -m "refactor: 配置默认值与向导 default 从 xlsx 改为 csv"
```

---

## Task 4: generatePromptContent 同源化 + 删伪造路径文案

**Files:**
- Modify: `skills/wbp/scripts/wbp.mjs:592-640`（generatePromptContent 函数）
- Modify: `skills/wbp/scripts/wbp.mjs:714-716`（createCommandFile 写入路径，若涉及 SKILL.md 需同步）

**Interfaces:**
- Produces: `generatePromptContent(tool): string` — 改为读取仓库 `SKILL.md`，不再内联硬编码副本。tool 参数仍保留（供未来按工具定制，当前未用则忽略）。

- [ ] **Step 1: 查看 generatePromptContent 与 createCommandFile 完整范围**

Run: `sed -n '592,660p' skills/wbp/scripts/wbp.mjs`
确认函数边界（约 592-640）与 createCommandFile（约 714-730）。

- [ ] **Step 2: 重写 generatePromptContent 为读取 SKILL.md**

`wbp.mjs:592` 起的 `generatePromptContent` 函数，整体替换为：

```js
function generatePromptContent(tool) {
  const skillPath = join(SRC_DIR, '../SKILL.md');
  if (existsSync(skillPath)) return readFileSync(skillPath, 'utf-8');
  // 兜底：SKILL.md 缺失时给最小可用提示（不应发生）
  return `# WordPress Publisher Skill\n\n## Purpose\n跨平台 WordPress 发布 CLI。单命令工作流：wbp pick → 撰写 → wbp publish。\n\n## Workflow\n1. wbp pick — 选取关键词与配置\n2. 撰写文章草稿写入 ~/.wbp/_draft.json\n3. wbp publish ~/.wbp/_draft.json — 去重/质量检查/图片处理/发布\n\n## 注意\n- 数据文件为 CSV/TXT 格式（keywords.csv / products.csv）\n- 未全局化时直接 node <仓库>/skills/wbp/scripts/wbp.mjs 调用`;
}
```

注：`SRC_DIR` 在 `doInstall` 内定义（`wbp.mjs:431`）。需确认 `generatePromptContent` 能访问 `SRC_DIR`。若 `generatePromptContent` 是模块级函数（非 doInstall 内嵌），则需改为接收 SRC_DIR 或用 `dirname(fileURLToPath(import.meta.url))` 重新计算。先查函数定义位置：

Run: `grep -n "^function generatePromptContent\|  function generatePromptContent\|function generatePromptContent" skills/wbp/scripts/wbp.mjs`

- [ ] **Step 3: 处理 SRC_DIR 作用域**

若 `generatePromptContent` 是模块级函数（`wbp.mjs:592` 行首无缩进、顶层 `function`），则 `SRC_DIR`（doInstall 局部变量）不可见。改用模块级常量。在文件顶部 `wbp.mjs:10` 附近已有 `WP_DIR` 等常量，新增：

```js
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
```

并将 `generatePromptContent` 内的 `SRC_DIR` 引用改为 `SCRIPT_DIR`：

```js
function generatePromptContent(tool) {
  const skillPath = join(SCRIPT_DIR, '../SKILL.md');
  if (existsSync(skillPath)) return readFileSync(skillPath, 'utf-8');
  return `# WordPress Publisher Skill\n\n## Purpose\n跨平台 WordPress 发布 CLI。单命令工作流：wbp pick → 撰写 → wbp publish。\n\n## Workflow\n1. wbp pick — 选取关键词与配置\n2. 撰写文章草稿写入 ~/.wbp/_draft.json\n3. wbp publish ~/.wbp/_draft.json — 去重/质量检查/图片处理/发布\n\n## 注意\n- 数据文件为 CSV/TXT 格式（keywords.csv / products.csv）\n- 未全局化时直接 node <仓库>/skills/wbp/scripts/wbp.mjs 调用`;
}
```

- [ ] **Step 4: 删除伪造路径文案**

原 `generatePromptContent` 内 `wbp.mjs:622` 的 `（未全局化时改用 \`node ~/.wbp/wbp.mjs pick\`）` 随函数整体替换被删除（Step 2 已覆盖）。确认无残留：

Run: `grep -n "~/.wbp/wbp.mjs" skills/wbp/scripts/wbp.mjs`
Expected: 无输出

- [ ] **Step 5: 语法检查**

Run: `node --check skills/wbp/scripts/wbp.mjs`
Expected: 无输出，退出码 0

- [ ] **Step 6: 提交**

```bash
git add skills/wbp/scripts/wbp.mjs
git commit -m "refactor: generatePromptContent 改为读取 SKILL.md，消除副本漂移与伪造路径文案"
```

---

## Task 5: SKILL.md 对齐标准

**Files:**
- Modify: `skills/wbp/SKILL.md:16`（兼容工具列表，保留）
- Modify: `skills/wbp/SKILL.md:41`（删伪造路径文案）
- Modify: `skills/wbp/SKILL.md`（全文 xlsx→csv，补格式说明）

- [ ] **Step 1: 修伪造路径文案**

`SKILL.md:41` 当前：
```
（未全局化时改用 `node ~/.wbp/wbp.mjs pick`）
```
替换为：
```
（未全局化时改用 `node <仓库>/skills/wbp/scripts/wbp.mjs pick`）
```

- [ ] **Step 2: 全文 xlsx→csv**

Run: `grep -n "xlsx" skills/wbp/SKILL.md`
SKILL.md 当前无 xlsx 字样（已确认仅 line 41 有伪造路径）。跳过此步若无输出。

- [ ] **Step 3: 补数据格式说明**

在 `SKILL.md` 的「## 图片处理模式」表格后（约 line 107 后），新增一节：

```markdown
## 数据文件格式
- **关键词文件**（`keywords.csv`）：CSV 格式，UTF-8 with BOM，首行表头 `keyword`，后续每行一个关键词
- **产品文件**（`products.csv`）：CSV 格式，UTF-8 with BOM，首行表头 `name,price,desc`
- 也支持 `.txt` 格式：首行表头含制表符则按 `\t` 分列，含 `;` 则按 `;` 分列，否则整行为单列
- 不支持 `.xlsx`：请用 Excel「另存为 CSV」转换
```

- [ ] **Step 4: 提交**

```bash
git add skills/wbp/SKILL.md
git commit -m "refactor: SKILL.md 对齐标准，删伪造路径文案，补数据格式说明"
```

---

## Task 6: 数据源 xlsx→csv 转换

**Files:**
- Create: `skills/wbp/references/data/keywords.csv`
- Create: `skills/wbp/references/data/products.csv`
- Delete: `skills/wbp/references/data/keywords.xlsx`
- Delete: `skills/wbp/references/data/products.xlsx`

- [ ] **Step 1: 读取现有 xlsx 列结构，确认表头与数据**

现有 install 示例生成代码（`wbp.mjs:549-559`）显示结构：
- keywords：表头 `keyword`，数据 5 行
- products：表头 `name,price,desc`，数据 2 行

但仓库内 `references/data/keywords.xlsx`/`products.xlsx` 是真实数据文件，非 install 生成的示例。需用 Node + 临时 exceljs 读取其内容。先在仓库根（有 `package.json` 声明 exceljs 但无 `node_modules`）安装临时依赖：

Run: `cd skills/wbp/scripts && npm install exceljs --no-save`

- [ ] **Step 2: 写转换临时脚本**

创建 `skills/wbp/scripts/_convert_tmp.mjs`（临时，不入库）：

```js
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
const DIR = dirname(fileURLToPath(import.meta.url));
const DATA = join(DIR, '../references/data');
const { default: ExcelJS } = await import('exceljs');

function toCSV(rows) {
  return '\uFEFF' + rows.map(r => r.map(f => {
    const s = String(f ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\n') + '\n';
}

for (const [name] of [['keywords.xlsx'], ['products.xlsx']]) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(join(DATA, name));
  const ws = wb.getWorksheet(1);
  const rows = [];
  ws.eachRow((row) => { const v = row.values; v.shift(); rows.push(v); });
  const csvName = name.replace('.xlsx', '.csv');
  writeFileSync(join(DATA, csvName), toCSV(rows), 'utf-8');
  console.log(`已转换 ${name} → ${csvName}（${rows.length} 行）`);
}
```

- [ ] **Step 3: 运行转换**

Run: `node skills/wbp/scripts/_convert_tmp.mjs`
Expected: 输出两行「已转换 …（N 行）」

- [ ] **Step 4: 验证 csv 可被 readTable 读取**

Run:
```bash
node -e "import('file:///'+process.cwd().replace(/\\\\/g,'/')+'/skills/wbp/scripts/wbp.mjs')" 2>/dev/null; node --input-type=module -e "
import { readFileSync } from 'fs';
function parseCSV(content){if(content.charCodeAt(0)===0xFEFF)content=content.slice(1);const rows=[];let row=[],field='',inQuotes=false;for(let i=0;i<content.length;i++){const c=content[i];if(inQuotes){if(c==='\"'){if(content[i+1]==='\"'){field+='\"';i++;}else inQuotes=false;}else field+=c;}else{if(c==='\"')inQuotes=true;else if(c===','){row.push(field);field='';}else if(c==='\r'){}else if(c==='\n'){row.push(field);rows.push(row);row=[];field='';}else field+=c;}}if(field.length||row.length){row.push(field);rows.push(row);}return rows.filter(r=>r.some(v=>v.trim()!=='')).slice(1);}
const k=parseCSV(readFileSync('skills/wbp/references/data/keywords.csv','utf-8'));
const p=parseCSV(readFileSync('skills/wbp/references/data/products.csv','utf-8'));
console.log('keywords:',k.length,'行, 首行:',JSON.stringify(k[0]));
console.log('products:',p.length,'行, 首行:',JSON.stringify(p[0]));
"
```
Expected: keywords/products 行数 >0，首行非空

- [ ] **Step 5: 删除旧 xlsx + 临时脚本 + 临时 node_modules**

Run:
```bash
rm skills/wbp/references/data/keywords.xlsx skills/wbp/references/data/products.xlsx
rm skills/wbp/scripts/_convert_tmp.mjs
rm -rf skills/wbp/scripts/node_modules
```

- [ ] **Step 6: 提交**

```bash
git add skills/wbp/references/data/keywords.csv skills/wbp/references/data/products.csv
git rm skills/wbp/references/data/keywords.xlsx skills/wbp/references/data/products.xlsx
git commit -m "refactor: 数据源 keywords/products 由 xlsx 转为 csv"
```

---

## Task 7: 两份 package.json 删 dependencies

**Files:**
- Modify: `package.json:37-39`（根 dependencies）
- Modify: `skills/wbp/scripts/package.json:29-31`（scripts dependencies）

- [ ] **Step 1: 删根 package.json dependencies**

`package.json:37-39` 当前：
```json
  "dependencies": {
    "exceljs": "^4.4.0"
  },
```
删除整段（含尾逗号处理，确保 JSON 合法）。

- [ ] **Step 2: 删 scripts/package.json dependencies**

`skills/wbp/scripts/package.json:29-31` 当前：
```json
  "dependencies": {
    "exceljs": "^4.4.0"
  }
```
删除整段。

- [ ] **Step 3: 验证 JSON 合法**

Run: `node -e "JSON.parse(require('fs').readFileSync('package.json','utf-8'));JSON.parse(require('fs').readFileSync('skills/wbp/scripts/package.json','utf-8'));console.log('OK')"`
Expected: `OK`

- [ ] **Step 4: 提交**

```bash
git add package.json skills/wbp/scripts/package.json
git commit -m "refactor: 两份 package.json 删除 exceljs 依赖，声明零运行时依赖"
```

---

## Task 8: selftest 适配 csv/txt + 新增解析单元测试

**Files:**
- Modify: `skills/wbp/scripts/__TEST__/selftest.mjs:106`（keywords.xlsx→csv）
- Modify: `skills/wbp/scripts/__TEST__/selftest.mjs:278-279`（数据文件存在性断言）
- Modify: `skills/wbp/scripts/__TEST__/selftest.mjs:349-350`（defaultConfig）
- Modify: `skills/wbp/scripts/__TEST__/selftest.mjs:363`（默认关键词文件断言）
- Modify: `skills/wbp/scripts/__TEST__/selftest.mjs`（新增 csv/txt 解析测试节）
- Delete: `skills/wbp/scripts/__TEST__/selftest.mjs.backup`

- [ ] **Step 1: selftest 数据文件断言 xlsx→csv**

`selftest.mjs:106` 当前：
```js
ok(existsSync(join(WP_DIR, 'data', 'keywords.xlsx')), '测试数据已就位');
```
替换为：
```js
ok(existsSync(join(WP_DIR, 'data', 'keywords.csv')), '测试数据已就位');
```

`selftest.mjs:278-279` 当前：
```js
ok(existsSync(join(SCRIPT_DIR, '../references/data', 'keywords.xlsx')), 'keywords.xlsx 存在');
ok(existsSync(join(SCRIPT_DIR, '../references/data', 'products.xlsx')), 'products.xlsx 存在');
```
替换为：
```js
ok(existsSync(join(SCRIPT_DIR, '../references/data', 'keywords.csv')), 'keywords.csv 存在');
ok(existsSync(join(SCRIPT_DIR, '../references/data', 'products.csv')), 'products.csv 存在');
```

- [ ] **Step 2: selftest defaultConfig xlsx→csv**

`selftest.mjs:349-350` 当前：
```js
      keywords: ['data/keywords.xlsx'],
      products: 'data/products.xlsx',
```
替换为：
```js
      keywords: ['data/keywords.csv'],
      products: 'data/products.csv',
```

`selftest.mjs:363` 当前：
```js
ok(cfgContent.includes('keywords = ["data/keywords.xlsx"]'), '包含默认关键词文件');
```
替换为：
```js
ok(cfgContent.includes('keywords = ["data/keywords.csv"]'), '包含默认关键词文件');
```

- [ ] **Step 3: 新增 csv/txt 解析单元测试**

在 `selftest.mjs` 的「## 13. 数据文件」节之后（约 line 281 后），插入新测试节：

```js
// ── 13.1 CSV/TXT 解析单元测试 ──
console.log('\n## 13.1 CSV/TXT 解析测试');
import { writeFileSync as _wf, mkdtempSync as _mkd } from 'fs';
import { tmpdir as _tmp } from 'os';
const _td = _mkd(join(_tmp(), 'wbp-csv-test-'));
function parseCSV(content) {
  if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
  const rows = []; let row = [], field = '', inQuotes = false;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (inQuotes) {
      if (c === '"') { if (content[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r') {}
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim() !== '')).slice(1);
}
function parseTXT(content) {
  if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim() !== '');
  if (lines.length <= 1) return [];
  const header = lines[0];
  const sep = header.includes('\t') ? '\t' : (header.includes(';') ? ';' : null);
  return lines.slice(1).map(l => sep ? l.split(sep) : [l]);
}

// CSV: 基本逗号分隔
_wf(join(_td, 'a.csv'), 'keyword\nfoo\nbar\nbaz\n', 'utf-8');
const a = parseCSV(readFileSync(join(_td, 'a.csv'), 'utf-8'));
ok(a.length === 3, 'CSV 基本解析 3 行');
ok(a[0][0] === 'foo', 'CSV 首行首列为 foo');

// CSV: 引号包裹含逗号
_wf(join(_td, 'b.csv'), 'name,desc\n"a,b","hello"\n', 'utf-8');
const b = parseCSV(readFileSync(join(_td, 'b.csv'), 'utf-8'));
ok(b.length === 1, 'CSV 引号含逗号 1 行');
ok(b[0][0] === 'a,b', 'CSV 引号内逗号保留');

// CSV: 引号转义 ""
_wf(join(_td, 'c.csv'), 'name\n"say ""hi"""\n', 'utf-8');
const c = parseCSV(readFileSync(join(_td, 'c.csv'), 'utf-8'));
ok(c[0][0] === 'say "hi"', 'CSV 双引号转义正确');

// CSV: UTF-8 BOM
_wf(join(_td, 'd.csv'), '\uFEFFkeyword\n中文\n', 'utf-8');
const d = parseCSV(readFileSync(join(_td, 'd.csv'), 'utf-8'));
ok(d[0][0] === '中文', 'CSV BOM 去除后中文正确');

// CSV: 空行过滤
_wf(join(_td, 'e.csv'), 'keyword\nfoo\n\n\nbar\n', 'utf-8');
const e = parseCSV(readFileSync(join(_td, 'e.csv'), 'utf-8'));
ok(e.length === 2, 'CSV 空行过滤为 2 行');

// TXT: 制表符分隔
_wf(join(_td, 'f.txt'), 'name\tdesc\nfoo\tbar\nbaz\tqux\n', 'utf-8');
const f = parseTXT(readFileSync(join(_td, 'f.txt'), 'utf-8'));
ok(f.length === 2, 'TXT 制表符 2 行');
ok(f[0][1] === 'bar', 'TXT 制表符第二列正确');

// TXT: 整行单列
_wf(join(_td, 'g.txt'), 'keyword\nhello\nworld\n', 'utf-8');
const g = parseTXT(readFileSync(join(_td, 'g.txt'), 'utf-8'));
ok(g.length === 2, 'TXT 单列 2 行');
ok(g[0][0] === 'hello', 'TXT 单列首行正确');

// TXT: 分号分隔
_wf(join(_td, 'h.txt'), 'a;b\n1;2\n3;4\n', 'utf-8');
const h = parseTXT(readFileSync(join(_td, 'h.txt'), 'utf-8'));
ok(h.length === 2 && h[0][0] === '1' && h[0][1] === '2', 'TXT 分号分隔正确');

// readTable 对 xlsx 显式报错
let xlsxThrew = false;
try {
  await readTable(join(_td, 'fake.xlsx'));
} catch (e) {
  xlsxThrew = e.message.includes('不支持的数据格式') || e.message.includes('未找到');
}
ok(xlsxThrew, 'readTable 对 xlsx 抛错');
```

注意：`readTable` 需在 selftest 中可访问。查 selftest 头部 import：

Run: `head -20 skills/wbp/scripts/__TEST__/selftest.mjs`

若 selftest 通过 `import` 从 wbp.mjs 导出函数，需确认 wbp.mjs 是否 export 了 readTable。当前 wbp.mjs 是脚本式（无 export）。selftest 通过 `run('wbp.mjs', [...])` 子进程调用，不直接 import 内部函数。因此 `readTable` 对 xlsx 抛错的测试改为：创建 `fake.xlsx` 空文件，调用 `wbp.mjs pick`（配置指向它），断言非零退出 + stderr 含「不支持」。

修订该测试为子进程方式：
```js
// readTable 对 xlsx 显式报错
_wf(join(_td, 'fake.xlsx'), 'not a real xlsx', 'utf-8');
const xlsxCfg = `site.x.url = "https://x.com"\nsite.x.user = "u"\nsite.x.pass = "p p p p p p p p"\nsite.x.keywords = ["${join(_td,'fake.xlsx').replace(/\\/g,'/')}"]\nsite.x.products = ""\nsite.x.prompts = ""`;
writeFileSync(CFG, xlsxCfg, 'utf-8');
const xlsxRes = run('wbp.mjs', ['pick']);
ok(xlsxRes.status !== 0, 'readTable 对 xlsx 退出码非零');
const xlsxOut = xlsxRes.stderr + xlsxRes.stdout;
ok(xlsxOut.includes('不支持的数据格式'), 'xlsx 报错含不支持字样');
writeFileSync(CFG, cfgBackup, 'utf-8');
```

（`cfgBackup` 在 selftest:286 已定义，但此处在其之前。调整：将 readTable xlsx 测试移到「## 14. 错误处理」节内，复用 cfgBackup。）最终决定：将 xlsx 抛错测试合并入「## 14 错误处理」节末尾，其余 csv/txt 解析测试留在 13.1。

- [ ] **Step 4: 删除冗余 backup 文件**

Run: `rm skills/wbp/scripts/__TEST__/selftest.mjs.backup`

- [ ] **Step 5: 运行 selftest**

Run: `node skills/wbp/scripts/__TEST__/selftest.mjs`
Expected: 全部通过（`N/N 通过`，无 FAIL）

- [ ] **Step 6: 提交**

```bash
git add skills/wbp/scripts/__TEST__/selftest.mjs
git rm skills/wbp/scripts/__TEST__/selftest.mjs.backup
git commit -m "test: selftest 适配 csv/txt 数据源，新增 csv/txt 解析单元测试"
```

---

## Task 9: 同步 README/AGENTS.md/CLAUDE.md

**Files:**
- Modify: `README.md:152-153,184,190,242-243`（xlsx→csv、安装说明）
- Modify: `AGENTS.md:14,28,31,53-54,59`（删 exceljs、xlsx→csv、单文件架构说明）
- Modify: `CLAUDE.md:25,27,56,59`（删 exceljs、xlsx→csv）

- [ ] **Step 1: README.md xlsx→csv**

`README.md:152-153`：
```
keywords = ["data/keywords.xlsx"]
products = "data/products.xlsx"
```
→
```
keywords = ["data/keywords.csv"]
products = "data/products.csv"
```

`README.md:184`：`keywords = ["data/blog1-keywords.xlsx"]` → `.csv`
`README.md:190`：`keywords = ["data/blog2-keywords.xlsx"]` → `.csv`
`README.md:242-243`：
```
│           ├── keywords.xlsx    # 关键词池
│           ├── products.xlsx    # 产品数据
```
→
```
│           ├── keywords.csv     # 关键词池
│           ├── products.csv     # 产品数据
```

- [ ] **Step 2: README.md 安装说明（若有 npm install 提及）**

Run: `grep -n "npm install\|exceljs\|~/.wbp/wbp.mjs" README.md`
若有，按语境删除或修正（npm install 仅在 install 子命令内部已删，README 若提「需安装依赖」则改为「零运行时依赖」）。

- [ ] **Step 3: AGENTS.md 修正**

`AGENTS.md:14`：
```
| `package.json` | Node.js 项目清单，依赖 exceljs 库；`scripts` 不含 `install`（npm 保留 lifecycle hook，改用 `wbp:install`） |
```
→
```
| `package.json` | Node.js 项目清单，零运行时依赖；`scripts` 不含 `install`（npm 保留 lifecycle hook，改用 `wbp:install`） |
```

`AGENTS.md:28`：
```
- **单文件架构**：所有逻辑集中在 `wbp.mjs`，不拆分内部模块（仅标准库/依赖的 import）
```
→
```
- **单文件架构**：所有逻辑集中在 `wbp.mjs`，不拆分内部模块（仅 Node 标准库 import，零运行时依赖）
```

`AGENTS.md:31`：`- **无构建步骤**：直接执行，无需转译` 保留不变（已正确）。

`AGENTS.md:53-54`：
```
- `data/keywords.xlsx` - 关键词池，随机选取主题
- `data/products.xlsx` - 产品数据，用于内容丰富
```
→
```
- `data/keywords.csv` - 关键词池，随机选取主题
- `data/products.csv` - 产品数据，用于内容丰富
```

`AGENTS.md:59`：
```
- `exceljs` (npm) - Excel 文件读取，通过 eachRow
```
删除整行（外部依赖节无其他条目则删整个「### 外部」节或该行）。

- [ ] **Step 4: CLAUDE.md 修正**

`CLAUDE.md:25`：
```
| `skills/wbp/scripts/package.json` | ESM 模块，依赖 exceljs；`scripts` 不含 `install`（npm 保留 lifecycle hook，改用 `wbp:install`） |
```
→
```
| `skills/wbp/scripts/package.json` | ESM 模块，零运行时依赖；`scripts` 不含 `install`（npm 保留 lifecycle hook，改用 `wbp:install`） |
```

`CLAUDE.md:27`：
```
| `skills/wbp/references/data/` | 配置数据目录（keywords.xlsx、products.xlsx、prompts.md） |
```
→
```
| `skills/wbp/references/data/` | 配置数据目录（keywords.csv、products.csv、prompts.md） |
```

`CLAUDE.md:56`：`- 单文件架构，所有逻辑在 `wbp.mjs` 中` → `- 单文件架构，所有逻辑在 `wbp.mjs` 中（仅 Node 标准库，零运行时依赖）`
`CLAUDE.md:59`：`- 无构建步骤，直接运行` 保留。

- [ ] **Step 5: 确认无残留**

Run: `grep -rn "xlsx\|exceljs\|~/.wbp/wbp.mjs" README.md AGENTS.md CLAUDE.md skills/wbp/SKILL.md`
Expected: 无输出（或仅注释，无）

- [ ] **Step 6: 提交**

```bash
git add README.md AGENTS.md CLAUDE.md
git commit -m "docs: 同步 README/AGENTS.md/CLAUDE.md，移除 exceljs 与 xlsx 引用"
```

---

## Task 10: 清理历史 tag + 残留文件 + .gitignore

**Files:**
- Delete: `wbp-skill-v1.2.0.zip`（已 git status 标 D，需提交）
- Delete: `.claude/worktrees/autopilot-install-enhancement`（已标 D）
- Modify: `.gitignore`（若有 zip 条目则删）

- [ ] **Step 1: 删除本地 + 远程旧 tag**

Run:
```bash
git tag -d v1.2.0 v2.0.0 v2.1.0
git push origin :refs/tags/v1.2.0 :refs/tags/v2.0.0 :refs/tags/v2.1.0
```
Expected: 各 tag 删除成功（远程删除需网络；若失败记录但不阻塞，本地删除即满足「清除历史 tags」）

- [ ] **Step 2: 提交残留文件删除**

Run:
```bash
git add -A
git status --short
```
确认 `wbp-skill-v1.2.0.zip` 与 `.claude/worktrees/autopilot-install-enhancement` 标记为删除，提交：

```bash
git commit -m "chore: 清理 wbp-skill-v1.2.0.zip 与 worktree 残留"
```

- [ ] **Step 3: 检查 .gitignore zip 条目**

Run: `grep -n "zip\|wbp-skill" .gitignore`
若有，删除相关行。若无，跳过。

- [ ] **Step 4: 提交 .gitignore（若有改动）**

```bash
git add .gitignore
git commit -m "chore: 清理 .gitignore 中 zip 相关条目"
```
（若无改动则跳过此步）

---

## Task 11: 最终验证 + 打 v3.0.0 tag

**Files:** 无（纯验证 + tag）

- [ ] **Step 1: 语法检查**

Run: `node --check skills/wbp/scripts/wbp.mjs`
Expected: 退出码 0，无输出

- [ ] **Step 2: 运行完整 selftest**

Run: `node skills/wbp/scripts/__TEST__/selftest.mjs`
Expected: 全部通过（`N/N 通过`，无 FAIL）。记录通过数。

- [ ] **Step 3: 确认无 exceljs/xlsx/伪造路径残留**

Run:
```bash
grep -rn "exceljs" skills/ package.json README.md AGENTS.md CLAUDE.md
grep -rn "keywords.xlsx\|products.xlsx\|~/.wbp/wbp.mjs" . --exclude-dir=.git
```
Expected: 均无输出

- [ ] **Step 4: 确认 tag 状态**

Run: `git tag -l "v*"`
Expected: 仅 `v3.0.0`（旧 tag 已删；v3.0.0 在 Step 6 打）

- [ ] **Step 5: 确认 git status 干净**

Run: `git status --short`
Expected: 无输出（工作区干净）

- [ ] **Step 6: 打 v3.0.0 tag**

Run:
```bash
git tag -a v3.0.0 -m "v3.0.0: skill 标准规范重构 — 零运行时依赖，数据源改用 csv/txt"
git push origin v3.0.0
```
Expected: tag 创建成功（远程推送需网络，失败不阻塞本地 tag）

- [ ] **Step 7: 最终确认**

Run: `git tag -l && git log --oneline -12`
Expected: tag 列表含 v3.0.0，提交历史含本次重构的所有 commit。

---

## Self-Review（计划自检）

**1. Spec 覆盖**：
- §1.1 单文件边界 → Task 1/2/7（删 exceljs）
- §1.2 readTable/parseCSV/parseTXT → Task 1
- §1.3 数据源迁移 → Task 6
- §1.4 install 简化 → Task 2
- §1.5 配置默认值 → Task 3
- §2.1 SKILL.md 修订 → Task 5
- §2.2 generatePromptContent 同源 → Task 4
- §2.3 package.json 收敛 → Task 7
- §3.1 tag 清理 → Task 10
- §3.2 残留文件清理 → Task 10
- §3.3 提交策略 → 各 Task 末尾 commit
- §4.1 selftest 适配 → Task 8
- §4.2 文档同步 → Task 9
- §4.3 验证清单 → Task 11
全部覆盖。

**2. Placeholder 扫描**：无 TBD/TODO；所有步骤含具体代码或命令。Task 4 Step 2 的 SRC_DIR 作用域已提供判断分支与确切代码。Task 8 Step 3 的 readTable xlsx 测试已改为子进程方式并提供确切代码。

**3. 类型一致性**：`readTable(p): Promise<string[][]>`、`parseCSV(content): string[][]`、`parseTXT(content): string[][]` 在 Task 1 定义、Task 8 测试中签名一致。`generatePromptContent(tool): string` 在 Task 4 一致。

**4. 风险点**：
- Task 6 依赖临时安装 exceljs 转换；若网络不通，可手动用 Excel 另存为 CSV。但 install 示例已显示列结构（keyword / name,price,desc），可手写最小 CSV 兜底。
- Task 10 远程 tag 删除需网络；本地删除已满足核心诉求，远程推送失败不阻塞。
- Task 8 selftest 可能因环境（`~/.wbp` 残留旧配置）失败；需确保测试前清理。selftest 头部已有清理逻辑（`selftest.mjs` 早期 setup）。
