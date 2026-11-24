// solve.js — fast drop-in for makefun-site 1.0.0, written from SPEC prose only.
// ES module, dependency-free. run(input) is pure and synchronous; every cache
// is born and dies inside one run() call. No I/O, no Date, no randomness.
export function run(input) {
  const site = input.site || {};
  const templatesSrc = input.templates || {};
  const files = input.files || [];
  const slugify = makeSlugify();

  // ---- 1. Parse all templates (name ascending, code-unit) ----------------
  const templates = new Map();
  const report = [];
  const names = Object.keys(templatesSrc).sort();
  for (const name of names) {
    const parsed = parseTemplate(templatesSrc[name]);
    templates.set(name, parsed);
    if (!parsed.ok) report.push(`template "${name}": ${parsed.reason}`);
  }
  const base = (site.base_url || '').replace(/\/+$/, '');

  // ---- 2. Read sources, sorted by path (code-unit) -----------------------
  const sorted = files.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const sources = [];
  const statics = [];
  for (const f of sorted) {
    if (f.path.endsWith('.md')) sources.push(f); else statics.push(f);
  }

  // ---- 3-4. Front matter + refusal checks (exact order) ------------------
  const built = [];
  for (const f of sources) {
    const raw = f.content;
    const content = raw.indexOf('\r') === -1 ? raw : raw.replace(/\r\n?/g, '\n');
    const fm = parseFrontMatter(content);
    if (fm.error) { report.push(`refused ${f.path}: ${fm.error}`); continue; }
    const slash = f.path.indexOf('/');
    const firstDir = slash === -1 ? '' : f.path.slice(0, slash);
    if (firstDir === 'tags' || firstDir === 'page') {
      report.push(`refused ${f.path}: ${firstDir}/ is the generator's own`); continue;
    }
    const isPost = firstDir === 'posts';
    if (isPost && !('date' in fm.data)) {
      report.push(`refused ${f.path}: a post needs a date`); continue;
    }
    const layout = fm.data.layout || (isPost ? 'post' : 'page');
    const tmpl = templates.get(layout);
    if (!tmpl || !tmpl.ok) {
      report.push(`refused ${f.path}: layout "${layout}" is no template that parses`); continue;
    }
    if (fm.data.draft === true) { report.push(`draft ${f.path}`); continue; }
    built.push({ path: f.path, data: fm.data, body: fm.body, isPost });
  }

  // ---- 5. Permalinks ------------------------------------------------------
  const dirUsed = new Map();
  for (const b of built) {
    const dir = b.isPost ? 'posts' : sourceDir(b.path);
    let set = dirUsed.get(dir);
    if (!set) {
      set = new Set(dir === '' ? ['posts', 'tags', 'page'] : []);
      dirUsed.set(dir, set);
    }
    const slug = b.data.slug !== undefined ? b.data.slug : slugify(b.data.title);
    b.slug = uniqueSuffixed(set, slug);
    b.dir = dir;
    b.outPath = dir === '' ? b.slug + '/index.html' : dir + '/' + b.slug + '/index.html';
    b.url = base + (dir === '' ? '/' + b.slug + '/' : '/' + dir + '/' + b.slug + '/');
  }

  // ---- 6. Render Markdown bodies (links resolved, broken links logged) ---
  const builtMap = new Map();
  for (const b of built) builtMap.set(b.path, b.url);
  const staticSet = new Set();
  for (const f of statics) staticSet.add(f.path);
  const brokenSeen = new Set();
  function recordBroken(srcPath, target) {
    const key = srcPath + '\0' + target;
    if (!brokenSeen.has(key)) {
      brokenSeen.add(key);
      report.push(`broken-link ${srcPath} -> ${target}`);
    }
  }
  for (const b of built) {
    const resolve = makeResolver(b.path, base, builtMap, staticSet, recordBroken);
    const md = renderMarkdown(b.body, slugify, resolve);
    b.content = md.content;
    b.toc = md.toc;
    b.excerpt = md.excerpt;
    b.words = countWords(b.body);
  }

  // ---- 7. Post collection + newer/older chains ---------------------------
  const posts = built.filter((b) => b.isPost);
  posts.sort((a, b) => {
    if (a.data.date !== b.data.date) return a.data.date < b.data.date ? 1 : -1;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  for (let i = 0; i < posts.length; i++) {
    posts[i].newer = i > 0 ? posts[i - 1] : null;
    posts[i].older = i < posts.length - 1 ? posts[i + 1] : null;
  }

  // ---- 8. Tags ------------------------------------------------------------
  const tagBySlug = new Map();
  const tagList = [];
  for (const p of posts) {
    const seen = new Set();
    p.tagEntries = [];
    for (const name of (p.data.tags || [])) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      p.tagEntries.push({ name, slug });
      let g = tagBySlug.get(slug);
      if (!g) {
        g = { name, slug, url: base + '/tags/' + slug + '/', posts: [] };
        tagBySlug.set(slug, g);
        tagList.push(g);
      }
      g.posts.push(p);
    }
  }
  const globalTags = tagList.slice().sort((a, b) =>
    (b.posts.length - a.posts.length) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  for (const b of built) {
    if (b.isPost) continue;
    const seen = new Set();
    b.tagEntries = [];
    for (const name of (b.data.tags || [])) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      b.tagEntries.push({ name, slug });
    }
  }

  // Cards + pages, built once and reused (G5).
  for (const b of built) {
    b.card = makeCard(b, tagBySlug);
    b.page = makePage(b);
  }
  const siteVar = { title: site.title, base_url: site.base_url };
  const tagsVar = globalTags.map((g) => ({ name: g.name, slug: g.slug, url: g.url, count: g.posts.length }));
  const recentCards = posts.slice(0, site.recent || 0).map((p) => p.card);
  const rootVars = { site: siteVar, tags: tagsVar, recent: recentCards };

  // ---- 9. Layout ----------------------------------------------------------
  const out = {};
  for (const b of built) {
    const layout = b.data.layout || (b.isPost ? 'post' : 'page');
    const t = templates.get(layout);
    const scopes = [rootVars, { page: b.page }];
    const buf = [];
    renderNodes(t.nodes, scopes, buf, templates, 0);
    out[b.outPath] = buf.join('');
  }
  // Index pages.
  const perPage = site.per_page;
  const totalPages = Math.max(1, Math.ceil(posts.length / perPage));
  const indexTmpl = templates.get('index');
  if (indexTmpl && indexTmpl.ok) {
    for (let k = 1; k <= totalPages; k++) {
      const slice = posts.slice((k - 1) * perPage, k * perPage);
      const pager = {
        number: k,
        total: totalPages,
        url: k === 1 ? base + '/' : base + '/page/' + k + '/',
        newer_url: k === 1 ? '' : (k === 2 ? base + '/' : base + '/page/' + (k - 1) + '/'),
        older_url: k === totalPages ? '' : base + '/page/' + (k + 1) + '/',
      };
      const scopes = [rootVars, { posts: slice.map((p) => p.card), pager }];
      const buf = [];
      renderNodes(indexTmpl.nodes, scopes, buf, templates, 0);
      out[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = buf.join('');
    }
  }
  // Per-tag pages.
  const tagTmpl = templates.get('tag');
  if (tagTmpl && tagTmpl.ok) {
    for (const g of globalTags) {
      const tagVar = {
        name: g.name, slug: g.slug, url: g.url, count: g.posts.length,
        posts: g.posts.map((p) => p.card),
      };
      const scopes = [rootVars, { tag: tagVar }];
      const buf = [];
      renderNodes(tagTmpl.nodes, scopes, buf, templates, 0);
      out['tags/' + g.slug + '/index.html'] = buf.join('');
    }
  }
  // Tag list page.
  const tagsTmpl = templates.get('tags');
  if (tagsTmpl && tagsTmpl.ok) {
    const scopes = [rootVars];
    const buf = [];
    renderNodes(tagsTmpl.nodes, scopes, buf, templates, 0);
    out['tags/index.html'] = buf.join('');
  }
  // Static files.
  for (const f of statics) {
    if (Object.prototype.hasOwnProperty.call(out, f.path)) {
      report.push(`shadowed ${f.path}: a built page has its path`);
      continue;
    }
    out[f.path] = f.content;
  }

  // ---- 10. build-report.txt ----------------------------------------------
  report.sort();
  const P = built.length - posts.length;
  const Q = posts.length;
  const R = globalTags.length;
  const S = statics.length;
  let reportText = '';
  for (const line of report) reportText += line + '\n';
  reportText += `built ${P} pages, ${Q} posts, ${R} tags and ${S} static files\n`;
  out['build-report.txt'] = reportText;
  return out;
}

function sourceDir(path) {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

function uniqueSuffixed(set, slug) {
  if (!set.has(slug)) { set.add(slug); return slug; }
  let k = 2;
  while (set.has(slug + '-' + k)) k++;
  const r = slug + '-' + k;
  set.add(r);
  return r;
}

// ---------------------------------------------------------------------------
// HTML escaping (bulk, fast path when the run holds no escapable char).
// ---------------------------------------------------------------------------
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

const ESC_FIRST_RE = /[&<>"']/g;
const ESC_ALL_RE = /[&<>"']/g;

function escapeHtml(s, a, b) {
  if (a === undefined) { a = 0; b = s.length; }
  // One native scan for the first escapable char (lastIndex always reset
  // before exec, so the shared regex is safe under recursion elsewhere).
  ESC_FIRST_RE.lastIndex = a;
  const m = ESC_FIRST_RE.exec(s);
  if (!m || m.index >= b) return (a === 0 && b === s.length) ? s : s.slice(a, b);
  return s.slice(a, m.index) + s.slice(m.index, b).replace(ESC_ALL_RE, (ch) => ESC_MAP[ch]);
}

// ---------------------------------------------------------------------------
// slugify (SPEC section 4) with an ASCII fast path and a per-run memo.
// ---------------------------------------------------------------------------
function makeSlugify() {
  const cache = new Map();
  function slugify(text) {
    let r = cache.get(text);
    if (r !== undefined) return r;
    r = slugifySlow(text);
    cache.set(text, r);
    return r;
  }
  return slugify;
}

function slugifySlow(text) {
  let s = text;
  if (/[^\x00-\x7F]/.test(s)) s = s.normalize('NFKD').replace(/\p{M}/gu, '');
  const parts = [];
  let pend = false;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    let lower = -1;
    if (cp >= 65 && cp <= 90) lower = cp + 32;
    else if ((cp >= 97 && cp <= 122) || (cp >= 48 && cp <= 57)) lower = cp;
    if (lower >= 0) {
      if (pend && parts.length > 0) parts.push('-');
      pend = false;
      parts.push(String.fromCodePoint(lower));
    } else {
      pend = true;
    }
  }
  let out = parts.join('');
  if (out.length > 64) out = out.slice(0, 64);
  if (out.endsWith('-')) out = out.slice(0, -1);
  if (out === '') out = 'untitled';
  return out;
}

// ---------------------------------------------------------------------------
// Word count without allocation (SPEC G3): JS \s definition.
// ---------------------------------------------------------------------------
const WS_TABLE = new Uint8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF]) WS_TABLE[c] = 1;
for (let c = 0x2000; c <= 0x200A; c++) WS_TABLE[c] = 1;

function countWords(s) {
  let n = 0;
  let inW = false;
  for (let i = 0; i < s.length; i++) {
    if (WS_TABLE[s.charCodeAt(i)]) inW = false;
    else if (!inW) { n++; inW = true; }
  }
  return n;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function dateLong(dstr) {
  if (!dstr) return '';
  const m = +dstr.slice(5, 7);
  const d = +dstr.slice(8, 10);
  return d + ' ' + MONTHS[m - 1] + ' ' + dstr.slice(0, 4);
}

function cardTags(b, tagBySlug) {
  const out = [];
  for (const e of (b.tagEntries || [])) {
    const g = tagBySlug.get(e.slug);
    // Card shows the global tag object's spelling (first finder), not the
    // page's own spelling; url "" when no global object exists (stub).
    out.push({ name: g ? g.name : e.name, slug: e.slug, url: g ? g.url : '' });
  }
  return out;
}

function makeCard(b, tagBySlug) {
  return {
    title: b.data.title,
    url: b.url,
    date: b.data.date || '',
    date_long: b.data.date ? dateLong(b.data.date) : '',
    summary: b.data.summary || '',
    excerpt: b.excerpt,
    reading_minutes: Math.max(1, Math.ceil(b.words / 200)),
    tags: cardTags(b, tagBySlug),
  };
}

function makePage(b) {
  const card = b.card;
  const page = {
    title: card.title,
    url: card.url,
    date: card.date,
    date_long: card.date_long,
    summary: card.summary,
    excerpt: card.excerpt,
    reading_minutes: card.reading_minutes,
    tags: card.tags,
    slug: b.slug,
    content: b.content,
    toc: b.toc,
    newer: null,
    older: null,
    is_post: b.isPost,
  };
  if (b.newer) {
    page.newer = {
      title: b.newer.data.title, url: b.newer.url,
      date: b.newer.data.date || '',
      date_long: b.newer.data.date ? dateLong(b.newer.data.date) : '',
    };
  }
  if (b.older) {
    page.older = {
      title: b.older.data.title, url: b.older.url,
      date: b.older.data.date || '',
      date_long: b.older.data.date ? dateLong(b.older.data.date) : '',
    };
  }
  return page;
}

// ---------------------------------------------------------------------------
// Front matter (SPEC section 2).
// ---------------------------------------------------------------------------
const KNOWN_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const FM_LINE_RE = /^([a-z_]+):(?: (.*))?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LAYOUT_RE = /^[a-z0-9-]+$/;
const SLUG_KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function parseFrontMatter(content) {
  const nl0 = content.indexOf('\n');
  if ((nl0 === -1 ? content : content.slice(0, nl0)) !== '---') return { error: 'no front matter' };
  if (nl0 === -1) return { error: 'the front matter is not closed' };
  const fm = {};
  const seen = new Set();
  let pos = nl0 + 1;
  let lineNo = 2;
  for (;;) {
    const eol = content.indexOf('\n', pos);
    const lineEnd = eol === -1 ? content.length : eol;
    const line = content.slice(pos, lineEnd);
    if (line === '---') {
      if (!('title' in fm)) return { error: 'no title' };
      return { data: fm, body: eol === -1 ? '' : content.slice(eol + 1) };
    }
    const err = processFmLine(line, lineNo, fm, seen);
    if (err) return { error: err };
    if (eol === -1) return { error: 'the front matter is not closed' };
    pos = eol + 1;
    lineNo++;
  }
}

function processFmLine(line, n, fm, seen) {
  if (/^[ \t]*$/.test(line)) return null;
  if (line[0] === '#') return null;
  const m = FM_LINE_RE.exec(line);
  if (!m) return `line ${n} is not "key: value"`;
  const key = m[1];
  if (!KNOWN_KEYS.has(key)) return `unknown key "${key}"`;
  if (seen.has(key)) return `key "${key}" is given twice`;
  seen.add(key);
  if (m[2] === undefined) return `key "${key}" has no value`;
  const v = m[2].replace(/[ \t]+$/, '');
  const parsed = parseFmValue(key, v);
  if (parsed.error) return `key "${key}": ${parsed.error}`;
  fm[key] = parsed.value;
  return null;
}

function parseFmValue(key, v) {
  if (key === 'title' || key === 'summary') return parseFmString(v);
  if (key === 'date') {
    if (!DATE_RE.test(v)) return { error: 'not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    const y = +v.slice(0, 4);
    const mo = +v.slice(5, 7);
    const d = +v.slice(8, 10);
    if (y < 1970 || y > 2099 || mo < 1 || mo > 12) return { error: 'not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    const leap = (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0));
    const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
    if (d < 1 || d > dim) return { error: 'not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    return { value: v };
  }
  if (key === 'tags') {
    if (!(v[0] === '[' && v.length > 0 && v[v.length - 1] === ']')) {
      return { error: 'not a list [a, b]' };
    }
    const inner = v.slice(1, -1);
    if (/^\s*$/.test(inner)) return { value: [] };
    const items = inner.split(',');
    const out = [];
    for (let it of items) {
      it = it.trim();
      if (it === '' || it.includes('"') || it.includes('[') || it.includes(']')) {
        return { error: 'an empty tag, or one holding " [ or ]' };
      }
      out.push(it);
    }
    return { value: out };
  }
  if (key === 'draft') {
    if (v === 'true') return { value: true };
    if (v === 'false') return { value: false };
    return { error: 'true or false' };
  }
  if (key === 'layout') {
    if (!LAYOUT_RE.test(v)) return { error: 'not a layout name' };
    return { value: v };
  }
  // slug
  if (!SLUG_KEY_RE.test(v) || v.length > 64) return { error: 'not a slug' };
  return { value: v };
}

function parseFmString(v) {
  if (v[0] === '"') {
    if (v.length < 2 || v[v.length - 1] !== '"') return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < v.length - 1; i++) {
      const c = v[i];
      if (c === '\\') {
        if (i + 1 >= v.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        const d = v[i + 1];
        if (d !== '"' && d !== '\\') {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += d;
        i++;
      } else if (c === '"') {
        return { error: 'a quoted string holds a stray quote' };
      } else {
        out += c;
      }
    }
    return { value: out };
  }
  if (v[0] === '[') return { error: 'a bare string opens on [' };
  return { value: v };
}

// ---------------------------------------------------------------------------
// Link resolution (SPEC 5.2).
// ---------------------------------------------------------------------------
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function makeResolver(sourcePath, base, builtMap, staticSet, recordBroken) {
  const idx = sourcePath.lastIndexOf('/');
  const srcDir = idx === -1 ? '' : sourcePath.slice(0, idx);
  return function resolve(target) {
    if (SCHEME_RE.test(target) || target[0] === '/' || target[0] === '#') return target;
    let pathPart = target;
    let frag = '';
    const hash = target.indexOf('#');
    if (hash !== -1) { pathPart = target.slice(0, hash); frag = target.slice(hash); }
    const segs = srcDir === '' ? [] : srcDir.split('/');
    let failed = false;
    for (const seg of pathPart.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') {
        if (segs.length === 0) { failed = true; break; }
        segs.pop();
      } else {
        segs.push(seg);
      }
    }
    if (!failed) {
      const resolved = segs.join('/');
      if (builtMap.has(resolved)) return builtMap.get(resolved) + frag;
      if (staticSet.has(resolved)) return base + '/' + resolved + frag;
    }
    recordBroken(sourcePath, target);
    return target;
  };
}

// ---------------------------------------------------------------------------
// Markdown (SPEC section 5). Inline scanner is bulk (G1): it jumps to the
// next special char with indexOf and escapes plain runs wholesale.
// ---------------------------------------------------------------------------
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const FENCE_OPEN_RE = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE_RE = /^```[ \t]*$/;
const HEADING_RE = /^(#{1,6})[ \t]+(.*)$/;
const HR_RE = /^(---|\*\*\*)[ \t]*$/;
const ORDERED_RE = /^(\d{1,9})\. /;
const BLANK_RE = /^[ \t]*$/;

function isBlank(line) {
  if (line.length === 0) return true;
  const c = line[0];
  if (c !== ' ' && c !== '\t') return false;
  return BLANK_RE.test(line);
}

function renderMarkdown(body, slugify, resolve) {
  const lines = body.split('\n');
  const n = lines.length;
  const out = [];
  const toc = [];
  let excerpt = '';
  let haveExcerpt = false;
  const headingIds = new Set();
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    // 1. Fence.
    let m = line[0] === '`' ? FENCE_OPEN_RE.exec(line) : null;
    if (m) {
      const lang = m[1];
      const buf = [];
      i++;
      while (i < n && !(lines[i][0] === '`' && FENCE_CLOSE_RE.test(lines[i]))) { buf.push(lines[i]); i++; }
      if (i < n) i++;
      let html = '<pre><code' + (lang ? ' class="language-' + lang + '"' : '') + '>';
      for (const bl of buf) html += escapeHtml(bl) + '\n';
      html += '</code></pre>';
      out.push(html + '\n');
      continue;
    }
    // 2. Heading.
    m = line[0] === '#' ? HEADING_RE.exec(line) : null;
    if (m) {
      const text = m[2].replace(/[ \t]+$/, '');
      if (text !== '') {
        const level = m[1].length;
        let id = slugify(text);
        id = uniqueSuffixed(headingIds, id);
        const html = inline(text, resolve);
        out.push('<h' + level + ' id="' + id + '">' + html + '</h' + level + '>\n');
        if (level === 2 || level === 3) toc.push({ level, id, html });
        i++;
        continue;
      }
    }
    // 3. Thematic break.
    if ((line[0] === '-' || line[0] === '*') && HR_RE.test(line)) { out.push('<hr>\n'); i++; continue; }
    // 4. Blockquote.
    if (line[0] === '>') {
      const parts = [];
      while (i < n && lines[i][0] === '>') {
        let l = lines[i].slice(1);
        if (l[0] === ' ') l = l.slice(1);
        l = l.trim();
        if (l !== '') parts.push(l);
        i++;
      }
      if (parts.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else out.push('<blockquote>\n<p>' + inline(parts.join('\n'), resolve) + '</p>\n</blockquote>\n');
      continue;
    }
    // 5. List.
    const lm = listStart(line);
    if (lm) {
      const type = lm.type;
      const items = [[line.slice(lm.markerLen).trim()]];
      i++;
      while (i < n) {
        const l = lines[i];
        const nm = listStart(l);
        if (nm && nm.type === type) { items.push([l.slice(nm.markerLen).trim()]); i++; continue; }
        if (l.length >= 3 && l[0] === ' ' && l[1] === ' ' && /^ {2,}\S/.test(l)) { items[items.length - 1].push(l.trim()); i++; continue; }
        break;
      }
      let html;
      if (type === 'ul') {
        html = '<ul>\n';
        for (const it of items) html += '<li>' + inline(it.join('\n'), resolve) + '</li>\n';
        html += '</ul>';
      } else {
        html = lm.num === 1 ? '<ol>\n' : '<ol start="' + lm.num + '">\n';
        for (const it of items) html += '<li>' + inline(it.join('\n'), resolve) + '</li>\n';
        html += '</ol>';
      }
      out.push(html + '\n');
      continue;
    }
    // 6. Paragraph: stops only at blank, fence open, valid heading, hr.
    const para = [];
    while (i < n) {
      const l = lines[i];
      if (isBlank(l)) break;
      if (l[0] === '`' && FENCE_OPEN_RE.test(l)) break;
      const hm = l[0] === '#' ? HEADING_RE.exec(l) : null;
      if (hm && hm[2].replace(/[ \t]+$/, '') !== '') break;
      if ((l[0] === '-' || l[0] === '*') && HR_RE.test(l)) break;
      para.push(l.trim());
      i++;
    }
    const text = para.join('\n');
    const html = inline(text, resolve);
    if (!haveExcerpt) { excerpt = html; haveExcerpt = true; }
    out.push('<p>' + html + '</p>\n');
  }
  return { content: out.join(''), toc, excerpt };
}

function listStart(line) {
  if (line.startsWith('- ') || line.startsWith('* ')) return { type: 'ul', markerLen: 2, num: 0 };
  if (line.length === 0) return null;
  const c0 = line.charCodeAt(0);
  if (c0 < 48 || c0 > 57) return null;
  const m = ORDERED_RE.exec(line);
  if (m) return { type: 'ol', markerLen: m[0].length, num: parseInt(m[1], 10) };
  return null;
}

const INLINE_RE = /[\\`*[]/g;
const INLINE_PLAIN_RE = /[\\`*\[&<>"']/;

function inline(s, resolve) {
  // Lazy fast path (bench #3): a span with no Markdown special and no
  // HTML-escapable char renders exactly as itself — no array, no join.
  if (!INLINE_PLAIN_RE.test(s)) return s;
  const out = [];
  const n = s.length;
  let i = 0;
  while (i < n) {
    // One native scan for the next special char; lastIndex is reset before
    // every exec, so the shared regex stays correct across recursion.
    INLINE_RE.lastIndex = i;
    const mm = INLINE_RE.exec(s);
    const next = mm ? mm.index : n;
    if (next > i) { out.push(escapeHtml(s, i, next)); i = next; }
    if (i >= n) break;
    const c = s[i];
    if (c === '\\') {
      const d = s[i + 1];
      if (d !== undefined && ESCAPABLE.has(d)) { out.push(ESC_MAP[d] || d); i += 2; }
      else { out.push('\\'); i += 1; }
    } else if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j > i + 1) {
        out.push('<code>' + escapeHtml(s, i + 1, j) + '</code>');
        i = j + 1;
      } else {
        out.push('`'); i += 1;
      }
    } else if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findStrongClose(s, i + 2);
        if (j !== -1 && j > i + 2) {
          out.push('<strong>' + inline(s.slice(i + 2, j), resolve) + '</strong>');
          i = j + 2;
        } else {
          out.push('**'); i += 2;
        }
      } else {
        const j = findEmClose(s, i + 1);
        if (j !== -1) {
          out.push('<em>' + inline(s.slice(i + 1, j), resolve) + '</em>');
          i = j + 1;
        } else {
          out.push('*'); i += 1;
        }
      }
    } else if (c === '[') {
      const close = findBracketClose(s, i + 1);
      if (close !== -1 && s[close + 1] === '(') {
        const paren = s.indexOf(')', close + 2);
        if (paren !== -1) {
          const target = s.slice(close + 2, paren);
          if (target.length > 0 && !/\s/.test(target)) {
            out.push('<a href="' + escapeHtml(resolve(target)) + '">' +
              inline(s.slice(i + 1, close), resolve) + '</a>');
            i = paren + 1;
            continue;
          }
        }
      }
      out.push('['); i += 1;
    }
  }
  return out.join('');
}

// Escape-aware search for a closing `**`: backslash jumps two positions.
function findStrongClose(s, start) {
  let i = start;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '*' && s[i + 1] === '*') return i;
    i++;
  }
  return -1;
}

// Escape-aware search for a closing single `*`: `**` pairs are skipped.
function findEmClose(s, start) {
  let i = start;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '*') {
      if (s[i + 1] === '*') { i += 2; continue; }
      return i;
    }
    i++;
  }
  return -1;
}

