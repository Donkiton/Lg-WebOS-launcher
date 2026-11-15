'use strict';
var crypto = require('crypto');
var version = 'lg-gate-portal-lazy-v2';
var pinned = '09e68bebafffae55ebbd8b6eb6544a9eb4c7fe938147c99b7f011cf7f494e13f';
// Exact reviewed profiles. Unknown assets must not receive guessed replacements.
var profiles = [
  {
    "sha256": "f41602fbed51545c6ff86863ca6fb4c45fc391843e1272c3faae4eb3b853e7e5",
    "component": "Oy",
    "react": "qe",
    "jsx": "Dd",
    "styles": "Ny",
    "classes": "mN",
    "stub": false,
    "image": "Oy=({src:e,fallbackSrc:t=\"/assets/logoForCover.png\",alt:n,className:r,fallBackClassName:o,setHasBackground:i,isLazy:a=!0})=>{const l=Boolean(e),[s,u]=(0,qe.useState)(l?e:t),[c,d]=(0,qe.useState)(!l);return(0,Dd.jsx)(\"img\",{src:s,onError:()=>{u(t),d(!0),null==i||i(!1)},sizes:\"auto\",alt:n,className:mN(r,Ny.image,{[Ny.imageError]:c,[null!=o?o:\"\"]:c&&o}),loading:a?\"lazy\":\"eager\"})}",
    "studio": "(0,Dd.jsx)(\"img\",{src:`/assets/studios/${t}.webp`,className:rb.image,alt:e,loading:\"lazy\"})",
    "genre": "(0,Dd.jsx)(\"img\",{src:`/assets/genres/${t}.webp`,className:lb.image,alt:e,loading:\"lazy\"})",
    "studioStyles": "rb",
    "genreStyles": "lb"
  },
  {
    "sha256": "09e68bebafffae55ebbd8b6eb6544a9eb4c7fe938147c99b7f011cf7f494e13f",
    "component": "ub",
    "react": "Ve",
    "jsx": "nf",
    "styles": "lb",
    "classes": "gN",
    "stub": true,
    "image": "ub=({src:e,fallbackSrc:t=ws,alt:n,className:r,fallBackClassName:o,setHasBackground:i,isLazy:a=!0})=>{const s=Boolean(e),[l,u]=(0,Ve.useState)(s?e:t),[c,d]=(0,Ve.useState)(!s),f=c&&\"/assets/logoForCover.png\"===t;return(0,nf.jsx)(\"img\",{src:f?\"data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7\":l,onError:()=>{u(t),d(!0),null==i||i(!1)},sizes:\"auto\",alt:n,className:gN(r,lb.image,{[lb.imageError]:c,[lb.imageStub]:f,[null!=o?o:\"\"]:c&&o}),style:f?{backgroundImage:`url(${ws})`}:void 0,loading:a?\"lazy\":\"eager\"})}",
    "studio": "(0,nf.jsx)(\"img\",{src:`/assets/studios/${t}.webp`,className:Mb.image,alt:e,loading:\"lazy\"})",
    "genre": "(0,nf.jsx)(\"img\",{src:`/assets/genres/${t}.webp`,className:Ub.image,alt:e,loading:\"lazy\"})",
    "studioStyles": "Mb",
    "genreStyles": "Ub"
  }
];

