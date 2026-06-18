import { loadCSS } from './aem.js';

const PSWP_VERSION = '5.4.4';
const PSWP_CSS = `https://cdn.jsdelivr.net/npm/photoswipe@${PSWP_VERSION}/dist/photoswipe.css`;
const PSWP_LIGHTBOX = `https://cdn.jsdelivr.net/npm/photoswipe@${PSWP_VERSION}/dist/photoswipe-lightbox.esm.js`;
const PSWP_CORE = `https://cdn.jsdelivr.net/npm/photoswipe@${PSWP_VERSION}/dist/photoswipe.esm.js`;

const ZOOM_CSS = `${window.hlx?.codeBasePath || ''}/styles/card-image-zoom.css`;

/** Config cell order matches card model field order in blocks/cards/_cards.json */
export const CARD_FIELD_INDEX = {
  image: 0,
  text: 1,
  style: 2,
  ctastyle: 3,
  heading: 4,
  headingColor: 5,
  bgColor: 6,
  textColor: 7,
  imageZoom: 8,
};

const lightboxByRoot = new WeakMap();
let zoomCssLoaded = false;

export function getConfigText(div) {
  return div?.querySelector('p')?.textContent?.trim()
    || div?.textContent?.trim()
    || '';
}

export function readCardRowConfig(row) {
  const { children } = row;
  const cell = (i) => (children[i] ? getConfigText(children[i]) : '');
  return {
    style: cell(CARD_FIELD_INDEX.style) || 'default',
    ctaStyle: cell(CARD_FIELD_INDEX.ctastyle) || 'button',
    heading: cell(CARD_FIELD_INDEX.heading),
    headingColor: cell(CARD_FIELD_INDEX.headingColor),
    bgColor: cell(CARD_FIELD_INDEX.bgColor),
    textColor: cell(CARD_FIELD_INDEX.textColor),
    imageZoom: cell(CARD_FIELD_INDEX.imageZoom),
  };
}

export function normalizeZoomMode(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'zoom-in' || v === 'zoom in' || v === 'zoom in effect') return 'zoom-in';
  if (v === 'zoom-out' || v === 'zoom out' || v === 'zoom out effect') return 'zoom-out';
  if (v === 'big-zoom' || v === 'big zoom') return 'big-zoom';
  return '';
}

function ensureZoomCss() {
  if (zoomCssLoaded) return;
  zoomCssLoaded = true;
  loadCSS(ZOOM_CSS);
}

function setPswpDimensions(link, img) {
  const w = img.naturalWidth || img.width || 1920;
  const h = img.naturalHeight || img.height || 1080;
  link.setAttribute('data-pswp-width', String(Math.max(w, 1)));
  link.setAttribute('data-pswp-height', String(Math.max(h, 1)));
}

export function wrapImageForPhotoSwipe(imageDiv) {
  if (!imageDiv || imageDiv.querySelector('a.card-pswp-trigger')) return;
  const img = imageDiv.querySelector('img');
  if (!img) return;

  const href = img.currentSrc || img.src;
  if (!href) return;

  const link = document.createElement('a');
  link.href = href;
  link.className = 'card-pswp-trigger';
  link.setAttribute('data-pswp', '');
  link.setAttribute('aria-label', img.alt ? `View larger: ${img.alt}` : 'View larger image');
  setPswpDimensions(link, img);

  const picture = imageDiv.querySelector('picture');
  if (picture) {
    link.append(picture);
  } else {
    link.append(img);
  }
  imageDiv.append(link);

  if (!img.complete) {
    img.addEventListener('load', () => setPswpDimensions(link, img), { once: true });
  }
}

/**
 * Apply zoom mode classes and PhotoSwipe trigger to a decorated card <li> (Cards block).
 */
