#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, writeSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { createHash, createHmac } from 'crypto';

const TIMEOUT_MS = 30000, WP_DIR = join(homedir(), '.wbp'), CFG = join(WP_DIR, 'setting.toml'), DRAFT = join(WP_DIR, '_draft.json');

const LOG_LEVELS = {
  ERROR: 'error',
  WARN: 'warn',
  INFO: 'info',
  DEBUG: 'debug'
};

const LOG_LEVEL = process.env.WBP_LOG_LEVEL || 'info';

/**
 * 统一日志函数
 * @param {string} level - 日志级别
 * @param {string} message - 日志消息
 * @param {Object} data - 附加数据（可选）
 * @param {boolean} skipPrefix - 是否跳过时间戳和级别前缀（默认 false）
 */
function log(level, message, data = {}, skipPrefix = false) {
  // 检查是否应该输出
  const levelOrder = ['debug', 'info', 'warn', 'error'];
  const currentLevelIndex = levelOrder.indexOf(LOG_LEVEL);
  const messageLevelIndex = levelOrder.indexOf(level);

  if (messageLevelIndex > currentLevelIndex) {
    return;
  }

  // 格式化消息
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level.toUpperCase()}]`;

  // 同步写入 stderr/stdout，避免 process.exit 异步 flush 丢失输出。
  // ponytail: 直接 writeSync 而非 console，Windows+Node 下 console.error 在 exit 前可能不 flush
  const hasData = data && typeof data === 'object' && Object.keys(data).length > 0;
  const line = skipPrefix ? `${message}${hasData ? ' ' + JSON.stringify(data) : ''}` : `${prefix} ${message}${hasData ? ' ' + JSON.stringify(data) : ''}`;
  if (level === 'error' || level === 'warn') {
    writeSync(2, line + '\n');
  } else {
    writeSync(1, line + '\n');
  }
}

/**
 * 同步输出错误后立即退出，确保用户在 Windows/快速退出下仍能看到消息。
 * ponytail: 替代散落的 log('error',...) + process.exit(1) 模式
 */
function die(msg, code = 1) {
  try { writeSync(2, String(msg) + '\n'); } catch {}
  process.exit(code);
}

const PARA_RE = /<p[^>]*>[\s\S]*?<\/p>/g;
const asArray = x => Array.isArray(x) ? x : [x];

/**
 * 安全路径解析：相对路径挂到 ~/.wbp 并防目录遍历，绝对路径放行。
 * ponytail: 仅对相对路径做 WP_DIR 越界检查 —— 配置约定相对路径相对 ~/.wbp；
 *   绝对路径（如仓库内数据文件）是合法用例，不受 WP_DIR 约束。
 */
function safePath(p) {
  if (!p) return null;
  const isAbs = p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);
  const abs = isAbs ? resolve(p) : resolve(WP_DIR, p);
  if (!isAbs && !abs.startsWith(WP_DIR)) {
    throw new Error(`路径越界 ~/.wbp: ${p} (解析为 ${abs})`);
  }
  return abs;
}

// 验证键名是否安全（防止原型污染）
function isValidKey(key) {
  // 只允许字母、数字、下划线，且必须以字母或下划线开头
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
    return false;
  }
  // 明确阻止原型污染相关的危险键名
  const dangerousKeys = ['__proto__', 'constructor', 'prototype'];
  return !dangerousKeys.includes(key);
}

/**
 * 验证草稿文件结构
 * @param {Object} draft - 草稿对象
 * @returns {{valid: boolean, errors: string[]}}
 */
function validateDraft(draft) {
  const errors = [];

  // 必需字段检查
  const requiredFields = ['title', 'content', 'excerpt'];
  for (const field of requiredFields) {
    if (!draft[field]) {
      errors.push(`草稿缺少必需字段: ${field}`);
    }
  }

  // 类型检查
  if (draft.title && typeof draft.title !== 'string') {
    errors.push('title 必须是字符串');
  }

  if (draft.content && typeof draft.content !== 'string') {
    errors.push('content 必须是字符串');
  }

  if (draft.excerpt && typeof draft.excerpt !== 'string') {
    errors.push('excerpt 必须是字符串');
  }

  return {
    valid: errors.length === 0,
    errors
  };
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
    if (!isValidKey(kv[1])) {
      throw new Error(`无效的 TOML 键: ${kv[1]}，只能包含字母、数字和下划线，且必须以字母或下划线开头`);
    }
    o[kv[1]] = val;
  }
  return r;
}

// ── Excel 读取器 ──
async function readExcel(p) {
  if (!existsSync(p)) throw new Error('文件未找到');
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(p);
  const ws = wb.getWorksheet(1);
  const data = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber > 1) { // 跳过表头
      const rowValues = row.values;
      rowValues.shift(); // 移除空值
      data.push(rowValues);
    }
  });
  return data;
}

// ── 图片搜索（Serper.dev / 兼容 API）──
async function searchImages(cfg, tags, title) {
  const keys = cfg.keys || (cfg.key ? [cfg.key] : []);
  if (!keys.length) { log('warn', '  ⚠ 未配置 images.keys'); return []; }
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
  if (!res.ok) { log('warn', `  图片搜索失败: ${res.status}`); return []; }
  let data;
  try { data = await res.json(); } catch { log('warn', '  图片搜索响应解析失败'); return []; }
  if (!data.images || !data.images.length) { log('warn', '  图片搜索返回空结果，可能 API 响应格式已变更'); return []; }
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
      log('warn', `  请求失败 (${res.status})，${Math.round(d)}ms 后重试...`);
      await new Promise(r => setTimeout(r, d));
    } catch (e) {
      if (i >= retries) throw e;
      const d = 1000 * Math.pow(2, i) + Math.random() * 200;
      log('warn', `  请求错误: ${e.message}，${Math.round(d)}ms 后重试...`);
      await new Promise(r => setTimeout(r, d));
    }
  }
}

async function s3List(cfg, limit) {
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
    if (!res.ok) { const errText = await res.text().catch(() => ''); throw new Error(`S3 列表获取失败: ${res.status}`); }
    const xml = await res.text();
    const unesc = xml.replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"})[e]);
    images.push(...[...unesc.matchAll(/<Key>([^<]+)<\/Key>/g)].map(m => m[1]));
    const ct = unesc.match(/<IsTruncated>true<\/IsTruncated>/);
    token = ct ? (unesc.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/) || [,''])[1] : '';
  } while (token);
  const imgs = images.filter(k => /\.(jpg|jpeg|png|gif|webp|avif)$/i.test(k)).slice(0, limit);
  const base = cfg.domain ? `https://${cfg.domain}/${prefix}` : ep ? `${ep}/${prefix}` : `https://${bucket}.s3.${region}.amazonaws.com/${prefix}`;
  return imgs.map(k => k.startsWith(prefix) ? base + k.slice(prefix.length) : base + k.replace(/^\/+/, ''));
}

