import { $$ } from '../core/dom.js';

let actionMenuSequence = 0;

export function actionMenu(content) {
  const id = `action-popover-${++actionMenuSequence}`;
  return `<span class="action-menu"><button type="button" class="action-menu-trigger" popovertarget="${id}" aria-haspopup="menu" aria-expanded="false">更多</button><div id="${id}" class="action-popover" popover="auto" role="menu">${content}</div></span>`;
}

function positionActionPopover(popover) {
  const trigger = document.querySelector(`[popovertarget="${CSS.escape(popover.id)}"]`); if (!trigger) return;
  const anchor = trigger.getBoundingClientRect(); const menu = popover.getBoundingClientRect(); const edge = 8;
  const viewportWidth = window.visualViewport?.width || window.innerWidth; const viewportHeight = window.visualViewport?.height || window.innerHeight;
  const left = Math.max(edge, Math.min(anchor.right - menu.width, viewportWidth - menu.width - edge));
  const below = anchor.bottom + 6; const top = below + menu.height <= viewportHeight - edge ? below : Math.max(edge, anchor.top - menu.height - 6);
  popover.style.left = `${Math.round(left)}px`; popover.style.top = `${Math.round(top)}px`;
  trigger.setAttribute('aria-expanded', 'true');
}

export function closeActionPopovers() {
  for (const popover of $$('.action-popover:popover-open')) popover.hidePopover();
}

document.addEventListener('toggle', event => {
  const popover = event.target.closest?.('.action-popover'); if (!popover) return;
  const trigger = document.querySelector(`[popovertarget="${CSS.escape(popover.id)}"]`);
  if (event.newState === 'open') requestAnimationFrame(() => positionActionPopover(popover));
  else trigger?.setAttribute('aria-expanded', 'false');
}, true);

document.addEventListener('click', event => {
  const action = event.target.closest('.action-popover button'); const popover = action?.closest('.action-popover');
  if (popover?.matches(':popover-open')) popover.hidePopover();
});

window.addEventListener('scroll', closeActionPopovers, true);
