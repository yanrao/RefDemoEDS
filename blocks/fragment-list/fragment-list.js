import { getMetadata } from '../../scripts/aem.js';
import { isAuthorEnvironment } from '../../scripts/scripts.js';
import { getHostname, resolveImageUrl } from '../../scripts/utils.js';

// --- Constants ---
const GRAPHQL_QUERY_PATH = '/graphql/execute.json/ref-demo-eds/GetContentCardListFromFolder';
const OPEN_API_CF_PATH = '/adobe/contentFragments';
const OPEN_API_CFM_PATH = '/adobe/contentFragments/models';
const CONFIG = {
  WRAPPER_SERVICE_URL: 'https://3635370-refdemoapigateway-stage.adobeioruntime.net/api/v1/web/ref-demo-api-gateway/fetch-cf',
};

// --- Utilities ---
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
}

function createElement(tag, className, content) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content) element.innerHTML = content;
  return element;
}

function toTitleCase(text) {
  if (!text) return '';
  return text.replace(/[-_]/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}

function extractTagLabel(tagId) {
  if (!tagId || typeof tagId !== 'string') return '';
  const last = tagId.split('/').pop();
  return toTitleCase(last);
}

function getUniqueTags(cards) {
  const tags = new Set();
  cards.forEach((card) => {
    if (Array.isArray(card.tags)) {
      card.tags.forEach((tag) => {
        if (tag && tag.trim()) tags.add(tag.trim());
      });
    }
  });
  return Array.from(tags).sort();
}

function getCtaVariant(config) {
  if (config.ctaStyle) {
    const styleMap = {
      button: 'cta-button',
      'button-secondary': 'cta-button-secondary',
      'button-dark': 'cta-button-dark',
      link: 'cta-link',
    };
    return styleMap[config.ctaStyle] || 'cta-button';
  }
  return config.layout === 'articles' ? 'cta-button-secondary' : 'cta-button';
}

// --- Data Fetching ---

/**
 * Primary method: Content Fragment Open API
 */
async function fetchViaOpenAPI(folderPath, modelName) {
  try {
    const decodedFolderPath = decodeURIComponent(folderPath);
    const hostnameFromPlaceholders = await getHostname();
    const hostname = hostnameFromPlaceholders || getMetadata('hostname');
    const publishUrl = hostname?.replace('author', 'publish')?.replace(/\/$/, '') || '';

    const cfUrl = `${publishUrl}${OPEN_API_CF_PATH}?path=${encodeURIComponent(decodedFolderPath)}`;
    const cfResponse = await fetch(cfUrl);

    if (!cfResponse.ok) {
      // Non-200 means Open API is not enabled on this environment
      console.log(`Open API not available (${cfResponse.status}), will fallback to GraphQL`);
      return null;
    }

    const cfData = await cfResponse.json();
    const items = cfData?.items || cfData?.results || (Array.isArray(cfData) ? cfData : []);

    if (!items.length) {
      console.log('Open API returned empty results for folder:', folderPath);
      return [];
    }

    // If modelName is provided, fetch CFM list to filter by model
    let filteredItems = items;
    if (modelName) {
      const modelsUrl = `${publishUrl}${OPEN_API_CFM_PATH}`;
      const modelsResponse = await fetch(modelsUrl);

      if (modelsResponse.ok) {
        const modelsData = await modelsResponse.json();
        const modelsList = modelsData?.items || modelsData?.results || (Array.isArray(modelsData) ? modelsData : []);

        // Build modelId → modelName map
        const modelMap = new Map();
        modelsList.forEach((m) => {
          const mName = m.name || m.title || '';
          const mId = m.id || m._id || m.modelId || '';
          if (mId) modelMap.set(mId, mName.toLowerCase());
        });

        // Filter items by matching model name
        filteredItems = items.filter((item) => {
          const itemModelId = item.modelId || item.model?.id || item._modelId || '';
          const resolvedName = modelMap.get(itemModelId) || '';
          return resolvedName === modelName.toLowerCase();
        });
      }
    }

    const isAuthor = isAuthorEnvironment();
    return filteredItems.map((item) => transformOpenAPIItem(item, isAuthor));
  } catch (error) {
    console.error('Error in Open API fetch:', error);
    return null;
  }
}

/**
 * Fallback method: GraphQL persisted query
 */
async function fetchViaGraphQL(folderPath) {
  try {
    const decodedFolderPath = decodeURIComponent(folderPath);
    const hostnameFromPlaceholders = await getHostname();
    const hostname = hostnameFromPlaceholders || getMetadata('hostname');
    const aemauthorurl = getMetadata('authorurl') || '';
    const aempublishurl = hostname?.replace('author', 'publish')?.replace(/\/$/, '') || '';
    const isAuthor = isAuthorEnvironment();

    const requestConfig = isAuthor
      ? {
        url: `${aemauthorurl}${GRAPHQL_QUERY_PATH};path=${decodedFolderPath};ts=${Date.now()}`,
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      }
      : {
        url: CONFIG.WRAPPER_SERVICE_URL,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          graphQLPath: `${aempublishurl}${GRAPHQL_QUERY_PATH}`,
          cfPath: decodedFolderPath,
          variation: `main;ts=${Date.now()}`,
        }),
      };

    const response = await fetch(requestConfig.url, {
      method: requestConfig.method,
      headers: requestConfig.headers,
      ...(requestConfig.body && { body: requestConfig.body }),
    });

    if (!response.ok) {
      throw new Error(`GraphQL request failed: ${response.status}`);
    }

    const payload = await response.json();
    const items = payload?.data?.contentCardList?.items || [];
    return items.map((item) => transformGraphQLItem(item, isAuthor));
  } catch (error) {
    console.error('Error in GraphQL fetch:', error);
    return [];
  }
}

