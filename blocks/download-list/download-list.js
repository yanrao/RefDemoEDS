import { isAuthorEnvironment } from '../../scripts/scripts.js';
import { getMetadata } from '../../scripts/aem.js';
import { getHostname } from '../../scripts/utils.js';

const TYPE_MATCHERS = {
  pdf: (mime, ext) => mime === 'application/pdf' || ext === 'pdf',
  doc: (mime, ext) => /msword|officedocument\.wordprocessingml/.test(mime) || ext === 'doc' || ext === 'docx',
  xls: (mime, ext) => /excel|officedocument\.spreadsheetml/.test(mime) || ext === 'xls' || ext === 'xlsx',
  ppt: (mime, ext) => /powerpoint|officedocument\.presentationml/.test(mime) || ext === 'ppt' || ext === 'pptx',
  image: (mime, ext) => mime.startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'tiff', 'avif', 'ico'].includes(ext),
  video: (mime, ext) => mime.startsWith('video/') || ['mp4', 'webm', 'mov', 'ogg', 'm4v', 'avi', 'mkv'].includes(ext),
  audio: (mime, ext) => mime.startsWith('audio/') || ['mp3', 'wav', 'm4a', 'aac', 'flac', 'oga'].includes(ext),
  zip: (mime, ext) => mime === 'application/zip' || ext === 'zip',
};

function readConfig(block) {
  const config = {};
  block.querySelectorAll(':scope > div').forEach((row) => {
    const cells = row.querySelectorAll(':scope > div');
    if (cells.length < 2) return;
    const key = cells[0].textContent?.trim()?.toLowerCase();
    const valueCell = cells[1];
    const link = valueCell.querySelector('a');
    const value = (link?.getAttribute('title') || link?.textContent || valueCell.textContent || '').trim();
    if (key) config[key] = value;
  });
  return config;
}

