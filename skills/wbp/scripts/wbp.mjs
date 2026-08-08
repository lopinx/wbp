#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, writeSync, mkdirSync, chmodSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join, resolve, sep, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { createHash, createHmac } from 'crypto';
import readline from 'readline';

const TIMEOUT_MS = 30000, WP_DIR = join(homedir(), '.wbp'), CFG = join(WP_DIR, 'setting.toml'), DRAFT = join(WP_DIR, '_draft.json');
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LOG_LEVEL = process.env.WBP_LOG_LEVEL || 'info';
const LVL_IDX = { debug: 0, info: 1, warn: 2, error: 3 };
const log = (lvl, msg, data = {}, skipPrefix = false) => { if (LVL_IDX[lvl] < LVL_IDX[LOG_LEVEL]) return; const line = (skipPrefix ? '' : `[${new Date().toISOString()}] [${lvl.toUpperCase()}] `) + msg + (data && Object.keys(data).length ? ' ' + JSON.stringify(data) : ''); writeSync(lvl === 'error' || lvl === 'warn' ? 2 : 1, line + '\n'); };
const die = (msg, code = 1) => { try { writeSync(2, String(msg) + '\n'); } catch {}; process.exit(code); };
const PARA_RE = /<p[^>]*>[\s\S]*?<\/p>/g;
const asArray = x => Array.isArray(x) ? x : [x];
const isAbsPath = p => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);
const safePath = p => { if (!p) return null; const a = isAbsPath(p) ? resolve(p) : resolve(WP_DIR, p); if (!isAbsPath(p) && a !== WP_DIR && !a.startsWith(WP_DIR + sep)) throw new Error(`路径越界 ~/.wbp: ${p} (解析为 ${a})`); return a; };
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

// ── CSV/TXT 读取器（零依赖）──
function parseCSV(c) { if (c.charCodeAt(0) === 0xFEFF) c = c.slice(1); const rows = []; let row = [], f = '', q = false; for (let i = 0; i < c.length; i++) { const ch = c[i]; if (q) { if (ch === '"') { if (c[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; } else { if (ch === '"') q = true; else if (ch === ',') { row.push(f); f = ''; } else if (ch === '\r') {} else if (ch === '\n') { row.push(f); rows.push(row); row = []; f = ''; } else f += ch; } } if (f.length || row.length) { row.push(f); rows.push(row); } return rows.filter(r => r.some(v => v.trim() !== '')).slice(1); }
function parseTXT(c) { if (c.charCodeAt(0) === 0xFEFF) c = c.slice(1); const lines = c.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim() !== ''); if (lines.length <= 1) return []; const h = lines[0], s = h.includes('\t') ? '\t' : (h.includes(';') ? ';' : null); return lines.slice(1).map(l => s ? l.split(s) : [l]); }
async function readTable(p) { if (!existsSync(p)) throw new Error('文件未找到: ' + p); const e = p.toLowerCase().slice(p.lastIndexOf('.')); const c = readFileSync(p, 'utf-8'); if (e === '.csv') return parseCSV(c); if (e === '.txt') return parseTXT(c); throw new Error('不支持的数据格式 ' + e + '，请另存为 CSV 或 TXT: ' + p); }

// ── 图片搜索 ──
async function searchImages(cfg, tags, title) {
  const keys = cfg.keys || (cfg.key ? [cfg.key] : []); if (!keys.length) { log('warn', '  ⚠ 未配置 images.keys'); return []; }
  const key = keys[Math.floor(Math.random() * keys.length)];
  const { gl = 'pl', hl = 'pl', tbs = 'qdr:w' } = cfg;
  const keep = (tags || []).filter(t => t.length > 2 && !/^\d+\s*(in|pack|pcs|set|pairs?|stk|ctn|box|bag|roll|sheets?|ml|g|kg|cm|mm|inch)/i.test(t));
  const q = [...keep, title].filter(Boolean).join(' ').slice(0, 100);
  const res = await fetchWithRetry('https://google.serper.dev/images', { method: 'POST', headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ q, gl, hl, tbs }) });
  if (!res.ok) { log('warn', `  图片搜索失败: ${res.status}`); return []; }
  let data; try { data = await res.json(); } catch { log('warn', '  图片搜索响应解析失败'); return []; }
  if (!data.images || !data.images.length) { log('warn', '  图片搜索返回空结果'); return []; }
  return data.images.map(i => i.imageUrl).filter(u => u && /^https?:\/\//.test(u));
}

async function fetchWithRetry(url, opts, retries = 3) {
  const timeout = opts?.signal ? undefined : TIMEOUT_MS;
  for (let i = 0; i <= retries; i++) {
    try { const res = await fetch(url, { ...opts, signal: timeout ? AbortSignal.timeout(timeout) : opts.signal }); if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) return res; if (i >= retries) return res; const d = 1000 * 2 ** i + Math.random() * 200; log('warn', `  请求失败 (${res.status})，${Math.round(d)}ms 后重试...`); await new Promise(r => setTimeout(r, d)); } catch (e) { if (i >= retries) throw e; const d = 1000 * 2 ** i + Math.random() * 200; log('warn', `  请求错误: ${e.message}，${Math.round(d)}ms 后重试...`); await new Promise(r => setTimeout(r, d)); }
  }
}