// ── 安全获取认证配置（环境变量优先）──
function getAuthConfig(site) {
  const pass = process.env.WP_PASSWORD || site.pass;
  const key = process.env.AWS_ACCESS_KEY_ID || site.key;
  const secret = process.env.AWS_SECRET_ACCESS_KEY || site.secret;
  if (!process.env.WP_PASSWORD) {
    log('warn', '警告: WP_PASSWORD 环境变量未设置，使用 TOML 配置（不安全）');
  }
  if (!process.env.AWS_ACCESS_KEY_ID) {
    log('warn', '警告: AWS_ACCESS_KEY_ID 环境变量未设置，使用 TOML 配置（不安全）');
  }
  if (!process.env.AWS_SECRET_ACCESS_KEY) {
    log('warn', '警告: AWS_SECRET_ACCESS_KEY 环境变量未设置，使用 TOML 配置（不安全）');
  }
  return { pass, key, secret };
}

// ── WordPress REST API ──
function wpAuth(site) { return 'Basic ' + Buffer.from(`${site.user}:${getAuthConfig(site).pass}`).toString('base64'); }
const categoryCache = new Map(), tagCache = new Map();

async function wpFetch(site, path, opts = {}) {
  const url = `${site.url.replace(/\/+$/, '')}/${path.replace(/^\//, '')}`;
  const res = await fetchWithRetry(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'Authorization': wpAuth(site), 'Content-Type': 'application/json', ...opts.headers } });
  if (!res.ok) { const body = await res.text().catch(() => ''); log('error', `WP API 错误: ${res.status} ${res.statusText}`); throw new Error(`WP API ${res.status}: ${res.statusText}`); }
  return res.json();
}

