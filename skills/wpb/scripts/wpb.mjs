#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, writeSync, mkdirSync, readdirSync, statSync, copyFileSync } from 'fs';
import { homedir, platform } from 'os';
import { join, resolve, sep, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { createHash, createHmac } from 'crypto';
import readline from 'readline';
import * as XLSX from 'xlsx';

// Windows 控制台默认代码页为 936 (GBK)，Node 输出 UTF-8 字节会被按 GBK 解码导致乱码
// （如「用法」显示为「鐢ㄦ硶」）。切换到 65001 (UTF-8) 让控制台正确解码。
if (platform() === 'win32') {
  try { execSync('chcp 65001', { stdio: 'ignore' }); } catch {}
  // Node 24 TTY 以 UTF-8 写字节，控制台代码页改为 65001 后即可正确显示；
  // 同时显式设置 stdout/stderr 默认编码为 UTF-8，保证管道/重定向场景也一致。
  try { process.stdout.setDefaultEncoding('utf-8'); process.stderr.setDefaultEncoding('utf-8'); } catch {}
}

const TIMEOUT_MS = 30000, WP_DIR = join(homedir(), '.wpb'), CFG = join(WP_DIR, 'setting.toml');
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LOG_LEVEL = process.env.WPB_LOG_LEVEL || 'info';
const LVL_IDX = { debug: 0, info: 1, warn: 2, error: 3 };
const log = (lvl, msg, data = {}, skipPrefix = false) => { if (LVL_IDX[lvl] < LVL_IDX[LOG_LEVEL]) return; const line = (skipPrefix ? '' : `[${new Date().toISOString()}] [${lvl.toUpperCase()}] `) + msg + (data && Object.keys(data).length ? ' ' + JSON.stringify(data) : ''); writeSync(lvl === 'error' || lvl === 'warn' ? 2 : 1, line + '\n'); };
const die = (msg, code = 1) => { writeSync(2, String(msg) + '\n'); process.exit(code); };
const PARA_RE = /<p[^>]*>[\s\S]*?<\/p>/g;
const asArray = x => Array.isArray(x) ? x : [x];
const isAbsPath = p => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);
const safePath = p => { if (!p) return null; const a = isAbsPath(p) ? resolve(p) : resolve(WP_DIR, p); if (!isAbsPath(p) && a !== WP_DIR && !a.startsWith(WP_DIR + sep)) throw new Error(`路径越界 ~/.wpb: ${p} (解析为 ${a})`); return a; };
function isValidKey(k) { return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k) && !['__proto__', 'constructor', 'prototype'].includes(k); }
const validateDraft = d => { const e = []; for (const f of ['title', 'content', 'excerpt']) if (!d[f]) e.push(`草稿缺少必需字段: ${f}`); if (d.title && typeof d.title !== 'string') e.push('title 必须是字符串'); if (d.content && typeof d.content !== 'string') e.push('content 必须是字符串'); if (d.excerpt && typeof d.excerpt !== 'string') e.push('excerpt 必须是字符串'); return { valid: e.length === 0, errors: e }; };

