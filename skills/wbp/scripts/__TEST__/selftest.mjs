#!/usr/bin/env node
// selftest.mjs — wbp.mjs 自检（增强版）
import { existsSync, readFileSync, mkdirSync, writeFileSync, copyFileSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR = join(__dirname, '..');
const REF_DATA_DIR = join(SCRIPT_DIR, '../references/data'); // 与第 13 节数据文件检查一致：skills/wbp/references/data
const HOME = homedir(); // 与 install.mjs 一致：os.homedir() 在三平台稳定，避免 HOME 被改写导致目录不一致
const WP_DIR = join(HOME, '.wbp');

// 从 wbp.mjs 复制函数实现
function parseCategories(categoriesStr) {
  if (!categoriesStr || !categoriesStr.trim()) return [];
  return categoriesStr.split(',').map(c => {
    const trimmed = c.trim();
    // 尝试转换为数字
    const num = Number(trimmed);
    return isNaN(num) ? trimmed : num;
  }).filter(c => c);
}

function tomlString(cfg) {
  const lines = [];

  function stringifyValue(value) {
    if (Array.isArray(value)) {
      return JSON.stringify(value);
    } else if (typeof value === 'object' && value !== null) {
      const nested = [];
      for (const [k, v] of Object.entries(value)) {
        nested.push(`${k} = ${stringifyValue(v)}`);
      }
      return `{${nested.join(', ')}}`;
    } else {
      return typeof value === 'string' ? JSON.stringify(value) : String(value);
    }
  }

  for (const [key, value] of Object.entries(cfg)) {
    if (typeof value === 'object' && value !== null) {
      // 嵌套对象
      lines.push(`[${key}]`);
      for (const [k, v] of Object.entries(value)) {
        lines.push(`${k} = ${stringifyValue(v)}`);
      }
    } else {
      // 简单值
      lines.push(`${key} = ${stringifyValue(value)}`);
    }
  }
  return lines.join('\n');
}

function log(level, ...args) {
  const colors = {
    info: '\x1b[36m',
    warn: '\x1b[33m',
    error: '\x1b[31m',
    reset: '\x1b[0m'
  };
  console.log(`${colors[level] || ''}[${level.toUpperCase()}]${colors.reset}`, ...args);
}

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log(`  ✓ ${msg}`); } else { fail++; console.log(`  ✗ ${msg}`); } }
function error(msg) { fail++; console.log(`  ✗ ${msg}`); }
function run(cmd, args) { return spawnSync(process.execPath, [cmd, ...args], { cwd: SCRIPT_DIR, encoding: 'utf-8' }); }

// ── 1. 语法检查 ──
console.log('## 1. 语法检查');
ok(run('--check', [join(SCRIPT_DIR, 'wbp.mjs')]).status === 0, 'wbp.mjs 语法正确');
ok(run('--check', [join(__dirname, 'selftest.mjs')]).status === 0, 'selftest.mjs 语法正确');

// ── 2. 初始化 ──
console.log('\n## 2. 初始化');
ok(run('wbp.mjs', ['init', '--non-interactive']).status === 0, 'init 退出码为 0');
ok(existsSync(join(WP_DIR, 'setting.toml')), 'setting.toml 已创建');

// 准备测试数据：把仓库 references/data 复制到 ~/.wbp/data（init 不复制数据，
// pick 的相对路径解析到 ~/.wbp/data；未跑 install 的开发环境会缺数据）。
// ponytail: 仅复制引用数据（keywords/products/prompts/extensions），与 install.mjs 语义一致
function syncRefData() {
  if (!existsSync(REF_DATA_DIR)) return;
  const dst = join(WP_DIR, 'data');
  if (!existsSync(dst)) mkdirSync(dst, { recursive: true });
  for (const f of readdirSync(REF_DATA_DIR)) {
    const s = join(REF_DATA_DIR, f), d = join(dst, f);
    if (statSync(s).isDirectory()) {
      if (!existsSync(d)) mkdirSync(d, { recursive: true });
      for (const sub of readdirSync(s)) copyFileSync(join(s, sub), join(d, sub));
    } else {
      copyFileSync(s, d);
    }
  }
}
syncRefData();
ok(existsSync(join(WP_DIR, 'data', 'keywords.xlsx')), '测试数据已就位');

