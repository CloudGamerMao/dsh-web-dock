// Host half of the dsh-deepseek-web plugin (Phase 5 POC).
//
// Phase 4 added: Service Worker (/__dsweb-test/sw.js) that rewrites every
// *.deepseek.com request from the framed SPA to our same-origin proxy, plus a
// host-side cookie jar so the DeepSeek session survives on the 127.0.0.1 origin.
// Phase 5 adds /__dsweb-test/status, a server self-check JSON endpoint so the
// Web UI (and a human reviewer) can see in one glance whether the proxy/SW
// plumbing is healthy (SW script served, self-test proxy OK, allowlist active,
// cookie jar session count).
//
// Handler contract (verified against @deepseek-ai/dsh-host-webserver):
//   ctx.webServer.register({ kind: 'prefix', path, handler })
//   handler(req, res)  where req/res are Node http IncomingMessage/ServerResponse.
//   Prefix match: pathname === path  OR  pathname.startsWith(path + '/').
//
// Security model (Phase 0 R4 — do NOT weaken):
//   - isSameOrigin(req) keeps cross-origin callers out of every /__dsweb-test route.
//   - isAllowedTarget(u) restricts the proxy to deepseek.com hosts AND the same
//     DSH origin (the latter only enables a local self-test). Anything else -> 403.
//   - Framing-inhibiting headers are stripped; upstream Set-Cookie is jarred.

import { randomUUID, createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const name = 'dsh-deepseek-web'

export const inject = ['webServer']

function isSameOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    const originHost = new URL(origin).host
    const host = req.headers.host
    return !!host && originHost === host
  } catch {
    return false
  }
}

function isAllowedTarget(target, reqHost) {
  try {
    const t = new URL(target)
    if (!/^https?:$/i.test(t.protocol)) return false
    const host = t.host.toLowerCase()
    if (reqHost && host === String(reqHost).toLowerCase()) return true
    if (host === 'deepseek.com' || host.endsWith('.deepseek.com')) return true
    // Phase 5.6: DeepSeek login uses third-party anti-bot captcha SDKs whose
    // domains are NOT deepseek.com. Proxying them (same-origin) lets the SDK
    // script/iframe load; the user still solves the captcha manually — this is
    // NOT a captcha bypass, just making the SDK reachable inside the iframe.
    for (const h of CAPTCHA_HOSTS) {
      if (host === h || host.endsWith('.' + h)) return true
    }
    return false
  } catch {
    return false
  }
}

// Third-party anti-bot/captcha SDK hosts used by chat.deepseek.com login
// (found by scanning the shipped JS bundles, 2026-08-19):
//   awswaf.com            AWS WAF SDK + CAPTCHA SDK  (a0fea896111e.edge.*)
//   hcaptcha.com          hCaptcha
//   fengkongcloud.cn      数美 FengKong anti-fraud
//   cloudflare.com        Cloudflare Turnstile/challenges
//   portal101.cn          数美 device-fingerprint API (fp-1.min.js:
//                         apiHost 'fp-it.portal101.cn', path /deviceprofile/v4;
//                         observed live: fp-it-acc.portal101.cn). Without this
//                         the fingerprint POST went DIRECT from 127.0.0.1 and
//                         was CORS-blocked -> login flow stalled ("没有网").
//   wx.qq.com / weixin.qq.com  2026-08-20: WeChat QR login SDK.
//                         wxLogin.js (res.wx.qq.com) renders the QR; the
//                         refresh/status poll goes to open.weixin.qq.com.
//                         They were NOT allowlisted -> the proxy answered 403,
//                         the SDK's refresh call failed -> QR could not refresh.
const CAPTCHA_HOSTS = [
  'awswaf.com',
  'hcaptcha.com',
  'fengkongcloud.cn',
  'cloudflare.com',
  'portal101.cn',
  'wx.qq.com',
  'weixin.qq.com',
]