/**
 * External API fetch
 */
async function fetchFromExternalAPI(apiUrl) {
  try {
    const response = await fetch(apiUrl);
    if (!response.ok) throw new Error(`API request failed: ${response.status}`);
    const data = await response.json();
    const rawItems = Array.isArray(data) ? data : data.items || data.results || [];
    return rawItems.map((item) => transformExternalAPIItem(item));
  } catch (error) {
    console.error('Error fetching from external API:', error);
    return [];
  }
}

/**
 * Orchestrator: decides which fetch method to use based on config
 */
async function fetchFragmentData(config) {
  const {
    dataSourceType, contentFragmentFolder, apiUrl, modelName,
  } = config;

  if (dataSourceType === 'api') {
    if (!apiUrl) {
      console.warn('External API selected but no URL provided');
      return [];
    }
    return fetchFromExternalAPI(apiUrl);
  }

  // Content Fragments: try Open API first, fallback to GraphQL
  if (!contentFragmentFolder) {
    console.warn('Content Fragment folder not configured');
    return [];
  }

  const openAPIResult = await fetchViaOpenAPI(contentFragmentFolder, modelName);
  if (openAPIResult !== null) {
    // Open API responded (200) — use its result (could be empty array)
    return openAPIResult;
  }

  // Fallback to GraphQL
  console.log('Falling back to GraphQL approach');
  return fetchViaGraphQL(contentFragmentFolder);
}

// --- Transformers ---

function transformOpenAPIItem(item, isAuthorEnv) {
  const imageUrl = resolveImageUrl(item?.image, isAuthorEnv);

  const tags = Array.isArray(item?.tags)
    ? item.tags.map(extractTagLabel).filter(Boolean)
    : [];

  const subtext = item?.subtext?.plaintext || item?.subtext?.html || item?.subtext || '';
  const subtextHtml = item?.subtext?.html || '';

  return {
    // eslint-disable-next-line no-underscore-dangle
    id: item?._path || item?.id || Math.random().toString(36).slice(2),
    title: item?.title || '',
    subtext,
    subtextHtml,
    tags,
    image: imageUrl,
    enabled: item?.enabled !== false && item?.enabled !== 'false',
    ctaText: item?.ctaText || '',
    ctaLink: item?.ctaLink || '',
  };
}

