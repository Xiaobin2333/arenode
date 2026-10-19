import { state } from '../state/index.js';
import { closeActionPopovers } from '../components/action-menu.js';
import { $, $$ } from './dom.js';

// 工作台二级 rail 显隐：只切换 .rail-hidden 类，栅格与响应式全部由 CSS 媒体查询驱动
export function syncWorkbenchLayout() {
  for (const layout of $$('.workbench-layout')) {
    const rail = $('.workbench-rail', layout); const main = $('.workbench-main, .data-workbench-main', layout);
    if (!rail || !main) continue;
    const contextRailVisible = !layout.classList.contains('data-workbench')
      && (rail.id !== 'resourceContextRail' || ['certs', 'dnsapis'].includes(state.resourceKind));
    layout.classList.toggle('rail-hidden', !contextRailVisible);
  }
}

window.addEventListener('resize', () => { closeActionPopovers(); });

$('#dismissAnnouncement').addEventListener('click', () => {
  const dialog = $('#announcementDialog'); if (dialog.dataset.dismissible === 'true') localStorage.setItem(dialog.dataset.storageKey, 'dismissed'); dialog.close();
});

$('#closeAppAnnouncement').addEventListener('click', event => {
  const banner = event.currentTarget.closest('#appAnnouncement'); if (banner.dataset.storageKey) localStorage.setItem(banner.dataset.storageKey, 'dismissed'); banner.classList.add('hidden');
});

function announcementHomeVisible() {
  if (!state.me) return true;
  return state.me.user.role === 'admin' ? state.currentView === 'admin-overview' : state.currentView === 'overview';
}

export function renderAnnouncement(settings = state.authConfig) {
  const banner = state.me ? $('#appAnnouncement') : $('#publicAnnouncement'); const dialog = $('#announcementDialog');
  for (const item of [$('#appAnnouncement'), $('#publicAnnouncement')]) item?.classList.add('hidden');
  if (!settings?.announcementEnabled || !announcementHomeVisible()) {
    if (dialog?.open) dialog.close();
    return;
  }
  const severity = settings.announcementSeverity || 'info';
  const storageKey = `announcement:${settings.announcementVersion || settings.announcementTitle}`;
  if (settings.announcementDismissible && localStorage.getItem(storageKey) === 'dismissed') return;
  if (settings.announcementMode === 'banner' && banner) {
    banner.className = `${state.me ? 'app-announcement' : 'public-announcement'} announcement-${severity}`;
    $('strong', banner).textContent = settings.announcementTitle; $('p', banner).textContent = settings.announcementBody;
    banner.dataset.storageKey = storageKey;
    $('#closeAppAnnouncement')?.classList.toggle('hidden', !settings.announcementDismissible);
  }
  if (settings.announcementMode === 'modal' && dialog) {
    dialog.dataset.storageKey = storageKey; dialog.dataset.dismissible = String(Boolean(settings.announcementDismissible));
    $('#announcementDialogTitle').textContent = settings.announcementTitle; $('#announcementDialogBody').textContent = settings.announcementBody;
    $('[data-close="announcementDialog"]').classList.toggle('hidden', !settings.announcementDismissible);
    queueMicrotask(() => { if (announcementHomeVisible() && !dialog.open) dialog.showModal(); });
  }
}

export function applyPublicSettings(settings) {
  if (!settings) return;
  state.authConfig = settings;
  $$('[data-site-name]').forEach(element => { element.textContent = settings.siteName || 'Arenode'; });
  $$('[data-site-subtitle]').forEach(element => { element.textContent = settings.siteSubtitle || ''; });
  document.title = `${settings.siteName || 'Arenode'} 控制台`;
  $('#showRegister').classList.toggle('hidden', !settings.registrationEnabled);
  $('#inviteCodeField').classList.toggle('hidden', !settings.inviteOnly);
  $('#registerForm').elements.inviteCode.required = Boolean(settings.inviteOnly);
  $('#legalConsentField').classList.toggle('hidden', !settings.legalConsentRequired);
  $('#registerForm').elements.legalConsent.required = Boolean(settings.legalConsentRequired);
  renderAnnouncement(settings);
}

// 导航开关：移动端切抽屉，桌面端切折叠图标栏（偏好持久化）
$('#menuButton').addEventListener('click', () => {
  if (window.matchMedia('(max-width: 1024px)').matches) { $('.sidebar').classList.toggle('open'); return; }
  const collapsed = $('#appView').classList.toggle('nav-collapsed');
  try { localStorage.setItem('arenode-nav-collapsed', collapsed ? '1' : '0'); } catch {}
});
try { if (localStorage.getItem('arenode-nav-collapsed') === '1') $('#appView').classList.add('nav-collapsed'); } catch {}

// 深浅色主题切换：初始值由 <head> 内联脚本写入 html[data-theme]，这里同步图标并处理点击
const themeToggle = $('#themeToggle');
const syncThemeIcon = () => { if (themeToggle) themeToggle.textContent = document.documentElement.dataset.theme === 'dark' ? '☀' : '◐'; };
themeToggle?.addEventListener('click', (event) => {
  const root = document.documentElement;
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
  const applyTheme = () => {
    root.dataset.theme = next;
    try { localStorage.setItem('arenode-theme', next); } catch {}
    syncThemeIcon();
    window.dispatchEvent(new CustomEvent('arenode:themechange'));
  };
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) { applyTheme(); return; }
  // 现代浏览器：以点击位置为圆心圆形扩散揭示新主题（View Transitions API）
  if (document.startViewTransition) {
    root.style.setProperty('--theme-x', `${Math.round(event?.clientX ?? window.innerWidth - 120)}px`);
    root.style.setProperty('--theme-y', `${Math.round(event?.clientY ?? 28)}px`);
    const transition = document.startViewTransition(applyTheme);
    Promise.resolve(transition?.finished).catch(() => {}).finally(() => {
      root.style.removeProperty('--theme-x');
      root.style.removeProperty('--theme-y');
    });
    return;
  }
  // 降级：短暂开启全局颜色过渡，平滑交叉淡化
  root.classList.add('theme-fading');
  applyTheme();
  window.setTimeout(() => root.classList.remove('theme-fading'), 380);
});
syncThemeIcon();

function updateSystemClock() {
  $('#systemClock').textContent = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date());
}

updateSystemClock();

setInterval(updateSystemClock, 1000);