// ── 3. 选择关键词 ──
console.log('\n## 3. 选择关键词');
const p = run('wbp.mjs', ['pick']);
ok(p.status === 0, 'pick 退出码为 0');
let d; try { d = JSON.parse(p.stdout); ok(true, 'pick 输出可解析为 JSON'); } catch(e) { ok(false, 'pick 输出可解析为 JSON'); }
if (d) {
  ok(d.site, '包含站点信息');
  ok(d.site.name, '包含站点名称');
  ok(d.site.url, '包含站点 URL');
  ok(d.site.categories, '包含站点分类');
  ok(d.keyword, '包含关键词');
  ok(d.keywordRow, '包含关键词行号');
  ok(d.prompts.includes('电子烟'), '包含写作提示');
  ok(d.products.length > 0, '包含产品列表');
  ok(Array.isArray(d.products), '产品字段为数组');
  ok(d.products.length <= 5, '产品数量不超过 5');
}

// ── 4. TOML 解析器深度测试 ──
console.log('\n## 4. TOML 解析器');
const src = readFileSync(join(SCRIPT_DIR, 'wbp.mjs'), 'utf-8');
const tomlFn = src.match(/function isValidKey[\s\S]*?\nfunction parseToml[\s\S]*?\n\}/);
ok(!!tomlFn, 'parseToml 已定义');
const pt = eval(`(function() { ${tomlFn[0]}; return parseToml; })()`);

// 基本嵌套
const r1 = pt(`[site.a]\nname = "A"\n[site.a.cdn]\nkey = "x"\n[site.b]\nname = "B"`);
ok(r1.site.a.name === 'A', 'site.a.name');
ok(r1.site.b.name === 'B', 'site.b.name');
ok(r1.site.a.cdn.key === 'x', '嵌套节');

// 数组解析
const r2 = pt(`[s]\narr = ["a", "b", "c"]\nempty = []`);
ok(Array.isArray(r2.s.arr), '数组解析为数组');
ok(r2.s.arr.length === 3, '数组有 3 个元素');
ok(r2.s.arr[0] === 'a', '数组元素 0');
ok(r2.s.arr[1] === 'b', '数组元素 1');
ok(r2.s.arr[2] === 'c', '数组元素 2');
ok(Array.isArray(r2.s.empty), '空数组');
ok(r2.s.empty.length === 0, '空数组有 0 个元素');

// 单引号字符串
const r3 = pt(`[s]\nname = 'hello'\npath = 'C:\\\\Users\\\\test'`);
ok(r3.s.name === 'hello', '单引号字符串');
ok(r3.s.path === 'C:\\Users\\test', '单引号字符串转义');

// 行内注释
const r4 = pt(`[s]\nname = "test" # this is a comment\nval = 42`);
ok(r4.s.name === 'test', '行内注释已去除');
ok(r4.s.val === 42, '注释行后的数字');

// 引号内带井号的字符串
const r5 = pt(`[s]\ntitle = "item #3 - test"`);
ok(r5.s.title === 'item #3 - test', '引号内的井号保留');

// 布尔值和数字
const r6 = pt(`[s]\na = true\nb = false\nn = 123`);
ok(r6.s.a === true, '布尔值 true');
ok(r6.s.b === false, '布尔值 false');
ok(r6.s.n === 123, '数字');

// 转义引号
const r7 = pt(`[s]\ntext = "he said \\"hello\\""`);
ok(r7.s.text === 'he said "hello"', '转义引号');

// 多层嵌套节
const r8 = pt(`[a.b.c]\nx = "deep"`);
ok(r8.a.b.c.x === 'deep', '深层嵌套节');

// ── 原型污染防护 ──
console.log('\n## 原型污染防护');
// 测试非法键名
const badKeys = ['__proto__', 'constructor', 'prototype'];
for (const key of badKeys) {
  try {
    pt(`[s]\n${key} = "test"`);
    error(`非法键名 "${key}" 未被阻止`);
  } catch (e) {
    ok(e.message.includes('无效的 TOML 键'), `非法键名 "${key}" 被正确阻止`);
  }
}
// 测试合法键名
ok(pt(`[s]\nvalid_key_123 = "test"`).s.valid_key_123 === 'test', '合法键名通过');
ok(pt(`[s]\nValidKey = "test"`).s.ValidKey === 'test', '大写合法键名通过');
ok(pt(`[s]\n_key = "test"`).s._key === 'test', '下划线开头的合法键名通过');
ok(pt(`[s]\nname = "test"`).s.name === 'test', '合法键名 name 通过');
ok(pt(`[s]\nlength = 10`).s.length === 10, '合法键名 length 通过');

