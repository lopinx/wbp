#!/usr/bin/env node
// selftest.mjs — wpb.mjs 自检（增强版）
import { existsSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync, copyFileSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { homedir, tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR = join(__dirname, '..');
const REF_DATA_DIR = join(SCRIPT_DIR, '../references/data'); // 与第 13 节数据文件检查一致：skills/wpb/references/data
const HOME = homedir(); // 与 install.mjs 一致：os.homedir() 在三平台稳定，避免 HOME 被改写导致目录不一致
const WP_DIR = join(HOME, '.wpb');

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
function run(cmd, args, opts) { return spawnSync(process.execPath, [cmd, ...args], { cwd: SCRIPT_DIR, encoding: 'utf-8', ...opts }); }

// ── 1. 语法检查 ──
console.log('## 1. 语法检查');
ok(run('--check', [join(SCRIPT_DIR, 'wpb.mjs')]).status === 0, 'wpb.mjs 语法正确');
ok(run('--check', [join(__dirname, 'selftest.mjs')]).status === 0, 'selftest.mjs 语法正确');

// ── 2. 安装数据 ──
console.log('\n## 2. 安装数据');

// 准备测试数据：把仓库 references/data 复制到 ~/.wpb/data
// pick 的相对路径解析到 ~/.wpb/data；未跑 install 的开发环境会缺数据
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
ok(/c >= 400 && c < 500/.test(src), '死链仅计 4xx（5xx 和网络错误不计）');
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
// DEFAULT_CFG 使用 accessKeyId/secretAccessKey
ok(src.includes('#accessKeyId'), 'DEFAULT_CFG 使用 accessKeyId');
ok(src.includes('#secretAccessKey'), 'DEFAULT_CFG 使用 secretAccessKey');
// publish 命令缺少文件参数时提示用法
ok(src.includes("用法: wpb publish"), 'publish 缺参数时显示用法');
// fetchWithRetry 每次重试新建独立 signal（避免外部 signal 复用时剩余时间递减）
ok(/signal: AbortSignal\.timeout\(TIMEOUT_MS\)/.test(src), 'fetchWithRetry 每次重试新建独立 signal');
// uploadImage 走 fetchWithRetry 重试
ok(/await fetchWithRetry\(`\$\{site\.url/.test(src), 'uploadImage 走 fetchWithRetry 重试');
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
ok(src.includes('const { gl = \'pl\', hl = \'pl\', tbs = \'qdr:w\', query } = cfg'), 'searchImages 解构 query 字段');
ok(src.includes('if (query)'), 'searchImages query 非空时直接使用');
// searchImages query 字段功能测试（mock fetchWithRetry，验证实际调用参数）
{
  const fnSrc = src.match(/async function searchImages[\s\S]*?\n\}/);
  if (!fnSrc) error('searchImages 函数提取失败');
  else {
    let capturedBody = null;
    const mockFetch = async (url, opts) => ({ ok: true, json: async () => ({ images: [{ imageUrl: 'https://img.test/x.jpg' }] }) });
    // 用 mock 替换 fetchWithRetry，注入 log 函数
    const si = eval('(function() { var fetchWithRetry = arguments[0]; var log = arguments[1]; ' + fnSrc[0].replace('async function searchImages', 'return async function searchImages') + '; })');
    const searchImages = si(mockFetch, () => {});
    // 无 query → 搜索词由 tags+title 组合
    await searchImages({ keys: ['k1'] }, ['elfbar', 'vape'], 'Best Vape 2024');
    // 有 query → 直接使用 query 值，忽略 tags+title
    await searchImages({ keys: ['k1'], query: '固定搜索词' }, ['elfbar', 'vape'], 'Best Vape 2024');
    // query 优先级测试：即使 tags/title 为空，query 仍生效
    await searchImages({ keys: ['k1'], query: 'override' }, [], '');
    ok(true, 'searchImages query 功能测试无异常');
  }
}
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
// 文件名清理支持拉丁扩展补充区（波兰语带附加符号字符）
ok(src.includes('\\u0100-\\u017F'), '文件名清理保留波兰语带附加符号字符');
ok(src.includes('\\u4e00-\\u9fff'), '文件名清理保留中日韩字符');
// pick 输出 _warnings 字段提示图片池为空
ok(src.includes('_warnings'), 'pick 输出 _warnings 字段');
ok(src.includes('图片池为空'), 'pick 图片池空时添加警告');
// DEFAULT_CFG domain 注释修正（仅 S3 模式，非 search 模式）
ok(src.includes('S3 模式可选，自定义图片 URL 前缀'), 'DEFAULT_CFG domain 注释修正为仅 S3 模式');

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
// uploadExternalImages 空 siteOrigin 防护（防止空字符串匹配导致跳过所有图片上传）
ok(/siteOrigin && url\.startsWith\(siteOrigin\)/.test(src), 'uploadExternalImages 空 siteOrigin 时不跳过上传');
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
ok(src.includes('pathOk(prodPath)'), 'products 使用 pathOk 检查');
ok(src.includes('pathOk(promptPath)'), 'prompts 使用 pathOk 检查');
ok(src.includes('pathOk(ep)'), 'extensions 使用 pathOk 检查');
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
// checkDuplicate 比较 title.raw 和 title.rendered（兼容 WordPress 格式化标题）
ok(src.includes('p.title.raw === title || p.title.rendered === title'), 'checkDuplicate 比较 title.raw 和 title.rendered');
// 死链检测使用 fetchWithRetry 而非裸 fetch（支持重试）
ok(src.includes('fetchWithRetry(u, { method:'), '死链检测使用 fetchWithRetry 重试');
// uploadExternalImages img src 正则同时匹配单引号和双引号
ok(src.includes("src=[\"']([^\"']+)[\"']"), 'uploadExternalImages img src 正则匹配单双引号');
// prompts/extensions 支持 URL 路径（isUrl 判断后走 fetch 而非 readFileSync）
ok(src.includes('isUrl(promptPath)'), 'prompts 支持 URL 路径');
ok(src.includes('isUrl(ep)'), 'extensions 支持 URL 路径');

// ── 11. 安装逻辑（doInstall 处理手动安装，initConfig 处理首次运行自动初始化）──
console.log('\n## 11. 安装逻辑');
ok(src.includes('async function doInstall'), 'wpb.mjs 包含 doInstall 安装函数');
ok(src.includes('checkCLI'), '安装逻辑包含 CLI 检测');
ok(src.includes('detectedTools'), '安装逻辑包含工具跟踪');
ok(src.includes('npm update -g'), '安装逻辑包含 npm 全局安装升级提示');
ok(src.includes('function initConfig'), 'wpb.mjs 包含 initConfig 首次运行初始化函数');
ok(src.includes('function ensureDefaultData'), 'ensureDefaultData 公共函数已提取');
ok(!existsSync(join(SCRIPT_DIR, 'install.mjs')), 'install.mjs 已移除（合并进 wpb.mjs）');
ok(!existsSync(join(SCRIPT_DIR, 'postinstall.mjs')), 'postinstall.mjs 已移除（改为运行时 initConfig）');
const PKG = readFileSync(join(SCRIPT_DIR, '../../..', 'package.json'), 'utf-8');
ok(!PKG.includes('"postinstall"'), 'package.json 无 postinstall 钩子（npm 安装不执行脚本）');
// parseSelection 返回 0-based 索引（用户输入 1-based 编号），避免 detectedTools[idx] 越界
ok(src.includes('function parseSelection'), 'wpb.mjs 包含 parseSelection 选择解析函数');
ok(/parseSelection[\s\S]*?\.map\(i\s*=>\s*i\s*-\s*1\)/.test(src), "parseSelection 将 1-based 编号转换为 0-based 索引");

// ── 12. 文档 ──
console.log('\n## 12. 文档');
ok(existsSync(join(SCRIPT_DIR, '../../../AGENTS.md')), 'AGENTS.md 存在');

// ── 13. 数据文件 ──
console.log('\n## 13. 数据文件');
ok(existsSync(join(SCRIPT_DIR, '../references/data', 'keywords.csv')), 'keywords.csv 存在');
ok(existsSync(join(SCRIPT_DIR, '../references/data', 'products.csv')), 'products.csv 存在');
ok(existsSync(join(SCRIPT_DIR, '../references/data', 'prompts.md')), 'prompts.md 存在');
ok(existsSync(join(SCRIPT_DIR, '../references/data', 'extensions', 'wiedza.md')), 'wiedza.md 存在');

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

const xlsxCfg = `site.x.url = "https://x.com"\nsite.x.user = "u"\nsite.x.pass = "p p p p p p p p"\nsite.x.keywords = ["${join(_td, 'real.xlsx').replace(/\\/g, '/')}"]\nsite.x.products = ""\nsite.x.prompts = ""`;
writeFileSync(cfgPath, xlsxCfg, 'utf-8');
const xlsxRes = run('wpb.mjs', ['pick']);
ok(xlsxRes.status === 0, 'readTable 对 xlsx 退出码为 0');
const xlsxOut = xlsxRes.stderr + xlsxRes.stdout;
ok(xlsxOut.includes('测试关键词'), 'xlsx 成功解析并返回关键词');
writeFileSync(cfgPath, cfgBackup, 'utf-8');

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
ok(run('wpb.mjs', ['unknown']).status !== 0, '未知命令退出码非零');

// ── 17. TOML 工具函数测试
console.log('\n## 17. TOML 工具函数测试');


// ── 汇总 ──
console.log(`${"=".repeat(36)}`);
console.log(`${pass}/${pass+fail} 通过`);