// ── 迷你 TOML 解析器 ──
function parseToml(t) {
  const r = {}; let sectionPath = [];
  for (const l of t.split('\n')) {
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
async function readTable(p) {
  const isUrl = /^https?:\/\//i.test(p);
  let data;
  if (isUrl) { const res = await fetchWithRetry(p, { signal: AbortSignal.timeout(TIMEOUT_MS) }); if (!res.ok) throw new Error('URL 获取失败: ' + res.status + ' ' + p); data = await res.arrayBuffer(); }
  else { if (!existsSync(p)) throw new Error('文件未找到: ' + p); data = readFileSync(p); }
  const wb = XLSX.read(data, { type: isUrl ? 'array' : 'buffer', cellDates: false });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' });
  return rows.slice(1).filter(r => Array.isArray(r) && r.some(v => String(v).trim() !== ''));
}

// ── 图片搜索 ──
async function searchImages(cfg, tags, title) {
  const keys = cfg.keys || (cfg.key ? [cfg.key] : []); if (!keys.length) { log('warn', '  ⚠ 未配置 images.keys'); return []; }
  const key = keys[Math.floor(Math.random() * keys.length)];
  const { gl = 'pl', hl = 'pl', tbs = 'qdr:w', query } = cfg;
  let q;
  if (query) { q = String(query).slice(0, 100); }
  else {
    const keep = (tags || []).filter(t => t.length > 2 && !/^\d+\s*(in|pack|pcs|set|pairs?|stk|ctn|box|bag|roll|sheets?|ml|g|kg|cm|mm|inch)/i.test(t));
    q = [...keep, title].filter(Boolean).join(' ').slice(0, 100);
  }
  const res = await fetchWithRetry('https://google.serper.dev/images', { method: 'POST', headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ q, gl, hl, tbs }) });
  if (!res.ok) { log('warn', `  图片搜索失败: ${res.status}`); return []; }
  let data; try { data = await res.json(); } catch { log('warn', '  图片搜索响应解析失败'); return []; }
  if (!data.images || !data.images.length) { log('warn', '  图片搜索返回空结果'); return []; }
  return data.images.map(i => i.imageUrl).filter(u => u && /^https?:\/\//.test(u));
}

async function fetchWithRetry(url, opts, retries = 3) {
  const backoff = i => 1000 * 2 ** i + Math.random() * 200;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { ...opts, signal: opts?.signal || AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) return res;
      if (i >= retries) return res;
      const d = backoff(i); log('warn', `  请求失败 (${res.status})，${Math.round(d)}ms 后重试...`); await new Promise(r => setTimeout(r, d));
    } catch (e) {
      if (i >= retries) throw e;
      const d = backoff(i); log('warn', `  请求错误: ${e.message}，${Math.round(d)}ms 后重试...`); await new Promise(r => setTimeout(r, d));
    }
  }
}

// ── S3 列表 ──
async function s3List(cfg, limit) {
  const { endpoint, region, bucket, prefix = '' } = cfg;
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
  return res.json();
}