// ── 5. 去重哈希 ──
console.log('\n## 5. 去重哈希');
ok(createHash('sha256').update('A').digest('hex') === createHash('sha256').update('A').digest('hex'), '相同标题相同哈希');
ok(createHash('sha256').update('A').digest('hex') !== createHash('sha256').update('B').digest('hex'), '不同标题不同哈希');
// 中文字符测试
const cjk = createHash('sha256').update('中文标题').digest('hex');
const cjk2 = createHash('sha256').update('中文标题').digest('hex');
ok(cjk === cjk2, '相同中文标题相同哈希');

// ── 6. 图片混入 ──
console.log('\n## 6. 图片混入');
const mixFn = src.match(/function mixImages[\s\S]*?\n\}/);
ok(!!mixFn, 'mixImages 已定义');
const mix = eval('(function() { var PARA_RE = /<p[^>]*>[\\s\\S]*?<\\/p>/g; ' + mixFn[0] + '; return mixImages; })()');

// 基础混入
const html5 = '<p>P1</p><p>P2</p><p>P3</p>';
const mixed = mix(html5, ['img1.jpg']);
ok(mixed.includes('<figure><img src="img1.jpg"'), '图片已插入');
ok(mixed.includes('<p>P1</p>'), '段落 1 保留');
ok(mixed.includes('<p>P2</p>'), '段落 2 保留');
ok(mixed.includes('<p>P3</p>'), '段落 3 保留');

// 无图片
const noImg = mix(html5, []);
ok(noImg === html5, '无图片时返回原内容');

// 无段落
const noPara = mix('<div>no p</div>', ['img.jpg']);
ok(noPara === '<div>no p</div>', '无段落时返回原内容');

// 多张图片
const multiMix = mix('<p>P1</p><p>P2</p><p>P3</p><p>P4</p>', ['img1.jpg', 'img2.jpg']);
const imgCount = (multiMix.match(/<figure>/g) || []).length;
ok(imgCount === 2, '4 个段落插入 2 张图片');

// 图片分布
const manyParas = mix('<p>P1</p><p>P2</p><p>P3</p><p>P4</p><p>P5</p><p>P6</p>', ['img1.jpg', 'img2.jpg']);
const imgArr = [...manyParas.matchAll(/<figure>/g)];
ok(imgArr.length === 2, '6 个段落中插入 2 张图片');

// 带属性的 HTML
const attrHtml = '<p class="test">P1</p><p id="p2">P2</p>';
const attrMix = mix(attrHtml, ['img.jpg']);
ok(attrMix.includes('class="test"'), '保留段落属性');
ok(attrMix.includes('id="p2"'), '保留段落 ID');

// ── 7. 质量检查 ──
console.log('\n## 7. 质量检查函数');
const qcFn = src.match(/async function checkQuality[\s\S]*?\n\}/);
ok(!!qcFn, 'checkQuality 已定义');

// ── 8. 图片函数 ──
console.log('\n## 8. 图片函数');
ok(src.includes('async function s3List'), 's3List 已定义');
ok(src.includes('async function searchImages'), 'searchImages 已定义');
ok(src.includes('fetchWithRetry'), 'fetchWithRetry 已定义');
ok(src.includes('uriEncode('), 'uriEncode 已定义');

// ── 9. WP API 函数 ──
console.log('\n## 9. WP API 函数');
ok(src.includes('function wpAuth'), 'wpAuth 已定义');
ok(src.includes('async function wpFetch'), 'wpFetch 已定义');
ok(src.includes('async function uploadImage'), 'uploadImage 已定义');
ok(src.includes('async function uploadExternalImages'), 'uploadExternalImages 已定义');
ok(src.includes('async function findOrCreate'), 'findOrCreate 已定义');
ok(src.includes('async function checkDuplicate'), 'checkDuplicate 已定义');

// ── 11. 安装逻辑（合并进 wbp.mjs 的 doInstall）──
console.log('\n## 11. 安装逻辑');
ok(src.includes('async function doInstall'), 'wbp.mjs 包含 doInstall 安装函数');
ok(src.includes('checkCLI'), '安装逻辑包含 CLI 检测');
ok(src.includes('detectedTools'), '安装逻辑包含工具跟踪');
ok(src.includes('npm link'), '安装逻辑包含 npm link 全局化');
ok(!existsSync(join(SCRIPT_DIR, 'install.mjs')), 'install.mjs 已移除（合并进 wbp.mjs）');