// This function is serialized into the page. Keep it ES5 and independent of
// Node/modules, IntersectionObserver and native loading="lazy" support.
function installPortalImages(w, d) {
  'use strict';
  var name = '__lgGatePortalImagesV1';
  var version = 'lg-gate-portal-lazy-v2';
  if (w[name]) {
    if (w[name].version !== version) throw new Error('Portal image scheduler version mismatch');
    return;
  }
  var entries = [];
  var listening = false;
  var frame = null;
  var registered = 0, released = 0, cancelled = 0;
  var raf = typeof w.requestAnimationFrame === 'function';
  function visible(node) {
    if (d.hidden === true || d.visibilityState === 'hidden' || d.visibilityState === 'prerender') return false;
    if (!node || !d.documentElement.contains(node)) return false;
    var rect = node.getBoundingClientRect();
    var left = Math.max(0, rect.left), top = Math.max(0, rect.top);
    var right = Math.min(w.innerWidth || d.documentElement.clientWidth, rect.right);
    var bottom = Math.min(w.innerHeight || d.documentElement.clientHeight, rect.bottom);
    if (right <= left || bottom <= top) return false;
    for (var parent = node; parent && parent.nodeType === 1; parent = parent.parentElement) {
      var style = w.getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
      if (parent !== node) {
        var x = style.overflowX || style.overflow;
        var y = style.overflowY || style.overflow;
        if (/^(hidden|scroll|auto|clip)$/.test(x) || /^(hidden|scroll|auto|clip)$/.test(y)) {
          var clip = parent.getBoundingClientRect();
          if (/^(hidden|scroll|auto|clip)$/.test(x)) { left = Math.max(left, clip.left); right = Math.min(right, clip.right); }
          if (/^(hidden|scroll|auto|clip)$/.test(y)) { top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom); }
          if (right <= left || bottom <= top) return false;
        }
      }
    }
    return true;
  }
  function detachIfEmpty() {
    if (entries.length) return;
    if (listening) {
      d.removeEventListener('scroll', schedule, true);
      d.removeEventListener('visibilitychange', schedule, false);
      w.removeEventListener('resize', schedule, false);
      listening = false;
    }
    if (frame !== null) {
      if (raf) w.cancelAnimationFrame(frame); else w.clearTimeout(frame);
      frame = null;
    }
  }
  function remove(entry) {
    if (!entry.active) return;
    entry.active = false;
    var index = entries.indexOf(entry);
    if (index >= 0) entries.splice(index, 1);
    entry.node = null;
    entry.activate = null;
    detachIfEmpty();
  }
  function flush() {
    frame = null;
    var snapshot = entries.slice();
    for (var i = 0; i < snapshot.length; i++) {
      var entry = snapshot[i];
      if (entry.active && visible(entry.node)) {
        var activate = entry.activate;
        remove(entry);
        released++;
        activate();
      }
    }
  }
  function schedule() {
    if (entries.length && frame === null) frame = raf ? w.requestAnimationFrame(flush) : w.setTimeout(flush, 16);
  }
  function register(node, activate) {
    if (!node) return function () {};
    registered++;
    if (visible(node)) { released++; activate(); return function () {}; }
    var entry = { node: node, activate: activate, active: true };
    entries.push(entry);
    if (!listening) {
      d.addEventListener('scroll', schedule, true);
      d.addEventListener('visibilitychange', schedule, false);
      w.addEventListener('resize', schedule, false);
      listening = true;
    }
    schedule();
    return function () { if (entry.active) { cancelled++; remove(entry); } };
  }
  function normalize(address) {
    if (typeof address !== 'string') return address;
    var match = /^(?:https?:)?\/\/(img\d+\.zona(?:pic\.com|film\.ru))(?=\/|[?#]|$)(.*)$/i.exec(address);
    if (!match) return address;
    var suffix = match[2];
    if (suffix.charAt(0) !== '/') suffix = '/' + suffix;
    return w.location.protocol + '//' + w.location.host + '/__zona/img/' +
      match[1].toLowerCase().replace('zonafilm.ru', 'zonapic.com') + suffix;
  }
  w[name] = {
    version: version, register: register, refresh: schedule, normalize: normalize,
    stats: function () { return { pending: entries.length, listening: listening, scheduled: frame !== null,
      registered: registered, released: released, cancelled: cancelled }; }
  };
}

// Replacement of the actual portal Oy. Plain mode is used only by the two
// original studio/genre IMG producers; it retains their props and onError.
function PortalImage(props) {
  var plain = props.__lgGatePlain === true;
  var supportsStub = __LG_GATE_STUB__;
  var fallback = props.fallbackSrc === undefined ? '/assets/logoForCover.png' : props.fallbackSrc;
  var lazy = props.isLazy === undefined ? true : !!props.isLazy;
  var initial = plain ? props.src : (props.src || fallback);
  var modelPair = (0, qe.useState)(function () {
    return { input: props.src, fallback: fallback, plain: plain, value: initial, failed: !props.src, token: {} };
  });
  var model = modelPair[0], setModel = modelPair[1];
  if (model.input !== props.src || model.fallback !== fallback || model.plain !== plain) {
    model = { input: props.src, fallback: fallback, plain: plain, value: initial, failed: !props.src, token: {} };
    setModel(model);
  }
  var element = (0, qe.useRef)(null);
  var current = (0, qe.useRef)(model);
  current.current = model;
  var readyPair = (0, qe.useState)(lazy ? null : model.token);
  var ready = readyPair[0], setReady = readyPair[1];
  var hasSource = !!model.value;
  var deferred = lazy && hasSource && ready !== model.token;
  var scheduler = window.__lgGatePortalImagesV1;
  (0, qe.useEffect)(function () {
    if (!lazy) { if (ready !== model.token) setReady(model.token); return; }
    if (!hasSource || ready === model.token) return;
    var active = true, token = model.token;
    var cancel = scheduler.register(element.current, function () { if (active) setReady(token); });
    return function () { active = false; cancel(); };
  }, [lazy, hasSource, model.token, ready]);
  (0, qe.useEffect)(function () { if (deferred) scheduler.refresh(); });
  var source = hasSource && !deferred ? scheduler.normalize(model.value) : undefined;
  // Preserve the new upstream fallback presentation while gating both IMG
  // and CSS background requests with the same visibility decision.
  var stub = !plain && supportsStub && model.failed && fallback === '/assets/logoForCover.png';
  if (stub && !deferred) source = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  var imageProps;
  if (plain) {
    imageProps = {};
    for (var key in props) {
      if (Object.prototype.hasOwnProperty.call(props, key) && key !== '__lgGatePlain') imageProps[key] = props[key];
    }
  } else {
    var flags = {};
    flags[Ny.imageError] = model.failed;
    if (supportsStub) flags[Ny.imageStub] = stub;
    if (props.fallBackClassName) flags[props.fallBackClassName] = model.failed;
    var token = model.token;
    imageProps = {
      onError: function () {
        var latest = current.current;
        if (latest.token !== token) return;
        if (!latest.failed || latest.value !== fallback) {
          var next = { input: latest.input, fallback: latest.fallback, plain: false,
            value: fallback, failed: true, token: latest.value !== fallback ? {} : token };
          current.current = next;
          setModel(next);
        }
        if (typeof props.setHasBackground === 'function') props.setHasBackground(false);
      },
      sizes: 'auto', alt: props.alt, className: mN(props.className, Ny.image, flags), loading: lazy ? 'lazy' : 'eager'
    };
  }
  if (stub && !deferred) imageProps.style = { backgroundImage: 'url(/assets/logoForCover.png)' };
  imageProps.ref = element;
  imageProps.src = source;
  imageProps['data-lg-gate-image-deferred'] = deferred ? '1' : undefined;
  return (0, Dd.jsx)('img', imageProps);
}

function replaceOnce(source, before, after, label) {
  if (source.split(before).length !== 2) throw new Error('Portal image anchor mismatch: ' + label);
  return source.replace(before, after);
}
function profileFor(source) {
  if (typeof source !== 'string') return null;
  var digest = crypto.createHash('sha256').update(source, 'utf8').digest('hex');
  for (var i = 0; i < profiles.length; i++) if (profiles[i].sha256 === digest) return profiles[i];
  return null;
}
function componentFor(profile) {
  return PortalImage.toString().replace(/\bqe\b/g, profile.react).replace(/\bNy\b/g, profile.styles)
    .replace(/\bmN\b/g, profile.classes).replace(/\bDd\b/g, profile.jsx)
    .replace('__LG_GATE_STUB__', profile.stub ? 'true' : 'false');
}
function plainProducer(profile, kind, styles) {
  return '(0,' + profile.jsx + '.jsx)(' + profile.component + ',{__lgGatePlain:true,src:"/assets/' + kind + '/"+t+".webp",className:' + styles + '.image,alt:e,loading:"lazy"})';
}
function patch(source) {
  var profile = profileFor(source);
  if (!profile) throw new Error('Pinned portal image asset SHA256 mismatch');
  if (profile.stub && source.split('ws="/assets/logoForCover.png"').length !== 2) throw new Error('Portal image anchor mismatch: default fallback');
  var result = replaceOnce(source, profile.image, profile.component + '=' + componentFor(profile), profile.component);
  result = replaceOnce(result, profile.studio, plainProducer(profile, 'studios', profile.studioStyles), 'studio');
  result = replaceOnce(result, profile.genre, plainProducer(profile, 'genres', profile.genreStyles), 'genre');
  return '/* ' + version + ' */\n(' + installPortalImages.toString() + ')(window,document);\n/* lg-gate-portal-scheduler-end */\n' + result;
}

exports.patch = patch;
exports.version = version;
exports.pinnedUpstreamSha256 = pinned;
exports.supportedUpstreamSha256 = profiles.map(function (profile) { return profile.sha256; });