function rewriteDeepseekHtml(html, upstreamHost) {
  // Phase 5.8.7 final v2: the iframe loads https://chat.deepseek.com/ and the
  // SW proxies every *.deepseek.com request (navigation, assets, API). The
  // rewritten HTML must therefore contain NO http://127.0.0.1 URLs — an HTTPS
  // document blocked from loading HTTP subresources by mixed-content policy
  // (user saw "chat.deepseek.com 拒绝连接" = resources silently blocked).
  // Rules: absolute https://*.deepseek.com URLs stay untouched (SW intercepts);
  // RELATIVE paths are made absolute against the CDN (static) or app (API).
  // v6.27: INJECT the marker/nav-block ONLY for DeepSeek's own documents.
  // Third-party HTML (WeChat qrconnect, captcha pages) must stay untouched —
  // our injected nav-block disables location.reload, which broke the WeChat
  // QR's auto-refresh ("微信二维码刷新不了"). Their relative resources still
  // get absolute-ized below so they load through the proxy.
  const isDeepSeekHost =
    upstreamHost === 'chat.deepseek.com' ||
    upstreamHost === 'deepseek.com' ||
    (upstreamHost || '').endsWith('.deepseek.com')
  const cdnOrigin = 'https://fe-static.deepseek.com'
  const appOrigin = 'https://chat.deepseek.com'

  let out = html
  // Phase 5.8.3: inject a "proxied" marker into every rewritten document. The
  // SPA navigates to absolute chat.deepseek.com URLs (-> iframe goes
  // CROSS-ORIGIN) AND to relative paths like "/" (-> iframe URL becomes a
  // same-origin path outside /__dsweb-test/). Both are NORMAL proxied states,
  // so URL-based escape detection on the client was unreliable. Instead the
  // client checks for this marker: present == document came from our proxy.
  // Phase 5.8.4: also inject a JS error reporter — if the SPA throws after
  // captcha success (fverify 200 but no login_by_* request follows), the
  // browser console error is invisible to us; this relays it to the status page.
  // Phase 5.8.5: also hook fetch/XHR to log EVERY network call the SPA makes.
  // Captcha PASS but no login API call = the SPA never fired its request; seeing
  // exactly which URLs the SPA attempted (and when) pinpoints the break.
  // v6.9: ONE clean IIFE (previous piecemeal string assembly had a brace
  // imbalance — `}catch(e){}}` closed the IIFE early, the nav hooks became bare
  // statements and a stray `}` remained — the browser threw
  // "Unexpected token 'var'" at 3:1133 and SKIPPED the whole script, so the
  // marker, the reporter, the fetch/xhr hooks and the nav-block hooks never ran
  // (no marker -> Escape; no dsw-spa registration -> /api not proxied after
  // routing -> direct 404 -> "没接上网络"). Verified with `new Function()`.
  const INJECTED_SCRIPT = `(function(){
try{window.__DSWEB_PROXIED__=1}catch(e){}
try{if(navigator.serviceWorker&&navigator.serviceWorker.controller){navigator.serviceWorker.controller.postMessage({type:"dsw-spa"})}}catch(e){}
function r(m){try{var b="msg="+encodeURIComponent(String(m).slice(0,600));fetch("/__dsweb-test/report?"+b,{keepalive:true}).catch(function(){})}catch(e){}}
window.addEventListener("error",function(e){r("error: "+(e.message||"")+" @ "+(e.filename||"")+":"+(e.lineno||0)+":"+(e.colno||0))},true);
window.addEventListener("unhandledrejection",function(e){var x=e.reason;r("unhandledrejection: "+((x&&x.message)||String(x)||"unknown"))});
try{
var __of=window.fetch;window.fetch=function(){try{var u=(arguments[0]&&arguments[0].url)||arguments[0];if(u&&u.indexOf("/__dsweb-test")===-1){r("fetch: "+((arguments[1]&&arguments[1].method)||"GET")+" "+String(u).slice(0,200))}}catch(e){}return __of.apply(this,arguments)};
var __xhr=window.XMLHttpRequest.prototype.open;window.XMLHttpRequest.prototype.open=function(m,u){try{if(u&&String(u).indexOf("/__dsweb-test")===-1){r("xhr: "+String(m)+" "+String(u).slice(0,200))}}catch(e){}return __xhr.apply(this,arguments)};
}catch(e){}
try{
var __inFrame=(function(){try{return window.self!==window.top}catch(e){return true}})();
var __navBlock=function(u){
if(typeof u!=="string")return false;
if(u.indexOf("#")===0)return false;
var nu;try{nu=new URL(u,location.href)}catch(e){return false}
if(nu.pathname===location.pathname&&nu.search===location.search&&nu.hash!==location.hash)return false;
if(!__inFrame){if(nu.href===location.href)return true;return false}
try{r("nav-block: "+String(u).slice(0,160))}catch(e){}
return true;
};
try{window.location.reload=function(){}}catch(e){}
try{Location.prototype.reload=function(){}}catch(e){}
try{var __hg=history.go;if(__hg)history.go=function(d){if(d===0)return;return __hg.apply(history,arguments)}}catch(e){}
var __la=window.location.assign;if(__la)window.location.assign=function(u){if(__navBlock(u))return;return __la.call(window.location,u)};
var __lr=window.location.replace;if(__lr)window.location.replace=function(u){if(__navBlock(u))return;return __lr.call(window.location,u)};
try{var __hd=Object.getOwnPropertyDescriptor(Location.prototype,"href");if(__hd&&__hd.set){Object.defineProperty(Location.prototype,"href",{get:function(){return __hd.get.call(this)},set:function(v){if(__navBlock(v))return;__hd.set.call(this,v)},configurable:true})}}catch(e){}
try{document.addEventListener("click",function(ev){var a=ev.target&&ev.target.closest?ev.target.closest("a[href]"):null;if(a){var h=a.getAttribute("href");if(__navBlock(h)){ev.preventDefault()}}},true)}catch(e){}
}catch(e){}
})();`
  // v6.27: inject ONLY into DeepSeek's own documents; third-party HTML (WeChat
  // QR page etc.) must NOT get our nav-block (it disables location.reload and
  // broke the WeChat QR auto-refresh). Resource absolute-ization below still
  // applies to every host so third-party assets load through the proxy.
  if (isDeepSeekHost) {
    out = out.replace('<head>', '<head><script>' + INJECTED_SCRIPT + '</script>')
  }
  // Absolute https://*.deepseek.com URLs stay as-is — the SW intercepts every
  // *.deepseek.com request and proxies it. Rewriting them to http://127.0.0.1
  // would trigger mixed-content blocking on the HTTPS iframe document.
  out = out.replace(
    /(src|href|action)=("|')((\/)[^"'>\s]*)/gi,
    (m, attr, q, p) => {
      if (p.startsWith('/__dsweb-test')) return m
      // API calls stay on the app host; everything else (static assets) is CDN.
      const base = p.startsWith('/api/') ? appOrigin : cdnOrigin
      return attr + '=' + q + base + p
    },
  )
  return out
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

// ---------------------------------------------------------------------------
// Host-side cookie jar. Maps session id -> "name=value; ..." (DeepSeek cookies).
//
// Phase 4: in-memory POC. Phase 7 (this session): persisted to disk so the
// DeepSeek session survives DSH restarts. The session id comes from the SW
// (shared by every client of this origin — DSH page, iframe, login tab) via the
// `sid` query param; the dsw_sid cookie remains only as a fallback for direct
// (non-SW) browser use, e.g. the self-test route.
// ---------------------------------------------------------------------------
const cookieJar = new Map()

// v6.16: in-memory cache for versioned static assets (fe-static/cdn.deepseek.com).
// Every iframe load re-fetched ~30 assets (main.js 1.4MB, vendors 1MB, chunks,
// fonts, wasm) through two network hops (browser -> SW -> proxy -> upstream),
// which made page loads / iframe reloads / overlay reopens feel very slow.
// Content-hashed filenames are immutable, so caching is safe.
// v6.25: persisted to disk (~/.dsh/dsh-deepseek-web/asset-cache) so the FIRST
// load after a server restart also hits the cache (restarts wiped the memory
// cache and warmAssets couldn't keep up with the iframe's first requests).
const assetCache = new Map()
const ASSET_CACHE_TTL = 24 * 60 * 60 * 1000 // immutable content-hashed files
const ASSET_CACHE_MAX = 300

const ASSET_CACHE_DIR = path.join(os.homedir(), '.dsh', 'dsh-deepseek-web', 'asset-cache')
const ASSET_MANIFEST = path.join(ASSET_CACHE_DIR, 'manifest.json')

function assetCacheKey(url) {
  return createHash('sha256').update(url).digest('hex').slice(0, 32)
}

function loadAssetCache() {
  try {
    const raw = fs.readFileSync(ASSET_MANIFEST, 'utf8')
    const manifest = JSON.parse(raw)
    let n = 0
    for (const [hash, meta] of Object.entries(manifest)) {
      try {
        const body = fs.readFileSync(path.join(ASSET_CACHE_DIR, hash + '.bin'))
        if (body.length && meta.url) {
          assetCache.set(meta.url, { ts: Date.now(), status: meta.status, ct: meta.ct, body, ttl: ASSET_CACHE_TTL })
          n++
        }
      } catch (e) {}
    }
    ctxLogger?.info?.('[dsh-deepseek-web] loaded ' + n + ' cached assets from disk')
  } catch (e) {}
}

let assetSaveTimer = null
function persistAssetCache() {
  try {
    fs.mkdirSync(ASSET_CACHE_DIR, { recursive: true })
    const manifest = {}
    for (const [url, hit] of assetCache) {
      const hash = assetCacheKey(url)
      manifest[hash] = { url, status: hit.status, ct: hit.ct }
      try {
        fs.writeFileSync(path.join(ASSET_CACHE_DIR, hash + '.bin'), hit.body)
      } catch (e) {}
    }
    fs.writeFileSync(ASSET_MANIFEST, JSON.stringify(manifest))
  } catch (e) {}
}

function scheduleAssetCacheSave() {
  if (assetSaveTimer) clearTimeout(assetSaveTimer)
  assetSaveTimer = setTimeout(() => {
    assetSaveTimer = null
    persistAssetCache()
  }, 800)
}

function assetCacheGet(key) {
  const hit = assetCache.get(key)
  if (!hit) return null
  if (Date.now() - hit.ts > hit.ttl) {
    assetCache.delete(key)
    return null
  }
  return hit
}

function assetCacheSet(key, status, ct, body, ttl) {
  if (assetCache.size >= ASSET_CACHE_MAX) {
    let oldestKey = null
    let oldestTs = Infinity
    for (const [k, v] of assetCache) {
      if (v.ts < oldestTs) {
        oldestTs = v.ts
        oldestKey = k
      }
    }
    if (oldestKey) assetCache.delete(oldestKey)
  }
  assetCache.set(key, { ts: Date.now(), status, ct, body, ttl: ttl || ASSET_CACHE_TTL })
  scheduleAssetCacheSave()
}

const STATIC_HOST_RE = /(?:^|\.)(fe-static|cdn|static)\.deepseek\.com$/

function isCacheableAsset(req, upstream) {
  return (
    (req.method === 'GET' || req.method === 'HEAD') &&
    STATIC_HOST_RE.test(upstream.host)
  )
}

// v6.19: pre-warm the asset cache from the served HTML — parse script/link URLs
// and background-fetch the static assets so the iframe's FIRST load hits warm
// cache entries instead of fetching every asset through two hops.
function warmAssets(html) {
  try {
    const urls = new Set()
    const re = /(?:src|href)=["'](https:\/\/[^"']+)["']/g
    let m
    while ((m = re.exec(html)) !== null) {
      try {
        const u = new URL(m[1])
        if (STATIC_HOST_RE.test(u.host)) urls.add(u.toString())
      } catch (e) {}
    }
    for (const url of urls) {
      if (assetCacheGet(url)) continue
      fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0 Safari/537.36' } })
        .then(async (r) => {
          if (r.status === 200) {
            const buf = Buffer.from(await r.arrayBuffer())
            assetCacheSet(url, 200, r.headers.get('content-type') || 'application/octet-stream', buf, ASSET_CACHE_TTL)
          }
        })
        .catch(() => {})
    }
  } catch (e) {}
}

const JAR_FILE = path.join(os.homedir(), '.dsh', 'dsh-deepseek-web', 'session.json')
let lastJarSave = 0
let jarSaveTimer = null

function loadJar() {
  try {
    const raw = fs.readFileSync(JAR_FILE, 'utf8')
    const data = JSON.parse(raw)
    if (data && data.sessions && typeof data.sessions === 'object') {
      for (const [sid, cookies] of Object.entries(data.sessions)) {
        if (typeof cookies === 'string' && cookies.length) cookieJar.set(sid, cookies)
      }
    }
    ctxLogger?.info?.('[dsh-deepseek-web] loaded cookie jar: ' + cookieJar.size + ' session(s) from ' + JAR_FILE)
  } catch {
    /* first run or unreadable file — start empty */
  }
}

// Deferred so a module-scope variable can be set from apply() (ctx available).
let ctxLogger = null

function saveJarNow() {
  try {
    const payload = {
      version: 1,
      savedAt: Date.now(),
      sessions: Object.fromEntries(cookieJar),
    }
    fs.mkdirSync(path.dirname(JAR_FILE), { recursive: true })
    const tmp = JAR_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(payload))
    fs.renameSync(tmp, JAR_FILE)
    lastJarSave = Date.now()
  } catch (e) {
    ctxLogger?.warn?.('[dsh-deepseek-web] cookie jar save failed: ' + (e && e.message ? e.message : String(e)))
  }
}

function scheduleJarSave() {
  if (jarSaveTimer) clearTimeout(jarSaveTimer)
  jarSaveTimer = setTimeout(() => {
    jarSaveTimer = null
    saveJarNow()
  }, 400)
}

process.on('exit', () => {
  if (cookieJar.size) {
    try {
      saveJarNow()
    } catch {
      /* best-effort flush */
    }
  }
})

// Phase 5.2: how many requests the proxy has actually served this process.
// A rising value while the DeepSeek page is open proves the SW is intercepting
// the iframe's deepseek requests (verifiable via /__dsweb-test/status).
let proxyHits = 0

// Phase 5.3: how many upstream responses were HTTP 429 (DeepSeek WAF).
// Rising while the page is open = WAF is blocking the API, not a proxy bug.
let waf429 = 0

// Phase 5.8: how many times the proxy detected chat.deepseek.com's 200+HTML
// SPA-fallback on a non-HTML request and successfully retried via the CDN.
// >0 while the page is open = assets are being routed correctly now.
let spaFallbackRetries = 0

// v6.31: last few WeChat forwards (URL + Referer sent), for /status debugging.
const wechatDebug = []

// Phase 5.8.4: JS errors reported from inside the iframe (injected reporter).
// If the SPA throws after captcha success (fverify 200, no login_by_* follows),
// this shows the exact browser error instead of a silent stall.
const pageErrors = []

// Phase 5.5: per-request proxy log (method/path/status) + status histogram.
// Lets us see EXACTLY which DeepSeek API calls the SPA makes and what each
// returns (e.g. login/captcha endpoints), exposed via /__dsweb-test/status.
// Phase 5.8: record the FULL upstream host too — chat.deepseek.com returns
// 200+HTML (SPA fallback) for ANY missing path, so status-only-200 was a
// diagnostic blind spot. host + ct disambiguate real assets from fallbacks.
// Phase 5.8.6: ring buffer 30->60 so a failed first load (e.g. SRI onerror
// retry after a 502/timeout) AND its retry both stay visible in one snapshot.
const proxyLog = []
const statusHist = {}
function recordProxy(method, path, status, snippet, host, ct) {
  statusHist[status] = (statusHist[status] || 0) + 1
  const entry = { ts: Date.now(), method, path, status }
  if (host) entry.host = host
  if (ct) entry.ct = ct.slice(0, 40)
  // Phase 5.8.5: captcha JSONP responses carry the token past "riskLevel":
  // slice at 800 so we can see the full fverify payload (token/score/etc).
  if (snippet) entry.snippet = snippet.slice(0, 800)
  proxyLog.push(entry)
  if (proxyLog.length > 60) proxyLog.shift()
}

function parseSid(cookieHeader) {
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(';')) {
    const kv = part.trim()
    if (kv.startsWith('dsw_sid=')) return kv.slice('dsw_sid='.length)
  }
  return null
}