// ── 12. 文档 ──
console.log('\n## 12. 文档');
ok(existsSync(join(SCRIPT_DIR, '../../../AGENTS.md')), 'AGENTS.md 存在');

// ── 13. 数据文件 ──
console.log('\n## 13. 数据文件');
ok(existsSync(join(SCRIPT_DIR, '../references/data', 'keywords.xlsx')), 'keywords.xlsx 存在');
ok(existsSync(join(SCRIPT_DIR, '../references/data', 'products.xlsx')), 'products.xlsx 存在');
ok(existsSync(join(SCRIPT_DIR, '../references/data', 'prompts.md')), 'prompts.md 存在');
ok(existsSync(join(SCRIPT_DIR, '../references/data', 'extensions', 'wiedza.md')), 'wiedza.md 存在');

// ── 14. 错误处理 ──
console.log('\n## 14. 错误处理');
const cfgPath = join(WP_DIR, 'setting.toml');
const cfgBackup = readFileSync(cfgPath, 'utf-8');

// 空配置测试（每个子测试独立 try/finally 恢复配置）
try {
  writeFileSync(cfgPath, '');
  const noCfg = run('wbp.mjs', ['pick']);
  ok(noCfg.status !== 0, '空配置退出码非零');
} finally {
  writeFileSync(cfgPath, cfgBackup, 'utf-8');
}

// 未知命令（需要配置正常）
const badCmd = run('wbp.mjs', ['unknown']);
ok(badCmd.status !== 0, '未知命令退出码非零');
// 不管输出在哪，都检查
const badOut = badCmd.stderr + badCmd.stdout;
ok(badOut.includes('用法'), '未知命令显示用法');

// 配置中无站点
try {
  writeFileSync(cfgPath, '# just a comment\n', 'utf-8');
  const noSites = run('wbp.mjs', ['pick']);
  ok(noSites.status !== 0, '无站点退出码非零');
  ok(noSites.stderr.includes('未配置'), '无站点错误信息');
} finally {
  writeFileSync(cfgPath, cfgBackup, 'utf-8');
}

// ── 15. AGENTS.md 验证 ──
console.log('\n## 15. AGENTS.md 验证');
const rootAgents = readFileSync(join(SCRIPT_DIR, '../../../AGENTS.md'), 'utf-8');
ok(rootAgents.includes('用途'), '根目录 AGENTS.md 包含 用途');
ok(rootAgents.includes('关键文件'), '根目录 AGENTS.md 包含 关键文件');
ok(rootAgents.includes('给 AI 代理的指引'), '根目录 AGENTS.md 包含 给 AI 代理的指引');
ok(rootAgents.includes('在此目录工作'), '根目录 AGENTS.md 包含 在此目录工作');
ok(rootAgents.includes('测试要求'), '根目录 AGENTS.md 包含 测试要求');
ok(rootAgents.includes('常用模式'), '根目录 AGENTS.md 包含 常用模式');
ok(rootAgents.includes('依赖关系'), '根目录 AGENTS.md 包含 依赖关系');

// ── 16. 用法输出 ──
console.log('\n## 16. 用法输出');
// ── 17. 配置引导向导（doConfigWizard）测试 ──
console.log('\n## 17. 配置引导向导测试');

// 17.1 测试非 TTY 回退
console.log('\n  17.1 非 TTY 环境回退');
const rInit1 = run('wbp.mjs', ['init'], { stdio: ['ignore', 'pipe', 'pipe'], input: '' });
ok(rInit1.status === 0, '非 TTY 环境退出码为 0');
ok(existsSync(join(WP_DIR, 'setting.toml')), 'setting.toml 已创建');

// 清理
if (existsSync(join(WP_DIR, 'setting.toml'))) unlinkSync(join(WP_DIR, 'setting.toml'));