export function applyCardImageZoom(li, rawMode) {
  const mode = normalizeZoomMode(rawMode);
  if (!mode || !li) return;

  ensureZoomCss();

  const imageDiv = li.querySelector('.cards-card-image');
  if (!imageDiv) return;

  li.classList.remove('card-zoom-in', 'card-zoom-out', 'card-zoom-big');
  imageDiv.classList.remove('card-zoom-in', 'card-zoom-out', 'card-zoom-big');

  if (mode === 'zoom-in') {
    li.classList.add('card-zoom-in');
    imageDiv.classList.add('card-zoom-in');
  } else if (mode === 'zoom-out') {
    li.classList.add('card-zoom-out');
    imageDiv.classList.add('card-zoom-out');
  } else if (mode === 'big-zoom') {
    li.classList.add('card-zoom-big');
    imageDiv.classList.add('card-zoom-big');
    wrapImageForPhotoSwipe(imageDiv);
  }
}

/**
 * Apply zoom mode to entire carousel block (all card children share the effect).
 */
export function applyCarouselImageZoom(carouselBlock, rawMode) {
  const mode = normalizeZoomMode(rawMode);
  if (!mode || !carouselBlock) return;

  ensureZoomCss();
  carouselBlock.classList.remove('carousel-zoom-in', 'carousel-zoom-out', 'carousel-zoom-big');
  carouselBlock.dataset.imageZoom = mode;

  if (mode === 'zoom-in') {
    carouselBlock.classList.add('carousel-zoom-in');
  } else if (mode === 'zoom-out') {
    carouselBlock.classList.add('carousel-zoom-out');
  } else if (mode === 'big-zoom') {
    carouselBlock.classList.add('carousel-zoom-big');
    carouselBlock.querySelectorAll(':scope > ul > li .cards-card-image').forEach((imageDiv) => {
      wrapImageForPhotoSwipe(imageDiv);
    });
  }
}

/** Re-wrap images after createOptimizedPicture replaces picture nodes. */
export function rewrapCarouselBigZoomImages(carouselBlock) {
  if (!carouselBlock?.classList.contains('carousel-zoom-big')) return;
  carouselBlock.querySelectorAll(':scope > ul > li .cards-card-image').forEach((imageDiv) => {
    imageDiv.querySelector('a.card-pswp-trigger')?.remove();
    wrapImageForPhotoSwipe(imageDiv);
  });
}

/** Init PhotoSwipe lightbox for carousel or cards block. */
export async function initCardPhotoSwipe(root) {
  if (!root || lightboxByRoot.has(root)) return;

  const triggers = root.querySelectorAll('a.card-pswp-trigger');
  if (!triggers.length) return;

  root.setAttribute('data-card-pswp-gallery', '');

  try {
    await loadCSS(PSWP_CSS);
    const { default: PhotoSwipeLightbox } = await import(/* @vite-ignore */ PSWP_LIGHTBOX);
    const lightbox = new PhotoSwipeLightbox({
      gallery: root,
      children: 'a.card-pswp-trigger',
      pswpModule: () => import(/* @vite-ignore */ PSWP_CORE),
      loop: true,
      bgOpacity: 0.92,
      padding: { top: 20, bottom: 40, left: 20, right: 20 },
    });
    lightbox.init();
    lightboxByRoot.set(root, lightbox);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('PhotoSwipe failed to load for card big-zoom', e);
  }
}

/** After carousel decorate: init fullscreen slideshow when big-zoom is enabled. */
export function finalizeCarouselImageZoom(carouselBlock) {
  if (!carouselBlock?.classList.contains('carousel-zoom-big')) return;
  initCardPhotoSwipe(carouselBlock);
}

/** After cards block decorate, init lightbox if needed. */
export function finalizeCardsImageZoom(cardsBlock) {
  if (!cardsBlock) return;
  ensureZoomCss();
  const hasBigZoom = cardsBlock.querySelector('.card-zoom-big');
  if (hasBigZoom) {
    initCardPhotoSwipe(cardsBlock);
  }
}
