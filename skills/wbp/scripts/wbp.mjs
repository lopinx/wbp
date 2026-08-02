#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createHash, createHmac } from 'crypto';

const TIMEOUT_MS = 30000, WP_DIR = join(homedir(), '.wbp'), CFG = join(WP_DIR, 'setting.toml'), DRAFT = join(WP_DIR, '_draft.json');

const PARA_RE = /<p[^>]*>[\s\S]*?<\/p>/g;
const asArray = x => Array.isArray(x) ? x : [x];

async function resolveCategoryIds(site, cats) {
  if (!cats) return [];
  if (!Array.isArray(cats)) cats = [cats];
  if (!cats.length) return [];
  const ids = [];
  for (const c of cats) {
    if (typeof c === 'string' && c.trim() === '') continue;
    const s = String(c).trim();
    if (/^\d+$/.test(s) && Number(s) > 0) { ids.push(Number(s)); continue; }
    ids.push(await findOrCreate(site, 'categories', s, categoryCache));
  }
  return ids;
}

// ── 迷你 TOML 解析器 ──
function parseToml(t) {
  const r = {}; let path = [];
  for (const l of t.split('\n')) {
    const v = l.trim();
    if (!v || v.startsWith('#')) continue;
    const m = v.match(/^\[([^\]]+)\]$/);
    if (m) { path = m[1].split('.'); continue; }
    const kv = v.match(/^(\w+)\s*=\s*(.+)$/);
    if (!kv) continue;
    let val = kv[2].trim();
    let inStr = false, strQuote = '', escaped = false;
    for (let i = 0; i < val.length; i++) {
      const c = val[i];
      if (escaped) { escaped = false; continue; }
      if (c === '\\') { escaped = true; continue; }
      if ((c === '"' || c === "'") && !inStr) { inStr = true; strQuote = c; }
      else if (c === strQuote && inStr) { inStr = false; strQuote = ''; }
      if (c === '#' && !inStr) { val = val.slice(0, i).trimEnd(); break; }
    }
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    else if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    else if (val.startsWith('[') && val.endsWith(']')) {
      const arrStr = val.slice(1, -1).trim();
      if (arrStr) {
        const arr = []; let current = '', inQuote = false, q = '';
        for (let i = 0; i < arrStr.length; i++) {
          const c = arrStr[i];
          if (c === '"' || c === "'") { if (!inQuote) { inQuote = true; q = c; } else if (c === q) { inQuote = false; q = ''; } current += c; }
          else if (c === ',' && !inQuote) { arr.push(current.trim().replace(/^["']|["']$/g, '')); current = ''; }
          else { current += c; }
        }
        if (current.trim()) arr.push(current.trim().replace(/^["']|["']$/g, ''));
        val = arr;
      } else { val = []; }
    }
    else if (val === 'true') val = true;
    else if (val === 'false') val = false;
    else if (/^-?\d+$/.test(val)) val = Number(val);
    let o = r;
    for (const p of path) o = o[p] = o[p] || {};
    o[kv[1]] = val;
  }
  return r;
}

// ── Excel 读取器 ──
let XLSX;
async function loadXLSX() { if (!XLSX) { const m = await import('xlsx'); XLSX = m.default || m; } return XLSX; }
async function readExcel(p) {
  if (!existsSync(p)) throw new Error(`文件未找到: ${p}`);
  const x = await loadXLSX(), wb = x.readFile(p), ws = wb.Sheets[wb.SheetNames[0]];
  return x.utils.sheet_to_json(ws);
}

// ── 图片搜索（Serper.dev / 兼容 API）──
async function searchImages(cfg, tags, title) {
  const keys = cfg.keys || (cfg.key ? [cfg.key] : []);
  if (!keys.length) { console.warn('  ⚠ 未配置 images.keys'); return []; }
  const key = keys[Math.floor(Math.random() * keys.length)];
  const { gl = 'pl', hl = 'pl', tbs = 'qdr:w' } = cfg;
  const keep = (tags || []).filter(t => t.length > 2 && !/^\d+\s*(in|pack|pcs|set|pairs?|stk|ctn|box|bag|roll|sheets?|ml|g|kg|cm|mm|inch)/i.test(t));
  const q = [...keep, title].filter(Boolean).join(' ');
  const truncated = Array.from(q).slice(0, 100).join('');
  const res = await fetchWithRetry('https://google.serper.dev/images', {
    method: 'POST',
    headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: truncated, gl, hl, tbs })
  });
  if (!res.ok) { console.warn(`  图片搜索失败: ${res.status}`); return []; }
  let data;
  try { data = await res.json(); } catch { console.warn('  图片搜索响应解析失败'); return []; }
  if (!data.images || !data.images.length) { console.warn('  图片搜索返回空结果，可能 API 响应格式已变更'); return []; }
  return data.images.map(i => i.imageUrl).filter(u => u && /^https?:\/\//.test(u));
}

// ── S3 SigV4 + 重试 ──
async function fetchWithRetry(url, opts, retries = 3) {
  const timeout = opts?.signal ? undefined : TIMEOUT_MS;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { ...opts, signal: timeout ? AbortSignal.timeout(timeout) : opts.signal });
      if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) return res;
      if (i >= retries) return res;
      const d = 1000 * Math.pow(2, i) + Math.random() * 200;
      console.warn(`  请求失败 (${res.status})，${Math.round(d)}ms 后重试...`);
      await new Promise(r => setTimeout(r, d));
    } catch (e) {
      if (i >= retries) throw e;
      const d = 1000 * Math.pow(2, i) + Math.random() * 200;
      console.warn(`  请求错误: ${e.message}，${Math.round(d)}ms 后重试...`);
      await new Promise(r => setTimeout(r, d));
    }
  }
}

async function s3List(cfg) {
  const { bucket, region, key, secret, prefix = '', endpoint } = cfg;
  const ep = endpoint ? endpoint.replace(/\/+$/, '') : null;
  const host = ep ? new URL(ep).hostname : `${bucket}.s3.${region}.amazonaws.com`;
  const baseUrl = ep || `https://${host}`;
  const sha256 = s => createHash('sha256').update(s).digest('hex');
  const hmac = (k, s) => createHmac('sha256', k).update(s).digest();
  const sigKey = (k, d, r, sv) => ['AWS4', k, d, r, sv, 'aws4_request'].reduce((k, s) => hmac(k, s), Buffer.from('AWS4' + k));
  const uriEncode = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const d = new Date(), amz = d.toISOString().replace(/[:-]|\.\d{3}/g, ''), ds = amz.slice(0, 8), ph = sha256('');
  let images = [], token = '';
  do {
    const q = `list-type=2${prefix ? '&prefix=' + uriEncode(prefix) : ''}${token ? '&continuation-token=' + encodeURIComponent(token) : ''}`;
    const cr = `GET\n/\n${q}\nhost:${host}\nx-amz-content-sha256:${ph}\nx-amz-date:${amz}\n\nhost;x-amz-content-sha256;x-amz-date\n${ph}`;
    const cs = `${ds}/${region}/s3/aws4_request`, sts = `AWS4-HMAC-SHA256\n${amz}\n${cs}\n${sha256(cr)}`;
    const sk = sigKey(secret, ds, region, 's3'), sig = hmac(sk, sts).toString('hex');
    const auth = `AWS4-HMAC-SHA256 Credential=${key}/${cs}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${sig}`;
    const res = await fetchWithRetry(`${baseUrl}/?${q}`, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { host, 'x-amz-content-sha256': ph, 'x-amz-date': amz, authorization: auth } });
    if (!res.ok) { const errText = await res.text().catch(() => ''); throw new Error(`S3 列表获取失败: ${res.status} — ${errText.slice(0, 200)}`); }
    const xml = await res.text();
    const unesc = xml.replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"})[e]);
    images.push(...[...unesc.matchAll(/<Key>([^<]+)<\/Key>/g)].map(m => m[1]));
    const ct = unesc.match(/<IsTruncated>true<\/IsTruncated>/);
    token = ct ? (unesc.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/) || [,''])[1] : '';
  } while (token);
  const imgs = images.filter(k => /\.(jpg|jpeg|png|gif|webp|avif)$/i.test(k));
  const base = cfg.domain ? `https://${cfg.domain}/${prefix}` : ep ? `${ep}/${prefix}` : `https://${bucket}.s3.${region}.amazonaws.com/${prefix}`;
  return imgs.map(k => k.startsWith(prefix) ? base + k.slice(prefix.length) : base + k.replace(/^\/+/, ''));
}