async function handleProxy(req, res, parsedUrl) {
  const target = parsedUrl.searchParams.get('u')
  if (!target) {
    sendJson(res, 400, { ok: false, error: 'missing target param "u"' })
    return
  }
  if (!isAllowedTarget(target, req.headers.host)) {
    sendJson(res, 403, { ok: false, error: 'proxy target not allowed', target })
    return
  }
  proxyHits++

  let upstream
  try {
    upstream = new URL(target)
  } catch {
    sendJson(res, 400, { ok: false, error: 'malformed target', target })
    return
  }

  // Session id: prefer the SW-provided `sid` query param (shared by all clients
  // of this origin — iframe, login tab, DSH page), fall back to the dsw_sid
  // cookie for direct browser use.
  let sid = parsedUrl.searchParams.get('sid') || parseSid(req.headers.cookie)
  const newSid = !sid
  if (newSid) sid = randomUUID()

  const fwd = {}
  // v6.15: forward ALL of the browser's request headers (except the ones we
  // manage). DeepSeek's API requires custom headers beyond the old whitelist —
  // the login flow issues a DeepSeekHashV1 proof-of-work challenge
  // (create_guest_challenge) and the SPA sends the computed proof in a custom
  // header; dropping it made login fail with 40300 "Missing Header".
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase()
    if (
      lk === 'host' ||
      lk === 'cookie' ||
      lk === 'content-length' ||
      lk === 'connection' ||
      lk === 'transfer-encoding'
    ) {
      continue
    }
    fwd[k] = v
  }
  if (!fwd.accept) fwd.accept = '*/*'
  if (!fwd['accept-language']) fwd['accept-language'] = 'en-US,en;q=0.9'
  if (!fwd['user-agent']) {
    fwd['user-agent'] =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
  }
  // Mimic a same-site browser request to DeepSeek. The browser strips
  // Origin/Referer from SW-forwarded requests (forbidden header names), and its
  // API/WAF expects a matching same-origin Origin/Referer — synthesize them
  // from the upstream URL so API calls look like they come from chat.deepseek.com.
  // v6.14: EXCEPT for third-party anti-bot/captcha hosts — those servers
  // validate Origin/Referer against the REAL embedding page; synthesizing
  // upstream.origin made the captcha SDK's fverify look anomalous (page == the
  // captcha host itself) and it answered PASS without issuing a token, so the
  // SDK never settled and the login POST never fired. For those hosts forward
  // the browser's actual Origin/Referer (they are present in req.headers for
  // cross-origin SDK calls).
  const isCaptchaHost = CAPTCHA_HOSTS.some(
    (h) => upstream.host === h || upstream.host.endsWith('.' + h),
  )
  // v6.31: WeChat QR login needs SPECIAL treatment, distinct from captcha SDKs.
  // open.weixin.qq.com/connect/qrconnect validates the request Referer against
  // the appid's REGISTERED domain (chat.deepseek.com for wx5a2326c4bf5442ad).
  // Inside our iframe the browser's actual Referer is the 127.0.0.1 proxy URL,
  // so forwarding it (the isCaptchaHost path) made WeChat answer its generic
  // "抱歉，出错了" error page instead of the QR code -> QR never rendered.
  // Rewrite Origin/Referer to the registered domain for WeChat hosts only.
  const isWechatHost =
    upstream.host === 'open.weixin.qq.com' ||
    upstream.host.endsWith('.weixin.qq.com') ||
    upstream.host.endsWith('.wx.qq.com')
  if (isWechatHost) {
    fwd.referer = 'https://chat.deepseek.com/'
    fwd.origin = 'https://chat.deepseek.com'
    // v6.31 debug: record the last few WeChat forwards (URL + the Referer we
    // sent) so /status can PROVE the rewrite reached the wire after a user test.
    wechatDebug.push({
      ts: Date.now(),
      path: upstream.pathname + upstream.search.slice(0, 80),
      referer: fwd.referer,
    })
    if (wechatDebug.length > 8) wechatDebug.shift()
  } else if (isCaptchaHost) {
    if (req.headers.origin) fwd.origin = req.headers.origin
    else delete fwd.origin
    if (req.headers.referer) fwd.referer = req.headers.referer
    else delete fwd.referer
  } else {
    fwd.origin = upstream.origin
    fwd.referer = upstream.origin + upstream.pathname + upstream.search
  }
  const stored = cookieJar.get(sid)
  if (stored) fwd.cookie = stored

  const init = { method: req.method, headers: fwd, redirect: 'follow' }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try {
      init.body = await readBody(req)
    } catch {
      /* best-effort */
    }
  }

  try {
    // v6.16: serve cached static assets without touching the upstream.
    if (isCacheableAsset(req, upstream)) {
      const hit = assetCacheGet(upstream.toString())
      if (hit) {
        const hdrs = { 'content-type': hit.ct, 'cache-control': 'no-store' }
        if (req.headers.origin) {
          hdrs['access-control-allow-origin'] = req.headers.origin
          hdrs['access-control-allow-credentials'] = 'true'
          hdrs['vary'] = 'Origin'
        }
        recordProxy(req.method, upstream.pathname, hit.status, null, upstream.host, hit.ct)
        res.writeHead(hit.status, hdrs)
        res.end(hit.body)
        return
      }
    }
    // v6.5: retry once on transient upstream connect failures (DeepSeek WAF
    // intermittently throttles the server's outbound IP — observed 502
    // "fetch failed" on settings/fp-1). Only safe for bodyless methods (the
    // request body is consumed on the first attempt).
    let r = null
    const canRetry = req.method === 'GET' || req.method === 'HEAD'
    for (let attempt = 0; attempt < (canRetry ? 2 : 1); attempt++) {
      try {
        r = await fetch(upstream.toString(), init)
        break
      } catch (err) {
        if (!canRetry || attempt > 0) throw err
      }
    }
    // Phase 5.8: chat.deepseek.com returns 200+text/html (SPA fallback) for ANY
    // missing path — so a "successful" asset fetch can actually be the app shell.
    // If the client asked for a non-HTML resource (JS/CSS/JSON/IMG) but got HTML,
    // retry the same path against the real CDN host once.
    const cdnHost = 'fe-static.deepseek.com'
    if (
      r.status === 200 &&
      /text\/html/i.test(r.headers.get('content-type') || '') &&
      upstream.host === 'chat.deepseek.com' &&
      !/text\/html/i.test(fwd.accept || '') &&
      upstream.hostname !== cdnHost
    ) {
      const cdnUrl = new URL(upstream.toString())
      cdnUrl.host = cdnHost
      try {
        const r2 = await fetch(cdnUrl.toString(), init)
        if (!/text\/html/i.test(r2.headers.get('content-type') || '')) {
          r = r2
          spaFallbackRetries++
        }
      } catch {
        /* keep the original HTML response */
      }
    }
    if (r.status === 429) waf429++
    const ct = r.headers.get('content-type') || ''
    const isHtml = ct.toLowerCase().includes('text/html')
    const isErr = r.status >= 400

    const respHeaders = {}
    r.headers.forEach((v, k) => {
      const lk = k.toLowerCase()
      if (
        lk === 'x-frame-options' ||
        lk === 'content-security-policy' ||
        lk === 'content-security-policy-report-only' ||
        lk === 'content-disposition' ||
        lk === 'content-encoding' ||
        lk === 'content-length' ||
        lk === 'transfer-encoding' ||
        lk === 'connection' ||
        lk === 'keep-alive' ||
        lk === 'location' ||
        lk === 'set-cookie'
      ) {
        return
      }
      respHeaders[k] = v
    })
    respHeaders['cache-control'] = 'no-store'
    // Phase 5.8.6: DeepSeek's NEW SPA ships <script crossorigin integrity=...>
    // (SRI). The browser fetches those in CORS mode and validates
    // Access-Control-Allow-Origin against the PAGE origin (127.0.0.1). We were
    // transparently passing upstream's ACAO (e.g. https://fe-static.deepseek.com
    // or https://*.deepseek.com) — a mismatch, so Chrome refused to execute the
    // bundle, the onerror retry loop kicked in (~20s white screen), and the app
    // never came up properly. Rewrite ACAO to the page's origin so SRI passes.
    if (req.headers.origin) {
      respHeaders['access-control-allow-origin'] = req.headers.origin
      respHeaders['access-control-allow-credentials'] = 'true'
      respHeaders['vary'] = (respHeaders['vary'] ? respHeaders['vary'] + ', ' : '') + 'Origin'
    }

    const setCookies =
      typeof r.headers.getSetCookie === 'function'
        ? r.headers.getSetCookie()
        : r.headers.get('set-cookie')
          ? [r.headers.get('set-cookie')]
          : []
    if (setCookies.length) {
      const merged = new Map()
      const prev = cookieJar.get(sid)
      if (prev) for (const c of prev.split('; ')) { const i = c.indexOf('='); merged.set(c.slice(0, i), c) }
      for (const raw of setCookies) {
        const pair = raw.split(';')[0]
        const i = pair.indexOf('=')
        if (i > 0) merged.set(pair.slice(0, i), pair)
      }
      cookieJar.set(sid, [...merged.values()].join('; '))
      scheduleJarSave()
    }

    if (newSid) {
      respHeaders['Set-Cookie'] = 'dsw_sid=' + sid + '; Path=/; Max-Age=2592000; SameSite=Lax'
    }

    if (isErr) {
      // Error bodies are small and carry the reason (e.g. captcha required,
      // invalid credentials) — buffer, log a snippet, and pass through.
      let ebody = Buffer.from(await r.arrayBuffer())
      recordProxy(req.method, upstream.pathname, r.status, ebody.slice(0, 300).toString('utf8'), upstream.host, ct)
      if (isHtml) {
        const rewritten = rewriteDeepseekHtml(ebody.toString('utf8'), upstream.host)
        ebody = Buffer.from(rewritten, 'utf8')
        respHeaders['content-type'] = 'text/html; charset=utf-8'
      }
      res.writeHead(r.status, respHeaders)
      res.end(ebody)
    } else if (isHtml) {
      // HTML: buffer + rewrite static asset URLs (the SW covers runtime requests).
      // v6.19 note: HTML caching was removed — the cache-hit path skipped the
      // Set-Cookie/jar handling and could serve a stale shell; the HTML itself
      // is tiny, the asset cache + warmAssets give the real speedup.
      recordProxy(req.method, upstream.pathname, r.status, null, upstream.host, ct)
      const buf = Buffer.from(await r.arrayBuffer())
      const rewritten = rewriteDeepseekHtml(buf.toString('utf8'), upstream.host)
      warmAssets(rewritten)
      respHeaders['content-type'] = 'text/html; charset=utf-8'
      respHeaders['content-length'] = Buffer.byteLength(rewritten)
      res.writeHead(r.status, respHeaders)
      res.end(Buffer.from(rewritten, 'utf8'))
    } else if (isCacheableAsset(req, upstream) && r.status === 200) {
      // v6.16: buffer + cache versioned static assets (immutable filenames),
      // then serve locally on repeat loads.
      try {
        const buf = Buffer.from(await r.arrayBuffer())
        assetCacheSet(upstream.toString(), r.status, ct, buf)
        recordProxy(req.method, upstream.pathname, r.status, null, upstream.host, ct)
        respHeaders['content-length'] = buf.length
        res.writeHead(r.status, respHeaders)
        res.end(buf)
        return
      } catch {
        /* fall through to streaming on buffer failure */
      }
      recordProxy(req.method, upstream.pathname, r.status, null, upstream.host, ct)
      res.writeHead(r.status, respHeaders)
      const web = Readable.fromWeb(r.body)
      web.on('error', () => { res.destroy() })
      res.on('close', () => { web.destroy() })
      web.pipe(res)
    } else {
      // Everything else (JSON API, SSE/streaming chat, binaries): STREAM through.
      // Buffering with arrayBuffer() would hang forever on long-lived streams
      // (e.g. DeepSeek chat SSE), which was breaking the chat/API responses.
      // Phase 5.8.4: EXCEPT small JSON/plain API responses (login/captcha
      // flows) — those we buffer to record a snippet, so we can see e.g. what
      // fverify returned before the SPA goes silent. Streaming stays for SSE.
      const isSse = /text\/event-stream/i.test(ct)
      const isBuffered =
        !isSse &&
        /(application\/json|text\/plain|application\/x-www-form-urlencoded|text\/javascript)/i.test(ct) &&
        (req.method === 'GET' || req.method === 'POST')
      if (isBuffered) {
        try {
          const buf = Buffer.from(await r.arrayBuffer())
          recordProxy(req.method, upstream.pathname, r.status, buf.slice(0, 800).toString('utf8'), upstream.host, ct)
          respHeaders['content-length'] = buf.length
          res.writeHead(r.status, respHeaders)
          res.end(buf)
          return
        } catch {
          /* fall through to streaming on buffer failure */
        }
      }
      recordProxy(req.method, upstream.pathname, r.status, null, upstream.host, ct)
      res.writeHead(r.status, respHeaders)
      const web = Readable.fromWeb(r.body)
      web.on('error', () => { res.destroy() })
      res.on('close', () => { web.destroy() })
      web.pipe(res)
    }
  } catch (err) {
    recordProxy(
      req.method,
      upstream.pathname,
      502,
      'upstream fetch failed: ' + (err && err.message ? err.message : String(err)),
      upstream.host,
      null,
    )
    sendJson(res, 502, {
      ok: false,
      error: 'upstream fetch failed',
      detail: err && err.message ? err.message : String(err),
    })
  }
}

