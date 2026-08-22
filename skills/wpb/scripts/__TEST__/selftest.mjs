#!/usr/bin/env node
// selftest.mjs — wpb.mjs 自检（增强版）
import { existsSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync, copyFileSync, readdirSync, statSync, unlinkSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { homedir, tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR = join(__dirname, '..');
const REF_DATA_DIR = join(SCRIPT_DIR, '../references/data'); // 与第 13 节数据文件检查一致：skills/wpb/references/data
// 测试用临时项目目录，findWpDir() 从子进程 CWD 向上查找 .wpb
const TEST_PROJECT = mkdtempSync(join(tmpdir(), 'wpb-test-'));
const WP_DIR = join(TEST_PROJECT, '.wpb');

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
function run(cmd, args, opts) {
  const script = cmd === 'wpb.mjs' ? join(SCRIPT_DIR, 'wpb.mjs') : cmd;
  return spawnSync(process.execPath, [script, ...args], { cwd: TEST_PROJECT, encoding: 'utf-8', ...opts });
}

// ── 1. 语法检查 ──
console.log('## 1. 语法检查');
ok(run('--check', [join(SCRIPT_DIR, 'wpb.mjs')]).status === 0, 'wpb.mjs 语法正确');
ok(run('--check', [join(__dirname, 'selftest.mjs')]).status === 0, 'selftest.mjs 语法正确');

// ── 2. 安装数据 ──
console.log('\n## 2. 安装数据');

// 准备测试数据：把仓库 references/data 复制到测试项目 .wpb/data
// pick 的相对路径解析到 .wpb/data；测试用临时项目目录隔离
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
mkdirSync(WP_DIR, { recursive: true });
syncRefData();
ok(existsSync(join(WP_DIR, 'data', 'keywords.csv')), '测试数据已就位');

// 生成测试用配置（指向 .csv 测试数据）
writeFileSync(join(WP_DIR, 'setting.toml'), [
  '[site.myblog]',
  'name = "My Blog"',
  'url = "https://example.com/wp-json/wp/v2"',
  'user = "admin"',
  'pass = "abcd efgh ijkl mnop"',
  'categories = [1,2,3]',
  'keywords = ["data/keywords.csv"]',
  'products = "data/products.csv"',
  'prompts = "data/prompts.md"',
  'extensions = ["data/extensions/wiedza.md"]',
  '',
  '[site.myblog.cdn]',
  'mode = "s3"',
  ''
].join('\n'), 'utf-8');

// ── 3. 选择关键词 ──
console.log('\n## 3. 选择关键词');
const p = run('wpb.mjs', ['pick']);
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
const src = readFileSync(join(SCRIPT_DIR, 'wpb.mjs'), 'utf-8');
const refToml = readFileSync(join(SCRIPT_DIR, '../references/setting-reference.toml'), 'utf-8');
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
// 数组元素内含逗号（引号保护）
const r2b = pt(`[s]\narr = ["hello, world", "foo"]`);
ok(r2b.s.arr.length === 2, '数组引号内逗号不分割');
ok(r2b.s.arr[0] === 'hello, world', '数组含逗号元素正确');
// 数组混用单双引号
const r2c = pt(`[s]\narr = ["double", 'single']`);
ok(r2c.s.arr.length === 2, '数组混用单双引号');
ok(r2c.s.arr[0] === 'double', '数组双引号元素');
ok(r2c.s.arr[1] === 'single', '数组单引号元素');

// 多行数组（跨行折叠）
const r2d = pt(`[s]\narr = [\n  "a",\n  "b",\n  "c"\n]`);
ok(Array.isArray(r2d.s.arr), '多行数组解析为数组');
ok(r2d.s.arr.length === 3, '多行数组有 3 个元素');
ok(r2d.s.arr[0] === 'a', '多行数组元素 0');
ok(r2d.s.arr[1] === 'b', '多行数组元素 1');
ok(r2d.s.arr[2] === 'c', '多行数组元素 2');
// 多行数组含注释与尾逗号（模拟 setting-reference.toml 的 keywords 字段）
const r2e = pt(`[s]\nkeywords = [\n  "data/a.csv",\n  # "https://example.com/pub?output=csv",\n  "data/b.csv",\n]`);
ok(Array.isArray(r2e.s.keywords), '多行数组含注释解析为数组');
ok(r2e.s.keywords.length === 2, '多行数组含注释去除注释后剩 2 个元素');
ok(r2e.s.keywords[0] === 'data/a.csv', '多行数组含注释元素 0');
ok(r2e.s.keywords[1] === 'data/b.csv', '多行数组含注释元素 1');

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

// 基础混入（3 段 1 图 → 插在段落之间）
const html5 = '<p>P1</p><p>P2</p><p>P3</p>';
const mixed = mix(html5, ['img1.jpg']);
ok(mixed.includes('<figure><img src="img1.jpg"'), '图片已插入');
ok(mixed.includes('alt="img1"'), 'img 含 alt 属性（从文件名派生）');
ok(mixed.includes('title="img1"'), 'img 含 title 属性（从文件名派生）');
ok(mixed.includes('<p>P1</p>'), '段落 1 保留');
ok(mixed.includes('<p>P2</p>'), '段落 2 保留');
ok(mixed.includes('<p>P3</p>'), '段落 3 保留');
// 首段前无图
ok(!mixed.startsWith('<figure>'), '首段前不插入图片');

// 无图片
const noImg = mix(html5, []);
ok(noImg === html5, '无图片时返回原内容');

// 无段落
const noPara = mix('<div>no p</div>', ['img.jpg']);
ok(noPara === '<div>no p</div>', '无段落时返回原内容');

// 单段落（<2 不插入）
const singlePara = mix('<p>P1</p>', ['img.jpg']);
ok((singlePara.match(/<figure>/g) || []).length === 0, '单段落不插入图片');

// 多张图片
const multiMix = mix('<p>P1</p><p>P2</p><p>P3</p><p>P4</p>', ['img1.jpg', 'img2.jpg']);
const imgCount = (multiMix.match(/<figure>/g) || []).length;
ok(imgCount === 2, '4 个段落插入 2 张图片');

// 图片分布
const manyParas = mix('<p>P1</p><p>P2</p><p>P3</p><p>P4</p><p>P5</p><p>P6</p>', ['img1.jpg', 'img2.jpg']);
const imgArr = [...manyParas.matchAll(/<figure>/g)];
ok(imgArr.length === 2, '6 个段落中插入 2 张图片');

// 带属性的 HTML
const attrHtml = '<p class="test">P1</p><p id="p2">P2</p><p>P3</p>';
const attrMix = mix(attrHtml, ['img.jpg']);
ok(attrMix.includes('class="test"'), '保留段落属性');
ok(attrMix.includes('id="p2"'), '保留段落 ID');

// 图片多于可用位置（截断）
const moreImgs = mix('<p>P1</p><p>P2</p>', ['i1.jpg', 'i2.jpg', 'i3.jpg']);
const moreImgCount = (moreImgs.match(/<figure>/g) || []).length;
ok(moreImgCount === 1, '图片多于可用位置时截断');

// alt/title 从复杂 URL 派生（解码、分隔符转空格、去扩展名）
const complexMix = mix('<p>P1</p><p>P2</p>', ['https://cdn.example.com/images/red-shoe-front_view.JPG']);
ok(complexMix.includes('alt="red shoe front view"'), '复杂 URL 正确派生 alt 文本');
ok(complexMix.includes('title="red shoe front view"'), '复杂 URL 正确派生 title 文本');

// 不插在小标题之后相邻位置
const h3Html = '<h3>T1</h3><p>P1</p><p>P2</p><h3>T2</h3><p>P3</p><p>P4</p><p>P5</p><h3>T3</h3><p>P6</p><p>P7</p><p>P8</p>';
const h3Mix = mix(h3Html, ['img1.jpg', 'img2.jpg']);
ok((h3Mix.match(/<figure>/g) || []).length === 2, '带 H3 文章插入 2 张图');
ok(!/<\/h3><figure>/.test(h3Mix), '不在小标题之后相邻位置插入图片');
ok(!h3Mix.startsWith('<figure>'), '首段前不插入图片');

// 所有段落都跟在 H3 后（无可用位置）
const allH3 = '<h3>T1</h3><p>P1</p><h3>T2</h3><p>P2</p>';
const allH3Mix = mix(allH3, ['img.jpg']);
ok(allH3 === allH3Mix, '所有位置都被 H3 占据时不插入图片');

// NitroPack CDN URL 清理
{
  const npFn = src.match(/function stripNitroPack[\s\S]*?\n\}/);
  ok(!!npFn, 'stripNitroPack 已定义');
  if (npFn) {
    const strip = eval('(function() { ' + npFn[0] + '; return stripNitroPack; })()');
    // 标准 NitroPack URL
    const html1 = '<img src="https://cdn-ileknfn.nitrocdn.com/IOCVOCGySKYBwXIBEBTNuNiOLiCeeeZn/assets/images/optimized/rev-f2ca40a/xxxx.com/xxxxxx.jpg" alt="t">';
    const r1 = strip(html1);
    ok(r1.includes('xxxx.com/xxxxxx.jpg'), 'NitroPack 前缀已剥离');
    ok(!r1.includes('nitrocdn.com'), 'NitroPack CDN 域名已移除');
    // 不同 token 和 rev hash
    const html2 = '<img src="https://cdn-abc123.nitrocdn.com/DIFFERENT_TOKEN/assets/images/optimized/rev-abc123def456/example.com/img.png">';
    const r2 = strip(html2);
    ok(r2.includes('example.com/img.png'), '不同 token/rev 正确剥离');
    // 无 NitroPack URL 时不变
    const html3 = '<img src="https://example.com/normal.jpg">';
    ok(strip(html3) === html3, '非 NitroPack URL 不变');
    // 多个 NitroPack URL 混合普通 URL
    const html4 = '<img src="https://cdn-x.nitrocdn.com/TOK/assets/images/optimized/rev-hash/a.com/1.jpg"><img src="https://b.com/2.jpg"><img src="https://cdn-y.nitrocdn.com/TOK2/assets/images/optimized/rev-hash2/c.com/3.jpg">';
    const r4 = strip(html4);
    ok(r4.includes('a.com/1.jpg') && r4.includes('b.com/2.jpg') && r4.includes('c.com/3.jpg'), '混合 URL 全部正确处理');
    ok(!r4.includes('nitrocdn'), '混合 URL 中所有 NitroPack 前缀已移除');
  }
}

// ── 7. 质量检查 ──
console.log('\n## 7. 质量检查函数');
const qcFn = src.match(/async function checkQuality[\s\S]*?\n\}/);
ok(!!qcFn, 'checkQuality 已定义');
// 验证 checkQuality 包含 return 语句（非截断）
ok(qcFn && qcFn[0].includes('return'), 'checkQuality 函数体完整（含 return）');
// 词数校验阈值为 5000
ok(src.includes('wordCount < 5000'), '词数校验阈值为 5000');
ok(src.includes('少于 5000'), '词数不足提示 5000');
// CJK 词数统计：按字符计数而非空格分词
ok(src.includes('cjkChars'), 'checkQuality 支持 CJK 字符计数');
ok(src.includes('\\u4e00-\\u9fff'), 'CJK 范围包含中日韩统一表意文字');
ok(src.includes('\\uac00-\\ud7af'), 'CJK 范围包含韩文音节');
// 段落数校验阈值为 10
ok(src.includes('paras.length < 10'), '段落数校验阈值为 10');
// H3 标题校验阈值为 3
ok(src.includes('h3.length < 3'), 'H3 标题校验阈值为 3');
// 标题长度校验阈值为 10
ok(src.includes('title.length < 10'), '标题长度校验阈值为 10');
// 摘要长度校验阈值为 50
ok(src.includes('excerpt.length < 50'), '摘要长度校验阈值为 50');
// 标签数量校验下限为 3，上限为 10
ok(src.includes('tags.length < 3'), '标签数量下限为 3');
ok(src.includes('tags.length > 10'), '标签数量上限为 10');
// 死链检测使用 GET 而非 HEAD（避免 HEAD 被拒误判）
ok(src.includes("method: 'GET'"), '死链检测使用 GET 而非 HEAD');
ok(src.includes('catch { return null; }'), '死链检测网络错误返回 null 而非 500');
ok(/c !== null && c >= 400/.test(src), '死链计 4xx 和 5xx（网络错误不计）');
// navRe 支持多层子路径（如 /category/vape/disposable 不被误判为产品链接）
ok(/\(\/\[\^\/\]\+\)\*\//.test(src), 'navRe 支持多层子路径匹配');

// ── 8. 图片函数 ──
console.log('\n## 8. 图片函数');
ok(src.includes('async function s3List'), 's3List 已定义');
ok(src.includes('async function searchImages'), 'searchImages 已定义');
ok(src.includes('fetchWithRetry'), 'fetchWithRetry 已定义');
// S3 prefix 筛选支持
ok(src.includes("prefix = ''"), 's3List 支持 prefix 筛选');
// S3 密钥环境变量覆盖
ok(src.includes('AWS_ACCESS_KEY_ID'), 's3List 支持 AWS_ACCESS_KEY_ID 环境变量');
ok(src.includes('AWS_SECRET_ACCESS_KEY'), 's3List 支持 AWS_SECRET_ACCESS_KEY 环境变量');
// S3 endpoint 可选（留空用 AWS 默认）
ok(/endpoint \?/.test(src), 's3List endpoint 可选');
// pick 输出脱敏（API keys 不泄露）
ok(src.includes('keys: undefined'), 'pick 输出对 images.keys 脱敏');
// CDN 模式保留远程图片
ok(src.includes("mode === 'cdn'"), 'CDN 模式保留远程图片不变');
// readTable URL 分支转 Uint8Array 传给 SheetJS（type:'array' 期望字节数组，直接传 ArrayBuffer 不稳定）
ok(src.includes('new Uint8Array(await res.arrayBuffer())'), 'readTable URL 分支 ArrayBuffer 转 Uint8Array');
// pickSheet 空工作簿防护
ok(src.includes('工作簿没有任何工作表'), 'pickSheet 空工作簿明确报错');
// setting-reference.toml 使用 accessKeyId/secretAccessKey（配置模板参考）
ok(refToml.includes('#accessKeyId'), 'setting-reference.toml 使用 accessKeyId');
ok(refToml.includes('#secretAccessKey'), 'setting-reference.toml 使用 secretAccessKey');
// publish 命令缺少文件参数时提示用法
ok(src.includes("用法: wpb publish"), 'publish 缺参数时显示用法');
// fetchWithRetry 每次重试新建独立 timeout signal，避免复用已 aborted signal 导致重试失效
ok(/AbortSignal\.timeout\(TIMEOUT_MS\)/.test(src), 'fetchWithRetry 每次重试新建 timeout signal');
ok(/AbortSignal\.any\(\[opts\.signal/.test(src), 'fetchWithRetry 外部 signal 与 timeout 取较短者');
ok(src.includes('opts = {}'), 'fetchWithRetry opts 默认空对象（防止单参数调用 crash）');
ok(src.includes('opts.signal?.aborted'), 'fetchWithRetry 外部 signal abort 时不重试');
ok(src.includes('AbortSignal.any') && src.includes('typeof AbortSignal.any'), 'AbortSignal.any polyfill 兼容 Node 18/19');
ok(/AbortSignal\.any = \(sigs\)[\s\S]{0,600}?removeEventListener/.test(src), 'polyfill abort 时清理监听器（无泄漏）');
// fetchWithRetry 重试 mock 测试：首次超时后第 2 次重试仍能成功（验证每次新建 signal）
{
  const fnSrc = src.match(/async function fetchWithRetry[\s\S]*?\n\}/);
  if (!fnSrc) error('fetchWithRetry 函数提取失败');
  else {
    let callCount = 0;
    const mockFetch = async (url, opts) => {
      callCount++;
      if (callCount === 1) throw new Error('timeout');
      return { ok: true, json: async () => ({ success: true }) };
    };
    const fw = eval('(function() { var fetch = arguments[0]; var AbortSignal = arguments[1]; var log = arguments[2]; var TIMEOUT_MS = 30000; ' + fnSrc[0].replace('async function fetchWithRetry', 'return async function fetchWithRetry') + '; })');
    const fetchWithRetry = fw(mockFetch, { timeout: () => ({ aborted: false, addEventListener: () => {} }), any: (s) => s[0] }, () => {});
    const res = await fetchWithRetry('http://test', {}, 2);
    ok(res.ok === true && callCount === 2, 'fetchWithRetry 超时后第 2 次重试成功（每次新建 signal）');
  }
}
// uploadImage 走 fetchWithRetry 重试
ok(/await fetchWithRetry\(`\$\{site\.url/.test(src), 'uploadImage 走 fetchWithRetry 重试');
// fetchWithRetry UA 注入大小写不敏感（避免已有 User-Agent 键时重复设置）
ok(/keys\(headers\)\.some\(k => k\.toLowerCase\(\) === 'user-agent'\)/.test(src), 'fetchWithRetry UA 判断大小写不敏感');
// uploadImage decodeURIComponent 回退（非法 % 序列时用原始文件名而非 image.jpg）
ok(/catch \{ raw = imgUrl\.split/.test(src), 'uploadImage decodeURI 失败时回退原始文件名');
// uploadImage content-type 校验（非图片类型回退为 image/jpeg）
ok(src.includes("!/^image\\//i.test(ctype)"), 'uploadImage 非图片 content-type 回退为 image/jpeg');
// generatePromptContent 为不同工具注入 invoke 前缀
ok(src.includes('tool?.invoke'), 'generatePromptContent 注入 invoke 前缀');
// mixImages 截断图片到可用位置数（不丢图）
ok(src.includes('paras.length - 1'), 'mixImages 截断图片到段落数-1');
ok(src.includes("paras[i].end"), 'mixImages 基于段落位置插入');
ok(src.includes('</h3>'), 'mixImages 检测小标题避开');
ok(src.includes('paras.length < 2'), 'mixImages 少于2段落不插入');
// searchImages 支持 query 字段覆盖默认搜索词（tags+title）
ok(src.includes('const { gl, hl, tbs, query } = cfg'), 'searchImages 解构 query 字段（gl/hl/tbs 不写死默认值）');
ok(src.includes('if (query)'), 'searchImages query 非空时直接使用');
ok(/if\s*\(gl\)\s*body\.gl/.test(src), 'searchImages 仅在配置了 gl 时才传该字段');
ok(src.includes('const body = { q }'), 'searchImages 请求体以 q 为基础按需扩展');
// searchImages query 字段功能测试（mock fetchWithRetry，验证实际调用参数）
{
  const fnSrc = src.match(/async function searchImages[\s\S]*?\n\}/);
  if (!fnSrc) error('searchImages 函数提取失败');
  else {
    let capturedBody = null;
    const mockFetch = async (url, opts) => { capturedBody = JSON.parse(opts.body); return { ok: true, json: async () => ({ images: [{ imageUrl: 'https://img.test/x.jpg' }] }) }; };
    const si = eval('(function() { var fetchWithRetry = arguments[0]; var log = arguments[1]; ' + fnSrc[0].replace('async function searchImages', 'return async function searchImages') + '; })');
    const searchImages = si(mockFetch, () => {});
    // 无配置 → body 不含 gl/hl/tbs
    await searchImages({ keys: ['k1'] }, ['elfbar', 'vape'], 'Best Vape 2024');
    ok(capturedBody && !('gl' in capturedBody) && !('hl' in capturedBody) && !('tbs' in capturedBody), '无配置时 body 不含 gl/hl/tbs');
    // 有配置 → body 含对应字段
    await searchImages({ keys: ['k1'], gl: 'cn', tbs: 'qdr:m' }, ['elfbar', 'vape'], 'Best Vape 2024');
    ok(capturedBody.gl === 'cn' && capturedBody.tbs === 'qdr:m' && !('hl' in capturedBody), '有配置时 body 含 gl/tbs、不含未配 hl');
    // query → body.q 使用 query 值
    await searchImages({ keys: ['k1'], query: '固定搜索词' }, ['elfbar', 'vape'], 'Best Vape 2024');
    ok(capturedBody.q === '固定搜索词', 'query 传入 body.q');
    // query 优先级：tags/title 为空时 query 仍生效
    await searchImages({ keys: ['k1'], query: 'override' }, [], '');
    ok(capturedBody.q === 'override', 'query 即使 tags/title 为空仍生效');
  }
}
// searchImages 非 2xx 响应也退避（防止快速轮询 key 触发限流）
ok(/图片搜索失败[\s\S]{0,200}?backoff\(attempt\)/.test(src), 'searchImages 非 2xx 重试前退避');
// mixImages alt/title HTML 特殊字符转义
{
  const escMix = mix('<p>P1</p><p>P2</p>', ['https://x.com/red-shoe.jpg']);
  // 正常 alt 不含未转义的引号（不会产生额外的引号属性）
  ok(/alt="[^"]*"/.test(escMix), 'alt 属性正确闭合');
  // 验证 escAttr 函数存在
  ok(src.includes('escAttr'), 'mixImages 包含 escAttr 转义函数');
}
// validateDraft 对非对象输入的处理
{
  // validateDraft 是箭头函数赋值，用 eval 提取（匹配到 return 语句末尾，不含源码分号）
  const vdSrc = src.match(/const validateDraft = d => \{[\s\S]*?return \{ valid: e\.length === 0, errors: e \}; \}/);
  if (!vdSrc) error('validateDraft 函数提取失败');
  else {
    const vd = eval('(function() { ' + vdSrc[0] + '; return validateDraft; })()');
    ok(vd(null).valid === false, 'validateDraft(null) 返回 invalid');
    ok(vd(null).errors[0].includes('JSON 对象'), 'validateDraft(null) 错误提示含 JSON 对象');
    ok(vd(42).valid === false, 'validateDraft(42) 返回 invalid');
    ok(vd([1, 2]).valid === false, 'validateDraft(数组) 返回 invalid');
  }
}
// s3List 必填字段校验（bucket/region，endpoint 配置时豁免）
ok(src.includes('S3 配置缺少 bucket'), 's3List 校验 bucket 必填');
ok(src.includes('S3 配置缺少 region'), 's3List 校验 region 必填');
// s3List endpoint 配置时 region 兜底为 us-east-1（防止 createHmac 收到 undefined 抛 TypeError）
ok(src.includes("region: cfgRegion = endpoint ? 'us-east-1' : undefined"), 's3List endpoint 配置时 region 兜底');
// loadProducts/loadPromptDoc/loadExtDocs 加 try/catch 错误保护（单个加载失败不影响整体）
ok(src.includes('产品文件加载失败'), 'loadProducts 失败时降级返回空数组');
ok(src.includes('写作指令加载失败'), 'loadPromptDoc 失败时降级返回空字符串');
ok(src.includes('扩展知识加载失败'), 'loadExtDocs 单个失败时跳过不影响整体');
ok(src.includes('parts.filter(Boolean).join'), 'loadExtDocs 过滤空值后拼接');
// 文件名清理支持拉丁扩展补充区（波兰语带附加符号字符）
ok(src.includes('\\u0100-\\u017F'), '文件名清理保留波兰语带附加符号字符');
ok(src.includes('\\u4e00-\\u9fff'), '文件名清理保留中日韩字符');
// pick 输出 _warnings 字段提示图片池为空
ok(src.includes('_warnings'), 'pick 输出 _warnings 字段');
ok(src.includes('图片池为空'), 'pick 图片池空时添加警告');
// setting-reference.toml domain 注释（仅 S3 模式）
ok(refToml.includes('S3') && refToml.includes('domain'), 'setting-reference.toml 含 S3 domain 字段说明');

// ── 9. WP API 函数 ──
console.log('\n## 9. WP API 函数');
ok(src.includes('function wpAuth'), 'wpAuth 已定义');
ok(src.includes('async function wpFetch'), 'wpFetch 已定义');
ok(src.includes('async function uploadImage'), 'uploadImage 已定义');
ok(src.includes('async function uploadExternalImages'), 'uploadExternalImages 已定义');
ok(src.includes('async function findOrCreate'), 'findOrCreate 已定义');
ok(src.includes('async function checkDuplicate'), 'checkDuplicate 已定义');
// wpFetch JSON 解析错误处理（非 JSON 响应时给出明确错误）
ok(src.includes('WP API 响应 JSON 解析失败'), 'wpFetch 包含 JSON 解析错误处理');
// findOrCreate 分页上限防护（防止非数组响应导致死循环）
ok(/page <= 20/.test(src), 'findOrCreate 分页上限 20 页');
ok(src.includes('Array.isArray(batch)'), 'findOrCreate 非数组响应时 break');
// checkDuplicate 标题截断保护（防超长标题导致 WP 搜索异常）
ok(src.includes('title.slice(0, 100)'), 'checkDuplicate 标题截断至 100 字符');
// uploadExternalImages 按 origin 精确比较跳过（防 site.com.evil.com 前缀伪装）
ok(src.includes('const urlOrigin = u =>'), 'uploadExternalImages 提取 URL origin 辅助函数');
ok(src.includes('urlOrigin(url) === o'), '外链图片过滤使用 origin 相等比较（非前缀 startsWith）');
// uploadImage 缺少 content-length（分块传输）时按实际缓冲大小二次校验
ok(src.includes('buf.length > 5 * 1024 * 1024'), 'uploadImage 缓冲大小二次校验（防 content-length 缺失绕过限制）');
// checkQuality 关键词正则转义防护（用户标签含正则元字符时不注入）
ok(src.includes('k.replace(/[.'), 'checkQuality 关键词正则转义防护');

// ── 10. URL 关键词文件支持与路径安全 ──
console.log('\n## 10. URL 关键词文件与路径安全');
// safePath 对 URL 原样返回（不解析为本地伪路径）
ok(src.includes('if (isUrl(p)) return p'), 'safePath 对 URL 原样返回');
// isUrl 辅助函数已定义
ok(src.includes('const isUrl = p =>'), 'isUrl 辅助函数已定义');
// pathOk 统一路径可用性判断（URL 视为可用，本地文件须 existsSync）
ok(src.includes('const pathOk = p =>'), 'pathOk 统一路径可用性判断');
ok(src.includes('isUrl(p) || existsSync(p)'), 'pathOk URL 始终视为可用');
// main 函数使用 pathOk 替代 existsSync 检查关键词文件
ok(src.includes('kwPaths.some(pathOk)'), 'main 使用 pathOk 检查关键词文件');
ok(src.includes('kwPaths.filter(pathOk)'), 'main 使用 pathOk 过滤关键词文件');
// products/prompts/extensions 也使用 pathOk
ok(src.includes('prodPaths.filter(pathOk)'), 'products 使用 pathOk 检查');
ok(src.includes('promptPaths.filter(pathOk)'), 'prompts 使用 pathOk 检查');
ok(src.includes('pathOk(ep)'), 'extensions 使用 pathOk 检查');
// products/prompts 支持多个文件（随机选一个）
ok(src.includes('asArray(site.products)'), 'products 支持多文件数组');
ok(src.includes('asArray(site.prompts)'), 'prompts 支持多文件数组');
// checkQuality 死链检测使用 extHref 而非 allLinks（只检查外链）
ok(src.includes('extHref.slice(0, 3)'), '死链检测取外链前 3 个（非所有链接）');
ok(src.includes('if (extHref.length)'), '死链检测仅在有外链时执行');
// site.name 仅在未配置时回退为 section slug（不覆盖用户显式配置）
ok(src.includes('if (!site.name) site.name = siteName'), 'site.name 仅在未配置时回退为 slug');
// pick 输出使用 site.name 而非 siteName（与 site.name 回退逻辑一致）
ok(src.includes('name: site.name,'), 'pick 输出使用 site.name（非 slug）');
// readTable 复用全局 isUrl（无局部变量遮蔽）
ok(!/function readTable[\s\S]*?const isUrl =/.test(src), 'readTable 无 isUrl 局部变量遮蔽');
// stripNitroPack 正则同时支持 http:// 和 https://
ok(/https\?\:.*cdn-/.test(src), 'stripNitroPack 正则支持 http/https 双协议');
// mixImages src 属性也经 escAttr 转义（防 URL 中双引号注入）
ok(src.includes('src="${escAttr(used[i])}"'), 'mixImages src 属性经 escAttr 转义');
// checkDuplicate 归一化标题比较（默认 context 不返回 title.raw，rendered 含 HTML 实体）
ok(src.includes('const normTitle'), 'normTitle 标题归一化函数存在');
ok(src.includes('const decodeHtml'), 'decodeHtml HTML 实体解码函数存在');
ok(src.includes('normTitle(p.title.raw'), 'checkDuplicate 比较归一化 title.raw');
ok(src.includes('normTitle(p.title.rendered'), 'checkDuplicate 比较归一化 title.rendered');
// normTitle 功能测试（eval 提取；WP rendered 标题含实体，去重必须归一化）
{
  const dh = src.match(/const decodeHtml = s => [^\n]+/);
  const nt = src.match(/const normTitle = t => [^\n]+/);
  if (!dh || !nt) error('decodeHtml/normTitle 函数提取失败');
  else {
    const normTitle = eval('(function() { ' + dh[0] + ' ' + nt[0] + ' return normTitle; })()');
    ok(normTitle('Hello &amp; World') === 'Hello & World', 'normTitle 解码 &amp; 实体');
    ok(normTitle('Price &#8364;') === 'Price €', 'normTitle 解码数字实体');
    ok(normTitle('  multi   space ') === 'multi space', 'normTitle 压缩空白并去首尾空格');
  }
}
// 死链检测使用 fetchWithRetry 而非裸 fetch（支持重试）
ok(src.includes('fetchWithRetry(u, { method:'), '死链检测使用 fetchWithRetry 重试');
// uploadExternalImages img src 正则同时匹配单引号和双引号
ok(src.includes("src=[\"']([^\"']+)[\"']"), 'uploadExternalImages img src 正则匹配单双引号');
// prompts/extensions 支持 URL 路径（isUrl 判断后走 fetch 而非 readFileSync）
ok(src.includes('isUrl(p)'), 'prompts 支持 URL 路径');
ok(src.includes('isUrl(ep)'), 'extensions 支持 URL 路径');

// ── 10b. fetch 命令与 publish 更新路径 ──
console.log('\n## 10b. fetch 命令与 publish 更新路径');
// 用法字符串含 fetch
ok(src.includes('用法: wpb [pick|fetch <url>|publish <file>|install]'), '用法字符串含 fetch');
// 白名单含 fetch
ok(/'pick', 'fetch', 'publish'/.test(src), '命令白名单含 fetch');
// fetch 分支存在
ok(src.includes("if (cmd === 'fetch')"), 'main 含 fetch 分支');
// fetch 仅接受 URL，不接受 ID
ok(src.includes("fetch 参数必须是 http(s) URL"), 'fetch 拒绝非 URL 参数');
// fetch 无参数时提示用法
ok(src.includes('用法: wpb fetch <文章URL>'), 'fetch 无参数提示用法');
// 站点 origin 匹配（多站点安全：按 URL 域名精确匹配，不随机选）
ok(src.includes('siteOriginOf'), 'siteOriginOf 辅助函数已定义');
ok(src.includes('findSiteByOrigin'), 'findSiteByOrigin 按域名匹配站点');
ok(src.includes('文章 URL 不属于任何已配置站点'), 'fetch origin 未匹配时拒绝');
// slug 定位 + link 精确比对兜底
ok(src.includes('posts?slug='), 'fetch 按 slug 定位文章');
ok(src.includes('posts?search='), 'fetch slug 无结果时回退搜索');
ok(src.includes('p.link'), 'fetch 搜索兜底精确比对 link');
// context=edit 取 raw 字段
ok(src.includes('context=edit'), 'fetch 用 context=edit 取 raw 内容');
// termNames 反查术语名称
ok(src.includes('termNames'), 'termNames 反查 tags/categories 名称');
ok(src.includes('include='), 'termNames 用 include 参数反查');
// fetch 输出 postId/site/instructions 字段
ok(src.includes('postId: full.id'), 'fetch 输出 postId');
ok(src.includes('site: siteName'), 'fetch 输出 site 名（字符串，非对象）');
ok(src.includes('instructions'), 'fetch 输出 instructions 字段');
// validateDraft 校验 postId 正整数 + site 字符串
ok(src.includes('postId 必须是正整数'), 'validateDraft 校验 postId 正整数');
ok(src.includes('site 必须是字符串'), 'validateDraft 校验 site 字符串');
// checkDuplicate 加 excludeId 参数（更新时排除自身）
ok(src.includes('excludeId = 0'), 'checkDuplicate 加 excludeId 参数');
ok(src.includes('p.id !== excludeId'), 'checkDuplicate 排除指定 ID');
// 更新路径：draft.postId 存在时走 POST 更新
ok(src.includes('draft.postId !== undefined'), 'publish 检测 postId 判断更新路径');
ok(src.includes('posts/${draft.postId}'), '更新走 posts/{id} 路径');
ok(src.includes("method: 'POST'"), '更新用 POST（非 PUT，兼容性最好）');
// 更新路径站点绑定（多站点安全：draft.site 指定，无则单站点回退，多站点拒绝）
ok(src.includes('多站点环境下更新文章需在草稿中指定 site 字段'), '多站点无 site 绑定时拒绝更新');
ok(src.includes('草稿中指定的站点'), 'draft.site 不匹配时明确报错');
// draft.site 精确绑定创建/更新路径通用（防多站点随机重选发错站）
ok(src.includes('草稿含 site 时精确绑定站点'), 'publish 按 draft.site 精确绑定站点（创建/更新通用）');
// 更新时 categories 用 draft.categories，无值省略
ok(src.includes('draft.categories ? await resolveCategoryIds'), '更新 categories 有值则解析');
ok(src.includes('if (catIds) body.categories = catIds'), '更新无 categories 时省略（保留原分类）');
ok(src.includes('if (tagIds.length) body.tags = tagIds'), '更新无 tags 时省略（保留原标签，不清空）');
// 创建路径 categories 优先用 draft，回退 site
ok(src.includes('draft.categories?.length ? draft.categories : site.categories'), '创建 categories 优先 draft（空数组回退 site）');
// s3 模式 publish 时保留 URL 不上传（避免 s3 图片被误传到媒体库）
ok(/mode === 's3'[\s\S]*?uploadExternalImages/.test(src), 's3 模式仍上传非 S3 域外链图片');
// 更新成功日志含站点名
ok(src.includes('更新成功:'), '更新成功日志文案');
ok(src.includes('[站点:'), '更新日志含站点名');
// 公共函数 processImagesAndTags 消除重复
ok(src.includes('processImagesAndTags'), 'processImagesAndTags 公共函数已提取');
// validateDraft postId/site 校验单测
{
  const vdSrc = src.match(/const validateDraft = d => \{[\s\S]*?return \{ valid: e\.length === 0, errors: e \}; \}/);
  if (!vdSrc) error('validateDraft 函数提取失败（10b）');
  else {
    const vd = eval('(function() { ' + vdSrc[0] + '; return validateDraft; })()');
    ok(vd({ title: 't', content: 'c', excerpt: 'e', postId: 123, site: 'myblog' }).valid === true, 'validateDraft 合法 postId+site 通过');
    ok(vd({ title: 't', content: 'c', excerpt: 'e', postId: -1 }).valid === false, 'validateDraft 负 postId 拒绝');
    ok(vd({ title: 't', content: 'c', excerpt: 'e', postId: 1.5 }).valid === false, 'validateDraft 非整数 postId 拒绝');
    ok(vd({ title: 't', content: 'c', excerpt: 'e', postId: 'abc' }).valid === false, 'validateDraft 字符串 postId 拒绝');
    ok(vd({ title: 't', content: 'c', excerpt: 'e', site: 42 }).valid === false, 'validateDraft 非字符串 site 拒绝');
  }
}
// findSiteByOrigin 单测（纯函数，eval 提取；需注入 siteOriginOf 依赖）
// 注：未匹配时 die() 调用 process.exit，无法在进程内 try/catch，故未匹配路径仅做源码断言
{
  const fnSrc = src.match(/function findSiteByOrigin\(sites, origin\)[\s\S]*?\n}/);
  if (!fnSrc) error('findSiteByOrigin 函数提取失败');
  else {
    const siteOriginOf = url => (String(url).match(/^https?:\/\/[^/]+/i) || [''])[0];
    const findSiteByOrigin = eval('(function() { var siteOriginOf = arguments[0]; ' + fnSrc[0] + '; return findSiteByOrigin; })')(siteOriginOf);
    const sites = { a: { url: 'https://a.com/wp-json/wp/v2' }, b: { url: 'https://b.com/wp-json/wp/v2' } };
    ok(findSiteByOrigin(sites, 'https://a.com')[0] === 'a', 'findSiteByOrigin 命中 a');
    ok(findSiteByOrigin(sites, 'https://b.com')[0] === 'b', 'findSiteByOrigin 命中 b');
  }
}
// findSiteByOrigin 多匹配时拒绝（未匹配路径已在上方断言，因 die 会退出进程）
ok(src.includes('多个站点配置了同一域名'), 'findSiteByOrigin 多匹配时拒绝');

// ── 11. 安装逻辑（doInstall 仅做 AI CLI 检测 + 命令文件创建，无任何初始化）──
console.log('\n## 11. 安装逻辑');
ok(src.includes('async function doInstall'), 'wpb.mjs 包含 doInstall 安装函数');
ok(src.includes('checkCLI'), '安装逻辑包含 CLI 检测');
ok(src.includes('detectedTools'), '安装逻辑包含工具跟踪');
ok(src.includes('npm update -g'), '安装逻辑包含 npm 全局安装升级提示');
ok(src.includes('未找到配置文件'), '无配置时报错提示手动创建');
ok(src.includes('setting-reference.toml'), '报错提示参考 setting-reference.toml');
ok(src.includes('命令文件无变化，跳过'), 'createCommandFile 内容相同时跳过写入');
ok(/createCommandFile[\s\S]*?readFileSync[\s\S]*?===\s*content/.test(src), 'createCommandFile 比较新旧内容后再写入');
ok(src.includes('function findWpDir'), 'findWpDir 向上查找 .wpb 目录函数已提取');
ok(/findWpDir[\s\S]*?setting\.toml/.test(src), 'findWpDir 检测 setting.toml 存在');
ok(src.includes('WP_DIR = findWpDir()'), 'WP_DIR 由 findWpDir 动态定位');
ok(!/mkdirSync/.test(/function findWpDir[\s\S]*?\n\}/.exec(src)?.[0] || ''), 'findWpDir 不自动创建目录');
// parseSelection 返回 0-based 索引（用户输入 1-based 编号），避免 detectedTools[idx] 越界
ok(src.includes('function parseSelection'), 'wpb.mjs 包含 parseSelection 选择解析函数');
ok(/parseSelection[\s\S]*?\.map\(i\s*=>\s*i\s*-\s*1\)/.test(src), "parseSelection 将 1-based 编号转换为 0-based 索引");
// parseSelection 功能单测（纯函数，eval 提取）
{
  const psSrc = src.match(/function parseSelection\(answer, total\)[\s\S]*?\n\}/);
  if (!psSrc) error('parseSelection 函数提取失败');
  else {
    const ps = eval('(function() { ' + psSrc[0] + '; return parseSelection; })()');
    ok(JSON.stringify(ps('1', 3)) === '[0]', "parseSelection('1',3) → [0]");
    ok(JSON.stringify(ps('1,3', 3)) === '[0,2]', "parseSelection('1,3',3) → [0,2]");
    ok(JSON.stringify(ps('all', 3)) === '[0,1,2]', "parseSelection('all',3) → [0,1,2]");
    ok(JSON.stringify(ps('4', 3)) === '[]', "parseSelection('4',3) → [] (越界过滤)");
    ok(JSON.stringify(ps('', 3)) === '[]', "parseSelection('',3) → [] (空输入)");
    ok(JSON.stringify(ps('2,abc', 3)) === '[1]', "parseSelection('2,abc',3) → [1] (非数字过滤)");
  }
}

// ── 12. 文档 ──
console.log('\n## 12. 文档');
ok(existsSync(join(SCRIPT_DIR, '../../../AGENTS.md')), 'AGENTS.md 存在');

// ── 13. 数据文件 ──
console.log('\n## 13. 数据文件');
ok(existsSync(join(SCRIPT_DIR, '../references/data', 'keywords.csv')), 'keywords.csv 存在');
ok(existsSync(join(SCRIPT_DIR, '../references/data', 'products.csv')), 'products.csv 存在');
ok(existsSync(join(SCRIPT_DIR, '../references/data', 'prompts.md')), 'prompts.md 存在');
ok(existsSync(join(SCRIPT_DIR, '../references/data', 'extensions', 'wiedza.md')), 'wiedza.md 存在');
// setting-reference.toml 含 fetch/更新工作流说明
ok(existsSync(join(SCRIPT_DIR, '../references/setting-reference.toml')), 'setting-reference.toml 存在');
ok(refToml.includes('wpb fetch'), 'setting-reference.toml 含 fetch 命令说明');
ok(refToml.includes('postId'), 'setting-reference.toml 含 postId 更新字段说明');

// ── 13.1 CSV/TXT/XLSX 解析单元测试 ──
console.log('\n## 13.1 CSV/TXT/XLSX 解析测试 (SheetJS)');
import * as XLSX from 'xlsx';
const _td = mkdtempSync(join(tmpdir(), 'wpb-csv-test-'));

// SheetJS 通用解析函数
function parseWithSheetJS(buf, type = 'buffer') {
  const wb = XLSX.read(buf, { type });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
  return rows.slice(1).filter(r => Array.isArray(r) && r.some(v => String(v).trim() !== ''));
}

// CSV: 基本逗号分隔
writeFileSync(join(_td, 'a.csv'), 'keyword\nfoo\nbar\nbaz\n', 'utf-8');
const _a = parseWithSheetJS(readFileSync(join(_td, 'a.csv')));
ok(_a.length === 3, 'CSV 基本解析 3 行');
ok(_a[0][0] === 'foo', 'CSV 首行首列为 foo');

// CSV: 引号包裹含逗号
writeFileSync(join(_td, 'b.csv'), 'name,desc\n"a,b","hello"\n', 'utf-8');
const _b = parseWithSheetJS(readFileSync(join(_td, 'b.csv')));
ok(_b.length === 1, 'CSV 引号含逗号 1 行');
ok(_b[0][0] === 'a,b', 'CSV 引号内逗号保留');

// CSV: 引号转义 ""
writeFileSync(join(_td, 'c.csv'), 'name\n"say ""hi"""\n', 'utf-8');
const _c = parseWithSheetJS(readFileSync(join(_td, 'c.csv')));
ok(_c[0][0] === 'say "hi"', 'CSV 双引号转义正确');

// CSV: UTF-8 BOM
writeFileSync(join(_td, 'd.csv'), '\uFEFFkeyword\n中文\n', 'utf-8');
const _d = parseWithSheetJS(readFileSync(join(_td, 'd.csv')));
ok(_d[0][0] === '中文', 'CSV BOM 去除后中文正确');

// CSV: 空行过滤
writeFileSync(join(_td, 'e.csv'), 'keyword\nfoo\n\n\nbar\n', 'utf-8');
const _e = parseWithSheetJS(readFileSync(join(_td, 'e.csv')));
ok(_e.length === 2, 'CSV 空行过滤为 2 行');

// TXT: 制表符分隔
writeFileSync(join(_td, 'f.txt'), 'name\tdesc\nfoo\tbar\nbaz\tqux\n', 'utf-8');
const _f = parseWithSheetJS(readFileSync(join(_td, 'f.txt')));
ok(_f.length === 2, 'TXT 制表符 2 行');
ok(_f[0][1] === 'bar', 'TXT 制表符第二列正确');

// TXT: 整行单列
writeFileSync(join(_td, 'g.txt'), 'keyword\nhello\nworld\n', 'utf-8');
const _g = parseWithSheetJS(readFileSync(join(_td, 'g.txt')));
ok(_g.length === 2, 'TXT 单列 2 行');
ok(_g[0][0] === 'hello', 'TXT 单列首行正确');

// TXT: 分号分隔
writeFileSync(join(_td, 'h.txt'), 'a;b\n1;2\n3;4\n', 'utf-8');
const _h = parseWithSheetJS(readFileSync(join(_td, 'h.txt')));
ok(_h.length === 2 && _h[0][0] === '1' && _h[0][1] === '2', 'TXT 分号分隔正确');

// XLSX: 真实 xlsx 文件读取
console.log('\n  XLSX 读取测试');
const testData = [['keyword'], ['测试1'], ['测试2'], ['测试3']];
const ws = XLSX.utils.aoa_to_sheet(testData);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
const xlsxBuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
writeFileSync(join(_td, 'test.xlsx'), xlsxBuf);
const _x = parseWithSheetJS(xlsxBuf);
ok(_x.length === 3, 'XLSX 读取 3 行数据');
ok(_x[0][0] === '测试1', 'XLSX 首行正确');

// URL 格式识别测试（正则检查）
ok(/^https?:\/\//i.test('https://docs.google.com/spreadsheets/d/abc/export?format=csv'), 'Google Sheets CSV URL 识别');
ok(/^https?:\/\//i.test('http://example.com/data.csv'), 'HTTP CSV URL 识别');
ok(!/^https?:\/\//i.test('data/keywords.csv'), '本地相对路径不识别为 URL');
ok(!/^https?:\/\//i.test('/home/user/data.xlsx'), '绝对路径不识别为 URL');

// ── 14. 错误处理 ──
console.log('\n## 14. 错误处理');
const cfgPath = join(WP_DIR, 'setting.toml');
const cfgBackup = readFileSync(cfgPath, 'utf-8');

// 空配置测试（每个子测试独立 try/finally 恢复配置）
try {
  writeFileSync(cfgPath, '');
  const noCfg = run('wpb.mjs', ['pick']);
  ok(noCfg.status !== 0, '空配置退出码非零');
} finally {
  writeFileSync(cfgPath, cfgBackup, 'utf-8');
}

// 未知命令（需要配置正常）
const badCmd = run('wpb.mjs', ['unknown']);
ok(badCmd.status !== 0, '未知命令退出码非零');
// 不管输出在哪，都检查
const badOut = badCmd.stderr + badCmd.stdout;
ok(badOut.includes('用法'), '未知命令显示用法');

// 配置中无站点
try {
  writeFileSync(cfgPath, '# just a comment\n', 'utf-8');
  const noSites = run('wpb.mjs', ['pick']);
  ok(noSites.status !== 0, '无站点退出码非零');
  ok(noSites.stderr.includes('未配置'), '无站点错误信息');
} finally {
  writeFileSync(cfgPath, cfgBackup, 'utf-8');
}

// 站点缺少必填字段（url/user/pass）
try {
  writeFileSync(cfgPath, '[site.nofield]\nname = "test"\nkeywords = ["data/keywords.csv"]\n', 'utf-8');
  const noField = run('wpb.mjs', ['pick']);
  ok(noField.status !== 0, '缺少必填字段退出码非零');
  const noFieldOut = noField.stderr + noField.stdout;
  ok(noFieldOut.includes('缺少必填字段'), '缺少必填字段错误提示');
} finally {
  writeFileSync(cfgPath, cfgBackup, 'utf-8');
}

// validateSite 在 WP_PASSWORD 环境变量设置时允许 pass 字段为空
try {
  writeFileSync(cfgPath, '[site.nopass]\nname = "test"\nurl = "https://example.com/wp-json/wp/v2"\nuser = "admin"\ncategories = [1]\nkeywords = ["data/keywords.csv"]\n', 'utf-8');
  const oldEnv = process.env.WP_PASSWORD;
  process.env.WP_PASSWORD = 'test-pass';
  const noPass = run('wpb.mjs', ['pick'], { env: { ...process.env, WP_PASSWORD: 'test-pass' } });
  // 不会因缺 pass 而退出（可能因网络错误退出，但不应该是 validateSite 报错）
  const noPassOut = noPass.stderr + noPass.stdout;
  ok(!noPassOut.includes('缺少必填字段: pass'), 'WP_PASSWORD 环境变量设置时允许 pass 为空');
  ok(noPassOut.includes('WP_PASSWORD 环境变量') || !noPassOut.includes('缺少必填字段'), 'WP_PASSWORD 设置时不报 pass 缺失');
  if (oldEnv === undefined) delete process.env.WP_PASSWORD; else process.env.WP_PASSWORD = oldEnv;
} finally {
  writeFileSync(cfgPath, cfgBackup, 'utf-8');
}

// 草稿 JSON 格式错误
try {
  const badDraftPath = join(WP_DIR, 'bad_draft.json');
  writeFileSync(badDraftPath, '{invalid json!!!', 'utf-8');
  const badDraft = run('wpb.mjs', ['publish', badDraftPath]);
  ok(badDraft.status !== 0, 'JSON 格式错误退出码非零');
  const badDraftOut = badDraft.stderr + badDraft.stdout;
  ok(badDraftOut.includes('JSON 解析失败'), 'JSON 格式错误提示清晰');
  unlinkSync(badDraftPath);
} finally {
  writeFileSync(cfgPath, cfgBackup, 'utf-8');
}

// readTable 对 xlsx 成功解析
console.log('\n  XLSX 成功解析测试');
const xlsxData2 = [['keyword'], ['测试关键词1'], ['测试关键词2']];
const ws2 = XLSX.utils.aoa_to_sheet(xlsxData2);
const wb2 = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb2, ws2, 'Sheet1');
const xlsxBuf2 = XLSX.write(wb2, { type: 'buffer', bookType: 'xlsx' });
writeFileSync(join(_td, 'real.xlsx'), xlsxBuf2);

const xlsxCfg = `site.x.url = "https://x.com"\nsite.x.user = "u"\nsite.x.pass = "p p p p p p p p"\nsite.x.categories = [1]\nsite.x.keywords = ["${join(_td, 'real.xlsx').replace(/\\/g, '/')}"]\nsite.x.products = ""\nsite.x.prompts = ""`;
writeFileSync(cfgPath, xlsxCfg, 'utf-8');
const xlsxRes = run('wpb.mjs', ['pick']);
ok(xlsxRes.status === 0, 'readTable 对 xlsx 退出码为 0');
const xlsxOut = xlsxRes.stderr + xlsxRes.stdout;
  ok(xlsxOut.includes('测试关键词'), 'xlsx 成功解析并返回关键词');
  writeFileSync(cfgPath, cfgBackup, 'utf-8');

// readTable 多 sheet xlsx：跳过日期 sheet，选关键词 sheet（GSC 导出格式）
console.log('\n  XLSX 多 sheet 智能选择测试（GSC 导出格式）');
const chartRows = [['日期', '点击次数', '展示', '点击率', '排名']];
for (let d = 1; d <= 10; d++) chartRows.push([`2025-10-${String(d).padStart(2, '0')}`, '1', '2', '50%', '5']);
const queryRows = [['热门查询', '点击次数', '展示', '点击率', '排名'], ['fizzy candy e papieros', '1', '0', '0%', '12'], ['buchmistrz', '958', '1181', '81%', '1']];
const wbGsc = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wbGsc, XLSX.utils.aoa_to_sheet(chartRows), '图表');
XLSX.utils.book_append_sheet(wbGsc, XLSX.utils.aoa_to_sheet(queryRows), '查询数');
const gscBuf = XLSX.write(wbGsc, { type: 'buffer', bookType: 'xlsx' });
writeFileSync(join(_td, 'gsc.xlsx'), gscBuf);
const gscCfg = `site.x.url = "https://x.com"\nsite.x.user = "u"\nsite.x.pass = "p p p p p p p p"\nsite.x.categories = [1]\nsite.x.keywords = ["${join(_td, 'gsc.xlsx').replace(/\\/g, '/')}"]\nsite.x.products = ""\nsite.x.prompts = ""`;
writeFileSync(cfgPath, gscCfg, 'utf-8');
const gscRes = run('wpb.mjs', ['pick']);
ok(gscRes.status === 0, 'GSC xlsx pick 退出码为 0');
const gscOut = gscRes.stderr + gscRes.stdout;
ok(!gscOut.includes('2025-10'), 'GSC xlsx 不返回日期作为关键词');
ok(gscOut.includes('fizzy') || gscOut.includes('buchmistrz'), 'GSC xlsx 返回查询数 sheet 中的关键词');
writeFileSync(cfgPath, cfgBackup, 'utf-8');

// ── 15. 无配置报错真实测试（不自动创建 .wpb / setting.toml / prompts.md）──
console.log('\n## 15. 无配置报错真实测试');
const _initCfgPath = join(WP_DIR, 'setting.toml');
const _initCfgBackup = join(tmpdir(), `wpb-init-cfg-backup-${Date.now()}.toml`);

try {
  // 测试1：空目录运行 pick → 报错且不自动创建 .wpb
  const _emptyProject = mkdtempSync(join(tmpdir(), 'wpb-empty-'));
  const _emptyRun = run('wpb.mjs', ['pick'], { cwd: _emptyProject });
  ok(_emptyRun.status !== 0, '无配置时退出码非零');
  ok((_emptyRun.stderr + _emptyRun.stdout).includes('未找到配置文件'), '无配置时报错提示');
  ok((_emptyRun.stderr + _emptyRun.stdout).includes('setting-reference.toml'), '报错提示参考模板');
  ok(!existsSync(join(_emptyProject, '.wpb')), '未自动创建 .wpb 目录');
  try { rmSync(_emptyProject, { recursive: true, force: true }); } catch {}
} catch (_) {}

try {
  // 测试2：setting.toml 已存在且含用户内容 → pick 正常执行且不修改配置
  const _userCfg = '[site.userblog]\nname = "User Blog"\nurl = "https://user.example.com/wp-json/wp/v2"\nuser = "admin"\npass = "xxxx xxxx xxxx xxxx"\ncategories = [1]\nkeywords = ["data/keywords.csv"]\n';
  writeFileSync(_initCfgPath, _userCfg, 'utf-8');
  const _initRun2 = run('wpb.mjs', ['pick']);
  ok(_initRun2.status === 0, 'setting.toml 已存在时 pick 可正常执行');
  const _currentCfg = readFileSync(_initCfgPath, 'utf-8');
  ok(_currentCfg.includes('User Blog'), '用户配置保持不变（含 User Blog）');
  // 恢复原始配置
  writeFileSync(_initCfgPath, cfgBackup, 'utf-8');
} catch (_) {
  if (existsSync(_initCfgBackup)) copyFileSync(_initCfgBackup, _initCfgPath);
}

// ── 16. AGENTS.md 验证 ──
console.log('\n## 16. AGENTS.md 验证');
const rootAgents = readFileSync(join(SCRIPT_DIR, '../../../AGENTS.md'), 'utf-8');
ok(rootAgents.includes('用途'), '根目录 AGENTS.md 包含 用途');
ok(rootAgents.includes('关键文件'), '根目录 AGENTS.md 包含 关键文件');
ok(rootAgents.includes('给 AI 代理的指引'), '根目录 AGENTS.md 包含 给 AI 代理的指引');
ok(rootAgents.includes('在此目录工作'), '根目录 AGENTS.md 包含 在此目录工作');
ok(rootAgents.includes('测试要求'), '根目录 AGENTS.md 包含 测试要求');
ok(rootAgents.includes('常用模式'), '根目录 AGENTS.md 包含 常用模式');
ok(rootAgents.includes('依赖关系'), '根目录 AGENTS.md 包含 依赖关系');

// ── 汇总 ──
console.log(`${"=".repeat(36)}`);
console.log(`${pass}/${pass+fail} 通过`);