// 17.2 测试配置文件内容
console.log('\n  17.2 配置文件内容验证');
const defaultConfig = {
  site: {
    'myblog': {
      name: 'My Blog',
      url: 'https://example.com/wp-json/wp/v2',
      user: 'admin',
      pass: 'abcd efgh ijkl mnop',
      categories: [1, 2, 3],
      keywords: ['data/keywords.xlsx'],
      products: 'data/products.xlsx',
      prompts: 'data/prompts.md',
      extensions: ['data/extensions/wiedza.md'],
      cdn: { mode: 's3' }
    }
  }
};
const cfgContent = tomlString(defaultConfig);
ok(cfgContent.includes('[site.myblog]'), '包含站点配置');
ok(cfgContent.includes('url = "https://example.com/wp-json/wp/v2"'), '包含默认 URL');
ok(cfgContent.includes('user = "admin"'), '包含默认用户名');
ok(cfgContent.includes('pass = "abcd efgh ijkl mnop"'), '包含默认密码');
ok(cfgContent.includes('categories = [1, 2, 3]'), '包含默认分类');
ok(cfgContent.includes('keywords = ["data/keywords.xlsx"]'), '包含默认关键词文件');
ok(cfgContent.includes('cdn = { mode = "s3" }'), '包含默认 S3 配置');

// 17.3 测试 parseCategories
console.log('\n  17.3 分类解析测试');
const categories = parseCategories('1,2,abc,456');
ok(Array.isArray(categories), '分类是数组');
ok(categories.length === 4, '分类数量为 4');
ok(categories[0] === 1, '第一个元素为数字 1');
ok(categories[1] === 2, '第二个元素为数字 2');
ok(categories[2] === 'abc', '第三个元素为字符串 abc');
ok(categories[3] === 456, '第四个元素为数字 456');

// 17.4 测试空分类
const emptyCategories = parseCategories('');
ok(emptyCategories.length === 0, '空分类返回空数组');

// 17.5 测试 TOML 字符串化
console.log('\n  17.5 TOML 字符串化测试');
const testObj = {
  site: {
    'myblog': {
      url: 'https://example.com',
      user: 'admin',
      pass: 'pass123'
    }
  },
  cdn: { mode: 's3' }
};
const tomlStr = tomlString(testObj);
ok(tomlStr.includes('[site."myblog"]'), '站点名正确转义');
ok(tomlStr.includes('url = "https://example.com"'), 'URL 正确转义');
ok(tomlStr.includes('cdn = { mode = "s3" }'), 'CDN 配置正确');

// 17.6 测试非 TTY 环境直接使用默认配置
console.log('\n  17.6 非 TTY 环境默认配置');
const testCfg = `[site.test]
url = "https://test.com"
user = "test"
pass = "test"`;
writeFileSync(join(WP_DIR, 'setting.toml'), testCfg);
const expectedCfg = tomlString(defaultConfig);
const rInit3 = run('wbp.mjs', ['init'], { stdio: ['pipe', 'pipe', 'pipe'], input: '' });
ok(rInit3.status === 0, '非 TTY 环境退出码为 0');
const newCfg = readFileSync(join(WP_DIR, 'setting.toml'), 'utf-8');
ok(newCfg === expectedCfg, '使用默认配置覆盖原有配置');

// 清理
if (existsSync(join(WP_DIR, 'setting.toml'))) unlinkSync(join(WP_DIR, 'setting.toml'));

// 17.7 测试站点点名验证
console.log('\n  17.7 验证站点点名验证');
const rInit4 = run('wbp.mjs', ['init'], {
  input: 'my-blog\nhttps://x.com/wp-json/wp/v2\nadmin\npass\n\n\n\n\n'
});
ok(rInit4.status !== 0, '非法站点点名退出码非零');

// 17.8 测试 URL 格式验证
console.log('\n  17.8 验证 URL 格式验证');
const rInit5 = run('wbp.mjs', ['init'], {
  input: 'myblog\ninvalid-url\nadmin\npass\n\n\n\n\n\n'
});
ok(rInit5.status !== 0, '格式错误的 URL 退出码非零');

// 17.9 测试密码格式验证
console.log('\n  17.9 验证密码格式验证');
const rInit6 = run('wbp.mjs', ['init'], {
  input: 'myblog\nhttps://x.com/wp-json/wp/v2\nshort\n\n\n\n\n\n'
});
ok(rInit6.status !== 0, '格式错误的密码 退出码非零');
const rInit7 = run('wbp.mjs', ['init', '--non-interactive']);
ok(rInit7.status === 0, '图片模式选择成功');
const cfg7 = readFileSync(join(WP_DIR, 'setting.toml'), 'utf-8');
ok(cfg7.includes('cdn = { mode = "s3" }'), '默认图片模式为 S3');

// 清理
if (existsSync(join(WP_DIR, 'setting.toml'))) unlinkSync(join(WP_DIR, 'setting.toml'));


// ── 汇总 ──
console.log(`${"=".repeat(36)}`);
console.log(`${pass}/${pass+fail} 通过`);
