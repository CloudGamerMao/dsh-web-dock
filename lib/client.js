// Client half of the dsh-deepseek-web plugin (v6.31).
//
// Hand-written in the exact module shape DSH's Web Client loader expects:
//   window.__ModuleLoader__.load({ id, factory: (require) => { ... } })
// `id` must equal the package name. `react` is resolved by the loader's
// externals table — do NOT inline a second React instance.
//
// v6.17/v6.18 architecture: the DeepSeek panel is a BODY-LEVEL VANILLA DOM
// element (not a React child). DSH re-renders/remounts the sidebar when the
// user switches workspace/settings views, which reset React component state and
// unmounted the panel ("点击左侧任何按钮 dsWEB 自动隐藏"). A vanilla panel
// attached to document.body survives every React remount, keeps the iframe
// alive, and stays visible regardless of DSH view switches.
//
// v6.27: the entry button is NO LONGER a React slot (sidebar.footer.action).
// The user asked for it right UNDER DSH's own "新会话" (New Session) button,
// styled like it. So we clone the New Session button's classes and insert a
// vanilla sibling right after it (MutationObserver re-applies it if React
// re-renders the sidebar). React is now unused; the module stays in the exact
// loader shape for compatibility.

window.__ModuleLoader__.load({
  id: 'dsh-deepseek-web',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var SPA_URL = '/__dsweb-test/proxy?u=' + encodeURIComponent('https://chat.deepseek.com/')

    // -----------------------------------------------------------------------
    // Service Worker helpers (unchanged from v6.5)
    // -----------------------------------------------------------------------
    // v6.24: SW readiness with a LIVE fast path and no permanent failure cache —
    // if the controller exists right now, we're ready; if a registration attempt
    // failed earlier (first-load race), the next call retries instead of
    // replaying the stale false forever ("首次使用请刷新一次页面" on every reopen).
    var swPromise = null
    function ensureSW() {
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        return Promise.resolve({ ok: true, reason: 'controlled' })
      }
      if (swPromise) return swPromise
      swPromise = new Promise(function (resolve) {
        if (!('serviceWorker' in navigator)) {
          resolve({ ok: false, reason: 'unsupported' })
          return
        }
        navigator.serviceWorker
          .register('/__dsweb-test/sw.js', { scope: '/' })
          .then(function (reg) {
            if (navigator.serviceWorker.controller) {
              resolve({ ok: true, reason: 'controlled' })
              return
            }
            var deadline = Date.now() + 12000
            var timer = setInterval(function () {
              if (navigator.serviceWorker.controller) {
                clearInterval(timer)
                resolve({ ok: true, reason: 'controlled' })
              } else if (Date.now() > deadline) {
                clearInterval(timer)
                swPromise = null // allow a later retry
                resolve({ ok: false, reason: 'no-controller' })
              }
            }, 200)
            var sw = reg.installing || reg.waiting || reg.active
            if (sw) {
              sw.addEventListener('statechange', function (e) {
                if (e.target.state === 'activated' && navigator.serviceWorker.controller) {
                  clearInterval(timer)
                  resolve({ ok: true, reason: 'controlled' })
                }
              })
            }
          })
          .catch(function () {
            swPromise = null
            resolve({ ok: false, reason: 'register-failed' })
          })
      })
      return swPromise
    }

    function querySWVersion() {
      return new Promise(function (resolve) {
        var c = navigator.serviceWorker && navigator.serviceWorker.controller
        if (!c) return resolve(null)
        try {
          var mc = new MessageChannel()
          mc.port1.onmessage = function (e) { resolve(e.data && e.data.version) }
          c.postMessage({ type: 'dsw-version' }, [mc.port2])
          setTimeout(function () { resolve(null) }, 800)
        } catch (e) {
          resolve(null)
        }
      })
    }

    function checkSWStale(panel) {
      fetch('/__dsweb-test/sw-version')
        .then(function (r) { return r.json() })
        .then(function (srv) {
          if (!srv || !srv.version) return
          querySWVersion().then(function (cur) {
            if (!cur || cur === srv.version) return
            if (panel) panel.setStale(true)
            try {
              if (sessionStorage.getItem('dsw_auto_sw_reload') !== '1') {
                sessionStorage.setItem('dsw_auto_sw_reload', '1')
                setTimeout(function () { location.reload() }, 800)
              }
            } catch (e) {}
          })
        })
        .catch(function () {})
    }

    // -----------------------------------------------------------------------
    // The panel: a body-level vanilla DOM element. Survives React remounts.
    // -----------------------------------------------------------------------
    var panel = null

    function el(tag, style, text) {
      var n = document.createElement(tag)
      if (style) for (var k in style) n.style[k] = style[k]
      if (text !== undefined) n.textContent = text
      return n
    }

    // v6.30 fix: btnStyle was deleted in the v6.27 refactor (the React sidebar
    // button that used it was removed) but the panel's small strip buttons
    // ("刷新"/"×") still use it via btn() — ensurePanel threw
    // "btnStyle is not defined", so the panel NEVER opened ("点击没反应").
    var btnStyle = {
      cursor: 'pointer',
      height: '32px',
      padding: '0 12px',
      margin: '0 4px',
      borderRadius: '8px',
      border: '1px solid var(--dsw-alias-border-l2, #2a2a33)',
      background: 'var(--dsw-alias-button-elevated-fill, #23232b)',
      color: 'var(--dsw-alias-label-primary, #e8e8ec)',
      fontSize: '13px',
      fontWeight: 500,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
    }
    function btn(text, onClick, extra) {
      var b = el('button', Object.assign({}, btnStyle, { margin: 0 }, extra || {}), text)
      b.type = 'button'
      b.addEventListener('click', onClick)
      return b
    }

    function getSidebarRight() {
      try {
        var s =
          document.querySelector('[class*="sidebarCol"]') ||
          document.querySelector('[class*="sideBar"]') ||
          document.querySelector('[class*="sidebar"]')
        if (s) {
          var r = s.getBoundingClientRect()
          if (r && r.right > 0) return r.right
        }
      } catch (e) {}
      return 280
    }

    function ensurePanel() {
      if (panel) return panel

      // v6.20: full-bleed embedded page — just the iframe. All controls live in
      // a tiny hover-revealed strip in the top-right corner (zero footprint
      // normally, appears on hover of the panel edge).
      // v6.23: start hidden (display:none) — otherwise the FIRST toggle click
      // sees the freshly-created panel as "visible" and hides it (first click
      // appeared to do nothing).
      var overlay = el('div', {
        position: 'fixed',
        top: '0',
        right: '0',
        bottom: '0',
        left: getSidebarRight() + 'px',
        zIndex: '9999',
        // v6.27: TRANSPARENT background — the skin-center plugin paints the
        // skin wallpaper onto document.body; a panel background color (even one
        // following CSS vars) covered it ("一片白没有背景图"). The iframe has
        // its own opaque page background, so transparency is safe here.
        background: 'transparent',
        overflow: 'hidden',
        display: 'none',
      })

      var iframe = document.createElement('iframe')
      iframe.style.cssText = 'width:100%;height:100%;border:0;display:block'
      iframe.title = 'DeepSeek Web'

      // hover-reveal control strip (top-right: 60px from the edge, 12px down —
      // clear of DSH's share button at the far corner; v6.26)
      var strip = el('div', {
        position: 'absolute',
        top: '12px',
        right: '60px',
        zIndex: '10000',
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '4px 6px',
        borderRadius: '10px',
        background: 'rgba(28,28,34,0.88)',
        border: '1px solid rgba(255,255,255,0.12)',
        boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
        opacity: '0',
        transition: 'opacity .15s ease',
        font: '12px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        color: '#e8e8ec',
        flexWrap: 'wrap',
        maxWidth: '70%',
        pointerEvents: 'none',
      })
      overlay.addEventListener('mouseenter', function () { strip.style.opacity = '1'; strip.style.pointerEvents = 'auto' })
      overlay.addEventListener('mouseleave', function () { strip.style.opacity = '0'; strip.style.pointerEvents = 'none' })

      var statusEl = el('span', { fontSize: '11px', opacity: '0.85' }, '…')
      var msgEl = el('span', { fontSize: '11px', color: '#e0b660' })
      strip.appendChild(statusEl)
      strip.appendChild(msgEl)
      strip.appendChild(btn('刷新', function () {
        iframe.src = SPA_URL
        armLoadTimer()
      }, { height: '24px', fontSize: '11px', padding: '0 8px' }))
      strip.appendChild(btn('×', function () {
        overlay.style.display = 'none' // hide only; iframe stays alive
        setTitle(false)
      }, { height: '24px', fontSize: '11px', padding: '0 8px' }))

      overlay.appendChild(iframe)
      overlay.appendChild(strip)

      // v6.30: visible "loading" hint centered over the panel — the overlay
      // background is transparent (skin-plugin friendly), so WITHOUT this a
      // freshly opened panel that is still loading looks exactly like "click
      // did nothing". Hidden once the iframe fires load.
      var loadingHint = el('div', {
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%,-50%)',
        zIndex: '10001',
        padding: '10px 18px',
        borderRadius: '10px',
        background: 'rgba(28,28,34,0.9)',
        border: '1px solid rgba(255,255,255,0.12)',
        color: '#e8e8ec',
        font: '13px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
      }, 'DeepSeek 加载中…')
      overlay.appendChild(loadingHint)

      document.body.appendChild(overlay)

      // follow the resizable sidebar (DSH: 264-420px)
      try {
        var sbEl = document.querySelector('[class*="sidebarCol"]')
        var updateLeft = function () {
          var r = getSidebarRight()
          overlay.style.left = r + 'px'
        }
        if (sbEl && typeof ResizeObserver !== 'undefined') {
          var ro = new ResizeObserver(updateLeft)
          ro.observe(sbEl)
        }
        window.addEventListener('resize', updateLeft)
      } catch (e) {}

      iframe.addEventListener('load', function () {
        // skip the initial about:blank load (iframe created without src)
        if (!iframe.getAttribute('data-loaded')) return
        clearTimeout(loadTimer)
        if (loadingHint) loadingHint.style.display = 'none'
        var win = iframe.contentWindow
        var proxied = false
        try {
          if (win.__DSWEB_PROXIED__) proxied = true
        } catch (err) {
          proxied = true
        }
        if (!proxied) {
          msgEl.textContent = 'Escape: iframe 离开了代理页面，点「刷新」。'
          msgEl.style.color = '#f0a0a0'
        } else {
          msgEl.textContent = ''
        }
        // probe API reachability (meaningful status text)
        fetch('/__dsweb-test/proxy?u=' + encodeURIComponent('https://chat.deepseek.com/api/v0/client/settings'))
          .then(function (r) {
            setStatus(r.status === 200 ? ['● 正常', '#3fb950'] : r.status === 429 ? ['● WAF 限流', '#d29922'] : ['● 异常 ' + r.status, '#f0a0a0'])
          })
          .catch(function () { setStatus(['● 未知', '#8b949e']) })
      })

      // v6.22: if the iframe does not load within 15s, surface it instead of a
      // silent blank.
      var loadTimer = null
      function armLoadTimer() {
        clearTimeout(loadTimer)
        loadTimer = setTimeout(function () {
          setStatus(['● 加载超时', '#f0a0a0'])
          msgEl.textContent = '加载较慢，可点「刷新」重试。'
          msgEl.style.color = '#e0b660'
        }, 15000)
      }

      function setStatus(pair) {
        statusEl.textContent = pair[0]
        statusEl.style.color = pair[1]
      }

      // v6.22: the DSH page title mirrors the active view — "DeepSeek Web"
      // while the panel is open, restored on hide (like clicking other tasks).
      var originalTitle = null
      function setTitle(show) {
        try {
          if (show) {
            if (originalTitle === null) originalTitle = document.title
            document.title = 'DeepSeek Web'
          } else if (originalTitle !== null) {
            document.title = originalTitle
          }
        } catch (e) {}
      }

      panel = {
        el: overlay,
        iframe: iframe,
        statusEl: statusEl,
        setStale: function (v) {
          if (v) msgEl.textContent = 'Stale SW：刷新一次升级。'
        },
        armLoadTimer: armLoadTimer,
        show: function () { overlay.style.display = 'block'; setTitle(true) },
        hide: function () { overlay.style.display = 'none'; setTitle(false) },
        visible: function () { return overlay.style.display !== 'none' },
      }

      // v6.19: storage auto-sync scoped to the DeepSeek login token keys ONLY
      // (SPA writes feature-store keys constantly — reacting to every storage
      // event caused an iframe reload loop "一直刷新").
      var lastAutoReload = 0
      window.addEventListener('storage', function (e) {
        if (overlay.style.display === 'none') return
        if (e.key !== 'userToken' && e.key !== '__appKit_userInfo') return
        if (Date.now() - lastAutoReload < 3000) return
        lastAutoReload = Date.now()
        msgEl.textContent = '检测到登录完成，iframe 已刷新。'
        msgEl.style.color = '#3fb950'
        iframe.src = SPA_URL
      })

      // v6.19: clicking any OTHER sidebar button (workspace/settings) hides the
      // DeepSeek panel — it behaves like a regular DSH view.
      document.addEventListener(
        'click',
        function (e) {
          if (overlay.style.display === 'none') return
          var sb = document.querySelector('[class*="sidebarCol"]')
          var t = e.target
          if (sb && sb.contains(t)) {
            // v6.30: match BOTH the legacy footer button (data-dsw-web-btn) and
            // the new chat button (data-dsw-chat-btn) — otherwise clicking OUR
            // own button got treated as "clicked another sidebar item" and the
            // panel was force-hidden (never opening / instantly closing).
            var ours = t && t.closest && t.closest('[data-dsw-web-btn],[data-dsw-chat-btn]')
            if (!ours) {
              overlay.style.display = 'none'
              setTitle(false)
            }
          }
        },
        true,
      )

      return panel
    }

    function togglePanel() {
      // v6.30: harden — if anything in the open path throws (skin plugin DOM
      // quirk, missing body, etc.) report it to /__dsweb-test/report so the
      // next /status dump shows the exact error instead of "click did nothing".
      try {
        var p = ensurePanel()
        if (p.visible()) {
          p.hide()
          return
        }
        p.show()
        ensureSW().then(function (res) {
          // v6.24: live re-check — the cached ensureSW may have recorded an early
          // false; if the controller exists NOW, we are ready.
          var liveOk = !!(navigator.serviceWorker && navigator.serviceWorker.controller)
          if (liveOk || res.ok) {
            p.statusEl.textContent = '● proxy active'
            p.statusEl.style.color = '#3fb950'
          } else {
            p.statusEl.textContent = '● 首次使用请刷新一次页面'
            p.statusEl.style.color = '#d29922'
          }
        })
        checkSWStale(p)
        // mount the iframe source on first show
        if (!p.iframe.getAttribute('data-loaded')) {
          p.iframe.setAttribute('data-loaded', '1')
          p.iframe.src = SPA_URL
          p.armLoadTimer()
        }
      } catch (e) {
        try {
          var _b =
            'msg=' +
            encodeURIComponent(
              'togglePanel error: ' + ((e && e.message) || String(e)),
            )
          fetch('/__dsweb-test/report', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: _b,
            keepalive: true,
          }).catch(function () {})
        } catch (e2) {}
        // still try to make SOMETHING visible so it is not a silent no-op
        try {
          var p2 = ensurePanel()
          p2.show()
        } catch (e3) {}
      }
    }

    // v6.27: vanilla DOM entry button cloned from DSH's "新会话" (New Session)
    // button — same classes so it inherits the same skin/styles, inserted as
    // the NEXT sibling right after it. A MutationObserver re-applies it when
    // React re-renders the sidebar. NO React needed anymore.
    var chatBtn = null
    function makeChatButton() {
      var b = document.createElement('button')
      b.type = 'button'
      b.setAttribute('data-dsw-chat-btn', '1')
      b.title = 'DeepSeek Chat'
      // inline SVG chat icon (stand-in for DSH's IconNewChatOutline16; styled
      // by the cloned classes, sized like the New Session icon)
      b.innerHTML =
        '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" style="flex:none">' +
        '<path d="M8 1.5a6 6 0 0 0-5.4 8.6L1.5 14.5l4.3-1.1A6 6 0 1 0 8 1.5z" fill="currentColor"/>' +
        '</svg>'
      var label = document.createElement('span')
      label.textContent = 'DeepSeek Chat'
      b.appendChild(label)
      // v6.30: bind in the CAPTURE phase. DSH/skin plugins attach capture-phase
      // listeners (e.g. sidebar item click -> view switch) that may call
      // stopPropagation; a bubble-phase listener on our button would then never
      // fire ("点击没反应", proxyHits stays 0). Capture runs first, so the
      // toggle ALWAYS executes.
      b.addEventListener('click', togglePanel, true)
      return b
    }
    var lastChatMount = 0
    function mountChatButton() {
      // v6.29: throttle. The MutationObserver fires on EVERY body change; an
      // unconditional remove+insert would fight React's reconciliation and turn
      // into an infinite DOM-churn loop that freezes the GUI ("Loading plugins..."
      // forever). Short-circuit when the button is ALREADY in place, and rate
      // limit actual DOM mutations.
      var host = document.querySelector('[class*="newSession"]')
      if (!host) return false
      if (!host.parentNode) return false
      // already mounted exactly as the next sibling? no-op (observer storm guard)
      if (chatBtn && chatBtn.parentNode === host.parentNode && host.nextElementSibling === chatBtn) {
        return true
      }
      var now = Date.now()
      if (now - lastChatMount < 400) return true
      lastChatMount = now
      if (!chatBtn) chatBtn = makeChatButton()
      // clone classes from the New Session button so it inherits the exact skin
      var clone = host.classList
      chatBtn.className = ''
      for (var i = 0; i < clone.length; i++) chatBtn.classList.add(clone[i])
      // match label styling: give the span the same class DSH uses for the
      // New Session label (hidden in collapsed rail mode via max-width:0)
      var label = chatBtn.querySelector('span')
      if (label) {
        label.className = ''
        var newSessionLabel =
          host.querySelector('[class*="newSessionLabel"]')
        if (newSessionLabel) {
          var lc = newSessionLabel.classList
          for (var j = 0; j < lc.length; j++) label.classList.add(lc[j])
        }
        label.textContent = 'DeepSeek Chat'
      }
      // insert right after the New Session button if not already placed
      var next = host.nextElementSibling
      if (next !== chatBtn) {
        if (chatBtn.parentNode) chatBtn.parentNode.removeChild(chatBtn)
        host.insertAdjacentElement('afterend', chatBtn)
      }
      return true
    }
    function watchSidebar() {
      try {
        // poll until the New Session button exists (sidebar may mount late)
        var tries = 0
        var timer = setInterval(function () {
          tries++
          if (mountChatButton() || tries > 50) clearInterval(timer)
        }, 200)
        // re-apply when React swaps the sidebar DOM — DEBOUNCED so a burst of
        // mutations (React re-render, skin plugin repaint) collapses into one
        // check instead of a remove/insert loop.
        if (typeof MutationObserver !== 'undefined') {
          var moTimer = null
          var mo = new MutationObserver(function () {
            if (moTimer) clearTimeout(moTimer)
            moTimer = setTimeout(function () { mountChatButton() }, 250)
          })
          mo.observe(document.body, { childList: true, subtree: true })
        }
      } catch (e) {}
    }

    exports.name = 'dsh-deepseek-web'
    exports.inject = ['slots']
    exports.apply = function (ctx) {
      // Eager SW registration (proxy infrastructure; does NOT load the DeepSeek
      // page). Force an update check; auto-reload once when a newer SW installs.
      try {
        if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
          navigator.serviceWorker
            .register('/__dsweb-test/sw.js', { scope: '/' })
            .then(function (reg) {
              try { reg.update() } catch (e) {}
              var reloaded = false
              try { reloaded = sessionStorage.getItem('dsw_sw_reload') === '1' } catch (e) {}
              reg.addEventListener('updatefound', function () {
                var sw = reg.installing
                if (!sw) return
                sw.addEventListener('statechange', function () {
                  if ((sw.state === 'installed' || sw.state === 'activated') && !reloaded) {
                    try { sessionStorage.setItem('dsw_sw_reload', '1') } catch (e) {}
                    location.reload()
                  }
                })
              })
            })
            .catch(function (e) {
              console.warn('[dsh-deepseek-web] eager SW register failed', e)
            })
        }
      } catch (e) {
        console.warn('[dsh-deepseek-web] eager SW register error', e)
      }
      // v6.27: entry button = vanilla DOM clone of "新会话", inserted under it.
      // (Removed the React sidebar.footer.action slot per user request.)
      watchSidebar()
    }

    return module.exports
  },
})
