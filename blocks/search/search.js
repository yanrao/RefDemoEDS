import {
  createOptimizedPicture,
  decorateIcons,
  getMetadata,
} from '../../scripts/aem.js';
import { fetchPlaceholders } from '../../scripts/placeholders.js';
import { getLanguage, getHostname } from '../../scripts/utils.js';
import { isAuthorEnvironment } from '../../scripts/scripts.js';

const searchParams = new URLSearchParams(window.location.search);

// --- Utilities ---
function debounce(fn, delay = 200) {
  let timerId;
  return (...args) => {
    clearTimeout(timerId);
    timerId = setTimeout(() => fn(...args), delay);
  };
}

function safeText(value) {
  return typeof value === 'string' ? value : '';
}

function findNextHeading(el) {
  let preceedingEl = el.parentElement.previousElement || el.parentElement.parentElement;
  let h = 'H2';
  while (preceedingEl) {
    const lastHeading = [...preceedingEl.querySelectorAll('h1, h2, h3, h4, h5, h6')].pop();
    if (lastHeading) {
      const level = parseInt(lastHeading.nodeName[1], 10);
      h = level < 6 ? `H${level + 1}` : 'H6';
      preceedingEl = false;
    } else {
      preceedingEl = preceedingEl.previousElement || preceedingEl.parentElement;
    }
  }
  // Default down to H4 to avoid very large headings inside result cards
  if (h === 'H2') return 'H4';
  return h;
}

function highlightTextElements(terms, elements) {
  elements.forEach((element) => {
    if (!element || !element.textContent) return;

    const matches = [];
    const { textContent } = element;
    terms.forEach((term) => {
      let start = 0;
      let offset = textContent.toLowerCase().indexOf(term.toLowerCase(), start);
      while (offset >= 0) {
        matches.push({ offset, term: textContent.substring(offset, offset + term.length) });
        start = offset + term.length;
        offset = textContent.toLowerCase().indexOf(term.toLowerCase(), start);
      }
    });

    if (!matches.length) {
      return;
    }

    matches.sort((a, b) => a.offset - b.offset);
    let currentIndex = 0;
    const fragment = matches.reduce((acc, { offset, term }) => {
      if (offset < currentIndex) return acc;
      const textBefore = textContent.substring(currentIndex, offset);
      if (textBefore) {
        acc.appendChild(document.createTextNode(textBefore));
      }
      const markedTerm = document.createElement('mark');
      markedTerm.textContent = term;
      acc.appendChild(markedTerm);
      currentIndex = offset + term.length;
      return acc;
    }, document.createDocumentFragment());
    const textAfter = textContent.substring(currentIndex);
    if (textAfter) {
      fragment.appendChild(document.createTextNode(textAfter));
    }
    element.innerHTML = '';
    element.appendChild(fragment);
  });
}

function getSnippet(result, searchTerms, searchPhrase) {
  const sourceText = (result.body || result.description || '').trim();
  if (!sourceText) return '';
  const lc = sourceText.toLowerCase();
  let bestIdx = -1;
  // Prefer exact phrase if present
  if (searchPhrase && searchPhrase.length >= 2) {
    const phraseIdx = lc.indexOf(searchPhrase);
    if (phraseIdx >= 0) bestIdx = phraseIdx;
  }
  searchTerms.forEach((t) => {
    const idx = lc.indexOf(t.toLowerCase());
    if (idx >= 0 && (bestIdx === -1 || idx < bestIdx)) bestIdx = idx;
  });
  let start = 0;
  let end = Math.min(sourceText.length, 180);
  if (bestIdx >= 0) {
    start = Math.max(0, bestIdx - 60);
    end = Math.min(sourceText.length, bestIdx + 120);
  }
  let snippet = sourceText.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) snippet = `… ${snippet}`;
  if (end < sourceText.length) snippet = `${snippet} …`;
  return snippet;
}

export async function fetchData(source) {
  try {
    const response = await fetch(source, { credentials: 'same-origin' });
    if (!response.ok) {
      // eslint-disable-next-line no-console
      console.error('[search] error loading index:', response.status, response.statusText);
      return [];
    }
    const json = await response.json();
    if (!json || !Array.isArray(json.data)) return [];
    return json.data;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[search] fetchData failed', e);
    return [];
  }
}

function applySearchPathFilter(data, searchPath) {
  const list = Array.isArray(data) ? data : [];
  const prefix = (searchPath || '').trim().toLowerCase();
  if (!prefix || prefix === '/' || prefix === '*') return list;
  return list.filter((r) => typeof r?.path === 'string' && r.path.toLowerCase().startsWith(prefix));
}

/* ── DAM Asset Search (merges assets into the page-search dataset) ─────
 * Asset records use the same shape as page-search records, with `path`
 * pointing at the asset URL and `contentType` set to its MIME type.
 * `image` is the asset itself for images, or empty for documents so the
 * renderer can fall back to an icon. */

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg']);
const DOC_EXTS = new Set(['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx']);

function extOf(name) {
  if (!name) return '';
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : '';
}

function inferMimeFromExt(ext) {
  if (!ext) return '';
  if (IMAGE_EXTS.has(ext)) return `image/${ext === 'jpg' ? 'jpeg' : ext}`;
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'doc' || ext === 'docx') return 'application/msword';
  if (ext === 'ppt' || ext === 'pptx') return 'application/vnd.ms-powerpoint';
  if (ext === 'xls' || ext === 'xlsx') return 'application/vnd.ms-excel';
  return '';
}

function isImageMime(mime) {
  return typeof mime === 'string' && mime.toLowerCase().startsWith('image/');
}