// Escape-aware search for a closing `]`.
function findBracketClose(s, start) {
  let i = start;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === ']') return i;
    i++;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Template dialect (SPEC section 8): parse once per run() into a node tree,
// render with a slim scope stack and array join (G5).
// ---------------------------------------------------------------------------
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in ([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)$/;
const IF_NOT_RE = /^if not ([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)$/;
const IF_RE = /^if ([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

function isValidPath(t) { return PATH_RE.test(t); }

function parseTemplate(src) {
  const root = { kind: 'root', children: [] };
  const stack = [root];
  function curChildren() {
    const top = stack[stack.length - 1];
    if (top.kind === 'root') return top.children;
    if (top.kind === 'for') return top.node.children;
    return top.inElse ? top.node.elseChildren : top.node.thenChildren;
  }
  function pushText(t) {
    if (t !== '') curChildren().push({ kind: 'text', text: t });
  }
  const n = src.length;
  let pos = 0;
  let textStart = 0;
  while (pos < n) {
    const i1 = src.indexOf('{{', pos);
    const i2 = src.indexOf('{%', pos);
    let idx = -1;
    let isVar = false;
    let isTriple = false;
    if (i1 !== -1 && (i2 === -1 || i1 < i2)) {
      idx = i1; isVar = true; isTriple = src[i1 + 2] === '{';
    } else if (i2 !== -1) {
      idx = i2; isVar = false;
    }
    if (idx === -1) break;
    if (isVar) {
      const close = isTriple ? '}}}' : '}}';
      const end = src.indexOf(close, idx + (isTriple ? 3 : 2));
      if (end === -1) {
        return { ok: false, reason: isTriple ? 'a {{{ is not closed' : 'a {{ is not closed' };
      }
      pushText(src.slice(textStart, idx));
      const inner = src.slice(idx + (isTriple ? 3 : 2), end).trim();
      if (!isValidPath(inner)) return { ok: false, reason: `"${inner}" is not a path` };
      curChildren().push({ kind: 'var', path: inner.split('.'), raw: isTriple });
      pos = end + close.length;
      textStart = pos;
    } else {
      const end = src.indexOf('%}', idx + 2);
      if (end === -1) return { ok: false, reason: 'a {% is not closed' };
      const content = src.slice(idx + 2, end).trim();
      // Line-tag rule: a {% %} tag alone on its line (only spaces/tabs
      // before and after it on that line) consumes the whole line incl. \n.
      let consumeLine = false;
      let afterPos = end + 2;
      const lineStart = src.lastIndexOf('\n', idx - 1) + 1;
      const nlAfter = src.indexOf('\n', end + 2);
      const afterEnd = nlAfter === -1 ? n : nlAfter;
      if (/^[ \t]*$/.test(src.slice(lineStart, idx)) &&
          /^[ \t]*$/.test(src.slice(end + 2, afterEnd))) {
        consumeLine = true;
        afterPos = nlAfter === -1 ? n : nlAfter + 1;
      }
      pushText(src.slice(textStart, consumeLine ? lineStart : idx));
      const reason = handleTag(content, stack, curChildren);
      if (reason) return { ok: false, reason };
      pos = afterPos;
      textStart = pos;
    }
  }
  pushText(src.slice(textStart));
  if (stack.length > 1) {
    const top = stack[stack.length - 1];
    return { ok: false, reason: top.kind === 'for' ? 'a for is not closed' : 'a if is not closed' };
  }
  return { ok: true, nodes: root.children };
}

function handleTag(content, stack, curChildren) {
  const firstWord = content.split(/\s/, 1)[0];
  const top = stack[stack.length - 1];
  let m;
  if ((m = FOR_RE.exec(content))) {
    const node = { kind: 'for', varName: m[1], path: m[2].split('.'), children: [] };
    curChildren().push(node);
    stack.push({ kind: 'for', node });
    return null;
  }
  if ((m = IF_NOT_RE.exec(content))) {
    const node = { kind: 'if', path: m[1].split('.'), neg: true, thenChildren: [], elseChildren: null };
    curChildren().push(node);
    stack.push({ kind: 'if', node, inElse: false });
    return null;
  }
  if ((m = IF_RE.exec(content))) {
    const node = { kind: 'if', path: m[1].split('.'), neg: false, thenChildren: [], elseChildren: null };
    curChildren().push(node);
    stack.push({ kind: 'if', node, inElse: false });
    return null;
  }
  if (content === 'else') {
    if (top.kind === 'if' && !top.inElse) {
      top.inElse = true;
      top.node.elseChildren = [];
      return null;
    }
    return 'an else outside an if';
  }
  if (content === 'endfor') {
    if (top.kind === 'for') { stack.pop(); return null; }
    return 'an endfor with no open for';
  }
  if (content === 'endif') {
    if (top.kind === 'if') { stack.pop(); return null; }
    return 'an endif with no open if';
  }
  if ((m = INCLUDE_RE.exec(content))) {
    curChildren().push({ kind: 'include', name: m[1] });
    return null;
  }
  return `{% ${firstWord} %} is not a tag`;
}

function lookup(scopes, path) {
  const first = path[0];
  for (let s = scopes.length - 1; s >= 0; s--) {
    const scope = scopes[s];
    if (Object.prototype.hasOwnProperty.call(scope, first)) {
      let cur = scope[first];
      for (let i = 1; i < path.length; i++) {
        if (cur === null || typeof cur !== 'object' ||
            !Object.prototype.hasOwnProperty.call(cur, path[i])) return undefined;
        cur = cur[path[i]];
      }
      return cur;
    }
  }
  return undefined;
}

function valueToText(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(valueToText).join(', ');
  return '';
}

function isTruthy(v) {
  if (v === undefined || v === null || v === false) return false;
  if (v === '' || v === 0) return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}

function renderNodes(nodes, scopes, out, templates, depth) {
  for (const node of nodes) {
    if (node.kind === 'text') {
      out.push(node.text);
      continue;
    }
    if (node.kind === 'var') {
      const t = valueToText(lookup(scopes, node.path));
      out.push(node.raw ? t : escapeHtml(t));
      continue;
    }
    if (node.kind === 'for') {
      const v = lookup(scopes, node.path);
      if (!Array.isArray(v)) continue;
      const len = v.length;
      for (let idx = 0; idx < len; idx++) {
        const scope = {};
        scope[node.varName] = v[idx];
        scope.loop = { index: idx + 1, first: idx === 0, last: idx === len - 1, length: len };
        scopes.push(scope);
        renderNodes(node.children, scopes, out, templates, depth);
        scopes.pop();
      }
      continue;
    }
    if (node.kind === 'if') {
      const v = lookup(scopes, node.path);
      const cond = node.neg ? !isTruthy(v) : isTruthy(v);
      renderNodes(cond ? node.thenChildren : (node.elseChildren || []), scopes, out, templates, depth);
      continue;
    }
    if (node.kind === 'include') {
      if (depth + 1 >= 8) continue;
      const t = templates.get(node.name);
      if (!t || !t.ok) continue;
      renderNodes(t.nodes, scopes, out, templates, depth + 1);
      continue;
    }
  }
}
