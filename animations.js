/* ============================================
   TheFrontStats — Animation Engine (OPTIMIZED)
   Particles reduced, tilt throttled, no re-init
   ============================================ */

(function () {
  'use strict';

  var REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ── 1. Floating Particles (lightweight) ── */
  function initParticles() {
    if (REDUCED_MOTION) return;
    var canvas = document.createElement('canvas');
    canvas.className = 'particles-canvas';
    document.body.prepend(canvas);

    var ctx = canvas.getContext('2d');
    var particles = [];
    var PARTICLE_COUNT = 18; // Was 35 — halved for perf
    var mouse = { x: -1000, y: -1000 };
    var animId = 0;

    function resize() {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    }
    resize();
    window.addEventListener('resize', resize);

    document.addEventListener('mousemove', function (e) {
      mouse.x = e.clientX;
      mouse.y = e.clientY;
    }, { passive: true });

    for (var i = 0; i < PARTICLE_COUNT; i++) {
      particles.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        vx: (Math.random() - 0.5) * 0.25,
        vy: (Math.random() - 0.5) * 0.25,
        radius: Math.random() * 1.5 + 0.5,
        opacity: Math.random() * 0.2 + 0.08
      });
    }

    function drawParticles() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      for (var i = 0; i < particles.length; i++) {
        var p = particles[i];
        p.x += p.vx;
        p.y += p.vy;

        // Mouse repulsion (only for nearby particles)
        var dx = p.x - mouse.x;
        var dy = p.y - mouse.y;
        var dist = dx * dx + dy * dy; // Skip sqrt for perf
        if (dist < 14400) { // 120²
          dist = Math.sqrt(dist);
          p.vx += dx / dist * 0.015;
          p.vy += dy / dist * 0.015;
        }

        p.vx *= 0.992;
        p.vy *= 0.992;

        if (p.x < 0) p.x = canvas.width;
        if (p.x > canvas.width) p.x = 0;
        if (p.y < 0) p.y = canvas.height;
        if (p.y > canvas.height) p.y = 0;

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,122,0,' + p.opacity + ')';
        ctx.fill();
      }

      // Pause when tab hidden
      animId = requestAnimationFrame(drawParticles);
    }

    // Pause animation when tab is hidden
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        cancelAnimationFrame(animId);
      } else {
        animId = requestAnimationFrame(drawParticles);
      }
    });

    drawParticles();
  }

  /* ── 2. Scroll Reveal via IntersectionObserver ── */
  function initScrollReveal() {
    var reveals = document.querySelectorAll('.reveal, .reveal-left, .reveal-right');
    if (!reveals.length) return;

    var autoReveal = [
      { selector: '.hero-stats .stat-card', cls: 'reveal', stagger: true },
      { selector: '.feed-card', cls: 'reveal' },
      { selector: '.hof-card', cls: 'reveal', stagger: true },
      { selector: '.chart-card', cls: 'reveal', stagger: true },
      { selector: '.profile-stats-grid .modal-stat', cls: 'reveal', stagger: true },
      { selector: '.profile-sections-grid .feed-card', cls: 'reveal', stagger: true },
      { selector: '.sidebar', cls: 'reveal-left' },
      { selector: '.content', cls: 'reveal-right' }
    ];

    autoReveal.forEach(function (rule) {
      var els = document.querySelectorAll(rule.selector);
      els.forEach(function (el, i) {
        if (!el.classList.contains('reveal') && !el.classList.contains('reveal-left') && !el.classList.contains('reveal-right')) {
          el.classList.add(rule.cls);
          if (rule.stagger) el.style.transitionDelay = (i * 0.05) + 's';
        }
      });
    });

    reveals = document.querySelectorAll('.reveal, .reveal-left, .reveal-right');

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('revealed');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.05, rootMargin: '0px 0px -20px 0px' });

    reveals.forEach(function (el) { observer.observe(el); });
  }

  /* ── 3. Number Count-Up Animation ── */
  function animateCountUp(el) {
    var target = parseInt(el.getAttribute('data-count') || el.textContent.replace(/[^\d]/g, ''), 10);
    if (isNaN(target) || target === 0) return;

    var duration = 800; // Was 1200 — faster
    var start = performance.now();
    el.classList.add('counting');

    function tick(now) {
      var elapsed = now - start;
      var progress = Math.min(elapsed / duration, 1);
      var ease = 1 - Math.pow(1 - progress, 3);
      var current = Math.floor(ease * target);
      el.textContent = current.toLocaleString('fr-FR');

      if (progress < 1) {
        requestAnimationFrame(tick);
      } else {
        el.textContent = target.toLocaleString('fr-FR');
        el.classList.remove('counting');
        el.classList.add('count-pop');
      }
    }
    requestAnimationFrame(tick);
  }

  function initCountUp() {
    var statValues = document.querySelectorAll('.stat-value');
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting && !entry.target.classList.contains('counted')) {
          entry.target.classList.add('counted');
          animateCountUp(entry.target);
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.5 });

    statValues.forEach(function (el) {
      var val = el.textContent.replace(/[^\d]/g, '');
      if (val && parseInt(val, 10) > 0) {
        el.setAttribute('data-count', val);
        observer.observe(el);
      }
    });
  }

  /* ── 4. Ripple Effect on Buttons ── */
  function initRipple() {
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('.login-btn, .auth-btn, .share-btn, .see-more-btn, .settings-action-btn, .profile-edit-btn, .tab-btn, .runs-btn, .gg-btn');
      if (!btn) return;

      btn.classList.add('ripple');
      var rect = btn.getBoundingClientRect();
      var x = e.clientX - rect.left;
      var y = e.clientY - rect.top;
      var size = Math.max(rect.width, rect.height) * 2;

      var wave = document.createElement('span');
      wave.className = 'ripple-wave';
      wave.style.width = wave.style.height = size + 'px';
      wave.style.left = (x - size / 2) + 'px';
      wave.style.top = (y - size / 2) + 'px';

      btn.appendChild(wave);
      wave.addEventListener('animationend', function () { wave.remove(); });
    });
  }

  /* ── 5. Staggered Page Entrance ── */
  function initPageEntrance() {
    var elements = [
      { sel: '.site-logo', delay: 0 },
      { sel: '.nav .header-right', delay: 1 },
      { sel: '.hero-stats', delay: 2 },
      { sel: '.tabs', delay: 3 },
      { sel: '.search-bar', delay: 4 },
      { sel: '.main-grid', delay: 5 },
      { sel: '.profile-page-header', delay: 0 },
      { sel: '#profile-loading, #profile-gate, #profile-setup, #profile-main', delay: 2 }
    ];

    elements.forEach(function (rule) {
      var el = document.querySelector(rule.sel);
      if (el && !el.classList.contains('animate-entrance')) {
        el.classList.add('animate-entrance');
        el.classList.add('stagger-' + rule.delay);
      }
    });
  }

  /* ── 6. Shimmer on Loading States ── */
  function initShimmer() {
    document.querySelectorAll('.loading').forEach(function (el) {
      el.classList.add('shimmer');
    });
  }

  /* ── 7. 3D Tilt on Cards (THROTTLED — was O(n) on every mousemove) ── */
  function init3DTilt() {
    if (REDUCED_MOTION) return;
    var tiltTargets = '.stat-card, .hof-card';
    var MAX_TILT = 4; // Was 6 — subtler
    var lastTime = 0;
    var THROTTLE_MS = 32; // ~30fps for tilt (smooth enough)

    document.addEventListener('mousemove', function (e) {
      var now = performance.now();
      if (now - lastTime < THROTTLE_MS) return;
      lastTime = now;

      var cards = document.querySelectorAll(tiltTargets);
      for (var i = 0; i < cards.length; i++) {
        var card = cards[i];
        var rect = card.getBoundingClientRect();
        var cx = rect.left + rect.width / 2;
        var cy = rect.top + rect.height / 2;
        var dist = Math.sqrt((e.clientX - cx) * (e.clientX - cx) + (e.clientY - cy) * (e.clientY - cy));
        if (dist > 350) {
          card.style.transform = '';
          continue;
        }

        var x = (e.clientX - rect.left) / rect.width - 0.5;
        var y = (e.clientY - rect.top) / rect.height - 0.5;
        var rotY = x * MAX_TILT;
        var rotX = -y * MAX_TILT;

        if (e.clientX >= rect.left && e.clientX <= rect.right &&
            e.clientY >= rect.top && e.clientY <= rect.bottom) {
          card.style.transform = 'perspective(600px) rotateX(' + rotX + 'deg) rotateY(' + rotY + 'deg) translateY(-3px)';
        } else {
          card.style.transform = '';
        }
      }
    }, { passive: true });
  }

  /* ── 8. Smooth value updates for live stats ── */
  function initLiveUpdates() {
    var statEls = document.querySelectorAll('.stat-value');
    statEls.forEach(function (el) {
      var lastVal = el.textContent;
      var observer = new MutationObserver(function () {
        if (el.textContent !== lastVal) {
          lastVal = el.textContent;
          el.classList.remove('count-pop');
          void el.offsetWidth;
          el.classList.add('count-pop');
        }
      });
      observer.observe(el, { childList: true, characterData: true, subtree: true });
    });
  }

  /* ── Initialize Everything ── */
  function init() {
    initPageEntrance();
    initScrollReveal();
    initCountUp();
    initRipple();
    initShimmer();
    init3DTilt();
    initLiveUpdates();

    // Particles last — non-critical visual
    if (!document.hidden) initParticles();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