function isDocMime(mime) {
  if (typeof mime !== 'string') return false;
  const m = mime.toLowerCase();
  return /pdf|msword|wordprocessing|powerpoint|presentation|excel|spreadsheet/.test(m);
}

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return '';
  const num = Number(bytes);
  if (Number.isNaN(num) || num <= 0) return '';
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(0)} KB`;
  if (num < 1024 * 1024 * 1024) {
    return `${(num / (1024 * 1024)).toFixed(num < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }
  return `${(num / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatAssetDateTime(modifiedSec) {
  if (!Number.isFinite(modifiedSec) || modifiedSec <= 0) return '';
  const ms = modifiedSec < 1e12 ? modifiedSec * 1000 : modifiedSec;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  try {
    const locale = document.documentElement.lang || 'en';
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(d);
  } catch (_) {
    return d.toLocaleString();
  }
}

function isDamAssetResult(result) {
  return /\/content\/dam\//.test(result?.path || '');
}

function getAssetSizeLabel(result) {
  return formatBytes(result.size) || '';
}

function updateAssetSizeInActions(li, result) {
  const actions = li.querySelector('.search-result-asset-actions');
  if (!actions) return;
  let sizeEl = actions.querySelector('.search-result-asset-size');
  const sizeLabel = getAssetSizeLabel(result);
  if (sizeLabel) {
    if (!sizeEl) {
      sizeEl = document.createElement('span');
      sizeEl.className = 'search-result-asset-size';
      actions.append(sizeEl);
    }
    sizeEl.textContent = sizeLabel;
  } else if (sizeEl) {
    sizeEl.remove();
  }
}

function updateAssetResultMeta(li, result) {
  if (!isDamAssetResult(result)) {
    li.querySelector('.search-result-asset-date')?.remove();
    return;
  }
  updateAssetSizeInActions(li, result);
  const body = li.querySelector('.search-result-body');
  const title = li.querySelector('.search-result-title');
  const snippet = li.querySelector('.search-result-snippet');
  let dateEl = li.querySelector('.search-result-asset-date');
  const dateText = formatAssetDateTime(result.lastModified);
  if (dateText) {
    if (!dateEl) {
      dateEl = document.createElement('p');
      dateEl.className = 'search-result-asset-date';
    }
    dateEl.textContent = dateText;
    if (body) {
      if (dateEl.parentElement !== body) body.append(dateEl);
    } else {
      const insertAfter = snippet || title;
      if (insertAfter && dateEl.previousElementSibling !== insertAfter) {
        insertAfter.insertAdjacentElement('afterend', dateEl);
      }
    }
  } else if (dateEl) {
    dateEl.remove();
  }
}

function parseDamAssetNode(val) {
  const jcrContent = val['jcr:content'] || {};
  const meta = jcrContent.metadata || {};
  const renditions = jcrContent.renditions || {};
  const original = renditions.original || {};
  const originalContent = original['jcr:content'] || {};
  const mime = jcrContent['jcr:mimeType']
    || meta['dc:format']
    || originalContent['jcr:mimeType']
    || '';
  const size = Number(
    meta['dam:size']
      || originalContent['jcr:data']
      || jcrContent['jcr:data']
      || 0,
  );
  const modifiedRaw = meta['jcr:lastModified']
    || jcrContent['jcr:lastModified']
    || val['jcr:lastModified']
    || val['jcr:created']
    || '';
  let modifiedSec = 0;
  if (modifiedRaw) {
    const ms = new Date(modifiedRaw).getTime();
    if (Number.isFinite(ms)) modifiedSec = Math.floor(ms / 1000);
  }
  return { mime, size, modifiedSec };
}

// Build a single search-data record from one asset.
function assetToSearchRecord(name, mime, modifiedSec, parentPath, size = 0) {
  const ext = extOf(name);
  const inferredMime = mime || inferMimeFromExt(ext);
  const title = name.replace(/\.[^.]+$/, '');
  const path = `${parentPath.replace(/\/$/, '')}/${name}`;
  const sizeNum = Number(size);
  return {
    path,
    title,
    navTitle: title,
    description: '',
    body: '',
    tags: '',
    image: isImageMime(inferredMime) ? path : '',
    publishDate: Number.isFinite(modifiedSec) ? modifiedSec : 0,
    contentType: inferredMime,
    author: '',
    lastModified: Number.isFinite(modifiedSec) ? Math.floor(modifiedSec) : 0,
    size: Number.isFinite(sizeNum) && sizeNum > 0 ? sizeNum : 0,
    robots: '',
  };
}

function toAssetsApiPath(folderPath) {
  const clean = folderPath.replace(/\/$/, '').replace(/\.json$/, '');
  if (clean.startsWith('/api/assets/')) return `${clean}.json`;
  if (clean.startsWith('/content/dam/')) return `/api/assets/${clean.slice('/content/dam/'.length)}.json`;
  return `${clean}.json`;
}

// Normalize DAM folder path from block config (aem-content picker variants).
function normalizeAssetFolderPath(rawPath) {
  if (!rawPath) return '';
  let p = String(rawPath).trim();
  p = p.replace(/^urn:aemconnection:/i, '');
  try { p = decodeURIComponent(p); } catch (_) { /* keep as-is if malformed */ }
  p = p.replace(/\.json$/, '');
  p = p.replace(/\/$/, '');
  return p;
}

// Resolve the AEM origin to fetch asset listings from, per environment.
//   • author host    → '' (relative, same-origin works on author)
//   • localhost / aem.live / preview → publish AEM origin (anonymous read;
//     author requires login and returns 401 from localhost without a session)
async function resolveAssetListingBase() {
  if (isAuthorEnvironment()) return '';

  let hostname = '';
  try { hostname = (await getHostname()) || ''; } catch (_) { /* ignore */ }
  if (!hostname) hostname = getMetadata('hostname') || '';
  if (!hostname) return '';
  return hostname.replace('author', 'publish').replace(/\/$/, '');
}

const QUERYBUILDER_SERVLET = '/bin/querybuilder.json';

function normalizeSearchResultPath(path) {
  let p = String(path || '');
  if (/^https?:\/\//i.test(p)) {
    try { p = new URL(p).pathname; } catch (_) { /* keep as-is */ }
  }
  return p.replace(/\/$/, '').toLowerCase();
}

function buildExcludedPathMatcher(excludeRaw) {
  const prefixes = (excludeRaw || '')
    .split(/[,\n]+/)
    .map((p) => p.trim().replace(/\/$/, ''))
    .filter(Boolean);
  if (!prefixes.length) return null;
  return (recordPath) => {
    let p = String(recordPath || '');
    if (/^https?:\/\//i.test(p)) {
      try { p = new URL(p).pathname; } catch (_) { /* keep as-is */ }
    }
    return prefixes.some((pre) => p === pre || p.startsWith(`${pre}/`));
  };
}

// AEM QueryBuilder: full-text search inside PDF assets within a DAM folder.
// Builds a request like:
//   <host>/bin/querybuilder.json?path=<dam-folder>&type=dam:Asset
//     &property=jcr:content/metadata/dc:format&property.value=application/pdf
//     &fulltext=<keyword>&p.limit=50
// The host is resolved dynamically per environment; the folder path comes from
// the block's configured Asset Search Path.
async function fetchPdfSearchResults(keyword, folderPath) {
  const q = String(keyword || '').trim();
  if (q.length < 3) return [];

  const damRoot = normalizeAssetFolderPath(folderPath);
  if (!damRoot || !damRoot.startsWith('/content/dam/')) return [];

  const isAuthor = isAuthorEnvironment();
  const listingBase = isAuthor ? '' : await resolveAssetListingBase();
  if (!isAuthor && !listingBase) return [];

  const origin = isAuthor ? '' : listingBase;
  const params = new URLSearchParams({
    path: damRoot,
    type: 'dam:Asset',
    property: 'jcr:content/metadata/dc:format',
    'property.value': 'application/pdf',
    fulltext: q,
    'p.limit': '50',
  });
  const url = `${origin}${QUERYBUILDER_SERVLET}?${params.toString()}`;

  try {
    const res = await fetch(url, isAuthor ? { credentials: 'include' } : {});
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.warn('[search] querybuilder HTTP', res.status, url);
      return [];
    }
    const json = await res.json();
    const hits = Array.isArray(json?.hits) ? json.hits : [];
    if (!hits.length) return [];

    return hits
      .filter((hit) => hit && typeof hit.path === 'string' && hit.path.includes('/content/dam/'))
      .map((hit) => {
        const damPath = hit.path.replace(/\/$/, '');
        const fileName = hit.name || damPath.split('/').pop() || '';
        const title = (hit.title || fileName).replace(/\.[^.]+$/, '') || fileName;
        const snippet = safeText(hit.excerpt).trim();
        const fullPath = (!isAuthor && listingBase) ? `${listingBase}${damPath}` : damPath;
        let lastModified = 0;
        if (hit.lastModified) {
          const ms = new Date(hit.lastModified).getTime();
          if (Number.isFinite(ms)) lastModified = Math.floor(ms / 1000);
        }
        return {
          path: fullPath,
          title,
          navTitle: title,
          description: snippet,
          body: snippet,
          tags: '',
          image: '',
          publishDate: lastModified,
          contentType: 'application/pdf',
          author: '',
          lastModified,
          size: 0,
          robots: '',
          pdfTextMatch: true,
        };
      });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[search] querybuilder fetch failed', e);
    return [];
  }
}

// Merge PDF text hits into the search dataset without duplicating DAM assets.
function mergePdfSearchIntoData(data, pdfRecords) {
  if (!pdfRecords.length) return data;
  const list = Array.isArray(data) ? [...data] : [];
  const byPath = new Map();
  list.forEach((r) => byPath.set(normalizeSearchResultPath(r.path), r));

  pdfRecords.forEach((pdf) => {
    const key = normalizeSearchResultPath(pdf.path);
    const existing = byPath.get(key);
    if (existing) {
      const snippet = pdf.description || pdf.body;
      if (snippet && !existing.description && !existing.body) {
        existing.description = snippet;
        existing.body = snippet;
        existing.pdfTextMatch = true;
      }
    } else {
      byPath.set(key, pdf);
      list.push(pdf);
    }
  });
  return list;
}

// Servlet already matched PDF body text; keep hits even if title-only filter missed them.
function appendPdfTextMatches(filtered, pdfRecords) {
  if (!pdfRecords.length) return filtered;
  const out = Array.isArray(filtered) ? [...filtered] : [];
  const seen = new Set(out.map((r) => normalizeSearchResultPath(r.path)));
  pdfRecords.forEach((pdf) => {
    const key = normalizeSearchResultPath(pdf.path);
    if (!seen.has(key)) {
      out.push(pdf);
      seen.add(key);
    }
  });
  return out;
}

// Walk a Sling depth-N JSON tree (returned by /content/dam/<path>.<n>.json)
// collecting every dam:Asset descendant. Builds full DAM paths from the
// node hierarchy as it recurses.
function collectAssetsFromTree(tree, rootPath, base, isAuthor) {
  const records = [];

  const walk = (node, parentPath) => {
    if (!node || typeof node !== 'object') return;
    Object.entries(node).forEach(([key, val]) => {
      // Skip JCR/Sling/CQ housekeeping keys
      if (key.startsWith('jcr:') || key.startsWith('rep:')
        || key.startsWith('cq:') || key.startsWith('sling:')) return;
      if (!val || typeof val !== 'object') return;

      const primary = val['jcr:primaryType'];
      const childPath = `${parentPath}/${key}`;
      if (primary === 'dam:Asset') {
        const { mime, size, modifiedSec } = parseDamAssetNode(val);
        const record = assetToSearchRecord(key, mime, modifiedSec, parentPath, size);
        if (!isAuthor && base) {
          record.path = `${base}${record.path}`;
          if (record.image) record.image = `${base}${record.image}`;
        }
        records.push(record);
      } else {
        // sling:Folder, sling:OrderedFolder, etc. → recurse
        walk(val, childPath);
      }
    });
  };

  walk(tree, rootPath);
  return records;
}

// Fetch one folder's Sling JSON, trying the deepest depth first. Publish AEM
// caps depth per path: the root /content/dam/<site> often allows only depth 2
// while deeper folders allow 3. We probe down from 3 until one succeeds.
async function fetchFolderJson(base, folderPath, isAuthor, cacheBust) {
  /* eslint-disable no-await-in-loop */
  let lastStatus = 0;
  for (const depth of [3, 2, 1]) {
    const url = `${base}${folderPath}.${depth}.json?${cacheBust}`;
    try {
      const res = await fetch(url, isAuthor ? { credentials: 'include' } : {});
      lastStatus = res.status;
      if (!res.ok) continue;
      const data = await res.json();
      // HTTP 300 sometimes returns 200 with an array of allowed depths — skip.
      if (Array.isArray(data)) continue;
      return data;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.debug('[search] folder fetch error', url, err);
    }
  }
  /* eslint-enable no-await-in-loop */
  if (lastStatus) {
    // eslint-disable-next-line no-console
    console.warn('[search] folder fetch failed', folderPath, 'last HTTP status:', lastStatus);
  }
  return null;
}

function isFolderNode(node) {
  const pt = node && node['jcr:primaryType'];
  return typeof pt === 'string'
    && (pt === 'nt:folder' || pt === 'sling:Folder' || pt === 'sling:OrderedFolder');
}

const ASSET_META_ENRICH_CONCURRENCY = 8;

async function enrichOneSearchAsset(record, listingBase, isAuthor, suffix) {
  const url = /^https?:\/\//i.test(record.path)
    ? `${record.path}.3.json${suffix}`
    : `${listingBase}${record.path}.3.json${suffix}`;
  const res = await fetch(url, isAuthor ? { credentials: 'include' } : {});
  if (!res.ok) return;
  const data = await res.json();
  const jcrContent = data['jcr:content'] || {};
  const meta = jcrContent.metadata || {};
  const original = jcrContent.renditions?.original?.['jcr:content'] || {};
  if (!record.size) {
    record.size = Number(meta['dam:size'] || original['jcr:data'] || 0);
  }
  if (!record.contentType) {
    record.contentType = jcrContent['jcr:mimeType'] || meta['dc:format'] || original['jcr:mimeType'] || '';
  }
  if (!record.lastModified) {
    const modifiedRaw = meta['jcr:lastModified']
      || jcrContent['jcr:lastModified']
      || data['jcr:lastModified']
      || data['jcr:created']
      || '';
    if (modifiedRaw) {
      const ms = new Date(modifiedRaw).getTime();
      if (Number.isFinite(ms)) {
        record.lastModified = Math.floor(ms / 1000);
        record.publishDate = record.lastModified;
      }
    }
  }
}

// Enrich only visible results — publish folder JSON is often depth-capped.
async function enrichSearchAssetsWithMetadata(records, listingBase, isAuthor, cacheBust) {
  const needsFetch = records.filter((r) => !r.size || !r.lastModified);
  if (!needsFetch.length) return records;
  const suffix = cacheBust ? `?${cacheBust}` : '';
  for (let i = 0; i < needsFetch.length; i += ASSET_META_ENRICH_CONCURRENCY) {
    const batch = needsFetch.slice(i, i + ASSET_META_ENRICH_CONCURRENCY);
    /* eslint-disable no-await-in-loop */
    await Promise.all(batch.map(async (record) => {
      try {
        await enrichOneSearchAsset(record, listingBase, isAuthor, suffix);
      } catch (_) { /* skip failed enrichment */ }
    }));
    /* eslint-enable no-await-in-loop */
  }
  return records;
}

// Recursive BFS over the DAM tree. Sling depth caps mean a single fetch at the
// root only exposes the top folders' names — assets several levels deep are
// invisible. Re-fetch each discovered subfolder with its own depth probe so
// every dam:Asset gets collected.
async function fetchAssetsForSearch(folderPath) {
  const damRoot = normalizeAssetFolderPath(folderPath);
  if (!damRoot || !damRoot.startsWith('/content/dam/')) {
    // eslint-disable-next-line no-console
    console.warn('[search] invalid asset search path (expected /content/dam/...):', folderPath);
    return [];
  }
  const base = await resolveAssetListingBase();
  const isAuthor = isAuthorEnvironment();
  if (!isAuthor && !base) {
    // eslint-disable-next-line no-console
    console.warn('[search] no publish hostname available; skipping asset search');
    return [];
  }
  // eslint-disable-next-line no-console
  console.debug('[search] asset scan start', { damRoot, base: base || '(author same-origin)' });

  // Cache-bust: a unique value per page-load guarantees a fresh trip through
  // the AEM CORS filter (Fastly otherwise sometimes serves cached headerless
  // responses). Single value for all calls in this scan keeps Fastly's per-URL
  // cache hot during the scan but cold across page loads.
  const cacheBust = `ck=${Date.now()}`;

  const rootPath = damRoot;
  const queue = [rootPath];
  const visited = new Set();
  const all = [];
  const MAX_FOLDERS = 200; // hard cap to avoid runaway tree scans

  /* eslint-disable no-await-in-loop */
  while (queue.length && visited.size < MAX_FOLDERS) {
    // Process up to 8 folders in parallel to keep the scan fast on deep trees.
    const batch = queue.splice(0, 8).filter((p) => !visited.has(p));
    batch.forEach((p) => visited.add(p));
    const fetched = await Promise.all(batch.map((p) => fetchFolderJson(base, p, isAuthor, cacheBust)));

    fetched.forEach((data, i) => {
      const parent = batch[i];
      if (!data || typeof data !== 'object') return;
      Object.entries(data).forEach(([key, val]) => {
        if (key.startsWith('jcr:') || key.startsWith('rep:')
          || key.startsWith('cq:') || key.startsWith('sling:')) return;
        if (!val || typeof val !== 'object') return;
        const childPath = `${parent}/${key}`;
        const pt = val['jcr:primaryType'];
        if (pt === 'dam:Asset') {
          const { mime, size, modifiedSec } = parseDamAssetNode(val);
          const record = assetToSearchRecord(key, mime, modifiedSec, parent, size);
          if (!isAuthor && base) {
            record.path = `${base}${record.path}`;
            if (record.image) record.image = `${base}${record.image}`;
          }
          all.push(record);
        } else if (isFolderNode(val) || (!pt && Object.keys(val).some((k) => !k.startsWith('jcr:')))) {
          // queue for deeper scan — also catches partially-rendered folder nodes
          // (depth-truncated entries that only expose jcr:primaryType)
          if (!visited.has(childPath)) queue.push(childPath);
        }
      });
    });
  }
  /* eslint-enable no-await-in-loop */

  // eslint-disable-next-line no-console
  console.debug(`[search] asset scan — ${all.length} assets across ${visited.size} folders`);
  return all;
}

// Inline download arrow icon (16x16) for the per-result download button.
function downloadIconSvg() {
  return `
    <svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true" focusable="false">
      <path d="M10 2v11M5 9l5 5 5-5M3 16h14"
        stroke="currentColor" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round"></path>
    </svg>
  `;
}

// Build an inline SVG document icon with a colored extension label.
// Returns an HTML string so it can be assigned via innerHTML where needed.
function docIconSvg(mime, ext) {
  const e = (ext || '').toUpperCase().slice(0, 4) || 'FILE';
  // Color tag by document family.
  let badge = '#888';
  if (/pdf/i.test(mime)) badge = '#E03434';
  else if (/word|wordprocessing/i.test(mime)) badge = '#2A5699';
  else if (/powerpoint|presentation/i.test(mime)) badge = '#D04423';
  else if (/excel|spreadsheet/i.test(mime)) badge = '#1F6E43';
  return `
    <svg viewBox="0 0 60 80" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
      <rect x="2" y="2" width="56" height="76" rx="4" fill="#fff" stroke="#cfd6dd" stroke-width="2"/>
      <path d="M36 2 V18 H58" stroke="#cfd6dd" stroke-width="2" fill="none"/>
      <rect x="2" y="44" width="46" height="22" rx="3" fill="${badge}"/>
      <text x="6" y="60" font-family="sans-serif" font-weight="700" font-size="13" fill="#fff">${e}</text>
    </svg>
  `;
}

function deriveScopeFromRaw(raw) {
  const value = (raw || '').trim();
  if (!value) return '';
  // Pull the locale out of an AEM authoring path:
  //   /content/<site>/language-masters/<lang>/... → /<lang>
  const marker = '/language-masters/';
  const idx = value.indexOf(marker);
  if (idx >= 0) {
    const after = value.slice(idx + marker.length);
    const lang = (after.split('/')[0] || '').trim();
    return lang ? `/${lang}` : '';
  }
  // Any other AEM content path (e.g. `/content/<site>` or
  // `/content/<site>/language-masters` with no trailing locale segment) does
  // NOT correspond to a delivery-path prefix — query-index records use paths
  // like `/en/foo`, not `/content/...`. Treating it as a literal prefix wipes
  // out every result, so leave the scope empty and let the search match all
  // indexed pages.
  if (/^\/content\//i.test(value)) return '';
  // Delivery-path scope: first segment becomes the prefix (e.g. `/en`).
  if (value.startsWith('/')) {
    const seg = value.split('/').filter(Boolean)[0] || '';
    return seg ? `/${seg}` : '';
  }
  return '';
}

function getScopedPrefix(block) {
  // forwarded scope from overlay → search page takes precedence
  if (block && typeof block._forwardedScope === 'string' && block._forwardedScope) return block._forwardedScope;
  try {
    const a = block.querySelector(':scope > div:nth-child(1) .button-container a[href]');
    const raw = (a?.textContent || a?.getAttribute('href') || '').trim();
    return deriveScopeFromRaw(raw);
  } catch (e) { /* noop */ }
  return '';
}

function attachScopeParam(url, scope) {
  if (!url || !scope) return;
  if (scope !== '/') url.searchParams.set('sp', scope);
}

function isExcludedResult(result) {
  const path = safeText(result.path).toLowerCase();
  const robots = safeText(result.robots).toLowerCase();
  if (robots.includes('noindex')) return true;
  if (/\/(nav|footer)$/i.test(path)) return true;
  return false;
}

function renderResult(result, searchTerms, searchPhrase, titleTag) {
  const li = document.createElement('li');
  const a = document.createElement('a');
  a.href = result.path;

  // Asset vs page detection: DAM assets live under /content/dam/. On aem.live we
  // make these paths absolute (https://publish-…/content/dam/…) for cross-origin
  // fetching, so we match the substring rather than the start-of-string.
  const isAsset = isDamAssetResult(result);
  const mime = result.contentType || '';
  if (isAsset) li.classList.add('search-result-type-asset');
  const ext = extOf(result.path || '');
  const isImage = isImageMime(mime) || (isAsset && IMAGE_EXTS.has(ext));
  const isDoc = isDocMime(mime) || (isAsset && DOC_EXTS.has(ext));

  if (isImage) {
    // Image asset thumbnail
    const wrapper = document.createElement('div');
    wrapper.className = 'search-result-image search-result-asset-image';
    const imgSrc = isAsset ? result.path : result.image;
    // createOptimizedPicture() in aem.js uses only url.pathname — it strips
    // the origin. That's fine for same-origin images, but a cross-origin
    // publish-AEM URL gets resolved back to aem.live and 404s. So when the
    // src is already absolute, use a plain <img> with the URL untouched.
    if (/^https?:\/\//i.test(imgSrc)) {
      const imgEl = document.createElement('img');
      imgEl.src = imgSrc;
      imgEl.alt = result.title || '';
      imgEl.loading = 'lazy';
      wrapper.append(imgEl);
    } else {
      const pic = createOptimizedPicture(imgSrc, result.title || '', false, [{ width: '375' }]);
      wrapper.append(pic);
    }
    a.append(wrapper);
    li.classList.add('search-result-type-image');
  } else if (isDoc) {
    // Document icon (PDF/DOC/PPT/XLS)
    const wrapper = document.createElement('div');
    wrapper.className = 'search-result-image search-result-asset-icon';
    wrapper.innerHTML = docIconSvg(mime, ext);
    a.append(wrapper);
    li.classList.add('search-result-type-doc');
  } else if (result.image) {
    // Existing page-result behavior — use the meta image
    const wrapper = document.createElement('div');
    wrapper.className = 'search-result-image';
    const pic = createOptimizedPicture(result.image, '', false, [{ width: '375' }]);
    wrapper.append(pic);
    a.append(wrapper);
  }
  const displayTitle = result.navTitle || result.title;
  let titleEl = null;
  if (displayTitle) {
    titleEl = document.createElement(titleTag);
    titleEl.className = 'search-result-title';
    const link = document.createElement('a');
    link.href = result.path;
    link.textContent = displayTitle;
    highlightTextElements(searchTerms, [link]);
    titleEl.append(link);
  }
  const snippetText = getSnippet(result, searchTerms, searchPhrase);
  let snippetEl = null;
  if (snippetText) {
    snippetEl = document.createElement('p');
    snippetEl.className = 'search-result-snippet';
    snippetEl.textContent = snippetText;
    highlightTextElements(searchTerms, [snippetEl]);
  }
  let dateEl = null;
  if (isAsset) {
    const dateText = formatAssetDateTime(result.lastModified);
    if (dateText) {
      dateEl = document.createElement('p');
      dateEl.className = 'search-result-asset-date';
      dateEl.textContent = dateText;
    }
  }

  // Stack title + snippet + date in one column so the icon height does not
  // inflate grid row 1 and leave a gap under the title.
  if (isAsset && snippetEl) {
    const body = document.createElement('div');
    body.className = 'search-result-body';
    if (titleEl) body.append(titleEl);
    body.append(snippetEl);
    if (dateEl) body.append(dateEl);
    a.append(body);
    li.classList.add('search-result-stacked-body');
  } else {
    if (titleEl) a.append(titleEl);
    if (snippetEl) a.append(snippetEl);
    if (dateEl) {
      const insertAfter = snippetEl || titleEl;
      if (insertAfter) insertAfter.insertAdjacentElement('afterend', dateEl);
      else a.append(dateEl);
    }
  }
  li.append(a);

  // Asset-only: append a download button as a sibling of the main link so
  // clicking the button is separate from clicking the result. href points at
  // the absolute publish URL (already set on result.path for cross-origin
  // contexts in fetchAssetsForSearch).
  if (isAsset && (isImage || isDoc)) {
    const actions = document.createElement('div');
    actions.className = 'search-result-asset-actions';
    const dl = document.createElement('a');
    dl.className = 'search-result-download';
    dl.href = result.path;
    // The download attribute hints to same-origin browsers to save rather
    // than navigate. Cross-origin browsers ignore it and navigate instead —
    // that's still a usable "open the asset" experience for the user.
    const fileNameOnly = (result.path || '').split('/').pop() || (result.title || 'asset');
    dl.setAttribute('download', fileNameOnly);
    dl.setAttribute('aria-label', `Download ${result.title || 'asset'}`);
    dl.setAttribute('target', '_blank');
    dl.setAttribute('rel', 'noopener');
    dl.setAttribute('title', `Download ${result.title || 'asset'}`);
    dl.innerHTML = downloadIconSvg();
    dl.addEventListener('click', (e) => e.stopPropagation());
    actions.append(dl);
    const sizeLabel = getAssetSizeLabel(result);
    if (sizeLabel) {
      const sizeEl = document.createElement('span');
      sizeEl.className = 'search-result-asset-size';
      sizeEl.textContent = sizeLabel;
      actions.append(sizeEl);
    }
    li.classList.add('search-result-has-actions');
    li.append(actions);
  }
  return li;
}

function clearSearchResults(block) {
  const searchResults = block.querySelector('.search-results');
  searchResults.innerHTML = '';
}

function clearSearch(block) {
  clearSearchResults(block);
  const dropdown = block.querySelector('.search-dropdown');
  if (dropdown) dropdown.classList.remove('open');
  if (dropdown && dropdown.parentElement) dropdown.parentElement.classList.remove('open');
  // collapse expanded mode if present
  if (block.classList.contains('expanded')) {
    block.classList.remove('expanded');
    const expanded = block.querySelector('.search-expanded');
    if (expanded) expanded.remove();
  }
  if (window.history.replaceState) {
    const url = new URL(window.location.href);
    url.search = '';
    searchParams.delete('q');
    window.history.replaceState({}, '', url.toString());
  }
}

async function renderResults(block, config, filteredData, searchTerms, searchPhrase) {
  clearSearchResults(block);
  const searchResults = block.querySelector('.search-results');
  const headingTag = searchResults.dataset.h;
  const dropdown = block.querySelector('.search-dropdown');

  if (filteredData.length) {
    searchResults.classList.remove('no-results');
    filteredData.forEach((result) => {
      const li = renderResult(result, searchTerms, searchPhrase, headingTag);
      searchResults.append(li);
    });
    if (dropdown) {
      dropdown.classList.add('open');
      if (dropdown.parentElement) dropdown.parentElement.classList.add('open');
    }
  } else {
    const noResultsMessage = document.createElement('li');
    searchResults.classList.add('no-results');
    noResultsMessage.textContent = config.placeholders.searchNoResults || 'No results found.';
    searchResults.append(noResultsMessage);
    if (dropdown) {
      dropdown.classList.add('open');
      if (dropdown.parentElement) dropdown.parentElement.classList.add('open');
    }
  }
}

function compareFound(hit1, hit2) {
  return hit1.score - hit2.score;
}

// Rank results by match quality. Buckets, highest priority first:
//   1. Exact phrase appears in navTitle / header
//   2. ALL search terms appear in navTitle / header
//   3. Exact phrase appears anywhere in meta (description, body, path)
//   4. SOME (≥1) search terms appear in navTitle / header
//   5. SOME search terms appear in meta
// Within each bucket records are sorted by the earliest match index.
// This fixes two prior bugs:
//   • A header check that only required ONE term shadowed phrase matches —
//     so "Purchase Card" page lost to "card-platinum" asset.
//   • `minIdx` was accumulating the MAX index, then sorted ascending, which
//     ranked single-term partial matches above all-term matches.
function filterData(searchTerms, data, searchPhrase) {
  const phraseInHeader = [];
  const allTermsInHeader = [];
  const phraseInMeta = [];
  const someTermsInHeader = [];
  const someTermsInMeta = [];

  const hasPhrase = searchPhrase && searchPhrase.length >= 2;

  (Array.isArray(data) ? data : []).forEach((result) => {
    const header = safeText(result.header || result.navTitle).toLowerCase();

    // (1) phrase in header
    if (hasPhrase) {
      const i = header.indexOf(searchPhrase);
      if (i >= 0) {
        phraseInHeader.push({ score: i, result });
        return;
      }
    }

    // term-match analysis on header
    const headerTermIdxs = searchTerms
      .map((t) => header.indexOf(t))
      .filter((i) => i >= 0);

    // (2) ALL terms in header
    if (headerTermIdxs.length === searchTerms.length && searchTerms.length > 0) {
      allTermsInHeader.push({ score: Math.min(...headerTermIdxs), result });
      return;
    }

    const meta = `${safeText(result.navTitle || result.title)} ${safeText(result.description)} ${safeText(result.body)} ${safeText(result.path)?.split('/').pop() || ''}`.toLowerCase();

    // (3) phrase in meta
    if (hasPhrase) {
      const i = meta.indexOf(searchPhrase);
      if (i >= 0) {
        phraseInMeta.push({ score: i, result });
        return;
      }
    }

    // (4) SOME terms in header (partial)
    if (headerTermIdxs.length > 0) {
      someTermsInHeader.push({ score: Math.min(...headerTermIdxs), result });
      return;
    }

    // (5) SOME terms in meta
    const metaTermIdxs = searchTerms
      .map((t) => meta.indexOf(t))
      .filter((i) => i >= 0);
    if (metaTermIdxs.length > 0) {
      someTermsInMeta.push({ score: Math.min(...metaTermIdxs), result });
    }
  });

  return [
    ...phraseInHeader.sort(compareFound),
    ...allTermsInHeader.sort(compareFound),
    ...phraseInMeta.sort(compareFound),
    ...someTermsInHeader.sort(compareFound),
    ...someTermsInMeta.sort(compareFound),
  ].map((item) => item.result);
}

async function handleSearchImpl(e, block, config) {
  const inputEl = block?.querySelector?.('input.search-input');
  const searchValue = (e && e.target && typeof e.target.value === 'string'
    ? e.target.value
    : (inputEl && typeof inputEl.value === 'string' ? inputEl.value : '')) || '';
  searchParams.set('q', searchValue);
  if (window.history.replaceState) {
    const url = new URL(window.location.href);
    url.search = searchParams.toString();
    window.history.replaceState({}, '', url.toString());
  }

  if (searchValue.length < 3) {
    clearSearch(block);
    return;
  }
  const searchPhrase = searchValue.toLowerCase().trim();
  const searchTerms = searchPhrase.split(/\s+/).filter((term) => term && term.length >= 2);

  const authoredPrefix = getScopedPrefix(block);
  const data = (await fetchData(config.source)).filter((r) => !isExcludedResult(r));
  const scoped = applySearchPathFilter(data, authoredPrefix);
  const filteredData = filterData(searchTerms, scoped, searchPhrase);
  await renderResults(block, config, filteredData, searchTerms, searchPhrase);
}

const handleSearch = debounce(handleSearchImpl, 150);

function searchResultsContainer(block) {
  const results = document.createElement('ul');
  results.className = 'search-results';
  results.dataset.h = findNextHeading(block);
  return results;
}

// --- Query suggestions (typeahead) ----------------------------------------
// EDS has no live backend, so suggestions are derived in-browser from the
// same query-index JSON the search uses. Recent searches are kept in
// localStorage and shown when the input is focused but empty.
const RECENT_SEARCH_KEY = 'eds:recentSearches';
const MAX_RECENT = 5;
const MAX_SUGGESTIONS = 8;

function loadRecentSearches() {
  try {
    const raw = window.localStorage.getItem(RECENT_SEARCH_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((s) => typeof s === 'string') : [];
  } catch (_) { return []; }
}

function saveRecentSearch(query) {
  const q = (query || '').trim();
  if (q.length < 2) return;
  try {
    const list = loadRecentSearches().filter((s) => s.toLowerCase() !== q.toLowerCase());
    list.unshift(q);
    window.localStorage.setItem(RECENT_SEARCH_KEY, JSON.stringify(list.slice(0, MAX_RECENT)));
  } catch (_) { /* storage may be disabled */ }
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlightSnippet(text, query) {
  const t = String(text || '');
  const q = String(query || '').trim();
  if (!q) return document.createTextNode(t);
  const re = new RegExp(escapeRegExp(q), 'ig');
  const frag = document.createDocumentFragment();
  let lastIdx = 0;
  let m = re.exec(t);
  while (m) {
    if (m.index > lastIdx) frag.append(document.createTextNode(t.slice(lastIdx, m.index)));
    const mark = document.createElement('mark');
    mark.textContent = m[0];
    frag.append(mark);
    lastIdx = m.index + m[0].length;
    m = re.exec(t);
  }
  if (lastIdx < t.length) frag.append(document.createTextNode(t.slice(lastIdx)));
  return frag;
}

// Build suggestion list from the cached index. Rank: titles starting with the
// query first, then containing the query. De-dupe by lowercased title.
function buildSuggestions(query, data) {
  const q = String(query || '').toLowerCase().trim();
  if (!q || q.length < 2) return [];
  const startsWith = [];
  const contains = [];
  const seen = new Set();
  (Array.isArray(data) ? data : []).forEach((r) => {
    if (isExcludedResult(r)) return;
    const title = (r.navTitle || r.title || '').trim();
    if (!title) return;
    const key = title.toLowerCase();
    if (seen.has(key)) return;
    if (key.startsWith(q)) {
      startsWith.push({ title, path: r.path });
      seen.add(key);
    } else if (key.includes(q)) {
      contains.push({ title, path: r.path });
      seen.add(key);
    }
  });
  return [...startsWith, ...contains].slice(0, MAX_SUGGESTIONS);
}

function clockIconSvg() {
  return '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.5V8l2.5 1.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
}
function searchSuggestionIconSvg() {
  return '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true" focusable="false"><circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.5"/><path d="M11 11l3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
}

function renderSuggestionList(container, items, query, onPick, opts = {}) {
  container.innerHTML = '';
  if (!items.length) {
    container.classList.remove('open');
    return;
  }
  const ul = document.createElement('ul');
  ul.className = 'search-suggestion-list';
  ul.setAttribute('role', 'listbox');
  if (opts.heading) {
    const head = document.createElement('li');
    head.className = 'search-suggestion-heading';
    head.textContent = opts.heading;
    ul.append(head);
  }
  items.forEach((item, idx) => {
    const li = document.createElement('li');
    li.className = 'search-suggestion-item';
    li.setAttribute('role', 'option');
    li.dataset.value = item.title;
    li.dataset.index = String(idx);
    const iconWrap = document.createElement('span');
    iconWrap.className = 'search-suggestion-icon';
    iconWrap.innerHTML = opts.isRecent ? clockIconSvg() : searchSuggestionIconSvg();
    const text = document.createElement('span');
    text.className = 'search-suggestion-text';
    text.append(highlightSnippet(item.title, query));
    li.append(iconWrap, text);
    li.addEventListener('mousedown', (e) => {
      // mousedown (not click) so we fire before blur tears down the dropdown
      e.preventDefault();
      onPick(item.title);
    });
    ul.append(li);
  });
  container.append(ul);
  container.classList.add('open');
}

async function ensureSearchData(block, config) {
  if (block._suggestData) return block._suggestData;
  const fetched = (await fetchData(config.source)).filter((r) => !isExcludedResult(r));
  const scope = getScopedPrefix(block);
  block._suggestData = applySearchPathFilter(fetched, scope);
  return block._suggestData;
}

function attachSuggestions(block, input, container, config, onSubmit) {
  let activeIndex = -1;
  const updateActive = () => {
    const items = container.querySelectorAll('.search-suggestion-item');
    items.forEach((el, i) => el.classList.toggle('active', i === activeIndex));
    if (activeIndex >= 0 && items[activeIndex]) {
      items[activeIndex].scrollIntoView({ block: 'nearest' });
    }
  };

  const close = () => { container.classList.remove('open'); activeIndex = -1; };

  const showRecent = () => {
    const recent = loadRecentSearches().map((s) => ({ title: s, path: '' }));
    if (!recent.length) { close(); return; }
    renderSuggestionList(container, recent, '', (val) => {
      input.value = val;
      close();
      onSubmit(val);
    }, { heading: 'Recent searches', isRecent: true });
    activeIndex = -1;
  };

  const runSuggest = debounce(async (q) => {
    const data = await ensureSearchData(block, config);
    const items = buildSuggestions(q, data);
    renderSuggestionList(container, items, q, (val) => {
      input.value = val;
      close();
      onSubmit(val);
    });
    activeIndex = -1;
  }, 120);

  input.addEventListener('focus', () => {
    if (!input.value.trim()) showRecent();
  });
  input.addEventListener('input', () => {
    const v = input.value.trim();
    if (!v) { showRecent(); return; }
    if (v.length < 2) { close(); return; }
    runSuggest(v);
  });
  input.addEventListener('keydown', (e) => {
    const open = container.classList.contains('open');
    const items = container.querySelectorAll('.search-suggestion-item');
    if (e.key === 'ArrowDown' && open && items.length) {
      e.preventDefault();
      activeIndex = (activeIndex + 1) % items.length;
      updateActive();
    } else if (e.key === 'ArrowUp' && open && items.length) {
      e.preventDefault();
      activeIndex = (activeIndex - 1 + items.length) % items.length;
      updateActive();
    } else if (e.key === 'Enter' && open && activeIndex >= 0 && items[activeIndex]) {
      e.preventDefault();
      const value = items[activeIndex].dataset.value || '';
      input.value = value;
      close();
      onSubmit(value);
    } else if (e.key === 'Escape') {
      close();
    }
  });
  input.addEventListener('blur', () => {
    // delay so mousedown on a suggestion still resolves
    setTimeout(close, 120);
  });
  document.addEventListener('click', (e) => {
    if (!block.contains(e.target)) close();
  });

  return { close };
}

function searchInput(block, config) {
  const input = document.createElement('input');
  input.setAttribute('type', 'search');
  input.className = 'search-input';

  const searchPlaceholder = config.placeholders.searchPlaceholder || 'Search...';
  input.placeholder = searchPlaceholder;
  input.setAttribute('aria-label', searchPlaceholder);

  // Both variants now show keyword suggestions via attachSuggestions() in
  // decorate(), so the legacy live-results dropdown isn't wired up here.

  input.addEventListener('keyup', (e) => { if (e.code === 'Escape') { clearSearch(block); } });

  return input;
}

function searchIcon() {
  const icon = document.createElement('span');
  icon.classList.add('icon', 'icon-search');
  return icon;
}

function searchBox(block, config) {
  const box = document.createElement('div');
  box.classList.add('search-box');
  const input = searchInput(block, config);
  const icon = searchIcon();
  const isIconVariant = block.classList.contains('search-icon');
  if (isIconVariant) {
    const dropdown = document.createElement('div');
    dropdown.className = 'search-dropdown';
    const results = searchResultsContainer(block);
    dropdown.append(results);
    box.append(
      input,
      icon,
      dropdown,
    );
  } else {
    box.append(
      input,
      icon,
    );
  }

  return box;
}

// --- Expanded (inline) results mode for search-bar variant ---
function buildExpandedLayout(block) {
  let expanded = block.querySelector('.search-expanded');
  if (expanded) {
    // Existing layout — return all parts including pagination. If pagination
    // is missing (older render), create it now so callers always get a node.
    const filters = expanded.querySelector('.search-filters');
    const results = expanded.querySelector('.search-expanded-results .search-results');
    let pagination = expanded.querySelector('.search-expanded-results .search-pagination');
    if (!pagination) {
      pagination = document.createElement('nav');
      pagination.className = 'search-pagination';
      pagination.setAttribute('aria-label', 'Search results pagination');
      const wrap = expanded.querySelector('.search-expanded-results');
      if (wrap) wrap.append(pagination);
    }
    return {
      expanded, filters, results, pagination,
    };
  }

  expanded = document.createElement('div');
  expanded.className = 'search-expanded';

  const filters = document.createElement('aside');
  filters.className = 'search-filters';

  const resultsWrap = document.createElement('div');
  resultsWrap.className = 'search-expanded-results';
  const resultsCount = document.createElement('p');
  resultsCount.className = 'search-results-count';
  const results = document.createElement('ul');
  results.className = 'search-results';
  results.dataset.h = findNextHeading(block);
  const pagination = document.createElement('nav');
  pagination.className = 'search-pagination';
  pagination.setAttribute('aria-label', 'Search results pagination');
  resultsWrap.append(resultsCount, results, pagination);

  expanded.append(filters, resultsWrap);
  block.append(expanded);
  return {
    expanded, filters, results, pagination,
  };
}

function normalizeTimestamp(value) {
  if (!value && value !== 0) return NaN;
  if (typeof value === 'number') {
    // if seconds, convert to ms
    return value < 1e12 ? value * 1000 : value;
  }
  const ms = Date.parse(value);
  if (!Number.isNaN(ms)) return ms;
  const asNum = Number(value);
  if (!Number.isNaN(asNum)) return normalizeTimestamp(asNum);
  return NaN;
}

function getResultTimestamp(result) {
  const primary = normalizeTimestamp(result.publishDate);
  const fallback = normalizeTimestamp(result.lastModified);
  if (!Number.isNaN(primary)) return primary;
  if (!Number.isNaN(fallback)) return fallback;
  return NaN;
}

// Specific timestamp getters for distinct filters
function getPublishedTimestamp(result) {
  return normalizeTimestamp(result.publishDate);
}

function getModifiedTimestamp(result) {
  return normalizeTimestamp(result.lastModified);
}

function applyDateFilter(data, dateRange, getResultTimestamp) {
  if (!dateRange || dateRange === 'any') return data;
  const now = Date.now();
  const ranges = { '24h': 24 * 60 * 60 * 1000, '7d': 7 * 24 * 60 * 60 * 1000, '30d': 30 * 24 * 60 * 60 * 1000 };
  const windowMs = ranges[dateRange];
  if (!windowMs) return data;
  return data.filter((r) => {
    const ts = getResultTimestamp(r);
    if (Number.isNaN(ts)) return false;
    return (now - ts) <= windowMs;
  });
}

// --- Tags helpers ---
function getResultTags(result) {
  const raw = result && result.tags;
  if (Array.isArray(raw)) return raw.map((t) => (typeof t === 'string' ? t.trim() : '')).filter(Boolean);
  if (typeof raw === 'string') return raw.split(/\s*,\s*/).map((t) => t.trim()).filter(Boolean);
  return [];
}

function collectTagsWithCounts(list) {
  const freq = new Map();
  (Array.isArray(list) ? list : []).forEach((r) => {
    getResultTags(r).forEach((t) => {
      freq.set(t, (freq.get(t) || 0) + 1);
    });
  });
  return [...freq.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => a.key.localeCompare(b.key));
}

function applyTagFilter(data, selectedTags) {
  const list = Array.isArray(data) ? data : [];
  const selected = new Set((Array.isArray(selectedTags) ? selectedTags : []).map((t) => (typeof t === 'string' ? t.trim() : '')).filter(Boolean));
  if (!selected.size) return list;
  return list.filter((r) => getResultTags(r).some((t) => selected.has(t)));
}

function renderTagFilters(container, availableTags, selectedTags, onChange, openPathsSet) {
  if (!Array.isArray(availableTags) || !availableTags.length) return;
  const group = document.createElement('div');
  group.className = 'filter-group tags';
  const title = document.createElement('h4');
  title.textContent = 'Tags';
  group.append(title);
 
  const capitalizeFirst = (text) => {
    const str = String(text || '');
    if (!str) return str;
    return str.charAt(0).toUpperCase() + str.slice(1);
  };

  const splitNamespace = (key) => {
    const raw = String(key || '');
    const colonIdx = raw.indexOf(':');
    if (colonIdx > -1) {
      const ns = raw.slice(0, colonIdx);
      const remainder = raw.slice(colonIdx + 1);
      return { ns: ns || 'Other', remainder };
    }
    return { ns: 'Other', remainder: raw };
  };

  const buildTagTree = (list) => {
    const root = new Map(); // ns -> node
    (Array.isArray(list) ? list : []).forEach((t) => {
      const { ns, remainder } = splitNamespace(t.key);
      const path = (remainder || '').split('/').filter(Boolean);
      let nsNode = root.get(ns);
      if (!nsNode) { nsNode = { name: ns, children: new Map(), leaf: null, count: 0, hasSelected: false }; root.set(ns, nsNode); }
      let current = nsNode;
      // if no path, treat as single leaf under namespace
      if (!path.length) {
        current.leaf = { key: t.key, label: t.key, count: t.count };
        return;
      }
      path.forEach((seg, idx) => {
        let child = current.children.get(seg);
        if (!child) { child = { name: seg, children: new Map(), leaf: null, count: 0, hasSelected: false }; current.children.set(seg, child); }
        current = child;
        if (idx === path.length - 1) {
          current.leaf = { key: t.key, label: seg, count: t.count };
        }
      });
    });
    const computeCounts = (node) => {
      let total = node.leaf ? (node.leaf.count || 0) : 0;
      node.children.forEach((child) => { total += computeCounts(child); });
      node.count = total;
      return total;
    };
    root.forEach((n) => computeCounts(n));
    return root;
  };

  const markSelected = (node, selectedSet) => {
    let has = node.leaf ? selectedSet.has(node.leaf.key) : false;
    node.children.forEach((child) => { if (markSelected(child, selectedSet)) has = true; });
    node.hasSelected = has;
    return has;
  };

  const renderNode = (parentEl, node, name, selected, onChange, depth = 0, path = '') => {
    const hasChildren = node.children && node.children.size;
    const nodePath = path ? `${path}/${node.name}` : node.name;

    if (hasChildren) {
      const details = document.createElement('details');
      details.className = 'tag-collapsible';
      details.dataset.path = nodePath;
      // keep open if this branch contains a selected tag
      const shouldOpen = (depth === 0)
        || node.hasSelected
        || (openPathsSet && openPathsSet.has(nodePath));
      if (shouldOpen) details.open = true;

      const summary = document.createElement('summary');
      summary.textContent = `${capitalizeFirst(node.name)}${typeof node.count === 'number' ? ` (${node.count})` : ''}`;
      details.append(summary);

      const content = document.createElement('div');
      content.className = 'tag-subgroup';

      // Render leaf (selectable) at this node, if present
      if (node.leaf) {
        const id = `${name}-${node.leaf.key.replace(/[^a-z0-9]+/gi, '-')}`;
        const label = document.createElement('label');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.name = name;
        cb.id = id;
        cb.checked = (selected || []).includes(node.leaf.key);
        cb.addEventListener('change', () => {
          const next = new Set(selected || []);
          if (cb.checked) next.add(node.leaf.key); else next.delete(node.leaf.key);
          onChange([...next]);
        });
        const text = document.createTextNode(` ${capitalizeFirst(node.leaf.label)}${typeof node.leaf.count === 'number' ? ` (${node.leaf.count})` : ''}`);
        label.append(cb, text);
        content.append(label);
      }

      [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name)).forEach((child) => {
        renderNode(content, child, name, selected, onChange, depth + 1, nodePath);
      });

      details.append(content);
      parentEl.append(details);
      return;
    }

    // Leaf-only node, render checkbox directly
    if (node.leaf) {
      const id = `${name}-${node.leaf.key.replace(/[^a-z0-9]+/gi, '-')}`;
      const label = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.name = name;
      cb.id = id;
      cb.checked = (selected || []).includes(node.leaf.key);
      cb.addEventListener('change', () => {
        const next = new Set(selected || []);
        if (cb.checked) next.add(node.leaf.key); else next.delete(node.leaf.key);
        onChange([...next]);
      });
      const text = document.createTextNode(` ${capitalizeFirst(node.leaf.label)}${typeof node.leaf.count === 'number' ? ` (${node.leaf.count})` : ''}`);
      label.append(cb, text);
      parentEl.append(label);
    }
  };

  const tree = buildTagTree(availableTags);
  const name = `tags-${Math.random().toString(36).slice(2)}`;
  // mark selection so collapsibles with selected leaves remain open
  const selectedSet = new Set((selectedTags || []).filter(Boolean));
  [...tree.values()].forEach((nsNode) => markSelected(nsNode, selectedSet));
  [...tree.values()].sort((a, b) => a.name.localeCompare(b.name)).forEach((nsNode) => {
    const section = document.createElement('div');
    section.className = 'tag-group';
    renderNode(section, nsNode, name, selectedTags || [], onChange, 0, '');
    group.append(section);
  });

  container.append(group);
}

/**
 * Turn a filter group into a collapsible section toggled by its <h4> title.
 * Collapsed by default; the option rows are hidden via CSS when `.collapsed`.
 */
function makeCollapsible(group, title, collapsed = true) {
  group.classList.add('collapsible');
  if (collapsed) group.classList.add('collapsed');
  title.setAttribute('role', 'button');
  title.setAttribute('tabindex', '0');
  title.setAttribute('aria-expanded', String(!collapsed));
  const toggle = () => {
    const isCollapsed = group.classList.toggle('collapsed');
    title.setAttribute('aria-expanded', String(!isCollapsed));
  };
  title.addEventListener('click', toggle);
  title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  });
}

function renderDateFilters(container, selected, onChange) {
  const group = document.createElement('div');
  group.className = 'filter-group date-range';
  const title = document.createElement('h4');
  title.textContent = 'Published';
  group.append(title);
  makeCollapsible(group, title);

  const options = [
    { key: 'any', label: 'Any time' },
    { key: '24h', label: 'Last 24 hours' },
    { key: '7d', label: 'Last week' },
    { key: '30d', label: 'Last month' },
  ];
  const name = `date-range-${Math.random().toString(36).slice(2)}`;
  options.forEach((opt, idx) => {
    const id = `${name}-${idx}`;
    const label = document.createElement('label');
    const rb = document.createElement('input');
    rb.type = 'radio';
    rb.name = name;
    rb.id = id;
    rb.checked = (selected || 'any') === opt.key;
    rb.addEventListener('change', () => onChange(opt.key));
    label.append(rb, document.createTextNode(` ${opt.label}`));
    group.append(label);
  });
  container.append(group);
}

function renderModifiedFilters(container, selected, onChange) {
  const group = document.createElement('div');
  group.className = 'filter-group date-range modified-range';
  const title = document.createElement('h4');
  title.textContent = 'Modified';
  group.append(title);
  makeCollapsible(group, title);

  const options = [
    { key: 'any', label: 'Any time' },
    { key: '24h', label: 'Last 24 hours' },
    { key: '7d', label: 'Last week' },
    { key: '30d', label: 'Last month' },
  ];
  const name = `modified-range-${Math.random().toString(36).slice(2)}`;
  options.forEach((opt, idx) => {
    const id = `${name}-${idx}`;
    const label = document.createElement('label');
    const rb = document.createElement('input');
    rb.type = 'radio';
    rb.name = name;
    rb.id = id;
    rb.checked = (selected || 'any') === opt.key;
    rb.addEventListener('change', () => onChange(opt.key));
    label.append(rb, document.createTextNode(` ${opt.label}`));
    group.append(label);
  });
  container.append(group);
}

function applyAllFilters(base, selectedPublishedRange, selectedModifiedRange) {
  const byPublished = applyDateFilter(base, selectedPublishedRange, getPublishedTimestamp);
  const byModified = applyDateFilter(byPublished, selectedModifiedRange, getModifiedTimestamp);
  return byModified;
}

// Classify a single result into a high-level "type" bucket for the Type filter.
function classifyResultType(result) {
  const path = result?.path || '';
  const mime = result?.contentType || '';
  const ext = extOf(path);
  // Anything under /content/dam/ is an asset; otherwise treat as page.
  const isAsset = /\/content\/dam\//.test(path);
  if (!isAsset) return 'page';
  if (isImageMime(mime) || IMAGE_EXTS.has(ext)) return 'image';
  if (isDocMime(mime) || DOC_EXTS.has(ext)) return 'document';
  return 'other';
}

function applyTypeFilter(data, selectedTypes) {
  if (!Array.isArray(selectedTypes) || !selectedTypes.length) return data;
  const wanted = new Set(selectedTypes);
  return data.filter((r) => wanted.has(classifyResultType(r)));
}

function renderTypeFilters(container, data, selectedTypes, onChange) {
  const group = document.createElement('div');
  group.className = 'filter-group type-filter';
  const title = document.createElement('h4');
  title.textContent = 'Type';
  group.append(title);

  // Count items per bucket so the labels show useful numbers
  const counts = { page: 0, document: 0, image: 0, other: 0 };
  data.forEach((r) => { counts[classifyResultType(r)] += 1; });

  const options = [
    { key: 'page', label: 'Pages' },
    { key: 'document', label: 'Documents' },
    { key: 'image', label: 'Images' },
    { key: 'other', label: 'Other' },
  ].filter((opt) => counts[opt.key] > 0);

  options.forEach((opt) => {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = (selectedTypes || []).includes(opt.key);
    cb.addEventListener('change', () => {
      const cur = new Set(selectedTypes || []);
      if (cb.checked) cur.add(opt.key); else cur.delete(opt.key);
      onChange([...cur]);
    });
    label.append(cb, document.createTextNode(` ${opt.label} (${counts[opt.key]})`));
    group.append(label);
  });
  container.append(group);
}

function renderSortControls(container, selected, onChange) {
  const group = document.createElement('div');
  group.className = 'filter-group sort-order';
  const title = document.createElement('h4');
  title.textContent = 'Sort';
  group.append(title);
  makeCollapsible(group, title);

  const options = [
    { key: 'relevance', label: 'Relevance' },
    { key: 'az', label: 'Title A–Z' },
    { key: 'za', label: 'Title Z–A' },
  ];
  const name = `sort-order-${Math.random().toString(36).slice(2)}`;
  options.forEach((opt, idx) => {
    const id = `${name}-${idx}`;
    const label = document.createElement('label');
    const rb = document.createElement('input');
    rb.type = 'radio';
    rb.name = name;
    rb.id = id;
    rb.checked = (selected || 'relevance') === opt.key;
    rb.addEventListener('change', () => onChange(opt.key));
    label.append(rb, document.createTextNode(` ${opt.label}`));
    group.append(label);
  });
  container.append(group);
}

function applySort(results, order) {
  if (!Array.isArray(results) || !results.length) return results;
  if (order === 'az' || order === 'za') {
    const copy = [...results];
    copy.sort((a, b) => {
      const at = (a.navTitle || a.title || '').toLowerCase();
      const bt = (b.navTitle || b.title || '').toLowerCase();
      if (at < bt) return -1;
      if (at > bt) return 1;
      return 0;
    });
    return order === 'az' ? copy : copy.reverse();
  }
  return results; // relevance is original order
}

async function activateExpandedSearch(block, config, searchValue, cachedData) {
  const value = (searchValue || '').trim();
  if (value.length < 3) return;

  // manage URL param
  searchParams.set('q', value);
  if (window.history.replaceState) {
    const url = new URL(window.location.href);
    url.search = searchParams.toString();
    window.history.replaceState({}, '', url.toString());
  }

  // close dropdown if open
  const dropdown = block.querySelector('.search-dropdown');
  if (dropdown) dropdown.classList.remove('open');
  if (dropdown && dropdown.parentElement) dropdown.parentElement.classList.remove('open');

  block.classList.add('expanded');
  const { filters, results, pagination } = buildExpandedLayout(block);

  // fetch/cached data
  let data = cachedData || block._searchData;
  if (!data) {
    const fetched = (await fetchData(config.source)).filter((r) => !isExcludedResult(r));
    const scope = getScopedPrefix(block);
    data = applySearchPathFilter(fetched, scope);

    // Optional: append DAM asset records so the same search box surfaces files
    // (images, PDFs, Office docs) alongside pages. Configured via the
    // "Asset Search Path" dialog field on the Search block.
    const assetSearchPath = block.dataset.assetSearchPath || '';
    if (assetSearchPath) {
      try {
        block._assetListingBase = await resolveAssetListingBase();
        block._assetSearchIsAuthor = isAuthorEnvironment();
        let assetRecords = await fetchAssetsForSearch(assetSearchPath);
        // Apply author-configured DAM-path exclusions. Asset record `path` is
        // either /content/dam/... (author) or https://publish-…/content/dam/…
        // (aem.live). We match by the pathname so absolute URLs are handled.
        const excludeRaw = block.dataset.excludeAssetPaths || '';
        const startsWithExcluded = buildExcludedPathMatcher(excludeRaw);
        if (startsWithExcluded && assetRecords.length) {
          const before = assetRecords.length;
          assetRecords = assetRecords.filter((r) => !startsWithExcluded(r.path));
          // eslint-disable-next-line no-console
          console.debug(`[search] excluded ${before - assetRecords.length} asset(s) by path prefix`);
        }
        if (assetRecords.length) data = data.concat(assetRecords);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[search] asset search merge failed', e);
      }
    }

    block._searchData = data;
  }

  const searchPhrase = value.toLowerCase();
  const searchTerms = searchPhrase.split(/\s+/).filter((t) => t && t.length >= 2);

  let pdfRecords = [];
  try {
    pdfRecords = await fetchPdfSearchResults(value, block.dataset.assetSearchPath || '');
    const startsWithExcluded = buildExcludedPathMatcher(block.dataset.excludeAssetPaths || '');
    if (startsWithExcluded && pdfRecords.length) {
      pdfRecords = pdfRecords.filter((r) => !startsWithExcluded(r.path));
    }
    // eslint-disable-next-line no-console
    if (pdfRecords.length) console.debug(`[search] readpdf — ${pdfRecords.length} PDF hit(s)`);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[search] readpdf merge failed', e);
  }

  const dataWithPdf = mergePdfSearchIntoData(data, pdfRecords);
  const filtered = filterData(searchTerms, dataWithPdf, searchPhrase);
  const base = appendPdfTextMatches(filtered, pdfRecords);

  // Pagination config: read from block.dataset.pageSize (set by decorate from config cell)
  // or fall back to a sensible default.
  const pageSize = Math.max(1, parseInt(block.dataset.pageSize, 10) || 10);
  // Reset to first page each time the query changes
  if (block._lastQuery !== value) {
    block._currentPage = 1;
    block._lastQuery = value;
  }
  let currentPage = block._currentPage || 1;

  // state
  let selectedPublishedRange = block._selectedPublishedRange || 'any';
  let selectedModifiedRange = block._selectedModifiedRange || 'any';
  let sortOrder = block._sortOrder || 'relevance';
  let selectedTags = Array.isArray(block._selectedTags) ? block._selectedTags : [];
  let selectedTypes = Array.isArray(block._selectedTypes) ? block._selectedTypes : [];
  const availableTags = collectTagsWithCounts(data);

  const resetToFirstPage = () => {
    currentPage = 1;
    block._currentPage = 1;
  };

  const renderFilters = () => {
    filters.innerHTML = '';
    const heading = document.createElement('h3');
    heading.className = 'search-filters__heading';
    heading.textContent = 'Filter Results';
    filters.append(heading);
    // Type filter (pages vs documents vs images) — placed first so it's the
    // most prominent control. Counts reflect the current matched result set.
    renderTypeFilters(filters, base, selectedTypes, (next) => {
      selectedTypes = next;
      block._selectedTypes = selectedTypes;
      resetToFirstPage();
      refreshTagFilters();
      renderList();
    });
    // Tag filters are injected dynamically via refreshTagFilters()
    // so only static groups are built here to keep handlers simple
    renderDateFilters(filters, selectedPublishedRange, (next) => {
      selectedPublishedRange = next;
      block._selectedPublishedRange = selectedPublishedRange;
      resetToFirstPage();
      refreshTagFilters();
      renderList();
    });
    renderModifiedFilters(filters, selectedModifiedRange, (next) => {
      selectedModifiedRange = next;
      block._selectedModifiedRange = selectedModifiedRange;
      resetToFirstPage();
      refreshTagFilters();
      renderList();
    });
    renderSortControls(filters, sortOrder, (next) => {
      sortOrder = next;
      block._sortOrder = sortOrder;
      resetToFirstPage();
      renderList();
    });
    // Insert Tags group at the top initially
    refreshTagFilters(true);
  };

  const refreshTagFilters = (insertAtTop = false) => {
    // available tags should reflect the current result set AFTER date filters, BEFORE tag filters
    const preTag = applyAllFilters(base, selectedPublishedRange, selectedModifiedRange);
    const availableTags = collectTagsWithCounts(preTag);
    const existing = filters.querySelector('.filter-group.tags');
    // capture currently open paths so we can preserve expand state
    const openPaths = new Set();
    if (existing) {
      existing.querySelectorAll('details.tag-collapsible[open][data-path]').forEach((d) => {
        const p = d.getAttribute('data-path');
        if (p) openPaths.add(p);
      });
    }
    if (existing) existing.remove();
    // Render and optionally move to top
    const temp = document.createElement('div');
    renderTagFilters(temp, availableTags, selectedTags, (next) => {
      selectedTags = next;
      block._selectedTags = selectedTags;
      // when tags change, recompute available tags again from preTag (still ignoring tags)
      resetToFirstPage();
      refreshTagFilters();
      renderList();
    }, openPaths);
    const newGroup = temp.firstElementChild;
    if (!newGroup) return;
    // Always keep Tags group at the top of the filter groups (but below the
    // "Filter Results" heading) for consistency.
    const first = filters.querySelector('.filter-group');
    if (first) {
      filters.insertBefore(newGroup, first);
    } else {
      filters.appendChild(newGroup);
    }
  };

  // Build pagination control: « Prev | 1 2 3 … N | Next »
  // Uses ellipses when there are many pages to keep the strip compact.
  const renderPagination = (totalPages) => {
    pagination.innerHTML = '';
    if (totalPages <= 1) return;

    const makeBtn = (label, page, { disabled = false, active = false, ariaLabel } = {}) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'search-page-btn';
      if (active) btn.classList.add('active');
      if (disabled) btn.disabled = true;
      btn.textContent = label;
      if (ariaLabel) btn.setAttribute('aria-label', ariaLabel);
      if (active) btn.setAttribute('aria-current', 'page');
      btn.addEventListener('click', () => {
        if (disabled || active) return;
        currentPage = page;
        block._currentPage = page;
        renderList();
        // Scroll list into view smoothly so user sees new page top
        results.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      return btn;
    };

    const makeEllipsis = () => {
      const span = document.createElement('span');
      span.className = 'search-page-ellipsis';
      span.textContent = '…';
      span.setAttribute('aria-hidden', 'true');
      return span;
    };

    // Prev
    pagination.append(makeBtn('‹', currentPage - 1, {
      disabled: currentPage <= 1,
      ariaLabel: 'Previous page',
    }));

    // Page numbers: show first, last, current ± 1, with ellipses
    const pages = new Set([1, totalPages, currentPage, currentPage - 1, currentPage + 1]);
    const visible = [...pages].filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b);
    let prev = 0;
    visible.forEach((p) => {
      if (p - prev > 1) pagination.append(makeEllipsis());
      pagination.append(makeBtn(String(p), p, {
        active: p === currentPage,
        ariaLabel: `Page ${p}`,
      }));
      prev = p;
    });

    // Next
    pagination.append(makeBtn('›', currentPage + 1, {
      disabled: currentPage >= totalPages,
      ariaLabel: 'Next page',
    }));
  };

  const renderList = async () => {
    const preTag = applyAllFilters(base, selectedPublishedRange, selectedModifiedRange);
    const afterTags = applyTagFilter(preTag, selectedTags);
    const afterType = applyTypeFilter(afterTags, selectedTypes);
    const filtered = applySort(afterType, sortOrder);
    const countEl = block.querySelector('.search-results-count');
    if (countEl) {
      const n = filtered.length;
      countEl.textContent = n === 1 ? '1 result' : `${n} results`;
    }
    results.innerHTML = '';
    pagination.innerHTML = '';
    if (!filtered.length) {
      const msg = document.createElement('li');
      msg.textContent = config.placeholders.searchNoResults || 'No results found.';
      results.classList.add('no-results');
      results.append(msg);
      return;
    }
    results.classList.remove('no-results');

    // Pagination math
    const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
    if (currentPage > totalPages) {
      currentPage = totalPages;
      block._currentPage = currentPage;
    }
    const startIdx = (currentPage - 1) * pageSize;
    const pageSlice = filtered.slice(startIdx, startIdx + pageSize);
    const renderGeneration = (block._assetMetaRenderGen || 0) + 1;
    block._assetMetaRenderGen = renderGeneration;

    pageSlice.forEach((r) => results.append(renderResult(r, searchTerms, searchPhrase, results.dataset.h)));

    const toEnrich = pageSlice.filter(
      (r) => /\/content\/dam\//.test(r.path || '') && (!r.size || !r.lastModified),
    );
    if (toEnrich.length && block.dataset.assetSearchPath) {
      try {
        await enrichSearchAssetsWithMetadata(
          toEnrich,
          block._assetListingBase || '',
          block._assetSearchIsAuthor ?? isAuthorEnvironment(),
          `ck=${Date.now()}`,
        );
        if (block._assetMetaRenderGen !== renderGeneration) return;
        [...results.children].forEach((li, idx) => {
          const record = pageSlice[idx];
          if (record && isDamAssetResult(record)) updateAssetResultMeta(li, record);
        });
      } catch (_) { /* meta enrichment is best-effort */ }
    }

    renderPagination(totalPages);
  };

  renderFilters();
  renderList();
}

export default async function decorate(block) {
  const placeholders = await fetchPlaceholders();
  // Determine source path from the first config row anchor, or existing anchor in block, or locale default
  const configAnchor = block.querySelector(':scope > div:nth-child(1) a[href]');
  const inlineAnchor = block.querySelector('a[href]');
  const candidate = configAnchor?.href || inlineAnchor?.href || '';
  const isJsonSource = candidate && /\.json(\?|$)/.test(candidate) && /query-index\.json(\?|$)/.test(candidate);
  let source = isJsonSource ? candidate : '';
  if (!source) {
    // Resolve the locale for /<locale>/query-index.json from, in order:
    //   1. <html lang="…"> (set on author / aem.page)
    //   2. first path segment of the URL when it looks like a locale (aem.live
    //      sometimes ships pages without a lang attribute on <html>)
    //   3. empty (root-level query-index.json — not present in this repo so
    //      this case yields a 404 and an empty result set)
    const htmlLang = (document.documentElement.getAttribute('lang') || '').trim();
    const langMatch = htmlLang.match(/^[a-z]{2}(?:-[A-Z]{2})?$/);
    let locale = langMatch ? htmlLang.split('-')[0] : '';
    if (!locale) {
      const firstSeg = (window.location.pathname.split('/').filter(Boolean)[0] || '').toLowerCase();
      if (/^[a-z]{2}$/.test(firstSeg)) locale = firstSeg;
    }
    source = `${locale ? `/${locale}` : ''}/query-index.json`;
    // eslint-disable-next-line no-console
    if (candidate && !isJsonSource) console.log('[search] ignoring non-JSON config anchor for source:', candidate);
  }

  // Read style (row 2), pageSize (row 3), assetSearchPath (row 4); hide all config rows.
  try {
    const styleText = block.querySelector(':scope > div:nth-child(2) > div p')?.textContent?.trim();
    if (styleText) block.classList.add(styleText);
    const pageSizeText = block.querySelector(':scope > div:nth-child(3) > div p')?.textContent?.trim()
      || block.querySelector(':scope > div:nth-child(3) > div')?.textContent?.trim();
    const pageSizeNum = parseInt(pageSizeText, 10);
    if (pageSizeNum && pageSizeNum > 0) block.dataset.pageSize = String(pageSizeNum);

    // Asset search path — accepts an anchor href (aem-content picker) or plain text.
    const row4 = block.querySelector(':scope > div:nth-child(4)');
    if (row4) {
      const anchor = row4.querySelector('a');
      const anchorHref = anchor?.getAttribute('title')
        || anchor?.getAttribute('href')
        || anchor?.textContent
        || '';
      const plainText = row4.querySelector('div p')?.textContent
        || row4.querySelector('div')?.textContent
        || '';
      const assetPath = normalizeAssetFolderPath(anchorHref || plainText || '');
      if (assetPath) block.dataset.assetSearchPath = assetPath;
    }

    // Excluded asset paths — comma/newline separated DAM path prefixes.
    // Any asset record whose absolute or relative path starts with one of
    // these prefixes is dropped before merging into search results.
    const row5 = block.querySelector(':scope > div:nth-child(5)');
    if (row5) {
      const excludeText = (row5.querySelector('div p')?.textContent
        || row5.querySelector('div')?.textContent
        || '').trim();
      if (excludeText) block.dataset.excludeAssetPaths = excludeText;
    }

    const row1 = block.querySelector(':scope > div:nth-child(1)');
    const row2 = block.querySelector(':scope > div:nth-child(2)');
    const row3 = block.querySelector(':scope > div:nth-child(3)');
    [row1, row2, row3, row4, row5].forEach((r) => { if (r) r.style.display = 'none'; });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('[search] style/hide rows error', e);
  }

  // Variant selection via block classes
  const useIconVariant = block.classList.contains('search-icon');
  const useBarVariant = block.classList.contains('search-bar') || !useIconVariant;

  if (useIconVariant) {
    if (!block.classList.contains('search-icon')) block.classList.add('search-icon');
    // icon variant: trigger opens overlay hosting search UI
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'search-trigger';
    trigger.setAttribute('aria-label', 'Open search');
    const icon = searchIcon();
    trigger.append(icon);
    const overlay = document.createElement('div');
    overlay.className = 'search-overlay';
    const panel = document.createElement('div');
    panel.className = 'search-overlay-panel';
    panel.append(
      searchBox(block, { source, placeholders }),
    );
    overlay.append(panel);
    block.append(trigger, overlay);

    const openOverlay = () => {
      overlay.classList.add('open');
      const input = overlay.querySelector('input.search-input');
      if (input) input.focus();
    };
    const closeOverlay = () => {
      overlay.classList.remove('open');
      clearSearch(block);
    };

    trigger.addEventListener('click', openOverlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeOverlay(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && overlay.classList.contains('open')) closeOverlay(); });

    // Enter in icon variant should redirect to /{lang}/search?q=...
    const getLocalePrefix = () => {
      try {
        const lang = getLanguage();
        console.log('lang', lang);
        return lang ? `/${lang}` : '';
      } catch (e) {
        const htmlLang = (document.documentElement.getAttribute('lang') || '').trim();
        const langMatch = htmlLang.match(/^[a-z]{2}(?:-[A-Z]{2})?$/);
        const locale = langMatch ? htmlLang.split('-')[0] : '';
        return locale ? `/${locale}` : '';
      }
    };
    const redirectToSearchPage = (query) => {
      const targetPath = `${getLocalePrefix()}/search`;
      const url = new URL(targetPath, window.location.origin);
      if (query && query.trim()) url.searchParams.set('q', query.trim());
      // Carry scoped search path to the search page if authored
      attachScopeParam(url, getScopedPrefix(block));
      window.location.href = url.toString();
    };
    const overlayInput = panel.querySelector('input.search-input');
    if (overlayInput) {
      // Mount a query-suggestion dropdown above the overlay's results dropdown.
      // Picking a suggestion redirects to /search?q=<value> like Enter does.
      const overlayBox = overlayInput.closest('.search-box');
      const suggestions = document.createElement('div');
      suggestions.className = 'search-suggestions';
      if (overlayBox) overlayBox.append(suggestions);
      attachSuggestions(block, overlayInput, suggestions, { source, placeholders }, (val) => {
        saveRecentSearch(val);
        redirectToSearchPage(val);
      });
      overlayInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !suggestions.classList.contains('open')) {
          e.preventDefault();
          saveRecentSearch(overlayInput.value || '');
          redirectToSearchPage(overlayInput.value || '');
        }
      });
    }
  } else {
    // bar variant: inline search box with dropdown beneath input
    block.append(
      searchBox(block, { source, placeholders }),
    );

    // Ensure the (results) suggestion dropdown isn't present in bar variant —
    // we replace it with a lightweight query-suggestion dropdown.
    const oldDropdown = block.querySelector('.search-dropdown');
    if (oldDropdown) oldDropdown.remove();

    const input = block.querySelector('input.search-input');
    const box = input.closest('.search-box');
    const suggestions = document.createElement('div');
    suggestions.className = 'search-suggestions';
    if (box) box.append(suggestions);
    attachSuggestions(block, input, suggestions, { source, placeholders }, async (val) => {
      saveRecentSearch(val);
      await activateExpandedSearch(block, { source, placeholders }, val);
    });

    // Enter activates expanded mode (only when suggestion list isn't driving)
    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter' && !suggestions.classList.contains('open')) {
        e.preventDefault();
        saveRecentSearch(input.value || '');
        await activateExpandedSearch(block, { source, placeholders }, input.value);
      }
    });
  }

  if (searchParams.get('q')) {
    const input = block.querySelector('input');
    input.value = searchParams.get('q');
    // Apply scoped path forwarded via 'sp' param (from search-icon overlay)
    const forwardedScope = (new URL(window.location.href)).searchParams.get('sp') || '';
    if (forwardedScope) {
      block._forwardedScope = forwardedScope;
    }
    if (useBarVariant) {
      await activateExpandedSearch(block, { source, placeholders }, input.value);
    } else {
      input.dispatchEvent(new Event('input'));
    }
  }

  decorateIcons(block);

  // close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (!block.contains(e.target)) {
      const dropdown = block.querySelector('.search-dropdown');
      if (dropdown) dropdown.classList.remove('open');
      if (dropdown && dropdown.parentElement) dropdown.parentElement.classList.remove('open');
    }
  });

  // no special positioning logic needed; dropdown is positioned within box
}
