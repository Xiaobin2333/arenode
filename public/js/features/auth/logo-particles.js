// Sample the existing SVG so particle and static versions share the same silhouette.
// Only the visible desktop login illustration animates; static SVG is the fallback.
// Reference units for physics only. Rendering follows every browser RAF callback.
const REFERENCE_STEP_MS = 1000 / 60;
const SPRING_STIFFNESS = .03;
const SPRING_DRAG = .09;
const SPRING_FREQUENCY = Math.sqrt(SPRING_STIFFNESS - SPRING_DRAG * SPRING_DRAG);

export function initLogoParticles(art, stage) {
  const logo = stage.querySelector('.art-logo');
  if (!logo || !window.IntersectionObserver || !window.ResizeObserver) return;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) return;
  canvas.className = 'logo-particles';
  canvas.setAttribute('aria-hidden', 'true');

  const desktop = window.matchMedia('(min-width: 1025px)');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const pointer = { x: 0, y: 0, active: false };
  const groups = [[], [], []];
  const dotRadii = [];
  const sampleSize = navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4 ? 112 : 144;
  let particles = [];
  let width = 0, height = 0, side = 0, pixelRatio = 0;
  let bounds = { left: 0, top: 0 };
  let visible = false, loading = false, failed = false;
  let frame = 0, idleTimer = 0, lastClock = 0, elapsed = 0, burstAt = -Infinity;
  let color = getComputedStyle(logo).getPropertyValue('--text-2').trim() || '#5b5955';

  const eligible = () => desktop.matches && !reduced.matches && visible && !document.hidden && width > 0 && height > 0;

  function sizeDots() {
    for (let group = 0; group < groups.length; group++) {
      dotRadii[group] = Math.max(.85, Math.min(2.1, side * .0033)) * (.8 + group * .14);
    }
  }

  function resize() {
    const rect = art.getBoundingClientRect();
    bounds = rect;
    const nextWidth = Math.round(rect.width), nextHeight = Math.round(rect.height);
    const ratio = Math.min(window.devicePixelRatio || 1, 1.25, Math.sqrt(1100000 / Math.max(1, nextWidth * nextHeight)));
    if (width !== nextWidth || height !== nextHeight || pixelRatio !== ratio) {
      width = nextWidth; height = nextHeight;
      pixelRatio = ratio;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      side = Math.min(width * .8, 720);
      sizeDots();
      for (const particle of particles) {
        particle.homeX = (width - side) / 2 + particle.u * side;
        particle.homeY = (height - side) / 2 + particle.v * side;
        particle.x = particle.homeX + particle.scatterX;
        particle.y = particle.homeY + particle.scatterY;
        particle.vx = particle.vy = 0;
      }
      pointer.active = false;
    }
    sync();
  }

  async function loadSilhouette() {
    loading = true;
    try {
      const image = new Image();
      image.src = '/assets/factory-logo.svg';
      await image.decode();
      const mask = document.createElement('canvas');
      mask.width = mask.height = sampleSize;
      const maskContext = mask.getContext('2d', { willReadFrequently: true });
      if (!maskContext) throw new Error('Canvas unavailable');
      maskContext.drawImage(image, 0, 0, sampleSize, sampleSize);
      const pixels = maskContext.getImageData(0, 0, sampleSize, sampleSize).data;
      for (let y = 1; y < sampleSize; y += 2) {
        for (let x = 1; x < sampleSize; x += 2) {
          if (pixels[(y * sampleSize + x) * 4 + 3] < 160) continue;
          const u = (x + (Math.random() - .5) * .7) / sampleSize;
          const v = (y + (Math.random() - .5) * .7) / sampleSize;
          const angle = Math.atan2(v - .5, u - .5) + (Math.random() - .5) * .9;
          const spread = 85 + Math.random() * 155;
          const particle = {
            u, v, homeX: 0, homeY: 0, x: 0, y: 0, vx: 0, vy: 0,
            scatterX: Math.cos(angle) * spread,
            scatterY: Math.sin(angle) * spread,
          };
          particles.push(particle);
          groups[Math.floor(Math.random() * groups.length)].push(particle);
        }
      }
      if (!particles.length) throw new Error('Empty silhouette');
      canvas.dataset.particleCount = String(particles.length);
      logo.append(canvas);
      // Force target positions to be recalculated after the asynchronous SVG load.
      width = height = 0;
      resize();
    } catch {
      failed = true;
      particles = [];
      canvas.remove();
      logo.classList.remove('particles-ready');
    } finally {
      loading = false;
    }
  }

  function sync() {
    const active = eligible() && particles.length > 0;
    logo.classList.toggle('particles-ready', Boolean(active));
    if (!active) {
      cancelAnimationFrame(frame);
      clearTimeout(idleTimer);
      frame = idleTimer = lastClock = 0;
      if (eligible() && !loading && !failed) void loadSilhouette();
      return;
    }
    if (!frame) {
      clearTimeout(idleTimer);
      idleTimer = 0;
      frame = requestAnimationFrame(draw);
    }
  }

  function draw(now) {
    frame = 0;
    if (!eligible()) { sync(); return; }
    const delta = lastClock ? Math.max(0, now - lastClock) : REFERENCE_STEP_MS;
    lastClock = now;
    elapsed += delta;
    const step = Math.min(delta, 40) / REFERENCE_STEP_MS;
    const cycle = elapsed % 12500;
    const automatic = cycle > 8500 ? Math.sin((cycle - 8500) / 4000 * Math.PI) ** 2 : 0;
    const intro = Math.max(0, 1 - elapsed / 1600) ** 2;
    const burstAge = elapsed - burstAt;
    const burst = burstAge < 1900 ? Math.sin(burstAge / 1900 * Math.PI) : 0;
    const scatter = Math.max(intro, automatic, burst);
    const radius = Math.min(125, side * .24);
    const radiusSquared = radius * radius;
    // Exact damped-spring coefficients keep the response consistent at 60–240Hz.
    const decay = Math.exp(-SPRING_DRAG * step);
    const springSin = Math.sin(SPRING_FREQUENCY * step) / SPRING_FREQUENCY;
    const springCos = Math.cos(SPRING_FREQUENCY * step);
    const positionFactor = decay * (springCos + SPRING_DRAG * springSin);
    const velocityFactor = decay * springSin;
    const retainedVelocity = decay * (springCos - SPRING_DRAG * springSin);
    const accelerationFactor = SPRING_STIFFNESS * velocityFactor;
    const twistCos = Math.cos(scatter * .35), twistSin = Math.sin(scatter * .35);
    let motion = 0;
    context.clearRect(0, 0, width, height);
    context.fillStyle = color;

    for (let group = 0; group < groups.length; group++) {
      context.globalAlpha = .52 + group * .16;
      const dotRadius = dotRadii[group];
      context.beginPath();
      for (const particle of groups[group]) {
        let tx = particle.homeX + (particle.scatterX * twistCos - particle.scatterY * twistSin) * scatter;
        let ty = particle.homeY + (particle.scatterX * twistSin + particle.scatterY * twistCos) * scatter;
        if (pointer.active) {
          const dx = particle.x - pointer.x, dy = particle.y - pointer.y;
          const distanceSquared = dx * dx + dy * dy;
          if (distanceSquared < radiusSquared) {
            const distance = Math.sqrt(distanceSquared);
            const force = (1 - distance / radius) ** 2 * 100;
            tx += dx / (distance || 1) * force;
            ty += dy / (distance || 1) * force;
          }
        }
        const errorX = particle.x - tx, errorY = particle.y - ty;
        particle.x = tx + errorX * positionFactor + particle.vx * velocityFactor;
        particle.y = ty + errorY * positionFactor + particle.vy * velocityFactor;
        particle.vx = particle.vx * retainedVelocity - errorX * accelerationFactor;
        particle.vy = particle.vy * retainedVelocity - errorY * accelerationFactor;
        motion = Math.max(motion, Math.abs(particle.vx) + Math.abs(particle.vy) + Math.abs(tx - particle.x) + Math.abs(ty - particle.y));
        context.moveTo(particle.x + dotRadius, particle.y);
        context.arc(particle.x, particle.y, dotRadius, 0, Math.PI * 2);
      }
      context.fill();
    }
    if (scatter === 0 && motion < .02 && elapsed > 2000) {
      // Keep the assembled bitmap until interaction or the next automatic burst.
      idleTimer = setTimeout(() => { idleTimer = 0; frame = requestAnimationFrame(draw); }, Math.max(1, 8500 - cycle));
    } else frame = requestAnimationFrame(draw);
  }

  art.addEventListener('pointermove', event => {
    pointer.x = event.clientX - bounds.left;
    pointer.y = event.clientY - bounds.top;
    pointer.active = event.pointerType !== 'touch';
    sync();
  }, { passive: true });
  art.addEventListener('pointerleave', () => { pointer.active = false; sync(); });
  art.addEventListener('pointerdown', event => {
    if (eligible() && event.button === 0) {
      // Include time spent displaying the settled bitmap before starting a burst.
      if (lastClock) { elapsed += performance.now() - lastClock; lastClock = performance.now(); }
      burstAt = elapsed;
      sync();
    }
  }, { passive: true });
  window.addEventListener('arenode:themechange', () => {
    color = getComputedStyle(logo).getPropertyValue('--text-2').trim() || '#5b5955';
    sync();
  });
  document.addEventListener('visibilitychange', sync);
  desktop.addEventListener('change', resize);
  reduced.addEventListener('change', sync);
  window.addEventListener('resize', resize, { passive: true });
  window.addEventListener('scroll', () => { if (visible) bounds = art.getBoundingClientRect(); }, { passive: true });
  new ResizeObserver(resize).observe(art);
  new IntersectionObserver(entries => {
    visible = entries[0].isIntersecting;
    if (!visible) pointer.active = false;
    resize();
  }).observe(art);
}
