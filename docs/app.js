// Small enhancements; the page works without any of them.
(() => {
  // ---- copy buttons
  for (const b of document.querySelectorAll('[data-copy]')) {
    b.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(b.dataset.copy);
        b.textContent = 'Copied';
      } catch {
        b.textContent = 'Select and copy';
      }
      setTimeout(() => (b.textContent = 'Copy'), 1600);
    });
  }

  // ---- demo tabs: swap the animation
  const tabs = [...document.querySelectorAll('.tabs [role="tab"]')];
  const demo = document.getElementById('demo-img');
  const pick = t => {
    for (const x of tabs) x.setAttribute('aria-selected', String(x === t));
    demo.src = t.dataset.src;
    demo.alt = t.dataset.alt;
  };
  tabs.forEach((t, i) => {
    t.tabIndex = 0;
    t.addEventListener('click', () => pick(t));
    t.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(t); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const next = tabs[(i + (e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
        next.focus();
        pick(next);
      }
    });
  });

  // ---- pictures open full size
  const zoom = document.getElementById('zoom');
  if (zoom && zoom.showModal) {
    const big = zoom.querySelector('img');
    for (const img of document.querySelectorAll('[data-zoom]')) {
      img.tabIndex = 0;
      img.setAttribute('role', 'button');
      const open = () => { big.src = img.currentSrc || img.src; big.alt = img.alt; zoom.showModal(); };
      img.addEventListener('click', open);
      img.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    }
    zoom.addEventListener('click', () => zoom.close());
  }

  // ---- sections fade in as they come into view
  if ('IntersectionObserver' in window && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const io = new IntersectionObserver(es => {
      for (const e of es) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }, { rootMargin: '0px 0px -8% 0px' });
    for (const n of document.querySelectorAll('.card, .opt, .split, .demo, .two, .gallery figure, .then, details')) {
      n.classList.add('reveal');
      io.observe(n);
    }
  }

  // ---- current version, download count and a direct link to the file, from Open VSX
  fetch('https://open-vsx.org/api/vrxt/ssh-config-manager')
    .then(r => (r.ok ? r.json() : Promise.reject()))
    .then(d => {
      if (d.version) document.getElementById('ver').textContent = 'v' + d.version;
      const file = d.files && d.files.download;
      const link = document.getElementById('vsix');
      if (file && link && /^https:\/\/open-vsx\.org\//.test(file)) {
        link.href = file;
        link.textContent = `Download v${d.version} (.vsix)`;
        document.getElementById('stats').innerHTML = 'Older versions are on <a href="https://github.com/VRXT/ssh-config-manager/releases" rel="noopener">GitHub Releases</a>.';
      }
    })
    .catch(() => {});
})();