// ── WordPress REST API ──
function wpAuth(site) { return 'Basic ' + Buffer.from(`${site.user}:${site.pass}`).toString('base64'); }
const categoryCache = new Map(), tagCache = new Map();

async function wpFetch(site, path, opts = {}) {
  const url = `${site.url.replace(/\/+$/, '')}/${path.replace(/^\//, '')}`;
  const res = await fetchWithRetry(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'Authorization': wpAuth(site), 'Content-Type': 'application/json', ...opts.headers } });
  if (!res.ok) { const body = await res.text().catch(() => ''); throw new Error(`WP API ${res.status}: ${res.statusText} — ${body.slice(0, 200)}`); }
  return res.json();
}

async function uploadImage(site, imgUrl) {
  const res = await fetch(imgUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`获取 ${imgUrl} 失败: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  let raw; try { raw = decodeURIComponent(imgUrl.split('?')[0].split('/').pop() || 'image.jpg'); } catch { raw = 'image.jpg'; }
  const ext = '.' + ((raw.match(/\.(jpg|jpeg|png|gif|webp|avif)$/i) || [])[1] || 'jpg');
  const name = (raw.replace(/\.(jpg|jpeg|png|gif|webp|avif)$/i, '') || 'image').replace(/[^\w一-鿿.-]/g, '-').slice(0, 60) + ext;
  const boundary = '----' + Math.random().toString(36).slice(2), ctype = res.headers.get('content-type') || 'image/jpeg';
  const r = await fetch(`${site.url.replace(/\/+$/, '')}/media`, {
    method: 'POST', signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'Authorization': wpAuth(site), 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${ctype}\r\n\r\n`), buf, Buffer.from(`\r\n--${boundary}--\r\n`)])
  });
  if (!r.ok) { const txt = await r.text().catch(() => ''); throw new Error(`媒体上传失败: ${r.status} — ${txt.slice(0, 200)}`); }
  const j = await r.json();
  if (!j?.source_url) throw new Error(`媒体上传返回缺少 source_url: ${imgUrl}`);
  return j.source_url;
}