async function uploadImage(site, imgUrl) {
  const res = await fetchWithRetry(imgUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error('获取图片失败: ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  let raw; try { raw = decodeURIComponent(imgUrl.split('?')[0].split('/').pop() || 'image.jpg'); } catch { raw = 'image.jpg'; }
  const ext = '.' + ((raw.match(/\.(jpg|jpeg|png|gif|webp|avif)$/i) || [])[1] || 'jpg');
  const name = (raw.replace(/\.(jpg|jpeg|png|gif|webp|avif)$/i, '') || 'image').replace(/[^\w\u0100-\u017F\u4e00-\u9fff.-]/g, '-').slice(0, 60) + ext;
  const boundary = '----' + Math.random().toString(36).slice(2), ctype = res.headers.get('content-type') || 'image/jpeg';
  const r = await fetchWithRetry(`${site.url.replace(/\/+$/, '')}/media`, { method: 'POST', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'Authorization': wpAuth(site), 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${ctype}\r\n\r\n`), buf, Buffer.from(`\r\n--${boundary}--\r\n`)] ) });
  if (!r.ok) { log('error', `媒体上传失败: ${r.status}`); throw new Error(`媒体上传失败: ${r.status}`); }
  const j = await r.json(); if (!j?.source_url) throw new Error('媒体上传返回缺少 source_url'); return j.source_url;
}

function wpAuth(site) { return 'Basic ' + Buffer.from(`${site.user}:${process.env.WP_PASSWORD || site.pass}`).toString('base64'); }
async function uploadExternalImages(site, html) {
  const urls = [...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map(m => m[1]), results = {};
  const siteOrigin = (site.url.match(/https?:\/\/[^/]+/) || [''])[0];
  for (const url of urls) { if (url.startsWith(siteOrigin) || results[url]) continue; try { log('info', `  正在上传: ${url.slice(0, 60)}...`); results[url] = await uploadImage(site, url); log('info', `  → ${results[url]}`); } catch (e) { log('warn', `  ⚠ 上传失败: ${e.message}`); } }
  return results;
}

const categoryCache = new Map(), tagCache = new Map();
async function findOrCreate(site, type, name, cache) {
  const key = `${site.url}:${name}`; if (cache.has(key)) return cache.get(key);
  let items = [], page = 1;
  while (true) { const batch = await wpFetch(site, `${type}?per_page=100&page=${page}`); items = items.concat(batch); if (batch.length < 100) break; page++; }
  let item = items.find(i => i.name === name || i.slug === name);
  if (!item) { try { item = await wpFetch(site, type, { method: 'POST', body: JSON.stringify({ name, slug: name.toLowerCase().replace(/\s+/g, '-') }) }); } catch (e) { if (e.message?.includes('already exists') || e.message?.includes('term_exists')) { const existing = await wpFetch(site, `${type}?search=${encodeURIComponent(name)}`); item = existing.find(i => i.name === name || i.slug === name); if (!item) throw e; } else throw e; } }
  cache.set(key, item.id); return item.id;
}

async function checkDuplicate(site, title) { const posts = await wpFetch(site, `posts?search=${encodeURIComponent(title.slice(0, 100))}&status=any&per_page=20`); return posts.find(p => p.title && p.title.rendered === title) || null; }

async function resolveCategoryIds(site, cats) { return Promise.all(asArray(cats).map(c => { const isId = typeof c === 'number' || /^\d+$/.test(String(c)); return isId ? String(c) : findOrCreate(site, 'categories', c, categoryCache); })); }

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
  const imgAlt = u => { try { const n = decodeURIComponent(new URL(u, 'http://x').pathname).split('/').pop().replace(/\.[^.]+$/, ''); return (n || 'image').replace(/[-_]+/g, ' ').trim(); } catch { return 'image'; } };
  const parts = [];
  let last = 0;
  let si = 0;
  for (let i = 0; i < used.length && si < slots.length; i++) {
    const pos = slots[Math.min(si, slots.length - 1)];
    const a = imgAlt(used[i]);
    parts.push(html.slice(last, pos));
    parts.push(`<figure><img src="${used[i]}" alt="${a}" title="${a}" loading="lazy" style="max-width:100%;height:auto;border-radius:8px;margin:1em 0"></figure>`);
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
  const wordCount = text.split(/[\s]+/).filter(Boolean).length;
  const paras = body.match(PARA_RE) || [];
  const h3 = body.match(/<h3[^>]*>/g) || [];
  const checks = [[wordCount < 5000, `词数 ${wordCount} 少于 5000`], [paras.length < 10, `仅有 ${paras.length} 个段落`], [h3.length < 3, `仅有 ${h3.length} 个 H3 标题`], [!title || title.length < 10, `标题过短 (${title?.length || 0} 字符)`], [!excerpt || excerpt.length < 50, `摘要过短 (${excerpt?.length || 0} 字符)`], [!tags || tags.length < 3, `仅有 ${tags?.length || 0} 个标签`], [tags && tags.length > 10, `标签过多 (${tags.length} 个)`]];
  for (const [c, m] of checks) if (c) issues.push(m);
  const siteOrigin = (site.url.match(/https?:\/\/[^/]+/) || [''])[0];
  // 一次性提取所有 href 链接，复用于内链/外链/死链检测
  const allLinks = [...body.matchAll(/href="(https?:\/\/[^"]+)"/g)].map(m => m[1]);
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
  if (allLinks.length) {
    const codes = await Promise.all(allLinks.slice(0, 3).map(u => fetch(u, { method: 'GET', signal: AbortSignal.timeout(5000), redirect: 'follow' }).then(r => r.status).catch(() => null)));
    const dead = codes.filter(c => c !== null && c >= 400 && c < 500).length;
    if (dead) issues.push(`失效链接: ${dead} 个`);
  }
  return { issues, warnings };
}

// ── 安装 ──
const AGENTS_SKILLS = { claude: { name: 'Claude Code', dir: ['.claude', 'skills'], invoke: '/wpb', check: 'claude' }, codex: { name: 'OpenAI Codex', dir: ['.codex', 'skills'], invoke: '@wpb', check: 'codex' }, gemini: { name: 'Gemini CLI', dir: ['.gemini', 'skills'], invoke: '/wpb', check: 'gemini' }, antigravity: { name: 'Antigravity CLI', dir: ['.antigravity', 'skills'], invoke: '/wpb', check: 'antigravity' }, openclaw: { name: 'OpenClaw', dir: ['.openclaw', 'skills'], invoke: '/wpb', check: 'openclaw' }, 'uos-ai': { name: '小U同学', dir: ['.uos-ai', 'skills'], invoke: '/wpb', check: 'uos-ai' }, cursor: { name: 'Cursor', dir: ['.cursor', 'skills'], invoke: '/wpb', check: 'cursor' }, copilot: { name: 'GitHub Copilot', dir: ['.github', 'skills'], invoke: '/wpb', check: 'copilot' }, opencode: { name: 'OpenCode', dir: ['.config', 'opencode', 'skills'], invoke: '/wpb', check: 'opencode' }, hermes: { name: 'Hermes', dir: ['.hermes', 'skills'], invoke: '/wpb', check: 'hermes' }, zcode: { name: 'ZCode', dir: ['.zcode', 'skills'], invoke: '$wpb', check: 'zcode' } };

async function doInstall() {
  console.log('=== WordPress 发布器安装程序 ===\n');
  const SRC_DIR = dirname(fileURLToPath(import.meta.url));
  const DATA_SRC = join(SRC_DIR, '../references/data');
  const DATA_DST = join(WP_DIR, 'data');
  if (!existsSync(WP_DIR)) mkdirSync(WP_DIR, { recursive: true });

  // 用户手动运行 `wpb install`（TTY）时走完整 AI CLI 检测 + 命令文件创建流程；
  // 无 postinstall 钩子；npm 全局安装时用 symlink，脚本在 symlink 目标被清理后无法执行
  const checkCLI = cmd => { try { execSync(`${cmd} --version`, { stdio: 'ignore', timeout: 3000 }); return true; } catch { return false; }; };
  const detectedTools = Object.entries(AGENTS_SKILLS).map(([slug, tool]) => { const found = checkCLI(slug) || existsSync(join(homedir(), ...tool.dir.slice(0, -1))); console.log(found ? `  ✓ 检测到 ${tool.name}` : `  ✗ 未找到 ${tool.name}`); return found ? { ...tool, slug, path: join(homedir(), ...tool.dir) } : null; }).filter(Boolean);

  if (!detectedTools.length) { console.log('\n⚠ 未检测到任何已安装的 AI 工具，跳过命令文件创建。'); console.log('   如需安装，请先安装对应的 AI CLI，然后重新运行 wpb install。\n'); } else { console.log(`\n检测到 ${detectedTools.length} 个可安装工具：${detectedTools.map(t => t.name).join(', ')}\n`); const isTTY = process.stdin.isTTY; let selectedIndices = !isTTY ? (detectedTools.map((_, i) => i)) : await selectTools(detectedTools); if (!isTTY) console.log('⚠ 非 TTY 环境，使用默认配置：安装所有检测到的工具\n'); const selectedTools = selectedIndices.map(i => detectedTools[i]); console.log('\n正在创建 AI 工具命令文件...\n'); for (const tool of selectedTools) { const promptContent = generatePromptContent(tool); createCommandFile(tool, promptContent); } }

  console.log('=== 全局命令 ==='); console.log('✓ wpb 命令已通过 npm 全局安装自动注册'); console.log('  升级方式：npm update -g @lopinx/wpb');

  if (existsSync(DATA_SRC)) { const REF_FILES = ['keywords.csv', 'products.csv', 'prompts.md']; const REF_DIRS = ['extensions']; const cp = (src, dst) => { if (!existsSync(dst)) mkdirSync(dst, { recursive: true }); for (const f of readdirSync(src)) { const s = join(src, f), d = join(dst, f); if (statSync(s).isDirectory()) { if (REF_DIRS.includes(f)) cp(s, d); } else if (REF_FILES.includes(f) || !existsSync(d)) writeFileSync(d, readFileSync(s)); } }; cp(DATA_SRC, DATA_DST); console.log('数据文件已复制到', DATA_DST); } else console.warn('⚠ 未找到数据源目录:', DATA_SRC); for (const d of [join(WP_DIR, 'data'), join(WP_DIR, 'data', 'extensions')]) if (!existsSync(d)) mkdirSync(d, { recursive: true });

  const promptsPath = join(WP_DIR, 'data', 'prompts.md'); if (!existsSync(promptsPath)) writeFileSync(promptsPath, `# 写作指令\n\n## 文章风格\n- 专业但不晦涩，适当使用行业术语\n- 段落控制在 3-5 句，使用小标题分隔\n- 开头要有引人入胜的 hook\n\n## 内容结构\n1. 引言 (1-2段)\n2. 主体 (3-5个小标题)\n3. 总结 (1段)\n\n## SEO 要求\n- 标题包含关键词\n- 摘要 120-160 字\n- 标签 3-5 个\n`, 'utf-8');
  const knowledgePath = join(WP_DIR, 'data', 'extensions', 'knowledge.md'); if (!existsSync(knowledgePath)) writeFileSync(knowledgePath, `# 领域知识\n\n## 行业术语\n- 保持专业度\n- 解释生僻术语\n\n## 注意事项\n- 避免过度营销\n- 引用来源\n`, 'utf-8');
  const keywordsPath = join(WP_DIR, 'data', 'keywords.csv'); if (!existsSync(keywordsPath)) writeFileSync(keywordsPath, '\uFEFF' + ['keyword', '人工智能趋势', 'Python入门指南', 'Web开发最佳实践', '云计算架构', '数据安全'].map(r => r.includes(',') ? `"${r}"` : r).join('\n') + '\n', 'utf-8');
  const productsPath = join(WP_DIR, 'data', 'products.csv'); if (!existsSync(productsPath)) writeFileSync(productsPath, '\uFEFF' + [['name', 'price', 'desc'], ['产品A', '99', '基础版'], ['产品B', '199', '高级版']].map(r => r.map(f => f.includes(',') ? `"${f}"` : f).join(',')).join('\n') + '\n', 'utf-8');

  if (existsSync(CFG)) { log('info', '配置文件已存在，跳过生成:', CFG); } else { writeFileSync(CFG, DEFAULT_CFG, 'utf-8'); console.log(`配置文件已生成: ${CFG}（请编辑后使用）`); }

  console.log(`\n=== 安装完成 ===`); console.log(`全局命令：wpb（任意目录可用：wpb pick / wpb publish）`); console.log(`升级方式：npm update -g @lopinx/wpb`); console.log(`配置文件：${CFG}`); console.log('\n安全建议：设置环境变量以避免明文存储在 TOML 中：\n  macOS/Linux (bash/zsh)：\n    export WP_PASSWORD="your-wordpress-password"\n    export AWS_ACCESS_KEY_ID="your-aws-access-key"\n    export AWS_SECRET_ACCESS_KEY="your-aws-secret-key"\n  Windows (PowerShell)：\n    $env:WP_PASSWORD="your-wordpress-password"\n    $env:AWS_ACCESS_KEY_ID="your-aws-access-key"\n    $env:AWS_SECRET_ACCESS_KEY="your-aws-secret-key"'); if (detectedTools.length) console.log(`\nAI 命令：${detectedTools.map(t => t.invoke).join(', ')}`);
}

function generatePromptContent(tool) { const skillPath = join(SCRIPT_DIR, '../SKILL.md'); if (existsSync(skillPath)) { const base = readFileSync(skillPath, 'utf-8'); return tool?.invoke ? `<!-- 调用前缀: ${tool.invoke} -->\n${base}` : base; } return `# WordPress Publisher Skill (${tool?.name || 'wpb'})\n\n## Purpose\n跨平台 WordPress 发布 CLI。工作流：wpb pick → 撰写 → wpb publish。\n\n## Workflow\n1. wpb pick — 选取关键词与配置\n2. 撰写文章草稿保存为 JSON 文件\n3. wpb publish <草稿文件路径> — 去重/质量检查/图片处理/发布\n\n## 注意\n- 数据文件支持 CSV/TXT/XLSX 格式\n- 安装方式：npm i -g github:lopinx/wpb`; }

function createCommandFile(tool, content) { const { dir } = tool; const filePath = join(homedir(), ...dir, 'wpb', 'SKILL.md'); try { if (!existsSync(dirname(filePath))) mkdirSync(dirname(filePath), { recursive: true }); writeFileSync(filePath, content, 'utf8'); console.log(`  ✓ 已创建 ${tool.name} 命令文件：${filePath}`); } catch (e) { console.warn(`  ✗ 创建 ${tool.name} 命令文件失败：${e.message}`); } }

function parseSelection(answer, total) { if (!answer) return []; const a = answer.toLowerCase().trim(); if (a === 'all') return Array.from({ length: total }, (_, i) => i); return a.split(',').map(s => parseInt(s.trim(), 10)).filter(i => !isNaN(i) && i >= 1 && i <= total).map(i => i - 1); }

async function selectTools(tools) { return new Promise(resolve => { console.log('\n请选择要安装的 AI 工具：\n'); tools.forEach((t, i) => console.log(`${i + 1}. ${t.name} — ${t.path}`)); console.log('\n输入选项编号（多个选项用逗号分隔），或输入 all 选择全部：'); const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question('', ans => { rl.close(); const s = parseSelection(ans, tools.length); if (!s.length) { console.log('\n错误：请输入有效的选项编号（1-数字）或 all\n'); resolve([]); } else resolve(s); }); }); }


const DEFAULT_CFG = `# ~/.wpb/setting.toml
[site.myblog]
name = "BuchMistrz"
url = "https://www.buchmistrz.com/wp-json/wp/v2"
user = "admin"
pass = "xxxx xxxx xxxx xxxx"  # WP Application Password
categories = [8603, "Disposable Vape"]  # 支持数字ID或名称，多个分类
keywords = ["data/keywords.xlsx"]  # 可多个
products = "data/products.xlsx"  # 可选
prompts = "data/prompts.md"  # 可选
extensions = []  # 可选

# 四种图片模式（选其一）：
# 1) S3 兼容 — mode="s3" 拉图池混排，endpoint 可选
# 2) 图片搜索 — mode="search" 通过 Serper.dev 等 API 搜索图片
# 3) CDN — mode="cdn" 远程URL原样保留
# 4) 不配 cdn 节点 → 自动上传到媒体库
#[site.myblog.cdn]
#mode = "s3"
#bucket = "my-bucket"
#region = "us-east-1"
#accessKeyId = "AKIA..."
#secretAccessKey = "..."
#prefix = "images/"
# endpoint 可选，不填则自动使用 AWS S3 地址
# 支持：Cloudflare R2 / Amazon S3 / Kodo / MinIO / Ceph / 任意 S3 兼容存储
#endpoint = "https://s3.us-east-1.qiniucs.com"
#domain = "cdn.example.com"  # S3 模式可选，自定义图片 URL 前缀（留空则用 endpoint）
#
# 图片搜索 API（配合 cdn.mode="search" 使用）
#[site.myblog.images]
#keys = ["your-serper-dev-api-key-1", "your-serper-dev-api-key-2"]  # 随机轮询
#gl = "pl"                # 国家代码，默认 pl（波兰）
#hl = "pl"                # 语言代码，默认 pl
#tbs = "qdr:w"            # 时间范围，默认过去一周
#query = "固定搜索词"           # 可选，填写后直接使用该词搜索图片（忽略文章标题+标签）
`;

// ── 首次运行自动初始化（不依赖 xlsx，仅用 Node 标准库）──
function initConfig() {
  if (!existsSync(WP_DIR)) mkdirSync(WP_DIR, { recursive: true });
  const DATA_DST = join(WP_DIR, 'data');
  const DATA_SRC = join(SCRIPT_DIR, '..', 'references', 'data');
  if (!existsSync(DATA_DST)) mkdirSync(DATA_DST, { recursive: true });
  // 复制 references/data/ 到 ~/.wpb/data/
  if (existsSync(DATA_SRC)) {
    for (const f of readdirSync(DATA_SRC)) {
      const s = join(DATA_SRC, f), d = join(DATA_DST, f);
      if (statSync(s).isDirectory()) {
        if (!existsSync(d)) mkdirSync(d, { recursive: true });
        for (const sub of readdirSync(s)) { const dst = join(d, sub); if (!existsSync(dst)) copyFileSync(join(s, sub), dst); }
      } else { if (!existsSync(d)) copyFileSync(s, d); }
    }
  }
  for (const d of [DATA_DST, join(DATA_DST, 'extensions')]) if (!existsSync(d)) mkdirSync(d, { recursive: true });
  // 兜底生成缺失的默认数据文件
  const promptsPath = join(DATA_DST, 'prompts.md');
  if (!existsSync(promptsPath)) writeFileSync(promptsPath, `# 写作指令\n\n## 文章风格\n- 专业但不晦涩，适当使用行业术语\n- 段落控制在 3-5 句，使用小标题分隔\n- 开头要有引人入胜的 hook\n\n## 内容结构\n1. 引言 (1-2段)\n2. 主体 (3-5个小标题)\n3. 总结 (1段)\n\n## SEO 要求\n- 标题包含关键词\n- 摘要 120-160 字\n- 标签 3-5 个\n`, 'utf-8');
  const knowledgePath = join(DATA_DST, 'extensions', 'knowledge.md');
  if (!existsSync(knowledgePath)) writeFileSync(knowledgePath, `# 领域知识\n\n## 行业术语\n- 保持专业度\n- 解释生僻术语\n\n## 注意事项\n- 避免过度营销\n- 引用来源\n`, 'utf-8');
  const keywordsPath = join(DATA_DST, 'keywords.csv');
  if (!existsSync(keywordsPath)) writeFileSync(keywordsPath, '\uFEFF' + ['keyword', '人工智能趋势', 'Python入门指南', 'Web开发最佳实践', '云计算架构', '数据安全'].map(r => r.includes(',') ? `"${r}"` : r).join('\n') + '\n', 'utf-8');
  const productsPath = join(DATA_DST, 'products.csv');
  if (!existsSync(productsPath)) writeFileSync(productsPath, '\uFEFF' + [['name', 'price', 'desc'], ['产品A', '99', '基础版'], ['产品B', '199', '高级版']].map(r => r.map(f => f.includes(',') ? `"${f}"` : f).join(',')).join('\n') + '\n', 'utf-8');
  // 生成 setting.toml
  writeFileSync(CFG, DEFAULT_CFG, 'utf-8');
  console.log(`[wpb] 配置文件已生成: ${CFG}`);
  console.log(`[wpb] 数据文件已复制到 ${DATA_DST}`);
}

// 导入 copyFileSync（initConfig 需要）

// ── 主函数 ──
async function main() {
  const cmd = process.argv[2] || 'pick';
  if (cmd === 'install') { await doInstall(); return; }
  if (cmd === 'init') die('未识别命令 "init"。如需初始化配置请用: wpb install\n用法: wpb [pick|publish <file>|install]');
  if (!['pick', 'publish'].includes(cmd)) die('用法: wpb [pick|publish <file>|install]');
  if (!existsSync(CFG)) { initConfig(); die(`首次运行：已生成默认配置 ${CFG}\n请编辑后重新运行: wpb ${cmd}`); }
  const cfg = parseToml(readFileSync(CFG, 'utf-8'));
  const sites = cfg.site || {}; const siteNames = Object.keys(sites);
  if (!siteNames.length) die('未配置任何站点');
  const siteName = siteNames[Math.floor(Math.random() * siteNames.length)], site = sites[siteName]; site.name = siteName;
  // 站点必填字段校验，提前给出明确错误而非在后续 API 调用中抛晦涩 TypeError
  for (const f of ['url', 'user', 'pass']) if (!site[f]) die(`站点 [site.${siteName}] 缺少必填字段: ${f}`);
  if (!site.url.includes('/wp-json/wp/v2')) log('warn', `站点 [site.${siteName}] 的 url 不含 /wp-json/wp/v2，WP REST API 调用可能失败`);
  const kwPaths = asArray(site.keywords).map(p => safePath(p)).filter(Boolean); const prodPath = safePath(site.products), promptPath = safePath(site.prompts), extPaths = (site.extensions || []).map(p => safePath(p));
  if (!kwPaths.length || !kwPaths.some(existsSync)) die(`未找到关键词文件: ${kwPaths.join(', ')}`);
  const keywords = (await Promise.all(kwPaths.filter(existsSync).map(readTable))).flat(); if (!keywords.length) die('关键词文件为空');
  const kw = keywords[Math.floor(Math.random() * keywords.length)]; const firstKey = kw ? Object.keys(kw)[0] : ''; const keyword = (kw && firstKey) ? kw[firstKey] : '';
  let products = []; if (prodPath && existsSync(prodPath)) products = await readTable(prodPath);
  let promptDoc = ''; if (promptPath && existsSync(promptPath)) promptDoc = readFileSync(promptPath, 'utf-8').slice(0, 3000);
  let extDocs = ''; for (const ep of extPaths) if (existsSync(ep)) extDocs += `\n\n--- ${ep.replace(/\\/g, '/').split('/').pop()} ---\n${readFileSync(ep, 'utf-8').slice(0, 2000)}`;
  let images = []; if (site.cdn && site.cdn.mode === 's3') { try { images = await s3List(site.cdn, 50); if (!images.length) log('warn', 'S3 图片池为空'); } catch (e) { log('warn', 'S3 不可用:', e.message); } }
  const safe = site.images ? { ...site.images, key: undefined, keys: undefined } : null;
  if (cmd === 'pick') { const pickWarnings = []; if (site.cdn && site.cdn.mode === 's3' && !images.length) pickWarnings.push('图片池为空，文章中的图片标签可能无法配图'); console.log(JSON.stringify({ site: { name: siteName, url: site.url, categories: site.categories, images: safe }, keyword, keywordRow: kw, products: products.slice(0, 5), images, prompts: promptDoc, extensions: extDocs, ...(pickWarnings.length ? { _warnings: pickWarnings } : {}) }, null, 2)); return; }

  // ── publish ──
  const draftPath = process.argv[3];
  if (!draftPath) die('用法: wpb publish <草稿文件路径>');
  if (!existsSync(draftPath)) die('草稿文件不存在: ' + draftPath);
  let draft; try { draft = JSON.parse(readFileSync(draftPath, 'utf-8')); } catch (e) { die(`草稿文件 JSON 解析失败: ${e.message}\n文件: ${draftPath}`); }
  const v = validateDraft(draft); if (!v.valid) die('草稿验证失败: ' + v.errors.join('; '));
  const dup = await checkDuplicate(site, draft.title); if (dup) die(`检测到重复标题 (ID: ${dup.id})，请修改标题`);
  const q = await checkQuality(draft.title, draft.content, draft.excerpt, draft.tags || [], site); if (q.issues.length) die('质量检查不通过: ' + q.issues.join('; ')); if (q.warnings.length) q.warnings.forEach(w => log('warn', w));
  const catIds = await resolveCategoryIds(site, site.categories);
  let finalContent = draft.content; let tagIds = [];
  if (site.cdn && site.cdn.mode === 'search') { try { images = await searchImages(site.images || {}, draft.tags || [], draft.title); } catch (e) { log('warn', '图片搜索失败:', e.message); } if (images.length) finalContent = mixImages(finalContent, images); }
  else if (site.cdn && site.cdn.mode === 'cdn') { log('info', 'CDN 模式：保留远程图片 URL 不变'); }
  else { const up = await uploadExternalImages(site, finalContent); if (Object.keys(up).length) for (const [o, n] of Object.entries(up)) finalContent = finalContent.replaceAll(o, n); }
  if (draft.tags?.length) { for (const t of draft.tags) { try { const id = await findOrCreate(site, 'tags', t, tagCache); tagIds.push(id); } catch (e) { log('warn', `标签创建失败: ${t}`, e.message); } } }
  const res = await wpFetch(site, 'posts', { method: 'POST', body: JSON.stringify({ title: draft.title, content: finalContent, excerpt: draft.excerpt || '', status: 'publish', categories: catIds, tags: tagIds }) });
  log('info', `发布成功: ${res.link} (ID: ${res.id})`);
}

main().catch(e => die(e.message));