async function uploadImage(site, imgUrl) {
  const res = await fetch(imgUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) { log('error', `获取 ${imgUrl} 失败: ${res.status}`); throw new Error(`获取图片失败: ${res.status}`); }
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
  if (!r.ok) { const txt = await r.text().catch(() => ''); log('error', `媒体上传失败: ${r.status}`); throw new Error(`媒体上传失败: ${r.status}`); }
  const j = await r.json();
  if (!j?.source_url) throw new Error('媒体上传返回缺少 source_url');
  return j.source_url;
}

async function uploadExternalImages(site, html) {
  const urls = [...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map(m => m[1]), results = {};
  const siteOrigin = (site.url.match(/https?:\/\/[^/]+/) || [''])[0];
  for (const url of urls) {
    if (url.startsWith(siteOrigin) || results[url]) continue;
    try { log('info', `  正在上传: ${url.slice(0, 60)}...`); results[url] = await uploadImage(site, url); log('info', `  → ${results[url]}`); }
    catch (e) { log('warn', `  ⚠ 上传失败: ${e.message}`); }
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

/**
 * 解析分类配置：数字 ID 原样保留，名称经 findOrCreate 转为 ID。
 * ponytail: 分类既可填 1 也可填 "news"，统一 Promise.all 并行求值
 */
async function resolveCategoryIds(site, cats) {
  return Promise.all(asArray(cats).map(c => {
    const isId = typeof c === 'number' || /^\d+$/.test(String(c));
    return isId ? String(c) : findOrCreate(site, 'categories', c, categoryCache);
  }));
}

// ── 图片混排 ──
function mixImages(html, images) {
  if (!images.length) return html;
  const paras = html.match(PARA_RE) || [];
  if (!paras.length) return html;
  const step = Math.max(1, Math.floor(paras.length / (images.length + 1)));
  const parts = [...paras];
  let imgIdx = 0;
  for (let i = Math.min(step, parts.length - 1); i < parts.length && imgIdx < images.length; i += step) {
    parts[i] = `<figure><img src="${images[imgIdx++]}" alt="" loading="lazy" style="max-width:100%;height:auto;border-radius:8px;margin:1em 0"></figure>\n${parts[i]}`;
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
    [wordCount < 60, `词数 ${wordCount} 少于 60`],
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
    log('info', '示例配置文件已创建于', CFG);
    return;
  }

  if (!existsSync(CFG)) { die('未找到配置文件。请运行: node wbp.mjs init'); }
  const cfg = parseToml(readFileSync(CFG, 'utf-8'));
  const sites = cfg.site || {};
  const siteNames = Object.keys(sites);
  if (!siteNames.length) { die('未配置任何站点'); }

  const siteName = siteNames[Math.floor(Math.random() * siteNames.length)], site = sites[siteName];
  site.name = siteName;

  const kwPaths = asArray(site.keywords).map(p => safePath(p)).filter(Boolean);
  const prodPath = safePath(site.products), promptPath = safePath(site.prompts), extPaths = (site.extensions || []).map(p => safePath(p));

  if (cmd === 'pick') {
    if (!kwPaths.length || !kwPaths.some(existsSync)) { die(`未找到关键词文件: ${kwPaths.join(', ')}`); }
    const keywords = (await Promise.all(kwPaths.filter(existsSync).map(readExcel))).flat();
    if (!keywords.length) { die('关键词文件为空'); }
    const kw = keywords[Math.floor(Math.random() * keywords.length)], kwKeys = Object.keys(keywords[0]);
    const keyword = kw[kwKeys[0]] || kw.keyword || kw.name || '';
    let products = [];
    if (prodPath && existsSync(prodPath)) products = await readExcel(prodPath);
    let promptDoc = '';
    if (promptPath && existsSync(promptPath)) promptDoc = readFileSync(promptPath, 'utf-8').slice(0, 3000);
    let extDocs = '';
    for (const ep of extPaths) { if (existsSync(ep)) extDocs += `\n\n--- ${ep.replace(/\\/g, '/').split('/').pop()} ---\n${readFileSync(ep, 'utf-8').slice(0, 2000)}`; }
    let images = [];
    if (site.cdn && site.cdn.mode === 's3') { try { images = await s3List(site.cdn, 50); } catch (e) { log('warn', 'S3 不可用:', e.message); } }
    const safe = site.images ? { ...site.images, key: undefined } : null;
    const output = JSON.stringify({ site: { name: siteName, url: site.url, categories: site.categories, images: safe }, keyword, keywordRow: kw, products: products.slice(0, 5), images, prompts: promptDoc, extensions: extDocs }, null, 2);
    // Use console.log directly for pick command to avoid JSON parsing issues in tests
    console.log(output);
    return;
  }

  if (cmd === 'publish') {
    const draftPath = process.argv[3] || DRAFT;
    if (!existsSync(draftPath)) { die(`未找到草稿文件: ${draftPath}`); }
    const draft = JSON.parse(readFileSync(draftPath, 'utf-8'));
    const validation = validateDraft(draft);
    if (!validation.valid) {
      die('草稿文件结构无效:\n' + validation.errors.map(err => `  - ${err}`).join('\n'));
    }
    const { title, excerpt, content, tags = [] } = draft;
    if (!title) { die('草稿缺少标题'); }
    if (!content && !excerpt) { die('草稿缺少内容/摘要'); }

    log('info', '正在检查重复...');
    const dup = await checkDuplicate(site, title);
    if (dup) { log('info', `重复: "${title}" 已存在 (ID ${dup.id})，跳过。`); process.exit(0); }

    log('info', '正在进行质量检查...');
    const { issues: qIssues, warnings: qWarnings } = await checkQuality(title, content, excerpt, tags, site);
    if (qWarnings.length) qWarnings.forEach(i => log('info', `  ⚠ ${i}`));
    if (qIssues.length) { log('info', '质量问题:'); qIssues.forEach(i => log('info', `  ✗ ${i}`)); log('info', '跳过低质量文章。'); process.exit(0); }
    else { log('info', '  ✓ 通过'); }

    log('info', '确保分类存在:', site.categories);
    const catIds = await resolveCategoryIds(site, site.categories);
    log('info', '正在处理标签...');
    const tagIds = tags.length ? await Promise.all(asArray(tags).slice(0, 10).map(t => findOrCreate(site, 'tags', t, tagCache))) : [];

    let finalContent = content || excerpt;
    const cm = site.cdn && site.cdn.mode;

    if (cm === 's3') {
      let images = [];
      try { images = await s3List(site.cdn, 50); } catch (e) { log('warn', 'S3 不可用:', e.message); }
      if (images.length) finalContent = mixImages(finalContent, images);
    } else if (cm === 'search') {
      log('info', '正在搜索图片...');
      try { const images = await searchImages(site.images || {}, tags, title); if (images.length) finalContent = mixImages(finalContent, images); }
      catch (e) { log('warn', '  图片搜索失败:', e.message); }
    } else if (cm === 'cdn') {
      log('info', '纯 CDN 模式 — 远程图片 URL 保持不变');
    } else {
      const external = [...finalContent.matchAll(/<img[^>]+src="(https?:\/\/[^"]+)"/g)];
      if (external.length) {
        log('info', '正在上传外部图片到媒体库...');
        const replacements = await uploadExternalImages(site, finalContent);
        for (const [oldUrl, newUrl] of Object.entries(replacements)) {
          finalContent = finalContent.replace(new RegExp(oldUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), () => newUrl);
        }
      }
    }

    log('info', '正在发布...');
    const result = await wpFetch(site, 'posts', { method: 'POST', body: JSON.stringify({ title, content: finalContent, excerpt: excerpt || '', status: 'publish', categories: catIds, tags: tagIds }) });
    log('info', `已发布! ID: ${result.id}, URL: ${result.link}`);
    return;
  }

  die('用法: node wbp.mjs [pick|publish <file>|init]');
}

main().catch(e => { die(`致命错误: ${e.message}`); });