async function uploadExternalImages(site, html) {
  const urls = [...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map(m => m[1]), results = {};
  const siteOrigin = (site.url.match(/https?:\/\/[^/]+/) || [''])[0];
  for (const url of urls) {
    if (url.startsWith(siteOrigin) || results[url]) continue;
    try { console.log(`  正在上传: ${url.slice(0, 60)}...`); results[url] = await uploadImage(site, url); console.log(`  → ${results[url]}`); }
    catch (e) { console.warn(`  ⚠ 上传失败: ${e.message}`); }
  }
  return results;
}

async function findOrCreate(site, type, name, cache) {
  const key = `${site.url}:${name}`;
  if (cache.has(key)) return cache.get(key);
  let items = [], page = 1;
  while (true) {
    const batch = await wpFetch(site, `${type}?per_page=100&page=${page}`);
    items = items.concat(batch); if (batch.length < 100) break; page++;
  }
  let item = items.find(i => i.name === name || i.slug === name);
  if (!item) {
    try {
      item = await wpFetch(site, type, { method: 'POST', body: JSON.stringify({ name, slug: name.toLowerCase().replace(/\s+/g, '-') }) });
    } catch (e) {
      if (e.message?.includes('already exists') || e.message?.includes('term_exists')) {
        const existing = await wpFetch(site, `${type}?search=${encodeURIComponent(name)}`);
        item = existing.find(i => i.name === name || i.slug === name);
        if (!item) throw e;
      } else { throw e; }
    }
  }
  cache.set(key, item.id);
  return item.id;
}

async function checkDuplicate(site, title) {
  const posts = await wpFetch(site, `posts?search=${encodeURIComponent(title.slice(0, 100))}&status=any&per_page=20`);
  return posts.find(p => p.title && p.title.rendered === title) || null;
}

// ── 图片混排 ──
function mixImages(html, images) {
  if (!images.length) return html;
  const imgs = [...images];
  for (let i = imgs.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = imgs[i]; imgs[i] = imgs[j]; imgs[j] = t; }
  const paras = html.match(PARA_RE) || [];
  if (!paras.length) return html;
  const step = Math.max(1, Math.floor(paras.length / (imgs.length + 1)));
  const parts = []; let remaining = html, cursor = 0;
  for (let i = 0; i < paras.length; i++) {
    const idx = remaining.indexOf(paras[i], cursor);
    if (idx === -1) { parts.push(remaining); remaining = ''; break; }
    parts.push(remaining.slice(0, idx + paras[i].length));
    remaining = remaining.slice(idx + paras[i].length);
    cursor = 0;
  }
  if (remaining) parts.push(remaining);
  let imgIdx = 0;
  for (let i = Math.min(step, parts.length - 1); i < parts.length && imgIdx < imgs.length; i += step) {
    parts[i] = `<figure><img src="${imgs[imgIdx++]}" alt="" loading="lazy" style="max-width:100%;height:auto;border-radius:8px;margin:1em 0"></figure>\n${parts[i]}`;
  }
  return parts.join('');
}

// ── 质量检查 ──
async function checkQuality(title, content, excerpt, tags, site) {
  const issues = [], warnings = [];
  const text = (content || excerpt || '').replace(/<[^>]+>/g, '');
  const wordCount = text.split(/[\s]+/).filter(Boolean).length;
  const paras = (content || excerpt || '').match(PARA_RE) || [];
  const h3 = (content || excerpt || '').match(/<h3[^>]*>/g) || [];
  const checks = [
    [wordCount < 600, `词数 ${wordCount} 少于 600`],
    [paras.length < 8, `仅有 ${paras.length} 个段落`],
    [h3.length < 3, `仅有 ${h3.length} 个 H3 标题`],
    [!title || title.length < 10, `标题过短 (${title?.length || 0} 字符)`],
    [!excerpt || excerpt.length < 50, `摘要过短 (${excerpt?.length || 0} 字符)`],
    [!tags || tags.length < 3, `仅有 ${tags?.length || 0} 个标签`],
    [tags && tags.length > 10, `标签过多 (${tags.length} 个)`],
  ];
  for (const [cond, msg] of checks) { if (cond) issues.push(msg); }
  const siteOrigin = (site.url.match(/https?:\/\/[^/]+/) || [''])[0];
  if (siteOrigin) {
    const internalLinks = [...(content || '').matchAll(/href="(https?:\/\/[^"]+)"/g)].map(m => m[1]).filter(u => u && u.startsWith(siteOrigin));
    if (internalLinks.length === 0) warnings.push('没有内部链接');
    // 内链：排除首页与分类/标签聚合页，仅统计指向详情页的链接
    const rootRe = new RegExp('^' + siteOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/?$');
    const navRe = new RegExp('^' + siteOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/(category|tag|tagi|kategoria|produkty|shop|blog)/?([^/]+/)?$');
    const productLinks = internalLinks.filter(u => !rootRe.test(u) && !navRe.test(u));
    if (productLinks.length < 3) warnings.push(`内链不足 (${productLinks.length} 条，建议≥3)`);
  }
  // ponytail: 关键词命中用标签作主关键词近似，文档级无 TF-IDF；升级可读 pick 的真实主关键词
  const kwList = asArray(tags || []).map(t => String(t).toLowerCase()).filter(t => t && t.length > 2);
  if (kwList.length) {
    const lowerText = (text || '').toLowerCase();
    const hit = kwList.filter(k => {
      const re = new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      const m = lowerText.match(re);
      return m && m.length >= 2;
    });
    if (hit.length === 0) warnings.push(`关键词命中不足 (标签在正文出现均少于 2 次)`);
  }
  // E-E-A-T 信号：外部权威外链（语言无关，结构化判断，避免关键词误判）
  const extHref = [...(content || '').matchAll(/href="(https?:\/\/[^"]+)"/g)].map(m => m[1]).filter(u => !siteOrigin || !u.startsWith(siteOrigin));
  if (extHref.length === 0) warnings.push('E-E-A-T 信号不足 (无外部权威外链，建议引用权威来源链接)');
  const links = [...(content || '').matchAll(/href="(https?:\/\/[^"]+)"/g)].map(m => m[1]);
  if (links.length > 0) {
    const codes = await Promise.all(links.slice(0, 3).map(u => fetch(u, { method: 'HEAD', signal: AbortSignal.timeout(5000), redirect: 'follow' }).then(r => r.status).catch(() => 500)));
    const dead = codes.filter(c => c >= 400).length;
    if (dead) issues.push(`失效链接: ${dead} 个`);
  }
  return { issues, warnings };
}

// ── 主函数 ──
async function main() {
  const cmd = process.argv[2] || 'pick';

  if (cmd === 'install') {
    const { default: install } = await import('./install.mjs');
    await install();
    return;
  }

  if (cmd === 'init') {
    writeFileSync(CFG, `# ~/.wbp/setting.toml
[site.myblog]
name = "BuchMistrz"
url = "https://www.buchmistrz.com/wp-json/wp/v2"
user = "admin"
pass = "xxxx xxxx xxxx xxxx"  # WP Application Password
categories = [1, "news", "vape"]  # 支持数字ID或名称，多个分类
keywords = ["data/keywords.xlsx", "data/keywords2.xlsx"]  # 可多个
products = "data/products.xlsx"
prompts = "data/prompts.md"
extensions = ["data/extensions/wiedza.md"]

# 四种图片模式（选其一）：
# 1) S3 兼容 — mode="s3" 拉图池混排，endpoint 可选
# 2) 图片搜索 — mode="search" 通过 Serper.dev 等 API 搜索图片
# 3) CDN — mode="cdn" 远程URL原样保留
# 4) 不配 cdn 节点 → 自动上传到媒体库
#[site.myblog.cdn]
#mode = "s3"
#bucket = "my-bucket"
#region = "us-east-1"
#key = "AKIA..."
#secret = "..."
#prefix = "images/"
# endpoint 可选，不填则自动使用 AWS S3 地址
# 支持：Cloudflare R2 / Amazon S3 / Kodo / MinIO / Ceph / 任意 S3 兼容存储
#endpoint = "https://s3.us-east-1.qiniucs.com"
#domain = "cdn.example.com"
#
# 图片搜索 API（配合 cdn.mode="search" 使用）
#[site.myblog.images]
#keys = ["your-serper-dev-api-key-1", "your-serper-dev-api-key-2"]  # 随机轮询
#gl = "pl"                # 国家代码，默认 pl（波兰）
#hl = "pl"                # 语言代码，默认 pl
#tbs = "qdr:w"            # 时间范围，默认过去一周
#query = ""               # 可选，默认使用文章标题
`, 'utf-8');
    console.log('示例配置文件已创建于', CFG);
    return;
  }

  if (!existsSync(CFG)) { console.error('未找到配置文件。请运行: node wbp.mjs init'); process.exit(1); }
  const cfg = parseToml(readFileSync(CFG, 'utf-8'));
  const sites = cfg.site || {};
  const siteNames = Object.keys(sites);
  if (!siteNames.length) { console.error('未配置任何站点'); process.exit(1); }

  const siteName = siteNames[Math.floor(Math.random() * siteNames.length)], site = sites[siteName];
  site.name = siteName;

  const rp = (p) => p ? (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) ? p : join(WP_DIR, p)) : null;
  const kwPaths = asArray(site.keywords).map(p => rp(p)).filter(Boolean);
  const prodPath = rp(site.products), promptPath = rp(site.prompts), extPaths = (site.extensions || []).map(p => rp(p));

  if (cmd === 'pick') {
    if (!kwPaths.length || !kwPaths.some(existsSync)) { console.error('未找到关键词文件:', kwPaths.join(', ')); process.exit(1); }
    const keywords = (await Promise.all(kwPaths.filter(existsSync).map(readExcel))).flat();
    if (!keywords.length) { console.error('关键词文件为空'); process.exit(1); }
    const kw = keywords[Math.floor(Math.random() * keywords.length)], kwKeys = Object.keys(keywords[0]);
    const keyword = kw[kwKeys[0]] || kw.keyword || kw.name || '';
    let products = [];
    if (prodPath && existsSync(prodPath)) products = await readExcel(prodPath);
    let promptDoc = '';
    if (promptPath && existsSync(promptPath)) promptDoc = readFileSync(promptPath, 'utf-8').slice(0, 3000);
    let extDocs = '';
    for (const ep of extPaths) { if (existsSync(ep)) extDocs += `\n\n--- ${ep.replace(/\\/g, '/').split('/').pop()} ---\n${readFileSync(ep, 'utf-8').slice(0, 2000)}`; }
    let images = [];
    if (site.cdn && site.cdn.mode === 's3') { try { images = await s3List(site.cdn); } catch (e) { console.warn('S3 不可用:', e.message); } }
    const safe = site.images ? { ...site.images, key: undefined } : null;
    console.log(JSON.stringify({ site: { name: siteName, url: site.url, categories: site.categories, images: safe }, keyword, keywordRow: kw, products: products.slice(0, 5), images, prompts: promptDoc, extensions: extDocs }, null, 2));
    return;
  }

  if (cmd === 'publish') {
    const draftPath = process.argv[3] || DRAFT;
    if (!existsSync(draftPath)) { console.error('未找到草稿文件:', draftPath); process.exit(1); }
    const draft = JSON.parse(readFileSync(draftPath, 'utf-8'));
    const { title, excerpt, content, tags = [] } = draft;
    if (!title) { console.error('草稿缺少标题'); process.exit(1); }
    if (!content && !excerpt) { console.error('草稿缺少内容/摘要'); process.exit(1); }

    console.log('正在检查重复...');
    const dup = await checkDuplicate(site, title);
    if (dup) { console.log(`重复: "${title}" 已存在 (ID ${dup.id})，跳过。`); process.exit(0); }

    console.log('正在进行质量检查...');
    const { issues: qIssues, warnings: qWarnings } = await checkQuality(title, content, excerpt, tags, site);
    if (qWarnings.length) qWarnings.forEach(i => console.log(`  ⚠ ${i}`));
    if (qIssues.length) { console.log('质量问题:'); qIssues.forEach(i => console.log(`  ✗ ${i}`)); console.log('跳过低质量文章。'); process.exit(0); }
    else { console.log('  ✓ 通过'); }

    console.log('确保分类存在:', site.categories);
    const catIds = await resolveCategoryIds(site, site.categories);
    console.log('正在处理标签...');
    const tagIds = tags.length ? await Promise.all(asArray(tags).slice(0, 10).map(t => findOrCreate(site, 'tags', t, tagCache))) : [];

    let finalContent = content || excerpt;
    const cm = site.cdn && site.cdn.mode;

    if (cm === 's3') {
      let images = [];
      try { images = await s3List(site.cdn); } catch (e) { console.warn('S3 不可用:', e.message); }
      if (images.length) finalContent = mixImages(finalContent, images);
    } else if (cm === 'search') {
      console.log('正在搜索图片...');
      try { const images = await searchImages(site.images || {}, tags, title); if (images.length) finalContent = mixImages(finalContent, images); }
      catch (e) { console.warn('  图片搜索失败:', e.message); }
    } else if (cm === 'cdn') {
      console.log('纯 CDN 模式 — 远程图片 URL 保持不变');
    } else {
      const external = [...finalContent.matchAll(/<img[^>]+src="(https?:\/\/[^"]+)"/g)];
      if (external.length) {
        console.log('正在上传外部图片到媒体库...');
        const replacements = await uploadExternalImages(site, finalContent);
        for (const [oldUrl, newUrl] of Object.entries(replacements)) {
          finalContent = finalContent.replace(new RegExp(oldUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), () => newUrl);
        }
      }
    }

    console.log('正在发布...');
    const result = await wpFetch(site, 'posts', { method: 'POST', body: JSON.stringify({ title, content: finalContent, excerpt: excerpt || '', status: 'publish', categories: catIds, tags: tagIds }) });
    console.log(`已发布! ID: ${result.id}, URL: ${result.link}`);
    return;
  }

  console.error('用法: node wbp.mjs [pick|publish <file>|init]');
  process.exit(1);
}

main().catch(e => { console.error('致命错误:', e.message); process.exit(1); });