function transformGraphQLItem(item, isAuthorEnv) {
  const imageUrl = resolveImageUrl(item?.image, isAuthorEnv);

  const tags = Array.isArray(item?.tags)
    ? item.tags.map(extractTagLabel).filter(Boolean)
    : [];

  const subtext = item?.subtext?.plaintext || item?.subtext || '';
  const subtextHtml = item?.subtext?.html || '';

  return {
    id: item?._path || Math.random().toString(36).slice(2),
    title: item?.title || '',
    subtext,
    subtextHtml,
    tags,
    image: imageUrl,
    enabled: item?.enabled !== false && item?.enabled !== 'false',
    ctaText: item?.ctaText || '',
    ctaLink: item?.ctaLink || '',
  };
}

function transformExternalAPIItem(item) {
  const tags = Array.isArray(item?.tags)
    ? item.tags.map((t) => (typeof t === 'string' ? extractTagLabel(t) : t)).filter(Boolean)
    : [];

  return {
    id: item?.id || Math.random().toString(36).slice(2),
    title: item?.title || item?.name || '',
    subtext: item?.subtext || item?.description || '',
    subtextHtml: item?.subtextHtml || '',
    tags,
    image: item?.image || item?.imageUrl || '',
    enabled: item?.enabled !== false && item?.enabled !== 'false',
    ctaText: item?.ctaText || item?.ctaLabel || '',
    ctaLink: item?.ctaLink || item?.ctaUrl || item?.url || '',
  };
}

// --- UI Rendering ---

function createFragmentCard(card, config) {
  const cardEl = createElement('div', 'fragment-card');

  let html = '';

  // Image
  if (card.image) {
    html += `
      <div class="fragment-card-image">
        <img src="${card.image}" alt="${card.title}" loading="lazy">
      </div>`;
  }

  // Content
  html += '<div class="fragment-card-content">';

  // Title
  if (card.title) {
    html += `<h3 class="fragment-card-title">${card.title}</h3>`;
  }

  // Subtext
  if (card.subtextHtml) {
    html += `<div class="fragment-card-subtext">${card.subtextHtml}</div>`;
  } else if (card.subtext) {
    html += `<p class="fragment-card-subtext">${card.subtext}</p>`;
  }

  // Tags
  if (config.showTags && card.tags && card.tags.length > 0) {
    html += '<div class="fragment-card-tags">';
    card.tags.forEach((tag) => {
      html += `<span class="fragment-card-tag">${tag}</span>`;
    });
    html += '</div>';
  }

  // CTA Button
  const ctaLabel = card.ctaText || config.ctaButtonLabel || 'Learn More';
  const ctaVariant = getCtaVariant(config);
  if (card.ctaLink) {
    html += `<p class="button-container ${ctaVariant}"><a href="${card.ctaLink}" class="button" target="_blank" rel="noopener noreferrer">${ctaLabel}</a></p>`;
  } else {
    html += `<p class="button-container ${ctaVariant} fragment-card-cta-static"><span class="button">${ctaLabel}</span></p>`;
  }

  html += '</div>';
  cardEl.innerHTML = html;
  return cardEl;
}

function renderResults(cards, container, config) {
  container.innerHTML = '';

  if (cards.length === 0) {
    const noResults = createElement('div', 'no-results');
    const message = config.noResultsMessage || 'No items found';
    noResults.innerHTML = `
      <svg width="64" height="64" viewBox="0 0 24 24" fill="currentColor">
        <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
      </svg>
      <h3>${message}</h3>
      <p>Try adjusting your search criteria.</p>
    `;
    container.appendChild(noResults);
    return;
  }

  cards.forEach((card) => {
    container.appendChild(createFragmentCard(card, config));
  });
}

