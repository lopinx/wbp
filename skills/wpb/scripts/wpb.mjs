#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, writeSync, mkdirSync } from 'fs';
import { homedir, platform } from 'os';
import { join, resolve, sep, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { createHash, createHmac } from 'crypto';
import readline from 'readline';
import * as XLSX from 'xlsx';

// AbortSignal.any 自 Node 20.3 起可用；package.json 声明 >=18，需 polyfill 兼容 Node 18/19
if (typeof AbortSignal.any !== 'function') {
  AbortSignal.any = (sigs) => {
    const ctrl = new AbortController();
    const listeners = [];
    const cleanup = () => sigs.forEach((s, i) => s.removeEventListener?.('abort', listeners[i]));
    for (const s of sigs) {
      if (s.aborted) { ctrl.abort(s.reason); return ctrl.signal; }
      const listener = () => { ctrl.abort(s.reason); cleanup(); };
      listeners.push(listener);
      s.addEventListener('abort', listener, { once: true });
    }
    return ctrl.signal;
  };
}

// Windows 控制台默认代码页为 936 (GBK)，Node 输出 UTF-8 字节会被按 GBK 解码导致乱码
// （如「用法」显示为「鐢ㄦ硶」）。切换到 65001 (UTF-8) 让控制台正确解码。
if (platform() === 'win32') {
  try { execSync('chcp 65001', { stdio: 'ignore' }); } catch {}
  // Node 24 TTY 以 UTF-8 写字节，控制台代码页改为 65001 后即可正确显示；
  // 同时显式设置 stdout/stderr 默认编码为 UTF-8，保证管道/重定向场景也一致。
  try { process.stdout.setDefaultEncoding('utf-8'); process.stderr.setDefaultEncoding('utf-8'); } catch {}
}

// 从 CWD 向上查找含 setting.toml 的 .wpb 目录（类 git .git）；未找到则返回 CWD 下的预期路径（不自动创建）
function findWpDir() {
  let dir = process.cwd();
  while (true) {
    const candidate = join(dir, '.wpb');
    if (existsSync(join(candidate, 'setting.toml'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(process.cwd(), '.wpb');
}

const TIMEOUT_MS = 30000, WP_DIR = findWpDir(), CFG = join(WP_DIR, 'setting.toml');
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LOG_LEVEL = process.env.WPB_LOG_LEVEL || 'info';
const LVL_IDX = { debug: 0, info: 1, warn: 2, error: 3 };
const log = (lvl, msg, data = {}, skipPrefix = false) => { if (LVL_IDX[lvl] < LVL_IDX[LOG_LEVEL]) return; const line = (skipPrefix ? '' : `[${new Date().toISOString()}] [${lvl.toUpperCase()}] `) + msg + (data && Object.keys(data).length ? ' ' + JSON.stringify(data) : ''); writeSync(lvl === 'error' || lvl === 'warn' ? 2 : 1, line + '\n'); };
const die = (msg, code = 1) => { writeSync(2, String(msg) + '\n'); process.exit(code); };
const PARA_RE = /<p[^>]*>[\s\S]*?<\/p>/g;
const HREF_RE = /href=["']([^"']+?)["']/gi;
const asArray = x => Array.isArray(x) ? x : [x];
const isAbsPath = p => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);
const isUrl = p => /^https?:\/\//i.test(p);
// 提取 URL origin（protocol+host），fetch 站点匹配与 checkQuality/uploadExternalImages 复用
const siteOriginOf = url => (String(url).match(/^https?:\/\/[^/]+/i) || [''])[0];
// 安全路径：URL 原样返回（由 readTable 远程获取）；绝对路径原样 resolve；相对路径解析到 .wpb 并防越界
const safePath = p => { if (!p) return null; if (isUrl(p)) return p; const a = isAbsPath(p) ? resolve(p) : resolve(WP_DIR, p); if (!isAbsPath(p) && a !== WP_DIR && !a.startsWith(WP_DIR + sep)) throw new Error(`路径越界 .wpb: ${p} (解析为 ${a})`); return a; };
function isValidKey(k) { return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k) && !['__proto__', 'constructor', 'prototype'].includes(k); }
const validateDraft = d => { const e = []; if (!d || typeof d !== 'object' || Array.isArray(d)) return { valid: false, errors: ['草稿必须是 JSON 对象'] }; for (const f of ['title', 'content', 'excerpt']) if (!d[f]) e.push(`草稿缺少必需字段: ${f}`); if (d.title && typeof d.title !== 'string') e.push('title 必须是字符串'); if (d.content && typeof d.content !== 'string') e.push('content 必须是字符串'); if (d.excerpt && typeof d.excerpt !== 'string') e.push('excerpt 必须是字符串'); if (d.postId !== undefined && (!Number.isInteger(d.postId) || d.postId <= 0)) e.push('postId 必须是正整数'); if (d.site !== undefined && typeof d.site !== 'string') e.push('site 必须是字符串'); return { valid: e.length === 0, errors: e }; };

// ── 迷你 TOML 解析器 ──
function parseToml(t) {
  const r = {}; let sectionPath = [];
  // 合并多行数组：跨行的 [...] 折回单行，逐字符剥离注释并跟踪括号/字符串状态
  const logical = [];
  let buf = '', depth = 0, inStr = false, q = '', esc = false;
  for (const raw of t.split('\n')) {
    let kept = '';
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (esc) { esc = false; kept += c; continue; }
      if (inStr) { if (c === '\\') esc = true; else if (c === q) inStr = false; kept += c; continue; }
      if (c === '"' || c === "'") { inStr = true, q = c; kept += c; continue; }
      if (c === '#') break; // 行内/整行注释在数组外即剥离，避免吞掉后续的 ]
      if (c === '[') depth++;
      else if (c === ']') depth = Math.max(0, depth - 1);
      kept += c;
    }
    if (depth === 0 && !kept.trim()) { if (!buf) continue; }
    buf = buf ? buf + ' ' + kept.trim() : kept;
    if (depth === 0) { if (buf.trim()) logical.push(buf); buf = ''; }
  }
  if (buf.trim()) logical.push(buf);
  for (const l of logical) {
    const v = l.trim(); if (!v || v.startsWith('#')) continue;
    const m = v.match(/^\[([^\]]+)\]$/); if (m) { sectionPath = m[1].split('.'); continue; }
    const kv = v.match(/^([\w.]+)\s*=\s*(.+)$/); if (!kv) continue;
    let val = kv[2].trim(); let inStr = false, strQuote = '', escaped = false;
    for (let i = 0; i < val.length; i++) { const c = val[i]; if (escaped) { escaped = false; continue; } if (c === '\\') { escaped = true; continue; } if ((c === '"' || c === "'") && !inStr) { inStr = true, strQuote = c; } else if (c === strQuote && inStr) { inStr = false, strQuote = ''; } if (c === '#' && !inStr) { val = val.slice(0, i).trimEnd(); break; } }
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    else if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    else if (val.startsWith('[') && val.endsWith(']')) { const arrStr = val.slice(1, -1).trim(); if (arrStr) { const arr = []; let current = '', inQuote = false, q = ''; for (let i = 0; i < arrStr.length; i++) { const c = arrStr[i]; if (c === '"' || c === "'") { if (!inQuote) { inQuote = true, q = c; } else if (c === q) { inQuote = false, q = ''; } current += c; } else if (c === ',' && !inQuote) { arr.push(current.trim().replace(/^["']|["']$/g, '')); current = ''; } else current += c; } if (current.trim()) arr.push(current.trim().replace(/^["']|["']$/g, '')); val = arr; } else val = []; }
    else if (val === 'true') val = true; else if (val === 'false') val = false; else if (/^-?\d+$/.test(val)) val = Number(val);
    const keyPath = sectionPath.concat(kv[1].split('.'));
    for (const pk of keyPath) if (!isValidKey(pk)) throw new Error(`无效的 TOML 键: ${pk}，只能包含字母、数字和下划线，且必须以字母或下划线开头`);
    let o = r; for (const p of keyPath.slice(0, -1)) o = o[p] = o[p] || {}; o[keyPath[keyPath.length - 1]] = val;
  } return r;
}

// ── 数据表读取（SheetJS）──
// 采样首列，跳过以日期或 URL 为主的 sheet（如 Google Search Console 导出的"图表""网页"sheet）
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function pickSheet(wb) {
  const names = wb.SheetNames;
  if (!names.length) throw new Error('工作簿没有任何工作表');
  if (names.length <= 1) return wb.Sheets[names[0]];
  for (const name of names) {
    const ws = wb.Sheets[name];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
    const samples = rows.slice(1, 11).map(r => String(r[0] ?? '').trim()).filter(Boolean);
    if (!samples.length) continue;
    const skipCount = samples.filter(v => DATE_RE.test(v) || /^https?:\/\//i.test(v)).length;
    if (skipCount / samples.length < 0.5) return ws;
  }
  return wb.Sheets[names[0]];
}

async function readTable(p) {
  const url = isUrl(p);
  let data;
  if (url) { const res = await fetchWithRetry(p, { signal: AbortSignal.timeout(TIMEOUT_MS) }); if (!res.ok) throw new Error('URL 获取失败: ' + res.status + ' ' + p); data = new Uint8Array(await res.arrayBuffer()); }
  else { if (!existsSync(p)) throw new Error('文件未找到: ' + p); data = readFileSync(p); }
  const wb = XLSX.read(data, { type: url ? 'array' : 'buffer', cellDates: false });
  const rows = XLSX.utils.sheet_to_json(pickSheet(wb), { header: 1, raw: false, defval: '' });
  return rows.slice(1).filter(r => Array.isArray(r) && r.some(v => String(v).trim() !== ''));
}

// ── 带域名关键词过滤 ──
// 过滤 SEO 平台导出中混入的带域名垃圾词：site:xxx、xxx.com、xxx.pl、xxx site:xxx.com
const SITE_RE = /\bsite:\s*[a-z0-9.-]+/i;
// 匹配常见域名后缀（点号后 2-6 字母），覆盖 .com/.pl/.ru/.world 等，无需枚举全部 TLD
const DOMAIN_RE = /\.[a-z]{2,6}\b/i;
function isSpamKeyword(s) { const t = String(s ?? '').trim(); return !t || SITE_RE.test(t) || DOMAIN_RE.test(t); }
function filterSpamKeywords(rows) { return rows.filter(r => { const first = r && r[0]; return first && !isSpamKeyword(first); }); }

// ── 图片搜索 ──
async function searchImages(cfg, tags, title) {
  const keys = cfg.keys || (cfg.key ? [cfg.key] : []); if (!keys.length) { log('warn', '  ⚠ 未配置 images.keys'); return []; }
  const { gl, hl, tbs, query } = cfg;  // 不写死默认值；缺失则不传，由 Serper 自身默认
  let q;
  if (query) { q = String(query).slice(0, 100); }
  else {
    const keep = (tags || []).filter(t => t.length > 2 && !/^\d+\s*(in|pack|pcs|set|pairs?|stk|ctn|box|bag|roll|sheets?|ml|g|kg|cm|mm|inch)/i.test(t));
    q = [...keep, title].filter(Boolean).join(' ').slice(0, 100);
  }
  // 多 key 轮询 + 指数退避重试，总尝试次数限制
  const maxAttempts = keys.length * 3; // 每个 key 最多尝试 3 次
  let attempt = 0;
  const backoff = (i) => 500 * 2 ** Math.min(i, 5) + Math.random() * 200;
  while (attempt < maxAttempts) {
    const keyIndex = attempt % keys.length;
    const key = keys[keyIndex];
    try {
      const body = { q };
      if (gl) body.gl = gl;
      if (hl) body.hl = hl;
      if (tbs) body.tbs = tbs;
      const res = await fetchWithRetry('https://google.serper.dev/images', {
        method: 'POST',
        headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }, 1); // 每个请求内部重试 1 次（共 2 次尝试）
      if (!res.ok) {
        log('warn', `  图片搜索失败 (key ${keyIndex+1}): ${res.status}`);
        attempt++;
        if (attempt < maxAttempts) await new Promise(r => setTimeout(r, backoff(attempt)));
        continue;
      }
      let data;
      try { data = await res.json(); } catch {
        log('warn', '  图片搜索响应解析失败');
        attempt++;
        continue;
      }
      if (data.images && data.images.length) {
        return data.images.map(i => i.imageUrl).filter(u => u && /^https?:\/\//.test(u));
      }
      log('warn', `  图片搜索返回空结果 (key ${keyIndex+1})`);
      attempt++;
    } catch (e) {
      log('warn', `  图片搜索错误 (key ${keyIndex+1}): ${e.message}`);
      attempt++;
      if (attempt < maxAttempts) {
        const delay = backoff(attempt);
        log('debug', `  等待 ${Math.round(delay)}ms 后重试...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  log('warn', `  所有图片搜索尝试失败 (${maxAttempts} 次)`);
  return [];
}

async function fetchWithRetry(url, opts = {}, retries = 3) {
  const backoff = i => 1000 * 2 ** i + Math.random() * 200;
  for (let i = 0; i <= retries; i++) {
    try {
      // 每次重试新建独立 timeout signal，避免复用已 aborted 的 signal 导致重试失效；
      // 外部 signal（如死链检测 5s）与 timeout 取较短者
      const timeoutSignal = AbortSignal.timeout(TIMEOUT_MS);
      const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;
      // 注入 User-Agent：部分服务器（含 Cloudflare）要求 UA 非空，否则握手后断开连接
      const headers = { ...opts.headers };
      if (!Object.keys(headers).some(k => k.toLowerCase() === 'user-agent'))
        headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
      const res = await fetch(url, { ...opts, signal, headers });
      if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) return res;
      if (i >= retries) return res;
      const d = backoff(i); log('warn', `  请求失败 (${res.status})，${Math.round(d)}ms 后重试...`); await new Promise(r => setTimeout(r, d));
    } catch (e) {
      // 外部 signal 主动 abort（如死链检测超时）不重试，避免对已放弃的请求做无意义重试
      if (opts.signal?.aborted || i >= retries) throw e;
      const d = backoff(i); log('warn', `  请求错误: ${e.message}，${Math.round(d)}ms 后重试...`); await new Promise(r => setTimeout(r, d));
    }
  }
  throw new Error('fetchWithRetry: unreachable');
}

// ── S3 列表 ──
async function s3List(cfg, limit) {
  const { endpoint, region: cfgRegion = endpoint ? 'us-east-1' : undefined, bucket, prefix = '' } = cfg;
  if (!bucket && !endpoint) throw new Error('S3 配置缺少 bucket（且未配置 endpoint）');
  if (!cfgRegion && !endpoint) throw new Error('S3 配置缺少 region（且未配置 endpoint）');
  const region = cfgRegion;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID || cfg.accessKeyId || cfg.key;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || cfg.secretAccessKey || cfg.secret;
  if (!accessKeyId || !secretAccessKey) throw new Error('S3 凭据未配置（accessKeyId/secretAccessKey 或环境变量 AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY）');
  const base = endpoint ? endpoint.replace(/\/$/, '') : `https://${bucket}.s3.${region}.amazonaws.com`;
  const host = new URL(base).host;
  const date = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const sign = (msg, key) => createHmac('sha256', key).update(msg).digest('hex');
  const kDate = sign(date.slice(0, 8), 'AWS4' + secretAccessKey);
  const kRegion = sign(region, kDate);
  const kService = sign('s3', kRegion);
  const kSigning = sign('aws4_request', kService);
  const emptyHash = createHash('sha256').update('').digest('hex');
  const auth = 'AWS4-HMAC-SHA256 Credential=' + accessKeyId + '/' + date.slice(0, 8) + '/' + region + '/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=' + sign('AWS4-HMAC-SHA256\n' + date + '\n' + date.slice(0, 8) + '/' + region + '/s3/aws4_request\n' + emptyHash, kSigning);
  const query = 'list-type=2&max-keys=' + limit + (prefix ? '&prefix=' + encodeURIComponent(prefix) : '');
  const res = await fetchWithRetry(base + '/?' + query, { headers: { host, 'x-amz-date': date, 'x-amz-content-sha256': emptyHash, authorization: auth } });
  if (!res.ok) throw new Error('S3 列表失败: ' + res.status);
  const xml = await res.text();
  const files = xml.match(/<Key>([^<]+)<\/Key>/g)?.map(k => k.replace(/<\/?Key>/g, '')) || [];
  const domain = cfg.domain ? (cfg.domain.replace(/\/$/, '')) : base;
  return files.filter(f => /\.(jpg|jpeg|png|gif|webp|avif)$/i.test(f)).map(f => domain + '/' + f);
}

// ── WP REST API ──
let _wpPwWarned = false;
async function wpFetch(site, path, opts = {}) {
  if (!process.env.WP_PASSWORD && !_wpPwWarned) { log('warn', 'WP_PASSWORD 环境变量未设置，使用 TOML 配置（不安全）'); _wpPwWarned = true; }
  const res = await fetchWithRetry(site.url.replace(/\/+$/, '') + '/' + path.replace(/^\//, ''), { ...opts, signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'Authorization': wpAuth(site), 'Content-Type': 'application/json', ...opts.headers } });
  if (!res.ok) { log('error', `WP API 错误: ${res.status} ${res.statusText}`); throw new Error(`WP API ${res.status}: ${res.statusText}`); }
  let data; try { data = await res.json(); } catch (e) { throw new Error(`WP API 响应 JSON 解析失败 (${path}): ${e.message}`); }
  return data;
}

async function uploadImage(site, imgUrl) {
  const res = await fetchWithRetry(imgUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error('获取图片失败: ' + res.status);
  const contentLength = res.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > 5 * 1024 * 1024) {
    throw new Error(`图片大小 ${Math.round(parseInt(contentLength, 10) / 1024 / 1024)}MB 超过 5MB 限制`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  // 服务器不返回 content-length（分块传输）时以实际缓冲大小二次校验，防止超大图读入内存后仍被上传
  if (buf.length > 5 * 1024 * 1024) throw new Error(`图片大小 ${Math.round(buf.length / 1024 / 1024)}MB 超过 5MB 限制`);
  let raw; try { raw = decodeURIComponent(imgUrl.split('?')[0].split('/').pop() || 'image.jpg'); } catch { raw = imgUrl.split('?')[0].split('/').pop() || 'image.jpg'; }
  const ext = '.' + ((raw.match(/\.(jpg|jpeg|png|gif|webp|avif)$/i) || [])[1] || 'jpg');
  const name = (raw.replace(/\.(jpg|jpeg|png|gif|webp|avif)$/i, '') || 'image').replace(/[^\w\u0100-\u017F\u4e00-\u9fff.-]/g, '-').slice(0, 60) + ext;
  const boundary = '----' + Math.random().toString(36).slice(2); let ctype = res.headers.get('content-type') || 'image/jpeg'; if (!/^image\//i.test(ctype)) ctype = 'image/jpeg';
  const r = await fetchWithRetry(`${site.url.replace(/\/+$/, '')}/media`, { method: 'POST', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'Authorization': wpAuth(site), 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${ctype}\r\n\r\n`), buf, Buffer.from(`\r\n--${boundary}--\r\n`)] ) });
  if (!r.ok) { log('error', `媒体上传失败: ${r.status}`); throw new Error(`媒体上传失败: ${r.status}`); }
  const j = await r.json(); if (!j?.source_url) throw new Error('媒体上传返回缺少 source_url'); return j.source_url;
}

function wpAuth(site) { return 'Basic ' + Buffer.from(`${site.user}:${process.env.WP_PASSWORD || site.pass}`).toString('base64'); }
async function uploadExternalImages(site, html, skipOrigins = []) {
  const urls = [...new Set([...html.matchAll(/<img[^>]+src=["']([^"']+)["']/g)].map(m => m[1]))];
  const siteOrigin = siteOriginOf(site.url);
  // 按 URL origin 精确比较，防止 https://site.com.evil.com 之类伪前缀绕过
  const skip = [siteOrigin, ...skipOrigins.map(o => { try { return new URL(o).origin; } catch { return o; } })].filter(Boolean);
  const urlOrigin = u => { try { return new URL(u).origin; } catch { return ''; } };
  const external = urls.filter(url => !skip.some(o => urlOrigin(url) === o));
  if (!external.length) return {};
  // 并发上传外部图片，限制并发数 5，避免同时发起过多请求
  const entries = await concurrentMap(external, 5, async (url) => {
    try { log('info', `  正在上传: ${url.slice(0, 60)}...`); const r = await uploadImage(site, url); log('info', `  → ${r}`); return [url, r]; }
    catch (e) { log('warn', `  ⚠ 上传失败: ${e.message}`); return [url, null]; }
  });
  const results = {};
  for (const [url, r] of entries) if (r) results[url] = r;
  return results;
}

// 并发控制辅助函数：分块并发执行，限制最大并发数
async function concurrentMap(arr, concurrency, fn) {
  const results = [];
  const chunks = [];
  for (let i = 0; i < arr.length; i += concurrency) {
    chunks.push(arr.slice(i, i + concurrency));
  }
  for (const chunk of chunks) {
    const chunkResults = await Promise.all(chunk.map((item, idx) => fn(item, idx)));
    results.push(...chunkResults);
  }
  return results;
}

const categoryCache = new Map(), tagCache = new Map();
async function findOrCreate(site, type, name, cache) {
  const key = `${site.url}:${name}`; if (cache.has(key)) return cache.get(key);
  let items = [], page = 1;
  while (page <= 20) { const batch = await wpFetch(site, `${type}?per_page=100&page=${page}`); if (!Array.isArray(batch)) break; items = items.concat(batch); if (batch.length < 100) break; page++; }
  let item = items.find(i => i.name === name || i.slug === name);
  if (!item) { try { item = await wpFetch(site, type, { method: 'POST', body: JSON.stringify({ name, slug: name.toLowerCase().replace(/\s+/g, '-') }) }); } catch (e) { if (e.message?.includes('already exists') || e.message?.includes('term_exists')) { const existing = await wpFetch(site, `${type}?search=${encodeURIComponent(name)}&per_page=100`); if (!Array.isArray(existing)) throw new Error(`搜索 ${type} 返回非数组: ${JSON.stringify(existing)}`); item = existing.find(i => i.name === name || i.slug === name); if (!item) throw e; } else throw e; } }
  cache.set(key, item.id); return item.id;
}

// WP REST 默认 context 不返回 title.raw，rendered 含 HTML 实体（&amp; 等）；归一化后比较保证去重有效
const decodeHtml = s => String(s).replace(/&#(\d+);/g, (_, d) => String.fromCharCode(d)).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/<[^>]+>/g, '');
const normTitle = t => decodeHtml(t).replace(/\s+/g, ' ').trim();
async function checkDuplicate(site, title, excludeId = 0) { const posts = await wpFetch(site, `posts?search=${encodeURIComponent(title.slice(0, 100))}&status=any&per_page=20`); return posts.find(p => p.id !== excludeId && p.title && (normTitle(p.title.raw || '') === normTitle(title) || normTitle(p.title.rendered || '') === normTitle(title))) || null; }

async function resolveCategoryIds(site, cats) { return Promise.all(asArray(cats).map(c => { const isId = typeof c === 'number' || /^\d+$/.test(String(c)); return isId ? String(c) : findOrCreate(site, 'categories', c, categoryCache); })); }

// 图片处理 + 标签创建（更新/创建路径共用，消除重复）
async function processImagesAndTags(site, content, tags, title) {
  let finalContent = content; let tagIds = [];
  if (site.cdn && site.cdn.mode === 'search') { try { const imgs = await searchImages(site.images || {}, tags || [], title); if (imgs.length) finalContent = mixImages(finalContent, imgs); } catch (e) { log('warn', '图片搜索失败:', e.message); } }
  else if (site.cdn && site.cdn.mode === 'cdn') { log('info', 'CDN 模式：保留远程图片 URL 不变'); }
  else if (site.cdn && site.cdn.mode === 's3') {
    // S3 图片保留原 URL，但非 S3 域的外链图片仍上传到媒体库
    const s3Base = site.cdn.domain || (site.cdn.endpoint ? site.cdn.endpoint.replace(/\/$/, '') : `https://${site.cdn.bucket}.s3.${site.cdn.region || 'us-east-1'}.amazonaws.com`);
    const s3Origin = (() => { try { return new URL(s3Base).origin; } catch { return null; } })();
    const up = await uploadExternalImages(site, finalContent, s3Origin ? [s3Origin] : []);
    if (Object.keys(up).length) for (const [o, n] of Object.entries(up)) finalContent = finalContent.replaceAll(o, n);
  }
  else { const up = await uploadExternalImages(site, finalContent); if (Object.keys(up).length) for (const [o, n] of Object.entries(up)) finalContent = finalContent.replaceAll(o, n); }
  if (tags?.length) {
    const results = await concurrentMap(tags, 5, async (t) => {
      try { return await findOrCreate(site, 'tags', t, tagCache); }
      catch (e) { log('warn', `标签创建失败: ${t}`, e.message); return null; }
    });
    tagIds = results.filter(r => r !== null);
  }
  return { finalContent, tagIds };
}

// ── 站点匹配与术语反查（fetch / 更新路径共用）──
// validateSite：url/user/categories 必填；pass 在未设置 WP_PASSWORD 环境变量时必填
const SITE_REQUIRED_FIELDS = ['url', 'user', 'categories'];
function validateSite(siteName, site) {
  for (const f of SITE_REQUIRED_FIELDS) if (!site[f]) die(`站点 [site.${siteName}] 缺少必填字段: ${f}`);
  if (!site.pass && !process.env.WP_PASSWORD) die(`站点 [site.${siteName}] 缺少 pass 字段（或设置 WP_PASSWORD 环境变量）`);
  if (!site.url.includes('/wp-json/wp/v2')) log('warn', `站点 [site.${siteName}] 的 url 不含 /wp-json/wp/v2，WP REST API 调用可能失败`);
}
// 按文章 URL 的域名精确匹配配置站点；更新路径必须显式绑定站点，禁止随机选取
function findSiteByOrigin(sites, origin) { const hits = Object.entries(sites).filter(([, s]) => siteOriginOf(s.url) === origin); if (!hits.length) die(`文章 URL 不属于任何已配置站点: ${origin}，请检查 setting.toml`); if (hits.length > 1) die(`多个站点配置了同一域名 ${origin}: ${hits.map(([k, s]) => s.name || k).join(', ')}，请合并配置`); return hits[0]; }
// 按 slug 定位文章；slug 查询无结果时回退关键词搜索并精确匹配 link
async function findPostBySlug(site, articleUrl, slug) {
  const bySlug = await wpFetch(site, `posts?slug=${encodeURIComponent(slug)}&status=any&per_page=5`);
  if (Array.isArray(bySlug) && bySlug.length) return bySlug[0];
  const bySearch = await wpFetch(site, `posts?search=${encodeURIComponent(slug)}&status=any&per_page=20`);
  if (Array.isArray(bySearch)) { const hit = bySearch.find(p => p.link && (p.link === articleUrl || p.link === articleUrl.replace(/\/+$/, ''))); if (hit) return hit; }
  return null;
}
// 术语 ID 反查名称（tags/categories 在文章中只存 ID）
async function termNames(site, type, ids) { if (!ids?.length) return []; const terms = await wpFetch(site, `${type}?include=${ids.join(',')}&per_page=100`); return Array.isArray(terms) ? terms.map(t => t.name) : []; }

// ── NitroPack CDN URL 清理 ──
// NitroPack 将原始图片 URL 包装为：https://cdn-<sub>.nitrocdn.com/<token>/assets/images/optimized/rev-<hash>/<原始URL>
// 此函数剥离 CDN 前缀，还原原始图片 URL
function stripNitroPack(html) {
  return html.replace(/https?:\/\/cdn-[\w-]+\.nitrocdn\.com\/[\w]+\/assets\/images\/optimized\/rev-[\w]+\//g, '');
}

// ── 图片混排 ──
// 规则：图片插入段落之间，不得插在首段之前、尾段之后、小标题之后相邻位置
function mixImages(html, images) {
  if (!images.length) return html;
  // 找到所有 <p> 段落及其在原文中的位置
  const paras = [];
  let m;
  const re = new RegExp(PARA_RE.source, 'g');
  while ((m = re.exec(html)) !== null) paras.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  if (paras.length < 2) return html;
  const used = images.slice(0, paras.length - 1);
  if (!used.length) return html;
  // 计算可用插入点：段落 i 与 i+1 之间（即段落 i 之后）
  // 排除首段之前（i=-1 不生成）和尾段之后（i=paras.length-1 不生成）
  const slots = [];
  for (let i = 0; i < paras.length - 1; i++) {
    // 检查段落 i+1 前面是否紧跟 </h3>（小标题之后相邻位置）
    const gap = html.slice(paras[i].end, paras[i + 1].start);
    if (/<\/h3>/i.test(gap)) continue;
    slots.push(paras[i].end);
  }
  if (!slots.length) return html;
  const step = Math.max(1, Math.floor(slots.length / used.length));
  // 从图片 URL 提取文件名作为 alt/title 文本（利于 SEO 和无障碍）
  const escAttr = s => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const imgAlt = u => { try { const n = decodeURIComponent(new URL(u, 'http://x').pathname).split('/').pop().replace(/\.[^.]+$/, ''); return (n || 'image').replace(/[-_]+/g, ' ').trim(); } catch { return 'image'; } };
  const parts = [];
  let last = 0;
  let si = 0;
  for (let i = 0; i < used.length && si < slots.length; i++) {
    const pos = slots[Math.min(si, slots.length - 1)];
    const a = escAttr(imgAlt(used[i]));
    parts.push(html.slice(last, pos));
    parts.push(`<figure><img src="${escAttr(used[i])}" alt="${a}" title="${a}" loading="lazy" style="max-width:100%;height:auto;border-radius:8px;margin:1em 0"></figure>`);
    last = pos;
    si += step;
  }
  parts.push(html.slice(last));
  return parts.join('');
}

// ── 质量检查 ──
async function checkQuality(title, content, excerpt, tags, site) {
  const issues = [], warnings = [];
  const body = content || excerpt || '';
  const text = body.replace(/<[^>]+>/g, '');
  // 词数统计：对 CJK 文本（中日韩）按字符计数，对拉丁文本按空格分词
  const cjkChars = (text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g) || []).length;
  const nonCjkText = text.replace(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g, ' ');
  const nonCjkWords = nonCjkText.split(/[\s]+/).filter(Boolean).length;
  const wordCount = cjkChars + nonCjkWords;
  const paras = body.match(PARA_RE) || [];
  const h3 = body.match(/<h3[^>]*>/g) || [];
  const checks = [[wordCount < 5000, `词数 ${wordCount} 少于 5000`], [paras.length < 10, `仅有 ${paras.length} 个段落`], [h3.length < 3, `仅有 ${h3.length} 个 H3 标题`], [!title || title.length < 10, `标题过短 (${title?.length || 0} 字符)`], [!excerpt || excerpt.length < 50, `摘要过短 (${excerpt?.length || 0} 字符)`], [!tags || tags.length < 3, `仅有 ${tags?.length || 0} 个标签`], [tags && tags.length > 10, `标签过多 (${tags.length} 个)`]];
  for (const [c, m] of checks) if (c) issues.push(m);
  const siteOrigin = siteOriginOf(site.url);
  // 一次性提取所有 href 链接，复用于内链/外链/死链检测
  const allLinks = [...body.matchAll(HREF_RE)].map(m => m[1]);
  if (siteOrigin) {
    const internalLinks = allLinks.filter(u => u.startsWith(siteOrigin));
    if (!internalLinks.length) warnings.push('没有内部链接');
    const escOrigin = siteOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rootRe = new RegExp(`^${escOrigin}/?$`);
    const navRe = new RegExp(`^${escOrigin}/(category|tag|kategoria|produkty|shop|blog)(/[^/]+)*/?$`);
    const productLinks = internalLinks.filter(u => !rootRe.test(u) && !navRe.test(u));
    if (productLinks.length < 3) warnings.push(`内链不足 (${productLinks.length} 条，建议≥3)`);
  }
  const kwList = asArray(tags || []).map(t => String(t).toLowerCase()).filter(t => t && t.length > 2);
  if (kwList.length) {
    const lower = text.toLowerCase();
    const hit = kwList.filter(k => { const m = lower.match(new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')); return m && m.length >= 2; });
    if (!hit.length) warnings.push('关键词命中不足 (标签在正文出现均少于 2 次)');
  }
  const extHref = allLinks.filter(u => !siteOrigin || !u.startsWith(siteOrigin));
  if (!extHref.length) warnings.push('E-E-A-T 信号不足 (无外部权威外链，建议引用权威来源链接)');
  if (extHref.length) {
    const codes = await Promise.all(extHref.slice(0, 3).map(async u => { try { const r = await fetchWithRetry(u, { method: 'GET', signal: AbortSignal.timeout(5000), redirect: 'follow' }); return r.status; } catch { return null; } }));
    const dead = codes.filter(c => c !== null && c >= 400).length;
    if (dead) issues.push(`失效链接: ${dead} 个`);
  }
  return { issues, warnings };
}

// ── 安装 ──
const AGENTS_SKILLS = { claude: { name: 'Claude Code', dir: ['.claude', 'skills'], invoke: '/wpb', check: 'claude' }, codex: { name: 'OpenAI Codex', dir: ['.codex', 'skills'], invoke: '@wpb', check: 'codex' }, gemini: { name: 'Gemini CLI', dir: ['.gemini', 'skills'], invoke: '/wpb', check: 'gemini' }, antigravity: { name: 'Antigravity CLI', dir: ['.antigravity', 'skills'], invoke: '/wpb', check: 'antigravity' }, openclaw: { name: 'OpenClaw', dir: ['.openclaw', 'skills'], invoke: '/wpb', check: 'openclaw' }, 'uos-ai': { name: '小U同学', dir: ['.uos-ai', 'skills'], invoke: '/wpb', check: 'uos-ai' }, cursor: { name: 'Cursor', dir: ['.cursor', 'skills'], invoke: '/wpb', check: 'cursor' }, copilot: { name: 'GitHub Copilot', dir: ['.github', 'skills'], invoke: '/wpb', check: 'copilot' }, opencode: { name: 'OpenCode', dir: ['.config', 'opencode', 'skills'], invoke: '/wpb', check: 'opencode' }, hermes: { name: 'Hermes', dir: ['.hermes', 'skills'], invoke: '/wpb', check: 'hermes' }, zcode: { name: 'ZCode', dir: ['.zcode', 'skills'], invoke: '$wpb', check: 'zcode' } };

async function doInstall() {
  console.log('=== WordPress 发布器安装程序 ===\n');

  // 用户手动运行 `wpb install`（TTY）时走完整 AI CLI 检测 + 命令文件创建流程；
  // 无 postinstall 钩子；npm 全局安装时用 symlink，脚本在 symlink 目标被清理后无法执行
  const checkCLI = cmd => { try { execSync(`${cmd} --version`, { stdio: 'ignore', timeout: 3000 }); return true; } catch { return false; }; };
  const detectedTools = Object.entries(AGENTS_SKILLS).map(([slug, tool]) => { const found = checkCLI(slug) || existsSync(join(homedir(), ...tool.dir.slice(0, -1))); console.log(found ? `  ✓ 检测到 ${tool.name}` : `  ✗ 未找到 ${tool.name}`); return found ? { ...tool, slug, path: join(homedir(), ...tool.dir) } : null; }).filter(Boolean);

  if (!detectedTools.length) { console.log('\n⚠ 未检测到任何已安装的 AI 工具，跳过命令文件创建。'); console.log('   如需安装，请先安装对应的 AI CLI，然后重新运行 wpb install。\n'); } else { console.log(`\n检测到 ${detectedTools.length} 个可安装工具：${detectedTools.map(t => t.name).join(', ')}\n`); const isTTY = process.stdin.isTTY; let selectedIndices = !isTTY ? (detectedTools.map((_, i) => i)) : await selectTools(detectedTools); if (!isTTY) console.log('⚠ 非 TTY 环境，使用默认配置：安装所有检测到的工具\n'); const selectedTools = selectedIndices.map(i => detectedTools[i]); console.log('\n正在创建 AI 工具命令文件...\n'); for (const tool of selectedTools) { const promptContent = generatePromptContent(tool); createCommandFile(tool, promptContent); } }

  console.log('=== 全局命令 ==='); console.log('✓ wpb 命令已通过 npm 全局安装自动注册'); console.log('  升级方式：npm update -g @lopinx/wpb');

  console.log(`\n=== 安装完成 ===`); console.log(`全局命令：wpb（在项目根目录运行：wpb pick / wpb fetch <URL> / wpb publish）`); console.log(`升级方式：npm update -g @lopinx/wpb`); console.log(`\n下一步：手动创建配置文件 .wpb/setting.toml（参考 skills/wpb/references/setting-reference.toml）`); console.log('\n安全建议：设置环境变量以避免明文存储在 TOML 中：\n  macOS/Linux (bash/zsh)：\n    export WP_PASSWORD="your-wordpress-password"\n    export AWS_ACCESS_KEY_ID="your-aws-access-key"\n    export AWS_SECRET_ACCESS_KEY="your-aws-secret-key"\n  Windows (PowerShell)：\n    $env:WP_PASSWORD="your-wordpress-password"\n    $env:AWS_ACCESS_KEY_ID="your-aws-access-key"\n    $env:AWS_SECRET_ACCESS_KEY="your-aws-secret-key"'); if (detectedTools.length) console.log(`\nAI 命令：${detectedTools.map(t => t.invoke).join(', ')}`);
}

function generatePromptContent(tool) { const skillPath = join(SCRIPT_DIR, '../SKILL.md'); if (existsSync(skillPath)) { const base = readFileSync(skillPath, 'utf-8'); return tool?.invoke ? `<!-- 调用前缀: ${tool.invoke} -->\n${base}` : base; } return `# WordPress Publisher Skill (${tool?.name || 'wpb'})\n\n## Purpose\n跨平台 WordPress 发布 CLI。工作流：wpb pick → 撰写 → wpb publish。支持更新：wpb fetch <URL> → 改写 → wpb publish。\n\n## Workflow\n1. wpb pick — 选取关键词与配置\n2. 撰写文章草稿保存为 JSON 文件\n3. wpb publish <草稿文件路径> — 去重/质量检查/图片处理/发布\n4. 更新已有文章：wpb fetch <URL> 拉取原文 → 改写（保留 postId+site）→ wpb publish\n\n## 注意\n- 数据文件支持 CSV/TXT/XLSX 格式\n- 安装方式：npm i -g github:lopinx/wpb`; }

function createCommandFile(tool, content) { const { dir } = tool; const filePath = join(homedir(), ...dir, 'wpb', 'SKILL.md'); try { if (!existsSync(dirname(filePath))) mkdirSync(dirname(filePath), { recursive: true }); let skipped = false; if (existsSync(filePath)) { try { if (readFileSync(filePath, 'utf8') === content) skipped = true; } catch { skipped = false; } } if (skipped) console.log(`  • ${tool.name} 命令文件无变化，跳过：${filePath}`); else { writeFileSync(filePath, content, 'utf8'); console.log(`  ✓ 已创建 ${tool.name} 命令文件：${filePath}`); } } catch (e) { console.warn(`  ✗ 创建 ${tool.name} 命令文件失败：${e.message}`); } }

function parseSelection(answer, total) { if (!answer) return []; const a = answer.toLowerCase().trim(); if (a === 'all') return Array.from({ length: total }, (_, i) => i); return a.split(',').map(s => parseInt(s.trim(), 10)).filter(i => !isNaN(i) && i >= 1 && i <= total).map(i => i - 1); }

async function selectTools(tools) { return new Promise(resolve => { console.log('\n请选择要安装的 AI 工具：\n'); tools.forEach((t, i) => console.log(`${i + 1}. ${t.name} — ${t.path}`)); console.log('\n输入选项编号（多个选项用逗号分隔），或输入 all 选择全部：'); const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question('', ans => { rl.close(); const s = parseSelection(ans, tools.length); if (!s.length) { console.log('\n错误：请输入有效的选项编号（1-数字）或 all\n'); resolve([]); } else resolve(s); }); }); }


// ── 主函数 ──
async function main() {
  const cmd = process.argv[2] || 'pick';
  if (cmd === 'install') { await doInstall(); return; }
  if (!['pick', 'fetch', 'publish'].includes(cmd)) die('用法: wpb [pick|fetch <url>|publish <file>|install]');
  if (!existsSync(CFG)) die(`未找到配置文件: ${CFG}\n请手动创建（参考 skills/wpb/references/setting-reference.toml）`);
  const cfg = parseToml(readFileSync(CFG, 'utf-8'));
  const sites = cfg.site || {}; const siteNames = Object.keys(sites);
  if (!siteNames.length) die('未配置任何站点');

  // ── fetch：按 URL origin 匹配站点，拉取已发布文章供改写 ──
  if (cmd === 'fetch') {
    const articleUrl = process.argv[3];
    if (!articleUrl) die('用法: wpb fetch <文章URL>');
    if (!isUrl(articleUrl)) die('fetch 参数必须是 http(s) URL: ' + articleUrl);
    const origin = siteOriginOf(articleUrl);
    const [siteName, site] = findSiteByOrigin(sites, origin);
    if (!site.name) site.name = siteName;
    validateSite(siteName, site);
    const slug = new URL(articleUrl).pathname.split('/').filter(Boolean).pop();
    if (!slug) die('无法从 URL 提取文章 slug: ' + articleUrl);
    const post = await findPostBySlug(site, articleUrl, slug);
    if (!post) die('未找到文章: ' + articleUrl);
    const full = await wpFetch(site, `posts/${post.id}?context=edit`);
    const tagNames = await termNames(site, 'tags', full.tags);
    const catNames = await termNames(site, 'categories', full.categories);
    console.log(JSON.stringify({ postId: full.id, site: siteName, link: full.link, title: full.title.raw, excerpt: full.excerpt.raw, content: full.content.raw, tags: tagNames, categories: catNames, instructions: '这是已发布文章。改写后保存草稿时必须保留 postId 和 site 字段，wpb publish 将更新该文章而非新建。' }, null, 2));
    return;
  }

  // ── pick / publish：随机选站点；草稿显式指定 site 时按其精确绑定，避免多站点随机重选导致发错站 ──
  let siteName = siteNames[Math.floor(Math.random() * siteNames.length)], site = sites[siteName]; if (!site.name) site.name = siteName;
  validateSite(siteName, site);
  const kwPaths = asArray(site.keywords).map(p => safePath(p)).filter(Boolean); const prodPaths = asArray(site.products).map(p => safePath(p)).filter(Boolean), promptPaths = asArray(site.prompts).map(p => safePath(p)).filter(Boolean), extPaths = (site.extensions || []).map(p => safePath(p));
  // 路径可用性判断：URL 始终视为可用（由 readTable 远程获取），本地文件须 existsSync
  const pathOk = p => p && (isUrl(p) || existsSync(p));
  if (!kwPaths.length || !kwPaths.some(pathOk)) die(`未找到关键词文件: ${kwPaths.join(', ')}`);
  const keywords = filterSpamKeywords((await Promise.all(kwPaths.filter(pathOk).map(readTable))).flat()); if (!keywords.length) die('关键词文件为空');
  const kw = keywords[Math.floor(Math.random() * keywords.length)]; const firstKey = kw ? Object.keys(kw)[0] : ''; const keyword = (kw && firstKey) ? kw[firstKey] : '';
  const loadProducts = async () => { const ok = prodPaths.filter(pathOk); if (!ok.length) return []; try { return await readTable(ok[Math.floor(Math.random() * ok.length)]); } catch (e) { log('warn', '产品文件加载失败:', e.message); return []; } };
  const loadPromptDoc = async () => { const ok = promptPaths.filter(pathOk); if (!ok.length) return ''; const p = ok[Math.floor(Math.random() * ok.length)]; try { return isUrl(p) ? (await (await fetchWithRetry(p)).text()).slice(0, 3000) : readFileSync(p, 'utf-8').slice(0, 3000); } catch (e) { log('warn', '写作指令加载失败:', e.message); return ''; } };
  const loadExtDocs = async () => {
    const ok = extPaths.filter(ep => pathOk(ep)); if (!ok.length) return '';
    // 并发加载扩展文档，限制并发数避免过多请求；单个加载失败不影响整体，保留 --- <filename> --- 分隔格式
    const parts = await concurrentMap(ok, 5, async (ep) => {
      try { return `\n\n--- ${ep.replace(/\\/g, '/').split('/').pop()} ---\n${isUrl(ep) ? (await (await fetchWithRetry(ep)).text()).slice(0, 2000) : readFileSync(ep, 'utf-8').slice(0, 2000)}`; }
      catch (e) { log('warn', '扩展知识加载失败:', e.message); return ''; }
    });
    return parts.filter(Boolean).join('');
  };
  const [products, promptDoc, extDocs] = await Promise.all([loadProducts(), loadPromptDoc(), loadExtDocs()]);
  let images = []; if (site.cdn && site.cdn.mode === 's3') { try { images = await s3List(site.cdn, 50); if (!images.length) log('warn', 'S3 图片池为空'); } catch (e) { log('warn', 'S3 不可用:', e.message); } }
  const safe = site.images ? { ...site.images, key: undefined, keys: undefined } : null;
  if (cmd === 'pick') { const pickWarnings = []; if (site.cdn && site.cdn.mode === 's3' && !images.length) pickWarnings.push('图片池为空，文章中的图片标签可能无法配图'); console.log(JSON.stringify({ site: { name: site.name, url: site.url, categories: site.categories, images: safe }, keyword, keywordRow: kw, products: products.slice(0, 5), images, prompts: promptDoc, extensions: extDocs, ...(pickWarnings.length ? { _warnings: pickWarnings } : {}) }, null, 2)); return; }

  // ── publish ──
  const draftPath = process.argv[3];
  if (!draftPath) die('用法: wpb publish <草稿文件路径>');
  if (!existsSync(draftPath)) die('草稿文件不存在: ' + draftPath);
  let draft; try { draft = JSON.parse(readFileSync(draftPath, 'utf-8')); } catch (e) { die(`草稿文件 JSON 解析失败: ${e.message}\n文件: ${draftPath}`); }
  const v = validateDraft(draft); if (!v.valid) die('草稿验证失败: ' + v.errors.join('; '));
  const cleanedContent = stripNitroPack(draft.content);
  // 草稿含 site 时精确绑定站点（创建与更新路径通用），保证与 wpb pick 输出的站点一致
  if (draft.site) {
    const named = sites[draft.site];
    if (!named) die(`草稿中指定的站点 "${draft.site}" 不在配置中，可用站点: ${siteNames.join(', ')}`);
    site = named; siteName = draft.site;
    if (!site.name) site.name = siteName;
    validateSite(siteName, site);
  }

  // 更新路径：draft.postId 存在时走 POST 更新（WP REST 兼容性最好），否则走 POST 创建
  const isUpdate = draft.postId !== undefined;
  if (isUpdate) {
    if (!draft.site && siteNames.length > 1) {
      die('多站点环境下更新文章需在草稿中指定 site 字段（站点名），请先用 wpb fetch 获取完整草稿上下文');
    }
    // 去重排除自身（checkDuplicate 第三个参数）+ 质量检查（同一套硬指标，不放宽）
    const [dup, q] = await Promise.all([
      checkDuplicate(site, draft.title, draft.postId),
      checkQuality(draft.title, cleanedContent, draft.excerpt, draft.tags || [], site)
    ]);
    if (dup) die(`检测到重复标题 (ID: ${dup.id})，请修改标题`);
    if (q.issues.length) die('质量检查不通过: ' + q.issues.join('; '));
    if (q.warnings.length) q.warnings.forEach(w => log('warn', w));
    // categories：draft 有值则解析，无值省略（WP 保留原分类）
    const catIds = draft.categories ? await resolveCategoryIds(site, draft.categories) : undefined;
    const { finalContent, tagIds } = await processImagesAndTags(site, cleanedContent, draft.tags, draft.title);
    const body = { title: draft.title, content: finalContent, excerpt: draft.excerpt || '', status: 'publish' };
    if (catIds) body.categories = catIds;
    if (tagIds.length) body.tags = tagIds;  // 缺失则不传，WP 保留原标签
    const res = await wpFetch(site, `posts/${draft.postId}`, { method: 'POST', body: JSON.stringify(body) });
    log('info', `更新成功: ${res.link} (ID: ${res.id}) [站点: ${siteName}]`);
    return;
  }

  // ── 创建路径 ──
  const [dup, q] = await Promise.all([
    checkDuplicate(site, draft.title),
    checkQuality(draft.title, cleanedContent, draft.excerpt, draft.tags || [], site)
  ]);
  if (dup) die(`检测到重复标题 (ID: ${dup.id})，请修改标题`);
  if (q.issues.length) die('质量检查不通过: ' + q.issues.join('; '));
  if (q.warnings.length) q.warnings.forEach(w => log('warn', w));
  const catIds = await resolveCategoryIds(site, draft.categories?.length ? draft.categories : site.categories);
  const { finalContent, tagIds } = await processImagesAndTags(site, cleanedContent, draft.tags, draft.title);
  const res = await wpFetch(site, 'posts', { method: 'POST', body: JSON.stringify({ title: draft.title, content: finalContent, excerpt: draft.excerpt || '', status: 'publish', categories: catIds, tags: tagIds }) });
  log('info', `发布成功: ${res.link} (ID: ${res.id})`);
}

main().catch(e => die(e.message));