// ---------------------------------------------------------------------------
// Service Worker source. Served at /__dsweb-test/sw.js with scope '/'.
// VERSION must match SW_SOURCE's internal VERSION constant.
//
// v6.2 (SW): the same-origin iframe/tab (v6.4) routes the SPA to /sign_in etc.
// via pushState / full navigations, so the DOCUMENT URL (and therefore the
// referrer of its requests) stops containing "/__dsweb-test/". The old
// referrer-based isSpaRelative rule then failed to proxy the SPA's /api calls
// (they hit the DSH server -> "没接上网络") and full navigations went direct
// (no marker -> Escape). Fix: every document that came from our proxy
// registers itself with the SW via postMessage({type:'dsw-spa'}); the SW keeps
// the set of SPA clientIds and proxies their same-origin /api requests
// regardless of referrer. The DSH app's own client never registers -> its /api
// stays local. The referrer rule is kept as a fallback for the initial load.
// ---------------------------------------------------------------------------
const SW_VERSION = 'dsw-6.9'

const SW_SOURCE = `
const VERSION = 'dsw-6.9';
const DEEP = /(?:^|\\.)deepseek\\.com$/;
const EXTRA = /(?:^|\\.)(awswaf\\.com|hcaptcha\\.com|fengkongcloud\\.cn|cloudflare\\.com|portal101\\.cn|wx\\.qq\\.com|weixin\\.qq\\.com)$/;
const SPA_PREFIX = '/__dsweb-test/';
// Phase 5.8: chat.deepseek.com returns 200+HTML (SPA fallback) for ANY missing
// path — real static assets live on fe-static.deepseek.com. Route relative-path
// requests by type: /api/* -> chat.deepseek.com, everything else -> CDN.
const API_PREFIX = '/api/';
const CDN_HOST = 'https://fe-static.deepseek.com';
const APP_HOST = 'https://chat.deepseek.com';
function makeSid() {
  return 'sw-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}
// Shared session id. Synchronous module-level variable so the fetch handler
// stays fully synchronous (v6.0's async IndexedDB wait in the fetch path broke
// cross-origin navigation interception). Persisted to IndexedDB during activate
// so it survives SW updates / browser & DSH restarts; regenerated only when the
// user clears site data (which also clears the host-side jar key — consistent).
var SID = makeSid();
// v6.2: clientIds of documents that came from our proxy (the DeepSeek SPA in
// the iframe and the login tab). Used instead of the referrer to decide whether
// a same-origin /api request belongs to the SPA.
var SPA_CLIENTS = {};
self.addEventListener('install', function (e) { self.skipWaiting(); });
self.addEventListener('activate', function (e) {
  e.waitUntil(Promise.all([
    self.clients.claim(),
    new Promise(function (resolve) {
      try {
        var req = indexedDB.open('dsw-sid', 1);
        req.onupgradeneeded = function () {
          try { req.result.createObjectStore('kv'); } catch (err) {}
        };
        req.onsuccess = function () {
          try {
            var db = req.result;
            var tx = db.transaction('kv', 'readwrite');
            var store = tx.objectStore('kv');
            var g = store.get('sid');
            g.onsuccess = function () {
              if (g.result) { SID = g.result; } else { try { store.put(SID, 'sid'); } catch (err) {} }
              resolve();
            };
            g.onerror = function () { resolve(); };
          } catch (err) { resolve(); }
        };
        req.onerror = function () { resolve(); };
        req.onblocked = function () { resolve(); };
      } catch (err) { resolve(); }
    }),
  ]));
});
self.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'dsw-spa' && e.source && e.source.id) {
    SPA_CLIENTS[e.source.id] = 1;
  }
  if (e.data && e.data.type === 'dsw-version' && e.ports && e.ports[0]) {
    e.ports[0].postMessage({ version: VERSION });
  }
});
self.addEventListener('fetch', function (event) {
  var req = event.request;
  var url;
  try { url = new URL(req.url); } catch (e) { event.respondWith(fetch(req)); return; }
  var withSid = function (u) {
    return u + (u.indexOf('?') >= 0 ? '&' : '?') + 'sid=' + SID;
  };
  // 0) /__dsweb-test/* — DSH's OWN endpoints (probe/status/report/sw-version/
  //    jar-import). The iframe document lives on origin https://chat.deepseek.com,
  //    so the injected reporter's relative fetch("/__dsweb-test/report") would
  //    resolve to chat.deepseek.com/__dsweb-test/... and 404. Rewrite to the DSH
  //    host and attach the shared sid.
  if (url.pathname.indexOf(SPA_PREFIX) === 0) {
    var localUrl = 'http://' + self.location.host + url.pathname + url.search;
    var fwdH = new Headers(req.headers);
    fwdH.delete('content-length');
    if (req.method === 'GET' || req.method === 'HEAD') {
      event.respondWith(
        fetch(withSid(localUrl), { method: req.method, headers: fwdH, credentials: 'include' }),
      );
    } else {
      // v6.5: forward POST bodies as a buffered ArrayBuffer — known length, no
      // duplex, no content-length conflict; the streaming-body + duplex path
      // kept failing with TypeError in the browser (login POSTs never reached
      // the proxy -> "网络异常").
      event.respondWith(
        req.clone().arrayBuffer().then(function (buf) {
          return fetch(withSid(localUrl), {
            method: req.method,
            headers: fwdH,
            credentials: 'include',
            body: buf,
          });
        }),
      );
    }
    return;
  }
  // 1) absolute *.deepseek.com requests (and third-party captcha SDK hosts)
  var isDeep = DEEP.test(url.hostname) || EXTRA.test(url.hostname);
  // 2) SPA-RELATIVE requests made from inside our iframe (e.g. fetch("/api/v0/..."),
  //    dynamic chunk "/chat/static/87321.js") resolve to this origin (127.0.0.1) —
  //    route them through the proxy. v6.2: a client is the SPA if it registered
  //    via 'dsw-spa' (survives the SPA routing away from /__dsweb-test/), with
  //    the referrer check kept as a fallback for the very first load.
  var isSpaRelative =
    url.origin === self.location.origin &&
    url.pathname.indexOf(SPA_PREFIX) !== 0 &&
    (SPA_CLIENTS[event.clientId] ||
      (req.referrer && req.referrer.indexOf(SPA_PREFIX) >= 0));
  if (isDeep || isSpaRelative) {
    var target = isDeep
      ? url.toString()
      : (url.pathname.indexOf(API_PREFIX) === 0 ? APP_HOST : CDN_HOST) + url.pathname + url.search;
    var proxy = withSid('/__dsweb-test/proxy?u=' + encodeURIComponent(target));
    var fwdH2 = new Headers(req.headers);
    fwdH2.delete('content-length');
    if (req.method === 'GET' || req.method === 'HEAD') {
      event.respondWith(
        fetch(proxy, { method: req.method, headers: fwdH2, redirect: 'follow', credentials: 'include' }),
      );
    } else {
      // v6.5: buffered ArrayBuffer body (see rule-0 comment) — the streaming
      // body + duplex path failed in the browser, so login POSTs never reached
      // the proxy ("网络异常").
      event.respondWith(
        req.clone().arrayBuffer().then(function (buf) {
          return fetch(proxy, {
            method: req.method,
            headers: fwdH2,
            redirect: 'follow',
            credentials: 'include',
            body: buf,
          });
        }),
      );
    }
    return;
  }
  // Network passthrough for EVERYTHING else (incl. same-origin navigations).
  // Critical: a navigation that the SW does NOT respond to produces a document
  // that is NOT controlled by the SW — and only controlled clients get their
  // deepseek requests intercepted. Responding here makes the iframe a
  // controlled client, which is what routes its runtime /api through the proxy.
  // v6.4: fetch(req) on a NAVIGATION request (mode 'navigate') is a NETWORK
  // ERROR per the Fetch spec — so once the SW controlled the DSH page, every
  // page refresh / location.reload went blank with no console error. For
  // navigations, construct a fresh same-origin Request instead.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(new Request(req.url, { method: req.method, credentials: 'include', redirect: 'follow' })),
    );
    return;
  }
  event.respondWith(fetch(req));
});
`

