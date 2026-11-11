(() => {
  const hero = document.querySelector(".pkgx-ascii-hero");
  if (!hero) return;
  const canvas = hero.querySelector(".pkgx-ascii-hero__field");
  if (!canvas) return;
  const ctx = canvas.getContext("2d", { alpha: false });
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const ramp = "  .,:;-=+xX#%@";
  const wordmark = {
    p: ["1110", "1001", "1110", "1000", "1000", "1000", "1000"],
    k: ["1001", "1010", "1100", "1010", "1001", "1001", "1001"],
    g: ["0110", "1001", "1001", "0111", "0001", "1001", "0110"],
    x: ["1001", "0110", "0110", "0110", "0110", "1001", "1001"],
    "-": ["0000", "0000", "0000", "1111", "0000", "0000", "0000"],
    r: ["0000", "1011", "1100", "1000", "1000", "1000", "1000"],
    a: ["0110", "0001", "0111", "1001", "1001", "0111", "0000"],
    y: ["1001", "1001", "0111", "0001", "0010", "0110", "1100"]
  };
  const pointer = { x: -1000, y: -1000, tx: -1000, ty: -1000 };
  let width = 0, height = 0, dpr = 1, raf = 0, lastFrame = 0, logoLayout = null;

  function makeLogo(cols, rows) {
    let advance = 0;
    const pixels = [];
    for (const char of "pkg x-ray") {
      if (char === " ") { advance += 5; continue; }
      const glyph = wordmark[char];
      glyph.forEach((line, y) => {
        for (let x = 0; x < line.length; x++) if (line[x] === "1") pixels.push([y, advance + x]);
      });
      advance += 6;
    }
    const baseWidth = advance - 2;
    // Fixed silhouette: it scales with the card, but never animates or responds to the pointer.
    const scale = Math.min((cols * 0.84) / baseWidth, (rows * 0.68) / 7);
    const logoWidth = Math.round(baseWidth * scale);
    const logoHeight = Math.round(7 * scale);
    const left = Math.max(0, Math.floor((cols - logoWidth) / 2));
    const top = Math.max(0, Math.floor((rows - logoHeight) / 2));
    const cells = new Set();
    pixels.forEach(([y, x]) => {
      const x0 = Math.floor(x * scale), x1 = Math.max(x0 + 1, Math.floor((x + 1) * scale));
      const y0 = Math.floor(y * scale), y1 = Math.max(y0 + 1, Math.floor((y + 1) * scale));
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) cells.add((top + yy) * cols + left + xx);
    });
    return { cols, rows, left, top, width: logoWidth, height: logoHeight, cells };
  }

  function resize() {
    const rect = hero.getBoundingClientRect();
    width = rect.width;
    height = rect.height;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    requestDraw();
  }
  function requestDraw() {
    if (!raf) raf = requestAnimationFrame(draw);
  }
  function draw(now) {
    raf = 0;
    if (!reduceMotion.matches && now - lastFrame < 32) { requestDraw(); return; }
    lastFrame = now;
    const t = reduceMotion.matches ? 0 : now * 0.00038;
    const fontSize = width < 560 ? 10 : 11.5;
    const cellW = fontSize * 0.62;
    const lineH = fontSize * 1.22;
    const cols = Math.ceil(width / cellW);
    const rows = Math.ceil(height / lineH);
    if (!logoLayout || logoLayout.cols !== cols || logoLayout.rows !== rows) logoLayout = makeLogo(cols, rows);
    pointer.x += (pointer.tx - pointer.x) * 0.14;
    pointer.y += (pointer.ty - pointer.y) * 0.14;
    const px = pointer.x / Math.max(1, width);
    const py = pointer.y / Math.max(1, height);

    ctx.fillStyle = "#08090b";
    ctx.fillRect(0, 0, width, height);
    ctx.font = `${fontSize}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
    ctx.textBaseline = "top";

    for (let row = 0; row < rows; row++) {
      const ny = (row / Math.max(1, rows - 1)) * 2 - 1;
      for (let col = 0; col < cols; col++) {
        const nx = (col / Math.max(1, cols - 1)) * 2 - 1;
        const a = nx * 3.2 + Math.sin(ny * 3.1 + t * 1.1) * 0.72 + t * 1.35;
        const b = ny * 4.4 - nx * 1.25 + Math.cos(nx * 2.2 - t * 0.7) * 0.42 - t * 0.68;
        const c = nx * 5.1 + ny * 2.4 + t * 0.38;
        let energy = 0.47 + 0.22 * Math.sin(a) + 0.18 * Math.cos(b) + 0.11 * Math.sin(c);
        energy += 0.10 * (1 - Math.min(1, Math.abs(ny) * 0.8));

        const dx = nx - (px * 2 - 1);
        const dy = (ny - (py * 2 - 1)) * 1.25;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const near = pointer.x > -100 ? Math.exp(-dist * dist * 10) : 0;
        const ripple = pointer.x > -100 ? Math.sin(dist * 32 - t * 8) * Math.exp(-dist * 4.5) * 0.18 : 0;
        energy = Math.max(0, Math.min(1, energy + near * 0.28 + ripple));

        const cell = row * cols + col;
        const inWordmark = logoLayout.cells.has(cell);
        const centerX = logoLayout.left + logoLayout.width / 2;
        const centerY = logoLayout.top + logoLayout.height / 2;
        const dxLogo = Math.abs(col - centerX) / (logoLayout.width / 2 + 5);
        const dyLogo = Math.abs(row - centerY) / (logoLayout.height / 2 + 4);
        const quiet = Math.max(0, 1 - Math.max(dxLogo, dyLogo));
        if (!inWordmark) energy *= 1 - 0.16 * quiet;

        const fade = Math.max(0.08, 1 - Math.pow(Math.abs(nx) * 0.62, 2) - Math.pow(Math.abs(ny) * 0.42, 2));
        let ch, alpha;
        if (inWordmark) {
          ch = "@";
          alpha = 0.99;
        } else {
          const index = Math.min(ramp.length - 1, Math.floor(energy * (ramp.length - 1)));
          ch = ramp[index];
          if (ch === " ") continue;
          alpha = Math.min(0.42, (0.07 + energy * 0.36) * fade);
        }
        ctx.fillStyle = `rgba(245,246,247,${alpha})`;
        ctx.fillText(ch, col * cellW, row * lineH);
      }
    }

    if (!reduceMotion.matches) requestDraw();
    else if (Math.abs(pointer.tx - pointer.x) > 0.5 || Math.abs(pointer.ty - pointer.y) > 0.5) requestDraw();
  }

  hero.addEventListener("pointermove", event => {
    const rect = hero.getBoundingClientRect();
    pointer.tx = event.clientX - rect.left;
    pointer.ty = event.clientY - rect.top;
    requestDraw();
  });
  hero.addEventListener("pointerleave", () => {
    pointer.tx = -1000;
    pointer.ty = -1000;
    requestDraw();
  });
  window.addEventListener("resize", resize, { passive: true });
  reduceMotion.addEventListener?.("change", requestDraw);
  if ("ResizeObserver" in window) new ResizeObserver(resize).observe(hero);
  resize();
})();
