import { div, a, span } from '../../scripts/dom-helpers.js';

const KNOWN_STYLES = new Set([
  'default-button',
  'default-button-link',
  'default-button-link-light',
  'default-button-secondary',
  'default-button-dark',
]);

const KNOWN_ALIGNMENTS = new Set([
  'btn-align-center',
  'btn-align-right',
]);

function getCellInner(cell) {
  // Cell may be <div><p>text</p></div>, or directly <p>text</p>, or
  // (rarely) <div>text</div>. Pick the deepest text-bearing element.
  if (!cell) return { textContent: '', element: null };
  const inner = cell.querySelector('p') || cell;
  return { textContent: (inner.textContent || '').trim(), element: inner };
}

export default function decorate(block) {
  // Idempotency: don't corrupt the block if decorate runs again on the rendered DOM.
  if (block.dataset.actionButtonDecorated === 'true') return;

  const cells = [...block.children];

  // Pattern-match the cells instead of relying on rigid positions:
  // - Link cell: contains <a> (or <p class="button-container"><a>)
  // - Icon cell: contains <picture> or <img>
  // - Other cells: text values, identified by content (style/alignment vs label/title)
  const linkCell = cells.find((c) => c.querySelector('p.button-container a, a'));
  const iconCell = cells.find((c) => c.querySelector('picture, img'));

  const textCells = cells.filter((c) => c !== linkCell && c !== iconCell);

  // Walk text cells in order; classify by known vocab. Anything unrecognized
  // falls into label → title slots (in order of appearance).
  let buttonStyle = 'default-button';
  let buttonAlignment = '';
  const textValues = [];
  textCells.forEach((c) => {
    const text = getCellInner(c).textContent;
    if (!text) return;
    if (KNOWN_STYLES.has(text)) {
      buttonStyle = text;
    } else if (KNOWN_ALIGNMENTS.has(text)) {
      buttonAlignment = text;
    } else {
      textValues.push(text);
    }
  });

  const buttonLabel = textValues[0] || 'Button';
  const buttonTitle = textValues[1] || '';

  const linkAnchor = linkCell?.querySelector('a');
  const buttonLink = linkAnchor?.href || linkAnchor?.getAttribute('href') || '#';

  const iconPicture = iconCell?.querySelector('picture');
  const iconImg = iconCell?.querySelector('img');
  const iconSrc = iconImg?.getAttribute('src') || '';
  const iconAlt = iconImg?.getAttribute('alt') || '';

  const anchor = a({
    href: buttonLink,
    class: 'button',
    title: buttonTitle || buttonLabel,
  });

  if (iconSrc) {
    if (iconPicture) {
      // Move the existing optimized picture into the button to keep srcset/webp
      const cloned = iconPicture.cloneNode(true);
      const clonedImg = cloned.querySelector('img');
      if (clonedImg) clonedImg.classList.add('button-icon');
      anchor.appendChild(cloned);
    } else {
      const iconEl = document.createElement('img');
      iconEl.className = 'button-icon';
      iconEl.src = iconSrc;
      iconEl.alt = iconAlt;
      anchor.appendChild(iconEl);
    }
  }

  anchor.appendChild(span({ class: 'button-text' }, buttonLabel));

  const buttonElement = div({ class: `button-container ${buttonStyle}` }, anchor);

  // Replace the entire block content with the rendered button
  block.innerHTML = '';
  if (buttonAlignment) block.classList.add(buttonAlignment);
  block.appendChild(buttonElement);

  block.dataset.actionButtonDecorated = 'true';
}
