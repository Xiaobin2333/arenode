import { state } from '../state/index.js';
import { $$ } from '../core/dom.js';

export const turnstileWidgets = new Map();

export const turnstileTokens = new Map();

let turnstileLoader = null;

let renderedTurnstileSiteKey = '';

export function loadTurnstileScript() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (turnstileLoader) return turnstileLoader;
  turnstileLoader = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; script.async = true; script.defer = true;
    script.addEventListener('load', () => resolve(window.turnstile));
    script.addEventListener('error', () => reject(new Error('Turnstile 加载失败，请检查网络')));
    document.head.append(script);
  });
  return turnstileLoader;
}

export async function configureTurnstile(settings) {
  const slots = $$('.turnstile-slot[data-turnstile]');
  slots.forEach(slot => slot.classList.toggle('hidden', !settings.turnstileEnabled));
  if (!settings.turnstileEnabled) { turnstileTokens.clear(); return; }
  const client = await loadTurnstileScript();
  if (renderedTurnstileSiteKey && renderedTurnstileSiteKey !== settings.turnstileSiteKey) {
    for (const widgetId of turnstileWidgets.values()) client.remove(widgetId);
    turnstileWidgets.clear(); turnstileTokens.clear(); slots.forEach(slot => { slot.replaceChildren(); });
  }
  renderedTurnstileSiteKey = settings.turnstileSiteKey;
  for (const slot of slots) {
    const purpose = slot.dataset.turnstile;
    if (turnstileWidgets.has(purpose)) continue;
    const widgetId = client.render(slot, {
      sitekey: settings.turnstileSiteKey,
      theme: 'light',
      callback: token => turnstileTokens.set(purpose, token),
      'expired-callback': () => turnstileTokens.delete(purpose),
      'error-callback': () => turnstileTokens.delete(purpose),
    });
    turnstileWidgets.set(purpose, widgetId);
  }
}

export function turnstileToken(purpose) {
  if (!state.authConfig?.turnstileEnabled) return '';
  const token = turnstileTokens.get(purpose);
  if (!token) throw new Error('请先完成人机验证');
  return token;
}

export function resetTurnstile(purpose) {
  turnstileTokens.delete(purpose);
  const widgetId = turnstileWidgets.get(purpose);
  if (widgetId !== undefined && window.turnstile) window.turnstile.reset(widgetId);
}

export function startCooldown(button, seconds, label) {
  clearInterval(button.cooldownTimer); let remaining = Number(seconds || state.authConfig?.emailCodeCooldownSeconds || 60);
  button.disabled = true; button.textContent = `${remaining} 秒后可重发`;
  button.cooldownTimer = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) { clearInterval(button.cooldownTimer); button.disabled = false; button.textContent = label; }
    else button.textContent = `${remaining} 秒后可重发`;
  }, 1000);
}