// ── S3 列表 ──
async function s3List(cfg, limit) {
  const { endpoint, region, bucket, accessKeyId, secretAccessKey } = cfg;
  const host = new URL(endpoint).host;
  const date = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const sign = (msg, key) => createHmac('sha256', key).update(msg).digest('hex');
  const kDate = sign(date.slice(0, 8), 'AWS4' + secretAccessKey);
  const kRegion = sign(region, kDate);
  const kService = sign('s3', kRegion);
  const kSigning = sign('aws4_request', kService);
  const auth = 'AWS4-HMAC-SHA256 Credential=' + accessKeyId + '/' + date.slice(0, 8) + '/' + region + '/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=' + sign('AWS4-HMAC-SHA256\n' + date + '\n' + date.slice(0, 8) + '/' + region + '/s3/aws4_request\n' + createHash('sha256').update('').digest('hex'), kSigning);
  const res = await fetchWithRetry(endpoint.replace(/\/$/, '') + '/?list-type=2&max-keys=' + limit, { headers: { host, 'x-amz-date': date, 'x-amz-content-sha256': createHash('sha256').update('').digest('hex'), authorization: auth } });
  if (!res.ok) throw new Error('S3 列表失败: ' + res.status);
  const xml = await res.text();
  const files = xml.match(/<Key>([^<]+)<\/Key>/g)?.map(k => k.replace(/<\/?Key>/g, '')) || [];
  return files.filter(f => /\.(jpg|jpeg|png|gif|webp|avif)$/i.test(f)).map(f => endpoint.replace(/\/$/, '') + '/' + f);
}