function filterCards(cards, filters) {
  return cards.filter((card) => {
    // Full-text search
    if (filters.textSearch && filters.textSearch.length >= 2) {
      const query = filters.textSearch.toLowerCase();
      const searchable = [
        card.title,
        card.subtext,
        ...(card.tags || []),
      ].join(' ').toLowerCase();
      if (!searchable.includes(query)) return false;
    }

    // Tag filter
    if (filters.tag && filters.tag !== '') {
      const hasTag = (card.tags || []).some(
        (t) => t.toLowerCase() === filters.tag.toLowerCase(),
      );
      if (!hasTag) return false;
    }

    return true;
  });
}

function createFilterPanel(config, cards) {
  const panel = createElement('div', 'fragment-list-filters');
  const row = createElement('div', 'filter-row');

  // Text search
  if (config.enableTextSearch) {
    const group = createElement('div', 'filter-group');
    const label = createElement('label', '', 'Search');
    const input = createElement('input');
    input.type = 'text';
    input.className = 'text-search-input';
    input.placeholder = config.searchPlaceholder || 'Search...';
    group.appendChild(label);
    group.appendChild(input);
    row.appendChild(group);
  }

  // Tag filter
  if (config.enableTagFilter) {
    const group = createElement('div', 'filter-group');
    const label = createElement('label', '', 'Filter by Tag');
    const select = createElement('select', 'tag-filter-select');

    const defaultOpt = createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = 'All Tags';
    select.appendChild(defaultOpt);

    const uniqueTags = getUniqueTags(cards);
    uniqueTags.forEach((tag) => {
      const opt = createElement('option');
      opt.value = tag.toLowerCase();
      opt.textContent = tag;
      select.appendChild(opt);
    });

    group.appendChild(label);
    group.appendChild(select);
    row.appendChild(group);
  }

  panel.appendChild(row);
  return panel;
}

// --- Carousel Navigation ---
function addCarouselNav(block, resultsContainer) {
  const nav = createElement('div', 'carousel-nav');
  const prevBtn = createElement('button', 'carousel-nav-btn', '&#8592;');
  prevBtn.setAttribute('aria-label', 'Previous');
  prevBtn.type = 'button';
  const nextBtn = createElement('button', 'carousel-nav-btn', '&#8594;');
  nextBtn.setAttribute('aria-label', 'Next');
  nextBtn.type = 'button';

  prevBtn.addEventListener('click', () => {
    resultsContainer.scrollBy({ left: -320, behavior: 'smooth' });
  });
  nextBtn.addEventListener('click', () => {
    resultsContainer.scrollBy({ left: 320, behavior: 'smooth' });
  });

  nav.appendChild(prevBtn);
  nav.appendChild(nextBtn);
  block.appendChild(nav);
}

