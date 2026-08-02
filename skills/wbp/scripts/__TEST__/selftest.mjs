#!/usr/bin/env node
// selftest.mjs — wbp.mjs 自检（增强版）
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR = join(__dirname, '..');
const ROOT_DIR = join(SCRIPT_DIR, '..', '..');
const REF_DATA_DIR = join(ROOT_DIR, 'skills', 'wbp', 'references', 'data');
const HOME = process.env.HOME || process.env.USERPROFILE;
const WP_DIR = join(HOME, '.wbp');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log(`  ✓ ${msg}`); } else { fail++; console.log(`  ✗ ${msg}`); } }
function run(cmd, args) { return spawnSync(process.execPath, [cmd, ...args], { cwd: SCRIPT_DIR, encoding: 'utf-8' }); }
function runScript(file, args) { return spawnSync(process.execPath, [join(SCRIPT_DIR, file), ...args], { cwd: SCRIPT_DIR, encoding: 'utf-8' }); }

// ── 1. 语法检查 ──
console.log('## 1. 语法检查');
ok(run('--check', [join(SCRIPT_DIR, 'wbp.mjs')]).status === 0, 'wbp.mjs 语法正确');
ok(run('--check', [join(SCRIPT_DIR, 'install.mjs')]).status === 0, 'install.mjs 语法正确');
ok(run('--check', [join(__dirname, 'selftest.mjs')]).status === 0, 'selftest.mjs 语法正确');

// ── 2. 初始化 ──
console.log('\n## 2. 初始化');
ok(run('wbp.mjs', ['init']).status === 0, 'init 退出码为 0');
ok(existsSync(join(WP_DIR, 'setting.toml')), 'setting.toml 已创建');

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
const tomlFn = src.match(/function parseToml[\s\S]*?\n\}/);
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

// S3 URI 编码
const uriFn = src.match(/function uriEncodeS3[\s\S]*?\n\}/);
if (uriFn) {
  const uriEnc = eval(`(function() { ${uriFn[0]}; return uriEncodeS3; })()`);
  ok(uriEnc('test') === 'test', 'uriEncodeS3 纯文本');
  ok(uriEnc('a b') === 'a%20b', 'uriEncodeS3 空格');
}

// ── 9. WP API 函数 ──
console.log('\n## 9. WP API 函数');
ok(src.includes('function wpAuth'), 'wpAuth 已定义');
ok(src.includes('async function wpFetch'), 'wpFetch 已定义');
ok(src.includes('async function uploadImage'), 'uploadImage 已定义');
ok(src.includes('async function uploadExternalImages'), 'uploadExternalImages 已定义');
ok(src.includes('async function findOrCreate'), 'findOrCreate 已定义');
ok(src.includes('async function checkDuplicate'), 'checkDuplicate 已定义');

// ── 10. 辅助函数 ──
console.log('\n## 10. 辅助函数');

// isAbsPath 测试
const isAbsPathFn = src.match(/function isAbsPath[\s\S]*?\n\}/);
if (isAbsPathFn) {
  const iap = eval(`(function() { ${isAbsPathFn[0]}; return isAbsPath; })()`);
  ok(iap('/abc'), 'Unix 绝对路径');
  ok(iap('C:\\abc'), 'Windows 绝对路径');
  ok(iap('D:/abc'), 'Windows 绝对路径（正斜杠）');
  ok(!iap('relative/path'), '相对路径返回 false');
  ok(!iap(''), '空字符串返回 false');
}

// ── 11. 安装脚本 ──
console.log('\n## 11. 安装脚本');
const installSrc = readFileSync(join(SCRIPT_DIR, 'install.mjs'), 'utf-8');
ok(installSrc.includes('checkCLI'), '安装脚本包含 CLI 检测');
ok(installSrc.includes('detectedTools'), '安装脚本包含工具跟踪');
ok(installSrc.includes('prompt'), '安装脚本包含提示模板');

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
const usage = run('wbp.mjs', ['help']);
ok(usage.status !== 0, 'help 退出码非零');
const usageOut = usage.stderr + usage.stdout;
ok(usageOut.includes('用法'), 'help 显示用法');
ok(usageOut.includes('pick'), '用法提及 pick');
ok(usageOut.includes('publish'), '用法提及 publish');
ok(usageOut.includes('init'), '用法提及 init');

// ── 汇总 ──
console.log(`\n${'='.repeat(36)}`);
console.log(`${pass}/${pass+fail} 通过`);
process.exit(fail > 0 ? 1 : 0);