export function apply(ctx) {
  ctxLogger = ctx.logger
  loadJar()
  loadAssetCache()
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: '/__dsweb-test',
      handler: async (req, res) => {
        try {
          if (!isSameOrigin(req)) {
            res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('forbidden: cross-origin')
            return
          }
          const url = new URL(req.url ?? '/', 'http://localhost')
          const pathname = url.pathname

          // Phase 4: Service Worker script (scope '/').
          if (pathname === '/__dsweb-test/sw.js') {
            res.writeHead(200, {
              'content-type': 'text/javascript; charset=utf-8',
              'service-worker-allowed': '/',
              'cache-control': 'no-store',
            })
            res.end(SW_SOURCE)
            return
          }

          // Phase 4: same-origin reverse proxy for the iframe + SW.
          if (pathname === '/__dsweb-test/proxy') {
            await handleProxy(req, res, url)
            return
          }

          // Phase 5.7: current SW version (so the client can detect a stale SW).
          if (pathname === '/__dsweb-test/sw-version') {
            sendJson(res, 200, { version: SW_VERSION })
            return
          }

          // Phase 5.8.4: collect JS errors from inside the iframe (relayed by
          // the injected reporter script). Shown on the status page so a silent
          // SPA stall (captcha ok -> no login request) becomes diagnosable.
          // v6.9: accepts GET (query) too — the injected reporter now uses GET
          // because POST forwarding through older SWs failed (Content-Length +
          // stream body TypeError), which made every diagnostic report vanish.
          if (pathname === '/__dsweb-test/report') {
            if (req.method === 'POST') {
              const raw = (await readBody(req)).toString('utf8')
              pageErrors.push({ ts: Date.now(), raw: raw.slice(0, 500) })
              if (pageErrors.length > 50) pageErrors.shift()
            } else if (req.method === 'GET' && url.searchParams.get('msg')) {
              pageErrors.push({ ts: Date.now(), raw: url.searchParams.get('msg').slice(0, 500) })
              if (pageErrors.length > 50) pageErrors.shift()
            }
            sendJson(res, 200, { ok: true, count: pageErrors.length })
            return
          }

          // Phase 7: import DeepSeek cookies into the jar (manual fallback when
          // the user logs in on the real chat.deepseek.com in their own browser
          // — paste document.cookie from that page). Keyed under the SW-shared
          // sid (appended by the SW to every /__dsweb-test request), so the
          // iframe picks the session up on its next reload.
          if (pathname === '/__dsweb-test/jar-import') {
            if (req.method !== 'POST') {
              sendJson(res, 405, { ok: false, error: 'POST only' })
              return
            }
            const raw = (await readBody(req)).toString('utf8')
            let cookies = raw
            const m = raw.match(/^cookies=(.*)$/s)
            if (m) {
              try {
                cookies = decodeURIComponent(m[1])
              } catch {
                /* keep raw */
              }
            }
            const sid =
              url.searchParams.get('sid') || parseSid(req.headers.cookie) || randomUUID()
            const merged = new Map()
            const prev = cookieJar.get(sid)
            if (prev)
              for (const c of prev.split('; ')) {
                const i = c.indexOf('=')
                if (i > 0) merged.set(c.slice(0, i), c)
              }
            for (const c of cookies.split(';')) {
              const pair = c.trim()
              const i = pair.indexOf('=')
              if (i > 0) merged.set(pair.slice(0, i), pair)
            }
            cookieJar.set(sid, [...merged.values()].join('; '))
            scheduleJarSave()
            sendJson(res, 200, { ok: true, imported: merged.size, sid })
            return
          }

          // Phase 5: server self-check for the UI / human review.
          if (pathname === '/__dsweb-test/status') {
            let selfOk = false
            try {
              const probe = await fetch(
                'http://' + (req.headers.host || '127.0.0.1:8081') + '/__dsweb-test/sw-version',
              )
              selfOk = probe.ok
            } catch {
              selfOk = false
            }
            const curSid = url.searchParams.get('sid') || parseSid(req.headers.cookie)
            sendJson(res, 200, {
              ok: true,
              swScript: true,
              swVersion: SW_VERSION,
              proxySelfOk: selfOk,
              allowlist: {
                deepseekAllowed: isAllowedTarget('https://chat.deepseek.com', req.headers.host),
                exampleBlocked: !isAllowedTarget('https://example.com', req.headers.host),
              },
              jarSessions: cookieJar.size,
              jarFile: JAR_FILE,
              lastJarSave,
              currentSid: curSid || null,
              jarCookieNames: curSid && cookieJar.get(curSid) ? cookieJar.get(curSid).split('; ').map((c) => c.split('=')[0]) : [],
              proxyHits,
              waf429,
              spaFallbackRetries,
              wechatDebug,
              pageErrors: pageErrors.slice(-10),
              statusHist,
              recent: proxyLog.slice(-30),
              ts: Date.now(),
            })
            return
          }

          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('not found')
        } catch (err) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('plugin error: ' + (err && err.stack ? err.stack : String(err)))
        }
      },
    })
    ctx.logger?.info?.('[dsh-deepseek-web] registered /__dsweb-test prefix route (+proxy+sw+status)')
    return () => dispose()
  }, 'dsh-deepseek-web: proxy/sw/status routes')
}