// Read any legacy multi-reference "Individual Files" row that previously
// authored content may still contain. The current model only exposes the
// Asset Folder field, but this read keeps old pages rendering instead of
// silently dropping their lone picked asset.
function readIndividualAssets(block) {
  // Locate the value cell holding the picked assets. Prefer the editor's
  // data-aue-prop marker (reliable in the Universal Editor); otherwise match the
  // key-value row whose key mentions "individual" (individualAssets /
  // "Individual Files" / "Individual Assets").
  let valueCell = block.querySelector('[data-aue-prop="individualAssets"]');
  if (!valueCell) {
    const rows = block.querySelectorAll(':scope > div');
    for (const row of rows) {
      const cells = row.querySelectorAll(':scope > div');
      if (cells.length < 2) continue;
      const key = (cells[0].textContent || '').toLowerCase().replace(/[^a-z]/g, '');
      if (key.includes('individual')) { [, valueCell] = cells; break; }
    }
  }
  if (!valueCell) return [];

  const paths = [];
  const seen = new Set();
  const push = (raw) => {
    const p = (raw || '').trim();
    if (!p || seen.has(p)) return;
    seen.add(p);
    paths.push(p);
  };
  // Asset references can render as links (href/title hold the DAM path) or as
  // images/pictures (src may be an optimized delivery URL).
  valueCell.querySelectorAll('a[href]').forEach((a) => {
    push(a.getAttribute('title') || a.getAttribute('href') || '');
  });
  valueCell.querySelectorAll('picture source[srcset]').forEach((s) => {
    push((s.getAttribute('srcset') || '').split(/\s|,/)[0]);
  });
  valueCell.querySelectorAll('img[src]').forEach((img) => {
    push(img.getAttribute('src') || '');
  });
  return paths;
}

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return '';
  const num = Number(bytes);
  if (Number.isNaN(num)) return '';
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(0)} KB`;
  if (num < 1024 * 1024 * 1024) return `${(num / (1024 * 1024)).toFixed(num < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(num / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function getExtension(name) {
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : '';
}

// Normalize the folder path coming from the aem-content picker.
// Possible inputs we've seen:
//   /content/dam/my-site
//   /content/dam/my-site.json
//   urn:aemconnection:/content/dam/my-site
//   /content/dam/my%20site   (URL-encoded)
//   trailing slash variants
function normalizeFolderPath(rawPath) {
  if (!rawPath) return '';
  let p = String(rawPath).trim();
  p = p.replace(/^urn:aemconnection:/i, '');
  try { p = decodeURIComponent(p); } catch (_) { /* keep as-is if malformed */ }
  p = p.replace(/\.json$/, '');
  p = p.replace(/\/$/, '');
  return p;
}

function toAssetsApiPath(folderPath) {
  const cleanPath = normalizeFolderPath(folderPath);
  if (cleanPath.startsWith('/api/assets/')) return `${cleanPath}.json`;
  if (cleanPath.startsWith('/content/dam/')) {
    return `/api/assets/${cleanPath.slice('/content/dam/'.length)}.json`;
  }
  return `${cleanPath}.json`;
}

// Resolve the AEM base URLs for the current environment. On author we keep
// relative URLs; on aem.live (or any non-author) we read the hostname from
// placeholders.json and derive the publish AEM origin by swapping author→publish.
async function resolveAemUrls() {
  const isAuthor = isAuthorEnvironment();
  if (isAuthor) {
    return { isAuthor: true, listingBase: '', assetBase: '' };
  }
  let hostname = '';
  try {
    hostname = (await getHostname()) || '';
  } catch (_) { /* ignore */ }
  if (!hostname) hostname = getMetadata('hostname') || '';
  const publishOrigin = hostname
    ? hostname.replace('author', 'publish').replace(/\/$/, '')
    : '';
  return {
    isAuthor: false,
    listingBase: publishOrigin,
    assetBase: publishOrigin,
  };
}

// Parse the Siren-style response from /api/assets/<path>.json
function parseAssetsApiResponse(data, isAuthor, assetBase) {
  const entities = data.entities || [];
  return entities
    .filter((e) => Array.isArray(e['class']) && e['class'].includes('assets/asset'))
    .map((e) => {
      const props = e.properties || {};
      const meta = props.metadata || {};
      const name = props.name || (e.links?.find((l) => l.rel?.includes('content'))?.href || '').split('/').pop();
      const mime = props['dc:format'] || props.format || meta['dc:format'] || '';
      const size = Number(
        props.size
          || props.contentLength
          || meta['dam:size']
          || meta.size
          || 0,
      );
      const modified = props['jcr:lastModified'] || props.lastModified || '';
      const selfHref = e.links?.find((l) => l.rel?.includes('self'))?.href || '';
      // selfHref from AEM is often an absolute URL ("https://publish-…/api/assets/…json").
      // Convert /api/assets/ → /content/dam/ and strip .json, but DO NOT prepend
      // assetBase again if the result is already absolute — that would double the host.
      const damPath = selfHref.replace('/api/assets/', '/content/dam/').replace(/\.json$/, '');
      const isAbsolute = /^https?:\/\//i.test(damPath);
      const path = (isAuthor || isAbsolute) ? damPath : `${assetBase}${damPath}`;
      return { name, mime, size, modified, path };
    });
}

// Parse the Sling JSON view of a DAM folder: /content/dam/<path>.1.json
// Each immediate child is a key in the response object whose value is its node JSON.
// We pick those that are dam:Asset (i.e. have a jcr:content/metadata).
function parseSlingFolderResponse(data, folderDamPath, isAuthor, assetBase) {
  const out = [];
  Object.entries(data || {}).forEach(([key, val]) => {
    if (!val || typeof val !== 'object') return;
    if (key.startsWith('jcr:') || key.startsWith('rep:') || key.startsWith('cq:')) return;
    const primary = val['jcr:primaryType'];
    if (primary !== 'dam:Asset') return;
    const meta = val['jcr:content']?.metadata || {};
    const jcrContent = val['jcr:content'] || {};
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
    const modified = meta['jcr:lastModified']
      || jcrContent['jcr:lastModified']
      || val['jcr:lastModified']
      || '';
    const damChildPath = `${folderDamPath}/${key}`;
    const isAbsolute = /^https?:\/\//i.test(damChildPath);
    const path = (isAuthor || isAbsolute) ? damChildPath : `${assetBase}${damChildPath}`;
    out.push({ name: key, mime, size, modified, path });
  });
  return out;
}

async function tryFetch(url, isAuthor) {
  // eslint-disable-next-line no-console
  console.debug('download-list: trying', url);
  try {
    const response = await fetch(url, isAuthor ? { credentials: 'include' } : {});
    if (!response.ok) return { ok: false, status: response.status };
    return { ok: true, data: await response.json() };
  } catch (err) {
    return { ok: false, error: err };
  }
}

// Publish AEM caps Sling JSON depth at 1 for security, so `.3.json` on a folder
// lists the assets but strips their jcr:content/metadata. A single asset's
// `.3.json` is allowed, however — fetch each one in parallel and merge the
// dam:size / dc:format / lastModified back into the listing.
async function enrichAssetsWithMetadata(assets, listingBase, isAuthor) {
  const needsFetch = assets.filter((a) => !a.size || !a.mime);
  if (!needsFetch.length) return assets;
  await Promise.all(needsFetch.map(async (asset) => {
    const url = /^https?:\/\//i.test(asset.path)
      ? `${asset.path}.3.json?ck=${Date.now()}`
      : `${listingBase}${asset.path}.3.json?ck=${Date.now()}`;
    const result = await tryFetch(url, isAuthor);
    if (!result.ok || !result.data) return;
    const jcrContent = result.data['jcr:content'] || {};
    const meta = jcrContent.metadata || {};
    const original = jcrContent.renditions?.original?.['jcr:content'] || {};
    if (!asset.size) {
      asset.size = Number(meta['dam:size'] || original['jcr:data'] || 0);
    }
    if (!asset.mime) {
      asset.mime = jcrContent['jcr:mimeType'] || meta['dc:format'] || original['jcr:mimeType'] || '';
    }
    if (!asset.modified) {
      asset.modified = meta['jcr:lastModified'] || jcrContent['jcr:lastModified'] || '';
    }
  }));
  return assets;
}

async function fetchAssetsFromFolder(folderPath) {
  const { isAuthor, listingBase, assetBase } = await resolveAemUrls();
  if (!isAuthor && !listingBase) {
    throw new Error('No publish hostname configured (placeholders.json hostname is empty).');
  }
  const folderDamPath = normalizeFolderPath(folderPath); // e.g. /content/dam/my-site

  // Endpoint #1: Sling JSON view — `/content/dam/<path>.3.json`.
  // On author depth 3 returns metadata inline. On publish depth is capped at 1
  // so the listing returns asset nodes without jcr:content — we enrich below.
  if (folderDamPath.startsWith('/content/dam/')) {
    const slingUrl = `${listingBase}${folderDamPath}.3.json?ck=${Date.now()}`;
    const slingResult = await tryFetch(slingUrl, isAuthor);
    if (slingResult.ok && slingResult.data && typeof slingResult.data === 'object') {
      const assets = parseSlingFolderResponse(slingResult.data, folderDamPath, isAuthor, assetBase);
      if (assets.length) {
        return enrichAssetsWithMetadata(assets, listingBase, isAuthor);
      }
    }
  }

  // Endpoint #2 (fallback): Assets HTTP API — Siren JSON (entities). Missing dam:size.
  const apiPath = toAssetsApiPath(folderPath);
  const apiUrl = `${listingBase}${apiPath}`;
  const apiResult = await tryFetch(apiUrl, isAuthor);
  if (apiResult.ok && Array.isArray(apiResult.data?.entities)) {
    const assets = parseAssetsApiResponse(apiResult.data, isAuthor, assetBase);
    return enrichAssetsWithMetadata(assets, listingBase, isAuthor);
  }

  const status = apiResult.status || 'unknown';
  throw new Error(`Asset fetch failed: ${status} for ${apiUrl} (raw folderPath=${folderPath}). Sling JSON primary also failed.`);
}

// Build asset records from a list of individual picker paths (multi-reference
// field). Each entry is either an absolute publish URL or a relative
// /content/dam/... path. We construct a stub record and let
// enrichAssetsWithMetadata fill in size/mime/lastModified via per-asset
// Sling JSON fetches — same path used by the folder listing on publish.
async function fetchAssetsFromIndividualPaths(rawPaths) {
  const { isAuthor, listingBase, assetBase } = await resolveAemUrls();
  if (!isAuthor && !listingBase) {
    throw new Error('No publish hostname configured (placeholders.json hostname is empty).');
  }
  const records = [];
  const seen = new Set();
  rawPaths.forEach((raw) => {
    let value = String(raw || '').trim();
    if (!value) return;
    value = value.replace(/^urn:aemconnection:/i, '');
    try { value = decodeURIComponent(value); } catch (_) { /* keep as-is */ }
    value = value.replace(/\.json$/, '').replace(/\/$/, '');
    if (!value) return;

    const isAbsolute = /^https?:\/\//i.test(value);
    let pathname = value;
    if (isAbsolute) {
      try { pathname = new URL(value).pathname; } catch (_) { pathname = value; }
    }

    // Friendly name from the last path segment (strip query/hash).
    const name = (pathname.split('/').pop() || value).split('?')[0].split('#')[0] || 'file';

    // Resolve a fetchable download URL and (when available) the /content/dam
    // path used for the Sling JSON metadata enrichment:
    //  - /content/dam/... : enrichable; prepend the publish base on aem.live.
    //  - anything else (optimized delivery URL, absolute) : used as-is.
    let damPath = '';
    let path;
    if (pathname.startsWith('/content/dam/')) {
      damPath = pathname;
      path = (isAuthor || isAbsolute) ? (isAbsolute ? value : pathname) : `${assetBase}${pathname}`;
    } else {
      path = isAbsolute ? value : `${assetBase || ''}${value}`;
    }
    if (seen.has(path)) return;
    seen.add(path);
    records.push({
      name, mime: '', size: 0, modified: '', path, damPath,
    });
  });
  if (!records.length) return [];
  return enrichAssetsWithMetadata(records, listingBase, isAuthor);
}

function filterAssets(assets, fileTypes) {
  if (!fileTypes || fileTypes === 'all') return assets;
  const tokens = fileTypes.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (!tokens.length) return assets;
  return assets.filter((a) => {
    const ext = getExtension(a.name || '');
    const mime = (a.mime || '').toLowerCase();
    return tokens.some((t) => {
      const matcher = TYPE_MATCHERS[t];
      if (matcher) return matcher(mime, ext);
      return ext === t || mime.includes(t);
    });
  });
}

function sortAssets(assets, sortBy) {
  const list = [...assets];
  switch (sortBy) {
    case 'name-desc':
      return list.sort((a, b) => b.name.localeCompare(a.name));
    case 'modified':
      return list.sort((a, b) => new Date(a.modified) - new Date(b.modified));
    case 'modified-desc':
      return list.sort((a, b) => new Date(b.modified) - new Date(a.modified));
    case 'size':
      return list.sort((a, b) => Number(a.size) - Number(b.size));
    case 'size-desc':
      return list.sort((a, b) => Number(b.size) - Number(a.size));
    case 'name':
    default:
      return list.sort((a, b) => a.name.localeCompare(b.name));
  }
}

function fileIconSvg(ext) {
  const label = (ext || 'FILE').toUpperCase().slice(0, 4);
  return `
    <svg class="download-row__svg" viewBox="0 0 30 40" fill="none" aria-hidden="true" focusable="false">
      <rect x="1" y="1" width="28" height="38" rx="2" stroke="currentColor" stroke-width="2"></rect>
      <path d="M18 1V9H28" stroke="currentColor" stroke-width="2"></path>
      <rect x="1" y="22" width="23" height="13" rx="2" fill="var(--main-accent-color, #00A4E4)"></rect>
      <text x="3" y="31" font-family="sans-serif" font-weight="700" font-size="8" fill="white">${label}</text>
    </svg>`;
}

function downloadIconSvg() {
  return `
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
      <path d="M10 2v11M5 9l5 5 5-5M3 16h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
    </svg>`;
}

// Browsers ignore the <a download> attribute for cross-origin URLs (aem.live →
// publish AEM origin), so PDFs/images open inline instead of downloading.
// Fetch the asset as a blob and trigger the download via a same-origin object
// URL — this preserves the original filename and forces "save as".
async function triggerBlobDownload(url, filename) {
  const response = await fetch(url, { credentials: 'omit' });
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename || '';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

function buildRow(asset, downloadLabel) {
  const li = document.createElement('li');
  li.className = 'download-row';

  const info = document.createElement('div');
  info.className = 'download-row__info';

  const icon = document.createElement('div');
  icon.className = 'download-row__icon';
  icon.innerHTML = fileIconSvg(getExtension(asset.name || ''));

  const meta = document.createElement('div');
  meta.className = 'download-row__meta';
  const nameEl = document.createElement('span');
  nameEl.className = 'download-row__name';
  nameEl.textContent = asset.name;
  meta.append(nameEl);
  const sizeEl = document.createElement('span');
  sizeEl.className = 'download-row__size';
  sizeEl.textContent = `File size : ${asset.size ? formatBytes(asset.size) : '—'}`;
  meta.append(sizeEl);

  info.append(icon, meta);

  const link = document.createElement('a');
  link.className = 'btn btn--outline download-row__action';
  if (!downloadLabel) link.classList.add('download-row__action--icon-only');
  link.href = asset.path;
  link.setAttribute('download', asset.name || '');
  link.setAttribute('aria-label', downloadLabel ? `${downloadLabel} ${asset.name}` : `Download ${asset.name}`);
  link.innerHTML = downloadLabel
    ? `${downloadIconSvg()} <span>${downloadLabel}</span>`
    : downloadIconSvg();
  link.addEventListener('click', async (e) => {
    e.preventDefault();
    try {
      await triggerBlobDownload(asset.path, asset.name);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('download-list: blob download failed, falling back to direct link', err);
      window.location.href = asset.path;
    }
  });

  li.append(info, link);
  return li;
}

function renderEmpty(block, message) {
  const empty = document.createElement('p');
  empty.className = 'download__empty';
  empty.textContent = message;
  block.append(empty);
}

async function fetchManifest(url) {
  // eslint-disable-next-line no-console
  console.debug('download-list: fetching manifest', url);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Manifest fetch failed: ${response.status} for ${url}`);
  const data = await response.json();
  const files = Array.isArray(data) ? data : (data.files || []);
  return files.map((f) => ({
    name: f.name || (f.url || '').split('/').pop(),
    mime: f.mime || f.format || '',
    size: Number(f.size || 0),
    modified: f.modified || '',
    path: f.url || f.path || '',
  }));
}

export default async function decorate(block) {
  // IMPORTANT: read every input from the rendered block DOM BEFORE clearing it.
  // `block.textContent = ''` empties all child nodes, so anything that queries
  // the block (like readIndividualAssets) must run first.
  const config = readConfig(block);
  const individualPaths = readIndividualAssets(block);
  const title = config.title || config['section title'] || '';
  const manifestUrl = (config.manifesturl || config['manifest url (publish-friendly)'] || config['manifest url'] || '').trim();
  const folderPath = config.assetfolder || config['asset folder'] || '';
  const fileTypes = config.filetypes || config['file types'] || '';
  const sortBy = config.sortby || config['sort by'] || 'name';
  const limit = parseInt(config.limit || config['max items'] || '0', 10) || 0;
  const downloadLabel = (config.downloadlabel || config['download button label'] || '').trim();
  const bgColor = (config.bgcolor || config['background color'] || '').trim();
  const textColor = (config.textcolor || config['text color'] || '').trim();

  block.textContent = '';
  block.classList.add('download');

  // Author-controlled colors. Set them inline (highest specificity, so they win
  // over any inherited/global color rule) AND as custom properties (used by the
  // row borders/hover so those track the chosen text color). Child elements use
  // `color: inherit`, so the inline text color cascades to titles, names, etc.
  if (bgColor) {
    block.style.backgroundColor = bgColor;
    block.style.setProperty('--download-bg', bgColor);
  }
  if (textColor) {
    block.style.color = textColor;
    block.style.setProperty('--download-text', textColor);
  }

  if (title) {
    const heading = document.createElement('h2');
    heading.className = 'download__title';
    heading.textContent = title;
    block.append(heading);
  }

  // Individual picker takes precedence over a folder/manifest, so an author
  // can curate a list of specific files across multiple DAM folders.
  if (!individualPaths.length && !manifestUrl && !folderPath) {
    renderEmpty(block, 'No asset folder, individual files, or manifest URL configured.');
    return;
  }

  // Priority: individualAssets → manifestUrl → assetFolder.
  // Same-origin JSON works on author and aem.live for manifestUrl. Folder and
  // individual-picker paths both go through the Sling JSON metadata fetch.
  let assets = [];
  try {
    if (individualPaths.length) {
      assets = await fetchAssetsFromIndividualPaths(individualPaths);
    } else if (manifestUrl) {
      assets = await fetchManifest(manifestUrl);
    } else {
      assets = await fetchAssetsFromFolder(folderPath);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('download-list: failed to fetch assets', err);
    renderEmpty(block, 'Could not load files.');
    return;
  }

  // Hand-picked individual files are shown as-is — the author already curated
  // them, so the File Types filter only applies to folder/manifest listings.
  if (!individualPaths.length) {
    assets = filterAssets(assets, fileTypes);
  }
  assets = sortAssets(assets, sortBy);
  if (limit > 0) assets = assets.slice(0, limit);

  if (!assets.length) {
    renderEmpty(block, 'No files found in this folder.');
    return;
  }

  const list = document.createElement('ul');
  list.className = 'download__list';
  list.setAttribute('role', 'list');
  assets.forEach((asset) => list.append(buildRow(asset, downloadLabel)));
  block.append(list);
}