// ── WP REST API ──
async function wpFetch(site, path, opts = {}) {
  const pass = process.env.WP_PASSWORD || site.pass;
  if (!process.env.WP_PASSWORD) log('warn', '警告: WP_PASSWORD 环境变量未设置，使用 TOML 配置（不安全）');
  const auth = 'Basic ' + Buffer.from(`${site.user}:${pass}`).toString('base64');
  const res = await fetchWithRetry(site.url.replace(/\/+$/, '') + '/' + path.replace(/^\//, ''), { ...opts, signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'Authorization': auth, 'Content-Type': 'application/json', ...opts.headers } });
  if (!res.ok) { const body = await res.text().catch(() => ''); log('error', `WP API 错误: ${res.status} ${res.statusText}`); throw new Error(`WP API ${res.status}: ${res.statusText}`); }
  return res.json();
}

async function uploadImage(site, imgUrl) {
  const res = await fetchWithRetry(imgUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error('获取图片失败: ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  let raw; try { raw = decodeURIComponent(imgUrl.split('?')[0].split('/').pop() || 'image.jpg'); } catch { raw = 'image.jpg'; }
  const ext = '.' + ((raw.match(/\.(jpg|jpeg|png|gif|webp|avif)$/i) || [])[1] || 'jpg');
  const name = (raw.replace(/\.(jpg|jpeg|png|gif|webp|avif)$/i, '') || 'image').replace(/[^\w一-鿿.-]/g, '-').slice(0, 60) + ext;
  const boundary = '----' + Math.random().toString(36).slice(2), ctype = res.headers.get('content-type') || 'image/jpeg';
  const r = await fetch(`${site.url.replace(/\/+$/, '')}/media`, { method: 'POST', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'Authorization': 'Basic ' + Buffer.from(`${site.user}:${process.env.WP_PASSWORD || site.pass}`).toString('base64'), 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${ctype}\r\n\r\n`), buf, Buffer.from(`\r\n--${boundary}--\r\n`)] ) });
  if (!r.ok) { const txt = await r.text().catch(() => ''); log('error', `媒体上传失败: ${r.status}`); throw new Error(`媒体上传失败: ${r.status}`); }
  const j = await r.json(); if (!j?.source_url) throw new Error('媒体上传返回缺少 source_url'); return j.source_url;
}

function uriEncode(s) { return encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()); }
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
function mixImages(html, images) {
  if (!images.length) return html;
  const paras = html.match(PARA_RE) || [];
  if (!paras.length) return html;
  const step = Math.max(1, Math.floor(paras.length / (images.length + 1)));
  const parts = [...paras];
  let i = 0;
  for (let j = Math.min(step, parts.length - 1); j < parts.length && i < images.length; j += step) {
    parts[j] = `<figure><img src="${images[i++]}" alt="" loading="lazy" style="max-width:100%;height:auto;border-radius:8px;margin:1em 0"></figure>\n${parts[j]}`;
  }
  return parts.join('');
}

// ── 质量检查 ──
async function checkQuality(title, content, excerpt, tags, site) { const issues = [], warnings = []; const text = (content || excerpt || '').replace(/<[^>]+>/g, ''); const wordCount = text.split(/[\s]+/).filter(Boolean).length; const paras = (content || excerpt || '').match(PARA_RE) || []; const h3 = (content || excerpt || '').match(/<h3[^>]*>/g) || []; const checks = [[wordCount < 60, `词数 ${wordCount} 少于 60`], [paras.length < 8, `仅有 ${paras.length} 个段落`], [h3.length < 3, `仅有 ${h3.length} 个 H3 标题`], [!title || title.length < 10, `标题过短 (${title?.length || 0} 字符)`], [!excerpt || excerpt.length < 50, `摘要过短 (${excerpt?.length || 0} 字符)`], [!tags || tags.length < 3, `仅有 ${tags?.length || 0} 个标签`], [tags && tags.length > 10, `标签过多 (${tags.length} 个)`]]; for (const [c, m] of checks) if (c) issues.push(m); const siteOrigin = (site.url.match(/https?:\/\/[^/]+/) || [''])[0]; if (siteOrigin) { const internalLinks = [...(content || '').matchAll(/href="(https?:\/\/[^"]+)"/g)].map(m => m[1]).filter(u => u && u.startsWith(siteOrigin)); if (!internalLinks.length) warnings.push('没有内部链接'); const rootRe = new RegExp('^' + siteOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/?$'); const navRe = new RegExp('^' + siteOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/(category|tag|tagi|kategoria|produkty|shop|blog)/?([^/]+/)?$'); const productLinks = internalLinks.filter(u => !rootRe.test(u) && !navRe.test(u)); if (productLinks.length < 3) warnings.push(`内链不足 (${productLinks.length} 条，建议≥3)`); } const kwList = asArray(tags || []).map(t => String(t).toLowerCase()).filter(t => t && t.length > 2); if (kwList.length) { const lower = text.toLowerCase(); const hit = kwList.filter(k => { const re = new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'); const m = lower.match(re); return m && m.length >= 2; }); if (!hit.length) warnings.push('关键词命中不足 (标签在正文出现均少于 2 次)'); } const extHref = [...(content || '').matchAll(/href="(https?:\/\/[^"]+)"/g)].map(m => m[1]).filter(u => !siteOrigin || !u.startsWith(siteOrigin)); if (!extHref.length) warnings.push('E-E-A-T 信号不足 (无外部权威外链，建议引用权威来源链接)'); const links = [...(content || '').matchAll(/href="(https?:\/\/[^"]+)"/g)].map(m => m[1]); if (links.length) { const codes = await Promise.all(links.slice(0, 3).map(u => fetch(u, { method: 'HEAD', signal: AbortSignal.timeout(5000), redirect: 'follow' }).then(r => r.status).catch(() => 500))); const dead = codes.filter(c => c >= 400).length; if (dead) issues.push(`失效链接: ${dead} 个`); } return { issues, warnings }; }

// ── 安装 ──
const AGENTS_SKILLS = { claude: { name: 'Claude Code', dir: ['.claude', 'skills'], invoke: '/wbp', check: 'claude' }, codex: { name: 'OpenAI Codex', dir: ['.codex', 'skills'], invoke: '@wbp', check: 'codex' }, gemini: { name: 'Gemini CLI', dir: ['.gemini', 'skills'], invoke: '/wbp', check: 'gemini' }, antigravity: { name: 'Antigravity CLI', dir: ['.antigravity', 'skills'], invoke: '/wbp', check: 'antigravity' }, openclaw: { name: 'OpenClaw', dir: ['.openclaw', 'skills'], invoke: '/wbp', check: 'openclaw' }, 'uos-ai': { name: '小U同学', dir: ['.uos-ai', 'skills'], invoke: '/wbp', check: 'uos-ai' }, cursor: { name: 'Cursor', dir: ['.cursor', 'skills'], invoke: '/wbp', check: 'cursor' }, copilot: { name: 'GitHub Copilot', dir: ['.github', 'skills'], invoke: '/wbp', check: 'copilot' }, opencode: { name: 'OpenCode', dir: ['.config', 'opencode', 'skills'], invoke: '/wbp', check: 'opencode' }, hermes: { name: 'Hermes', dir: ['.hermes', 'skills'], invoke: '/wbp', check: 'hermes' }, zcode: { name: 'ZCode', dir: ['.zcode', 'skills'], invoke: '$wbp', check: 'zcode' } };

async function doInstall() {
  console.log('=== WordPress 发布器安装程序 ===\n');
  const SRC_DIR = dirname(fileURLToPath(import.meta.url));
  const SRC_MJS = join(SRC_DIR, 'wbp.mjs');
  const DATA_SRC = join(SRC_DIR, '../references/data');
  const DATA_DST = join(WP_DIR, 'data');
  if (!existsSync(WP_DIR)) mkdirSync(WP_DIR, { recursive: true });

  const checkCLI = cmd => { try { execSync(`${cmd} --version`, { stdio: 'ignore', timeout: 3000 }); return true; } catch { return false; }; };
  const detectedTools = Object.entries(AGENTS_SKILLS).map(([slug, tool]) => { const found = checkCLI(slug) || existsSync(join(homedir(), ...tool.dir.slice(0, -1))); console.log(found ? `  ✓ 检测到 ${tool.name}` : `  ✗ 未找到 ${tool.name}`); return found ? { ...tool, slug, path: join(homedir(), ...tool.dir) } : null; }).filter(Boolean);

  if (!detectedTools.length) { console.log('\n⚠ 未检测到任何已安装的 AI 工具，跳过命令文件创建。'); console.log('   如需安装，请先安装对应的 AI CLI，然后重新运行 wbp install。\n'); } else { console.log(`\n检测到 ${detectedTools.length} 个可安装工具：${detectedTools.map(t => t.name).join(', ')}\n`); const nonInteractive = process.argv.includes('--non-interactive'); const isTTY = process.stdin.isTTY; let selectedIndices = (!isTTY || nonInteractive) ? (detectedTools.map((_, i) => i)) : await selectTools(detectedTools); if (!isTTY) console.log('⚠ 非 TTY 环境，使用默认配置：安装所有检测到的工具\n'); const selectedTools = selectedIndices.map(i => detectedTools[i]); console.log('\n正在创建 AI 工具命令文件...\n'); for (const tool of selectedTools) { const promptContent = generatePromptContent(tool); createCommandFile(tool, promptContent); } }

  console.log('=== 注册全局命令（npm link）==='); let linked = false; try { execSync('npm link', { cwd: SRC_DIR, stdio: 'inherit' }); try { chmodSync(SRC_MJS, 0o755); } catch {}; linked = true; console.log('✓ 全局命令 `wbp` 已注册（一处安装，git pull 即可升级）'); } catch (e) { console.warn('⚠ npm link 失败（可能无需全局目录写权限）：', e.message.split('\n')[0]); console.warn('  回退到本地复制模式，AI 命令将使用绝对路径调用。'); }

  if (existsSync(DATA_SRC)) { const REF_FILES = ['keywords.csv', 'products.csv', 'prompts.md']; const REF_DIRS = ['extensions']; const cp = (src, dst) => { if (!existsSync(dst)) mkdirSync(dst, { recursive: true }); for (const f of readdirSync(src)) { const s = join(src, f), d = join(dst, f); if (statSync(s).isDirectory()) { if (REF_DIRS.includes(f)) cp(s, d); } else if (REF_FILES.includes(f) || !existsSync(d)) writeFileSync(d, readFileSync(s)); } }; cp(DATA_SRC, DATA_DST); console.log('数据文件已复制到', DATA_DST); } else console.warn('⚠ 未找到数据源目录:', DATA_SRC); for (const d of [join(WP_DIR, 'data'), join(WP_DIR, 'data', 'extensions')]) if (!existsSync(d)) mkdirSync(d, { recursive: true });

  const promptsPath = join(WP_DIR, 'data', 'prompts.md'); if (!existsSync(promptsPath)) writeFileSync(promptsPath, `# 写作指令\n\n## 文章风格\n- 专业但不晦涩，适当使用行业术语\n- 段落控制在 3-5 句，使用小标题分隔\n- 开头要有引人入胜的 hook\n\n## 内容结构\n1. 引言 (1-2段)\n2. 主体 (3-5个小标题)\n3. 总结 (1段)\n\n## SEO 要求\n- 标题包含关键词\n- 摘要 120-160 字\n- 标签 3-5 个\n`, 'utf-8');
  const knowledgePath = join(WP_DIR, 'data', 'extensions', 'knowledge.md'); if (!existsSync(knowledgePath)) writeFileSync(knowledgePath, `# 领域知识\n\n## 行业术语\n- 保持专业度\n- 解释生僻术语\n\n## 注意事项\n- 避免过度营销\n- 引用来源\n`, 'utf-8');
  const keywordsPath = join(WP_DIR, 'data', 'keywords.csv'); if (!existsSync(keywordsPath)) writeFileSync(keywordsPath, '\uFEFF' + ['keyword', '人工智能趋势', 'Python入门指南', 'Web开发最佳实践', '云计算架构', '数据安全'].map(r => r.includes(',') ? `"${r}"` : r).join('\n') + '\n', 'utf-8');
  const productsPath = join(WP_DIR, 'data', 'products.csv'); if (!existsSync(productsPath)) writeFileSync(productsPath, '\uFEFF' + [['name', 'price', 'desc'], ['产品A', '99', '基础版'], ['产品B', '199', '高级版']].map(r => r.map(f => f.includes(',') ? `"${f}"` : f).join(',')).join('\n') + '\n', 'utf-8');

  console.log(`\n=== 安装完成 ===`); if (linked) { console.log(`全局命令：wbp（任意目录可用：wbp pick / wbp publish / wbp init）`); console.log(`升级方式：cd 仓库目录 && git pull（npm link 保持有效，无需重装）`); } else { console.log(`未全局化：直接 node ${join(SRC_DIR, 'wbp.mjs')} 调用`); } console.log(`配置文件：${join(WP_DIR, 'setting.toml')}（运行 wbp init 创建）`); console.log('\n安全建议：设置环境变量以避免明文存储在 TOML 中：\n  macOS/Linux (bash/zsh)：\n    export WP_PASSWORD="your-wordpress-password"\n    export AWS_ACCESS_KEY_ID="your-aws-access-key"\n    export AWS_SECRET_ACCESS_KEY="your-aws-secret-key"\n  Windows (PowerShell)：\n    $env:WP_PASSWORD="your-wordpress-password"\n    $env:AWS_ACCESS_KEY_ID="your-aws-access-key"\n    $env:AWS_SECRET_ACCESS_KEY="your-aws-secret-key"'); if (detectedTools.length) console.log(`\nAI 命令：${detectedTools.map(t => t.invoke).join(', ')}`);
  await doConfigWizard(process.argv.includes('--non-interactive'));
}

function generatePromptContent() { const skillPath = join(SCRIPT_DIR, '../SKILL.md'); if (existsSync(skillPath)) return readFileSync(skillPath, 'utf-8'); return `# WordPress Publisher Skill\n\n## Purpose\n跨平台 WordPress 发布 CLI。单命令工作流：wbp pick → 撰写 → wbp publish。\n\n## Workflow\n1. wbp pick — 选取关键词与配置\n2. 撰写文章草稿写入 ~/.wbp/_draft.json\n3. wbp publish ~/.wbp/_draft.json — 去重/质量检查/图片处理/发布\n\n## 注意\n- 数据文件为 CSV/TXT 格式（keywords.csv / products.csv）\n- 未全局化时直接 node <仓库>/skills/wbp/scripts/wbp.mjs 调用`; }

function createCommandFile(tool, content) { const { slug, dir, invoke } = tool; const filePath = join(homedir(), ...dir, 'wbp', 'SKILL.md'); try { if (!existsSync(dirname(filePath))) mkdirSync(dirname(filePath), { recursive: true }); writeFileSync(filePath, content, 'utf8'); console.log(`  ✓ 已创建 ${tool.name} 命令文件：${filePath}`); } catch (e) { console.warn(`  ✗ 创建 ${tool.name} 命令文件失败：${e.message}`); } }

function parseSelection(answer, total) { if (!answer) return []; const a = answer.toLowerCase().trim(); if (a === 'all') return Array.from({ length: total }, (_, i) => i); return a.split(',').map(s => parseInt(s.trim(), 10)).filter(i => !isNaN(i) && i >= 1 && i <= total); }

async function selectTools(tools) { return new Promise(resolve => { console.log('\n请选择要安装的 AI 工具：\n'); tools.forEach((t, i) => console.log(`${i + 1}. ${t.name} — ${t.path}`)); console.log('\n输入选项编号（多个选项用逗号分隔），或输入 all 选择全部：'); const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question('', ans => { rl.close(); const s = parseSelection(ans, tools.length); if (!s.length) { console.log('\n错误：请输入有效的选项编号（1-数字）或 all\n'); resolve([]); } else resolve(s); }); }); }

function parseCategories(c) { if (!c || !c.trim()) return []; return c.split(',').map(x => x.trim()).filter(x => x).map(x => { const n = Number(x); return x !== '' && !isNaN(n) && /^-?\d+$/.test(x) ? n : x; }); }

function tomlString(cfg) { const lines = []; const stringify = v => Array.isArray(v) ? JSON.stringify(v) : typeof v === 'object' && v !== null ? `{${Object.entries(v).map(([k, v]) => `${k} = ${stringify(v)}`).join(', ')}}` : typeof v === 'string' ? JSON.stringify(v) : String(v); const walk = (obj, prefix = '') => { for (const [k, v] of Object.entries(obj)) { const f = prefix ? `${prefix}.${k}` : k; if (typeof v === 'object' && v !== null) { if (Array.isArray(v)) lines.push(`${f} = ${JSON.stringify(v)}`); else walk(v, f); } else lines.push(`${f} = ${stringify(v)}`); } }; walk(cfg); return lines.join('\n'); }

async function doConfigWizard(nonInteractive = false) {
  const isTTY = process.stdin.isTTY === true;
  const DEFAULT_CFG = { site: { myblog: { name: 'My Blog', url: 'https://example.com/wp-json/wp/v2', user: 'admin', pass: 'abcd efgh ijkl mnop', categories: [1, 2, 3], keywords: ['data/keywords.csv'], products: 'data/products.csv', prompts: 'data/prompts.md', extensions: ['data/extensions/wiedza.md'], cdn: { mode: 's3' } } } };
  if (nonInteractive) { log('info', '非交互模式：使用默认配置'); writeFileSync(CFG, tomlString(DEFAULT_CFG), 'utf-8'); log('info', '配置文件已创建于', CFG); return; }
  let pipedLines = null;
  if (!isTTY) { try { const stdinContent = readFileSync(0, 'utf-8'); pipedLines = stdinContent.split('\n'); if (pipedLines.length === 0 || (pipedLines.length === 1 && pipedLines[0] === '')) { log('info', '非交互模式（无 stdin）：使用默认配置'); writeFileSync(CFG, tomlString(DEFAULT_CFG), 'utf-8'); log('info', '配置文件已创建于', CFG); return; } } catch { log('info', '非交互模式（stdin 不可读）：使用默认配置'); writeFileSync(CFG, tomlString(DEFAULT_CFG), 'utf-8'); log('info', '配置文件已创建于', CFG); return; } }
  const readline = isTTY ? (await import('readline').then(m => m.createInterface({ input: process.stdin, output: process.stdout }))) : null; let pipedIdx = 0;
  const isValidSlug = v => /^[A-Za-z_][A-Za-z0-9_]*$/.test(v);
  const questions = [{ key: 'slug', question: '站点点名（TOML section key，字母/数字/下划线，不以数字开头）', default: 'myblog', validator: v => isValidSlug(v) || '站点点名只能包含字母、数字、下划线，且不能以数字开头' }, { key: 'name', question: '站点名称', default: 'My Blog', validator: v => v.trim().length > 0 || '站点名称不能为空' }, { key: 'url', question: 'WP REST API 地址（如 https://example.com/wp-json/wp/v2）', default: 'https://example.com/wp-json/wp/v2', validator: v => /^https?:\/\/.+\/wp-json\/wp\/v2$/.test(v) || 'URL 格式不正确' }, { key: 'user', question: 'WordPress 用户名', default: 'admin', validator: v => v.trim().length > 0 || '用户名不能为空' }, { key: 'pass', question: 'WP Application Password', default: 'abcd efgh ijkl mnop', validator: v => v.trim().length >= 10 || '密码长度至少 10 个字符' }, { key: 'categories', question: '分类（用逗号分隔，可填数字 ID 或名称）', default: '1,2,3', validator: v => parseCategories(v).length > 0 || '至少需要一个分类' }, { key: 'keywords', question: '关键词文件路径（多个用逗号分隔，相对 ~/.wbp 或绝对路径）', default: 'data/keywords.csv', validator: v => v.trim().length > 0 || '关键词文件路径不能为空', transform: v => v.split(',').map(s => s.trim()).filter(Boolean) }, { key: 'products', question: '产品文件路径（相对 ~/.wbp 或绝对路径）', default: 'data/products.csv', validator: v => v.trim().length > 0 || '产品文件路径不能为空' }, { key: 'prompts', question: '提示文件路径（相对 ~/.wbp 或绝对路径）', default: 'data/prompts.md', validator: v => v.trim().length > 0 || '提示文件路径不能为空' }, { key: 'extensions', question: '扩展文件路径（多个用逗号分隔，相对 ~/.wbp 或绝对路径）', default: 'data/extensions/wiedza.md', validator: v => v.trim().length > 0 || '扩展文件路径不能为空', transform: v => v.split(',').map(s => s.trim()).filter(Boolean) }, { key: 'cdn.mode', question: '图片模式（s3/search/cdn/不配置）', default: 's3', validator: v => ['s3', 'search', 'cdn'].includes(v.toLowerCase()) || '模式必须是 s3/search/cdn' }];
  const answers = {}; for (const q of questions) { let value; if (isTTY) { value = await new Promise(r => readline.question(`${q.question} [${q.default}]: `, input => r((input.trim() || q.default)))); } else { const line = pipedIdx < pipedLines.length ? pipedLines[pipedIdx++] : ''; value = (line || '').trim() || q.default; } const error = q.validator(value); if (error !== true) { log('error', String(error)); try { if (readline) readline.close(); } catch {}; process.exit(1); } answers[q.key] = q.transform ? q.transform(value) : value; }
  const config = { site: { [answers.slug]: { name: answers.name, url: answers.url, user: answers.user, pass: answers.pass, categories: parseCategories(answers.categories), keywords: answers.keywords, products: answers.products, prompts: answers.prompts, extensions: answers.extensions, cdn: { mode: answers['cdn.mode'] } } } }; writeFileSync(CFG, tomlString(config), 'utf-8'); log('info', '配置文件已创建于', CFG); if (readline) readline.close(); }

// ── 主函数 ──
async function main() {
  const cmd = process.argv[2] || 'pick'; const nonInteractive = process.argv.includes('--non-interactive');
  if (cmd === 'install') { await doInstall(); return; }
  if (cmd === 'init') { await doConfigWizard(nonInteractive); return; }
  if (!['pick', 'publish'].includes(cmd)) die('用法: node wbp.mjs [pick|publish <file>|init|install]');
  if (!existsSync(CFG)) die('未找到配置文件。请运行: node wbp.mjs init');
  const cfg = parseToml(readFileSync(CFG, 'utf-8'));
  const sites = cfg.site || {}; const siteNames = Object.keys(sites);
  if (!siteNames.length) die('未配置任何站点');
  const siteName = siteNames[Math.floor(Math.random() * siteNames.length)], site = sites[siteName]; site.name = siteName;
  const kwPaths = asArray(site.keywords).map(p => safePath(p)).filter(Boolean); const prodPath = safePath(site.products), promptPath = safePath(site.prompts), extPaths = (site.extensions || []).map(p => safePath(p));
  if (!kwPaths.length || !kwPaths.some(existsSync)) die(`未找到关键词文件: ${kwPaths.join(', ')}`);
  const keywords = (await Promise.all(kwPaths.filter(existsSync).map(readTable))).flat(); if (!keywords.length) die('关键词文件为空');
  const kw = keywords[Math.floor(Math.random() * keywords.length)], kwKeys = Object.keys(kw[0]); const keyword = kw[kwKeys[0]] || kw.keyword || kw.name || '';
  let products = []; if (prodPath && existsSync(prodPath)) products = await readTable(prodPath);
  let promptDoc = ''; if (promptPath && existsSync(promptPath)) promptDoc = readFileSync(promptPath, 'utf-8').slice(0, 3000);
  let extDocs = ''; for (const ep of extPaths) if (existsSync(ep)) extDocs += `\n\n--- ${ep.replace(/\\/g, '/').split('/').pop()} ---\n${readFileSync(ep, 'utf-8').slice(0, 2000)}`;
  let images = []; if (site.cdn && site.cdn.mode === 's3') { try { images = await s3List(site.cdn, 50); } catch (e) { log('warn', 'S3 不可用:', e.message); } }
  const safe = site.images ? { ...site.images, key: undefined } : null;
  if (process.argv[2] === 'pick') { console.log(JSON.stringify({ site: { name: siteName, url: site.url, categories: site.categories, images: safe }, keyword, keywordRow: kw, products: products.slice(0, 5), images, prompts: promptDoc, extensions: extDocs }, null, 2)); return; }

  // ── publish ──
  if (!existsSync(process.argv[3])) die('草稿文件不存在: ' + process.argv[3]);
  const draft = JSON.parse(readFileSync(process.argv[3], 'utf-8'));
  const v = validateDraft(draft); if (!v.valid) die('草稿验证失败: ' + v.errors.join('; '));
  const dup = await checkDuplicate(site, draft.title); if (dup) die(`检测到重复标题 (ID: ${dup.id})，请修改标题`);
  const q = await checkQuality(draft.title, draft.content, draft.excerpt, draft.tags || [], site); if (q.issues.length) die('质量检查不通过: ' + q.issues.join('; ')); if (q.warnings.length) q.warnings.forEach(w => log('warn', w));
  const catIds = await resolveCategoryIds(site, site.categories);
  let finalContent = draft.content; let tagIds = [];
  if (site.cdn && site.cdn.mode === 'search') { try { images = await searchImages(site.images || {}, draft.tags || [], draft.title); } catch (e) { log('warn', '图片搜索失败:', e.message); } if (images.length) finalContent = mixImages(finalContent, images); }
  else if (site.cdn && site.cdn.mode === 'cdn') { const up = await uploadExternalImages(site, finalContent); if (Object.keys(up).length) for (const [o, n] of Object.entries(up)) finalContent = finalContent.replaceAll(o, n); }
  else { const up = await uploadExternalImages(site, finalContent); if (Object.keys(up).length) for (const [o, n] of Object.entries(up)) finalContent = finalContent.replaceAll(o, n); }
  if (draft.tags?.length) { for (const t of draft.tags) { try { const id = await findOrCreate(site, 'tags', t, tagCache); tagIds.push(id); } catch (e) { log('warn', `标签创建失败: ${t}`, e.message); } } }
  const res = await wpFetch(site, 'posts', { method: 'POST', body: JSON.stringify({ title: draft.title, content: finalContent, excerpt: draft.excerpt || '', status: 'publish', categories: catIds, tags: tagIds }) });
  log('info', `发布成功: ${res.link} (ID: ${res.id})`);
}

main().catch(e => die(e.message));