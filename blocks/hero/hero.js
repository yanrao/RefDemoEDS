
/* Video file extensions recognised for auto-detection */
const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.ogg', '.m4v', '.avi'];

/**
 * Check whether a given <a> element points to a video file.
 */
function isVideoLink(link) {
  if (!link || !link.href) return false;
  try {
    const url = new URL(link.href, window.location.origin);
    const pathname = url.pathname.toLowerCase();
    if (VIDEO_EXTENSIONS.some((ext) => pathname.endsWith(ext))) return true;

    const assetName = url.searchParams.get('assetname') || '';
    if (VIDEO_EXTENSIONS.some((ext) => assetName.toLowerCase().endsWith(ext))) return true;
  } catch (_) {
    // malformed URL — not a video
  }
  return false;
}

/**
 * Find the first video link anywhere inside the block.
 */
function findVideoLink(block) {
  const links = block.querySelectorAll('a[href]');
  for (const link of links) {
    if (isVideoLink(link)) return link;
  }
  return null;
}

/**
 * Remove every video-URL <a> from the block DOM.
 * Also removes the parent <p> if it becomes empty after the link is removed.
 */
function removeVideoLinks(block) {
  block.querySelectorAll('a[href]').forEach((link) => {
    if (isVideoLink(link)) {
      const parent = link.parentElement;
      link.remove();
      if (parent && parent.tagName === 'P' && parent.textContent.trim() === '') {
        parent.remove();
      }
    }
  });
}

/**
 * Check whether a div has meaningful authored content.
 */
function hasMeaningfulContent(div) {
  if (!div) return false;
  if (div.querySelector('h1, h2, h3, h4, h5, h6')) return true;
  if (div.querySelector('.button-container')) return true;

  const hasText = [...div.querySelectorAll('p')].some(
    (p) => !p.classList.contains('button-container') && p.textContent.trim().length > 0,
  );
  return hasText;
}

/**
 * Hero block decorator.
 * Supports both image and video backgrounds — asset type is auto-detected.
 * Video plays muted, looped, autoplayed with no controls (background video).
 *
 * Config values are read by their data-aue-prop in the Universal Editor, so the
 * order of the config fields in the dialog does NOT matter there. On publish
 * (no data-aue attributes) we fall back to the positional index, which must
 * match the model field order:
 *   1  image + imageAlt   (asset + alt)
 *   2  text               (richtext — headings, paragraphs)
 *   3  enableunderline
 *   4  herolayout
 *   5  backgroundstyle
 *   6  ctalabel           (CTA button label)
 *   7  ctalink            (CTA button link)
 *   8  ctastyle           (CTA button style)
 *
 * @param {Element} block
 */
