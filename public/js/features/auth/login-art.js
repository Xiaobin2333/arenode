import { initLogoParticles } from './logo-particles.js?v=particles-hfr-20261019';

// 登录页徽标：粒子聚散 + 3D 视差倾斜 + 光标探照灯；重复调用幂等。
const TILT_DEG = 6;

export function initLoginArtFx() {
  const shell = document.querySelector('.login-shell');
  const art = document.querySelector('.login-art');
  const stage = document.querySelector('.art-stage');
  if (!shell || !art || !stage || stage.dataset.artBoot === '1') return;
  stage.dataset.artBoot = '1';
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  // Decorative effects must never prevent the login form from booting.
  try { initLogoParticles(art, stage); } catch {}

  let pointerFrame = 0, clientX = 0, clientY = 0;
  const resetTilt = () => {
    stage.style.setProperty('--tilt-x', '0deg');
    stage.style.setProperty('--tilt-y', '0deg');
  };
  const clearPointer = () => {
    cancelAnimationFrame(pointerFrame);
    pointerFrame = 0;
    shell.classList.remove('pointer-active');
    resetTilt();
  };
  const updatePointer = () => {
    pointerFrame = 0;
    if (reduced.matches || document.hidden) return;
    const page = shell.getBoundingClientRect();
    if (!page.width || !page.height) { clearPointer(); return; }
    shell.style.setProperty('--glow-x', `${(clientX - page.left).toFixed(1)}px`);
    shell.style.setProperty('--glow-y', `${(clientY - page.top).toFixed(1)}px`);
    shell.classList.add('pointer-active');
    const r = art.getBoundingClientRect();
    if (!r.width || !r.height || clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) {
      resetTilt();
      return;
    }
    const nx = ((clientX - r.left) / r.width) * 2 - 1;
    const ny = ((clientY - r.top) / r.height) * 2 - 1;
    stage.style.setProperty('--tilt-x', `${(-ny * TILT_DEG).toFixed(2)}deg`);
    stage.style.setProperty('--tilt-y', `${(nx * TILT_DEG).toFixed(2)}deg`);
  };
  shell.addEventListener('pointermove', event => {
    if (reduced.matches) return;
    if (event.pointerType === 'touch') { clearPointer(); return; }
    clientX = event.clientX; clientY = event.clientY;
    if (!pointerFrame) pointerFrame = requestAnimationFrame(updatePointer);
  }, { passive: true });
  art.addEventListener('pointerleave', resetTilt);
  shell.addEventListener('pointerleave', clearPointer);
  window.addEventListener('blur', clearPointer);
  reduced.addEventListener('change', () => { if (reduced.matches) clearPointer(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) clearPointer(); });
}
