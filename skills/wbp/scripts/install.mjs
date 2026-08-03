#!/usr/bin/env node
// install.mjs — wbp.mjs 一键安装脚本
// 用法：node install.mjs
// 创建：~/.wbp/wbp.mjs, ~/.wbp/setting.toml, ~/.wbp/data/
//          + AI 工具命令文件（仅针对检测到的 CLI）
// 注意：本脚本仅用于无需人工干预的首次安装，不覆盖已有配置

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const WP_DIR = join(homedir(), '.wbp');
const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const SRC_MJS = join(SRC_DIR, 'wbp.mjs');
const DATA_SRC = join(SRC_DIR, '../references/data');
const DATA_DST = join(WP_DIR, 'data');

async function install() {
  console.log('=== WordPress 发布器安装程序 ===\n');

// ── 辅助函数：检查 CLI 是否存在 ──
function checkCLI(cmd, args = ['--version']) {
  // 白名单验证
  const validCommands = new Set(['claude', 'codex', 'opencode', 'hermes', 'openclaw']);
  if (!validCommands.has(cmd)) {
    return false;
  }
  // 仅允许安全参数（以 - 开头）
  const safeArgs = args.filter(arg => arg.startsWith('-'));
  try {
    execSync(`${cmd} ${safeArgs.join(' ')}`, { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

// ── 辅助函数：检查配置目录是否存在 ──
function checkConfigDir(dir) {
  return existsSync(dir);
}

// ── 检测已安装的 AI CLI ──
console.log('正在检测已安装的 AI 工具...\n');

const TOOLS = [
  { name: 'Claude Code',  slug: 'claude',    dir: ['.claude', 'commands'],            invoke: '/wbp' },
  { name: 'OpenAI Codex', slug: 'codex',    dir: ['.codex', 'prompts'],              invoke: '@wbp' },
  { name: 'OpenCode',     slug: 'opencode', dir: ['.config', 'opencode', 'commands'], invoke: '/wbp' },
  { name: 'Hermes',       slug: 'hermes',   dir: ['.hermes', 'commands'],            invoke: '/wbp' },
  { name: 'OpenClaw',     slug: 'openclaw', dir: ['.openclaw', 'commands'],          invoke: '/wbp' },
];

const detectedTools = TOOLS.filter(t => {
  const found = checkCLI(t.slug) || checkConfigDir(join(homedir(), ...t.dir.slice(0, -1)));
  console.log(found ? `  ✓ 检测到 ${t.name}` : `  ✗ 未找到 ${t.name}`);
  return found;
}).map(t => ({ ...t, configDir: join(homedir(), ...t.dir), promptFile: 'wbp.md' }));

console.log(`\n检测到 ${detectedTools.length} 个工具：${detectedTools.map(t => t.name).join(', ')}\n`);

// ── 安装 npm 依赖 ──
console.log('正在安装 exceljs 依赖...');
// 确保目录存在
if (!existsSync(WP_DIR)) mkdirSync(WP_DIR, { recursive: true });
try {
  execSync('npm install exceljs', { cwd: WP_DIR, stdio: 'ignore' });
} catch {
  execSync('npm init -y', { cwd: WP_DIR, stdio: 'ignore' });
  execSync('npm install exceljs', { cwd: WP_DIR, stdio: 'ignore' });
}
console.log('exceljs 已安装。');

// ── 复制 wbp.mjs ──
writeFileSync(join(WP_DIR, 'wbp.mjs'), readFileSync(SRC_MJS, 'utf-8'), 'utf-8');
console.log('wbp.mjs 已复制到', join(WP_DIR, 'wbp.mjs'));

// ── 复制数据文件（引用数据无条件更新，用户配置文件不覆盖）──
if (existsSync(DATA_SRC)) {
  const { readdirSync, statSync } = await import('fs');
  const REF_FILES = ['keywords.xlsx', 'products.xlsx', 'prompts.md'];
  const REF_DIRS = ['extensions'];
  const cp = (src, dst) => {
    if (!existsSync(dst)) mkdirSync(dst, { recursive: true });
    for (const f of readdirSync(src)) {
      const s = join(src, f), d = join(dst, f);
      if (statSync(s).isDirectory()) {
        if (REF_DIRS.includes(f)) cp(s, d);
      } else if (REF_FILES.includes(f) || !existsSync(d)) {
        writeFileSync(d, readFileSync(s));
      }
    }
  };
  cp(DATA_SRC, DATA_DST);
  console.log('数据文件已复制到', DATA_DST);
} else {
  console.warn('⚠ 未找到数据源目录:', DATA_SRC);
}

// ── 确保数据目录存在 ──
for (const d of [
  join(WP_DIR, 'data'),
  join(WP_DIR, 'data', 'extensions'),
]) {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

// ── 创建示例提示文档（仅当文件不存在时）──
const promptsPath = join(WP_DIR, 'data', 'prompts.md');
if (!existsSync(promptsPath)) {
  writeFileSync(promptsPath, `# 写作指令

## 文章风格
- 专业但不晦涩，适当使用行业术语
- 段落控制在 3-5 句，使用小标题分隔
- 开头要有引人入胜的 hook

## 内容结构
1. 引言 (1-2段)
2. 主体 (3-5个小标题)
3. 总结 (1段)

## SEO 要求
- 标题包含关键词
- 摘要 120-160 字
- 标签 3-5 个
`, 'utf-8');
}

// ── 创建示例扩展（仅当文件不存在时）──
const knowledgePath = join(WP_DIR, 'data', 'extensions', 'knowledge.md');
if (!existsSync(knowledgePath)) {
  writeFileSync(knowledgePath, `# 领域知识

## 行业术语
- 保持专业度
- 解释生僻术语

## 注意事项
- 避免过度营销
- 引用来源
`, 'utf-8');
}

// ── 创建示例 keywords.xlsx + products.xlsx（仅当文件不存在时）──
const ExcelJS = (await import('exceljs')).default;

const keywordsPath = join(WP_DIR, 'data', 'keywords.xlsx');
if (!existsSync(keywordsPath)) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('keywords');
  ws.addRow(['keyword']);
  ws.addRow(['人工智能趋势']);
  ws.addRow(['Python入门指南']);
  ws.addRow(['Web开发最佳实践']);
  ws.addRow(['云计算架构']);
  ws.addRow(['数据安全']);
  await wb.xlsx.writeFile(keywordsPath);
}

const productsPath = join(WP_DIR, 'data', 'products.xlsx');
if (!existsSync(productsPath)) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('products');
  ws.addRow(['name', 'price', 'desc']);
  ws.addRow(['产品A', 99, '基础版']);
  ws.addRow(['产品B', 199, '高级版']);
  await wb.xlsx.writeFile(productsPath);
}

// ── 生成 AI 工具命令文件 ──
const wpPath = WP_DIR.replace(/\\/g, '/');
const draftPath = `${wpPath}/_draft.json`;
const prompt = `# WordPress Publisher

1. Run \`node ${wpPath}/wbp.mjs pick\` → keyword + config
2. Write Chinese blog post (title, excerpt, tags, HTML)
3. Save to ${draftPath}
4. Run \`node ${wpPath}/wbp.mjs publish\`
`;

for (const tool of detectedTools) {
  if (!existsSync(tool.configDir)) mkdirSync(tool.configDir, { recursive: true });
  writeFileSync(join(tool.configDir, tool.promptFile), prompt, 'utf-8');
  console.log(`  ✓ 已创建 ${tool.name} 命令`);
}

if (detectedTools.length === 0) {
  console.log('\n⚠ 未检测到 AI 工具。请安装 claude/codex/opencode/hermes/openclaw 后重试。');
}

console.log(`\n=== 安装完成 ===\n核心文件：${join(WP_DIR, 'wbp.mjs')}\n配置文件：${join(WP_DIR, 'setting.toml')}（运行 node wbp.mjs init 创建）`);
console.log('\n安全建议：');
console.log('  - 设置环境变量：');
console.log('    export WP_PASSWORD="your-wordpress-password"');
console.log('    export AWS_ACCESS_KEY_ID="your-aws-access-key"');
console.log('    export AWS_SECRET_ACCESS_KEY="your-aws-secret-key"');
console.log('  - 这样可避免密码明文存储在 TOML 文件中。');
if (detectedTools.length > 0) console.log(`\nAI 命令：${detectedTools.map(t => t.invoke).join(', ')}`);
}

export default install;