export default function decorate(block) {
  // --- Capture direct child divs BEFORE any DOM mutations ---
  const childDivs = [...block.querySelectorAll(':scope > div')];
  const assetDiv = childDivs[0]; // asset (image/video) + alt
  const textDiv = childDivs[1]; // richtext (headings, paragraphs)

  // Read a config value by its model property name. In the Universal Editor the
  // value carries a data-aue-prop, so reads are independent of the dialog field
  // order. On publish there are no aue attributes, so fall back to the
  // positional index (which must match the model field order documented above).
  const readProp = (prop, index) => {
    const authored = block.querySelector(`:scope > div [data-aue-prop="${prop}"]`);
    if (authored) return authored.textContent.trim();
    return childDivs[index]?.querySelector('div')?.textContent?.trim() || '';
  };

  // --- Read configuration values ---
  const enableUnderline = readProp('enableunderline', 2) || 'true';
  const layoutStyle = readProp('herolayout', 3) || 'overlay';
  const backgroundStyle = readProp('backgroundstyle', 4) || 'default';
  const ctaLabel = readProp('ctalabel', 5);
  const ctaStyle = readProp('ctastyle', 7) || 'button';
  const badgeText = readProp('badge', 8);

  // The CTA link (aem-content) renders as an <a> with no stable data-aue-prop,
  // so identify it as the only config div (after asset + text) containing a link.
  const ctaLinkDiv = childDivs.slice(2).find((d) => d.querySelector('a')) || childDivs[6];
  const ctaLinkAnchor = ctaLinkDiv?.querySelector('a');
  const ctaLink = ctaLinkAnchor?.getAttribute('href')
    || ctaLinkDiv?.querySelector('div')?.textContent?.trim()
    || '';

  // --- Apply layout & theme classes ---
  if (layoutStyle) block.classList.add(layoutStyle);
  if (backgroundStyle) block.classList.add(backgroundStyle);
  if (enableUnderline.toLowerCase() === 'false') block.classList.add('removeunderline');

  // Hero uses explicit CTA fields (CTA Button Label + Link). Any hyperlink the
  // author placed inside the Text richtext is left as a plain inline link
  // instead of being auto-converted into a button.
  if (textDiv) {
    textDiv.querySelectorAll('p.button-container').forEach((p) => {
      p.classList.remove('button-container');
      p.querySelectorAll('a.button').forEach((a) => a.classList.remove('button'));
    });
  }

  // --- Mark text div with a stable class so CSS targets it regardless of DOM position ---
  if (textDiv) textDiv.classList.add('hero-text');

  // --- Auto-detect video from any <a> in the block ---
  const videoLink = findVideoLink(block);

  if (videoLink) {
    block.classList.add('hero-video');
    const videoUrl = videoLink.href;

    // Remove ALL video-URL links from the DOM before building the player.
    removeVideoLinks(block);

    // Create a plain HTML5 <video> — no controls, background behaviour
    const video = document.createElement('video');
    video.src = videoUrl;
    video.autoplay = true;
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('disablepictureinpicture', '');
    video.setAttribute('disableremoteplayback', '');
    video.className = 'hero-video-bg';

    const isBackgroundLayout = [
      'overlay',
      'image-background-text-left',
      'image-background-text-right',
    ].includes(layoutStyle);

    if (isBackgroundLayout) {
      block.prepend(video);
    } else if (assetDiv) {
      assetDiv.innerHTML = '';
      assetDiv.appendChild(video);
    }
  }

  // --- Render the single explicit CTA from the label + link fields ---
  if (ctaLabel && ctaLink && textDiv) {
    const ctaContainer = document.createElement('p');
    ctaContainer.className = `button-container cta-${ctaStyle}`;
    const anchor = document.createElement('a');
    anchor.className = 'button';
    anchor.href = ctaLink;
    anchor.title = ctaLabel;
    anchor.textContent = ctaLabel;
    ctaContainer.appendChild(anchor);
    textDiv.appendChild(ctaContainer);
  }

  // --- Optional pill-style badge shown above the title ---
  if (badgeText && textDiv) {
    const badgeEl = document.createElement('span');
    badgeEl.className = 'hero__badge';
    badgeEl.textContent = badgeText;
    const heading = textDiv.querySelector('h1, h2, h3, h4, h5, h6');
    if (heading) {
      heading.parentElement.insertBefore(badgeEl, heading);
    } else {
      textDiv.prepend(badgeEl);
    }
  }

  // --- Hide the asset div if it's empty (video link removed, or no asset authored) ---
  if (assetDiv && assetDiv.textContent.trim() === '' && !assetDiv.querySelector('picture, video')) {
    assetDiv.style.display = 'none';
  }

  // --- Hide the text overlay div only if it has no meaningful content AND no
  //     badge (a lone badge should still render above an otherwise-empty hero) ---
  if (textDiv && !badgeText && !hasMeaningfulContent(textDiv)) {
    textDiv.style.display = 'none';
  }

  // --- Hide all configuration-only divs (everything after asset + text) ---
  childDivs.forEach((div, index) => {
    if (index > 1 && div) div.style.display = 'none';
  });
}