// --- Main Decorate Function ---
export default async function decorate(block) {
  // Parse config from block key-value structure
  let title = '';
  let subtitle = '';
  let layout = 'grid';
  let dataSourceType = 'content-fragments';
  let contentFragmentFolder = '';
  let modelName = '';
  let apiUrl = '';
  let enableFilters = false;
  let enableTextSearch = true;
  let enableTagFilter = true;
  let searchPlaceholder = 'Search...';
  let showTags = false;
  let ctaButtonLabel = '';
  let ctaStyle = '';
  let noResultsMessage = '';
  let customClass = '';

  const rows = Array.from(block.querySelectorAll(':scope > div'));
  rows.forEach((row) => {
    const cells = row.querySelectorAll(':scope > div');
    if (cells.length < 2) return;

    const key = cells[0].textContent?.trim()?.toLowerCase();
    const valueCell = cells[1];
    const link = valueCell.querySelector('a');
    const value = (link?.getAttribute('title') || link?.textContent || valueCell.textContent || '').trim();

    if (!key || !value) return;

    switch (key) {
      case 'title': title = value; break;
      case 'subtitle': subtitle = value; break;
      case 'layout':
      case 'layout style': layout = value; break;
      case 'data source type':
      case 'datasourcetype': dataSourceType = value; break;
      case 'content fragment folder':
      case 'contentfragmentfolder': contentFragmentFolder = value; break;
      case 'content fragment model name':
      case 'modelname': modelName = value; break;
      case 'api url':
      case 'apiurl': apiUrl = value; break;
      case 'enable filters':
      case 'enablefilters': enableFilters = value === 'true'; break;
      case 'enable text search':
      case 'enabletextsearch': enableTextSearch = value !== 'false'; break;
      case 'enable tag filter':
      case 'enabletagfilter': enableTagFilter = value !== 'false'; break;
      case 'search placeholder':
      case 'searchplaceholder': searchPlaceholder = value; break;
      case 'show tags':
      case 'showtags': showTags = value === 'true'; break;
      case 'cta button label':
      case 'ctabuttonlabel': ctaButtonLabel = value; break;
      case 'cta style':
      case 'ctastyle': ctaStyle = value; break;
      case 'no results message':
      case 'noresultsmessage': noResultsMessage = value; break;
      case 'custom class':
      case 'custom-class': customClass = value; break;
      default: break;
    }
  });

  // Hide config rows
  Array.from(block.children).forEach((row) => { row.style.display = 'none'; });

  // Apply classes
  block.classList.add('fragment-list');
  if (layout) block.classList.add(layout);
  if (customClass) {
    customClass.split(/\s+/).filter(Boolean).forEach((cls) => block.classList.add(cls));
  }

  // Build config object
  const config = {
    title,
    subtitle,
    layout,
    dataSourceType,
    contentFragmentFolder,
    modelName,
    apiUrl,
    enableFilters,
    enableTextSearch,
    enableTagFilter,
    searchPlaceholder,
    showTags,
    ctaButtonLabel,
    ctaStyle,
    noResultsMessage,
  };

  // --- Build UI ---
  // Header
  const header = createElement('div', 'fragment-list-header');
  header.innerHTML = `
    <h2 class="fragment-list-title">${title}</h2>
    ${subtitle ? `<p class="fragment-list-subtitle">${subtitle}</p>` : ''}
  `;
  block.appendChild(header);

  // Results container
  const resultsContainer = createElement('div', 'fragment-list-results');
  resultsContainer.innerHTML = '<div class="loading-state">Loading...</div>';
  block.appendChild(resultsContainer);

  // Fetch data
  let cards = await fetchFragmentData(config);

  // Filter out disabled items
  cards = cards.filter((card) => card.enabled !== false);

  // Filter panel (if enabled)
  if (enableFilters && (enableTextSearch || enableTagFilter)) {
    const filterPanel = createFilterPanel(config, cards);
    block.insertBefore(filterPanel, resultsContainer);

    // Wire up filter listeners
    const filters = { textSearch: '', tag: '' };
    const performFilter = debounce(() => {
      const filtered = filterCards(cards, filters);
      renderResults(filtered, resultsContainer, config);
    }, 300);

    const textInput = block.querySelector('.text-search-input');
    if (textInput) {
      textInput.addEventListener('input', (e) => {
        filters.textSearch = e.target.value;
        performFilter();
      });
    }

    const tagSelect = block.querySelector('.tag-filter-select');
    if (tagSelect) {
      tagSelect.addEventListener('change', (e) => {
        filters.tag = e.target.value;
        performFilter();
      });
    }
  }

  // Render cards
  renderResults(cards, resultsContainer, config);

  // Add carousel navigation if layout is carousel
  if (layout === 'carousel') {
    addCarouselNav(block, resultsContainer);
  }

  // Universal Editor auto-reload support
  const blockResource = block.getAttribute('data-aue-resource');
  if (blockResource) {
    const handleUEEvent = (event) => {
      const eventResource = event.detail?.request?.target?.resource;
      if (eventResource === blockResource) {
        setTimeout(() => window.location.reload(), 1000);
      }
    };
    if (!block._ueListenerAdded) {
      document.querySelector('main')?.addEventListener('aue:content-patch', handleUEEvent);
      document.querySelector('main')?.addEventListener('aue:content-update', handleUEEvent);
      block._ueListenerAdded = true;
    }
  }
}
