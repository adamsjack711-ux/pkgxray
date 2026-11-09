// Homepage integration only; the HeyClicky hero bundle remains unchanged.
// No package is fetched, scanned, installed, or executed by this page.
const copyStatus = document.querySelector('.copy-status');
for (const button of document.querySelectorAll('[data-copy-target]')) {
  button.hidden = false;
  let resetTimer;
  button.addEventListener('click', async () => {
    const code = document.getElementById(button.dataset.copyTarget);
    const label = button.querySelector('[data-copy-label]');
    clearTimeout(resetTimer);
    try {
      await navigator.clipboard.writeText(code.textContent.trim());
      label.textContent = 'Copied';
      copyStatus.textContent = button.dataset.copyMessage || 'Command copied. Paste it into your terminal.';
    } catch {
      // Keep the command selectable when clipboard access is denied.
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(code);
      selection.removeAllRanges();
      selection.addRange(range);
      label.textContent = 'Select text';
      copyStatus.textContent = 'Clipboard unavailable. The text is selected; copy it with your keyboard or touch menu.';
    }
    resetTimer = window.setTimeout(() => {
      label.textContent = 'Copy';
      copyStatus.textContent = '';
    }, 6500);
  });
}

const hero = document.querySelector('.pkgx-ascii-hero');
const live = hero.querySelector('.pkgx-ascii-hero__field');
const still = hero.querySelector('.hero-still');
const motionButton = document.querySelector('.motion-button');
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
let userPaused = false;
let snapshotFrame = 0;

// A page-owned still frame provides pause/reduced-motion behavior without
// forking or editing the approved renderer. Its decorative RAF remains owned
// by the prototype. No letters or field pixels are reconstructed here.
function syncMotion() {
  cancelAnimationFrame(snapshotFrame);
  const paused = userPaused || reduced.matches;
  motionButton.hidden = false;
  motionButton.disabled = reduced.matches;
  motionButton.setAttribute('aria-pressed', String(paused));
  motionButton.textContent = reduced.matches ? 'Reduced motion on' : userPaused ? 'Resume animation' : 'Pause animation';
  if (!paused) {
    still.hidden = true;
    live.style.visibility = '';
    return;
  }
  // Wait for the original renderer's resized/reduced-motion frame.
  snapshotFrame = requestAnimationFrame(() => {
    still.width = live.width;
    still.height = live.height;
    still.getContext('2d').drawImage(live, 0, 0);
    still.hidden = false;
    live.style.visibility = 'hidden';
  });
}
// Do not forward pointer movement to the original interpolating renderer when
// motion is disabled. This also prevents hidden pointer animation in reduce mode.
const forwardedPointers = new WeakSet();
for (const type of ['pointermove', 'pointerleave']) {
  hero.addEventListener(type, event => {
    if (userPaused || reduced.matches) { event.stopImmediatePropagation(); return; }
    if (type !== 'pointermove' || forwardedPointers.has(event)) return;
    const displayed = live.getBoundingClientRect();
    const rendered = hero.getBoundingClientRect();
    if (Math.abs(displayed.width - rendered.width) < 1) return;
    // The mobile canvas displays the same original grid at a smaller size.
    // Map pointer positions back into that grid before the renderer sees them.
    event.stopImmediatePropagation();
    const mapped = new PointerEvent('pointermove', {
      clientX: rendered.left + (event.clientX - displayed.left) * rendered.width / displayed.width,
      clientY: rendered.top + (event.clientY - displayed.top) * rendered.height / displayed.height,
      pointerType: event.pointerType
    });
    forwardedPointers.add(mapped);
    hero.dispatchEvent(mapped);
  }, { capture: true });
}
motionButton.addEventListener('click', () => { userPaused = !userPaused; syncMotion(); });
reduced.addEventListener('change', syncMotion);
window.addEventListener('resize', syncMotion, { passive: true });
requestAnimationFrame(() => { hero.classList.add('hero-ready'); syncMotion(); });
