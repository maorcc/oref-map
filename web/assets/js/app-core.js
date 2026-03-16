'use strict';

// App structure:
// 1) Config + API helpers
// 2) Map state + rendering primitives
// 3) Live/history ingestion
// 4) Panel features (sound, stats, timeline)
// 5) Bootstrapping + global event wiring

// --- Config ---
// Set PROXY_BASE to the Cloudflare Worker URL for production, e.g.:
//   var PROXY_BASE = 'https://oref-proxy.YOUR_ACCOUNT.workers.dev';
var PROXY_BASE = '';
var apiPrefix = '/api'; // Pages Function; switches to '/api2' (Worker) if non-TLV

function apiFetch(endpoint) {
  return fetch(PROXY_BASE + apiPrefix + '/' + endpoint).then(function(resp) {
    if (apiPrefix === '/api' && resp.url && resp.url.indexOf('/api2/') !== -1) {
      console.log('Non-TLV colo detected, switching to /api2');
      apiPrefix = '/api2';
    }
    return resp;
  });
}
var LIVE_POLL_MS = 1000;
var HISTORY_POLL_MS = 10000;
var GREEN_FADE_MS = 120000; // 2 minutes
var ALERT_MAX_AGE_MS = 3600000; // 1 hour — safety net for stuck alerts
var FADE_TICK_MS = 1000;

// --- Map setup ---
var DEFAULT_CENTER = [31.6, 34.8], DEFAULT_ZOOM = 8;
var map = L.map('map', { preferCanvas: true }).setView(DEFAULT_CENTER, DEFAULT_ZOOM);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors',
  maxZoom: 18
}).addTo(map);

// --- User location ---
var userLocationMarker = null;

function initUserLocation() {
  var btn = document.getElementById('location-btn');
  var btnText = btn.querySelector('.btn-text');
  if (!navigator.geolocation) { btn.style.display = 'none'; return; }

  var icon = L.divIcon({
    html: '<span style="display:block;width:14px;height:14px;background:#4285F4;border:3px solid #fff;border-radius:50%;box-shadow:0 0 6px rgba(66,133,244,0.6);"></span>',
    className: '',
    iconSize: [20, 20],
    iconAnchor: [10, 10]
  });

  var watchId = null;
  var transientTimeout = null;

  function setIdle() {
    btnText.textContent = 'הראה אותי';
    btnText.style.display = '';
    btn.title = 'הצג מיקום שלי על המפה';
  }

  function setActive() {
    if (transientTimeout) { clearTimeout(transientTimeout); transientTimeout = null; }
    btnText.textContent = '';
    btnText.style.display = 'none';
    btn.title = 'הסר מיקום מהמפה';
  }

  function setTransient(msg) {
    if (transientTimeout) { clearTimeout(transientTimeout); transientTimeout = null; }
    btnText.style.display = '';
    btnText.textContent = msg;
    transientTimeout = setTimeout(function() { transientTimeout = null; setIdle(); }, 3000);
  }

  function showToast(msg) {
    var el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.8);color:#fff;padding:10px 20px;border-radius:8px;font-size:14px;z-index:1001;direction:rtl;text-align:center;animation:toastFade 3s forwards;pointer-events:none;';
    document.body.appendChild(el);
    setTimeout(function() { el.remove(); }, 3000);
  }

  function stopWatching() {
    if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
    if (userLocationMarker) { map.removeLayer(userLocationMarker); userLocationMarker = null; }
  }

  function startWatching() {
    if (watchId !== null) return;
    watchId = navigator.geolocation.watchPosition(function(pos) {
      var latlng = [pos.coords.latitude, pos.coords.longitude];
      if (!isInIsrael(latlng)) {
        stopWatching();
        setTransient('בעיית GPS');
        return;
      }
      if (!userLocationMarker) {
        userLocationMarker = L.marker(latlng, {
          icon: icon,
          interactive: false,
          zIndexOffset: 1000
        }).addTo(map);
        showToast('מראה מיקום על המפה');
      } else {
        userLocationMarker.setLatLng(latlng);
      }
      setActive();
    }, function(err) {
      console.warn('Geolocation error:', err.code, err.message);
      if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
      setTransient('שגיאה בקבלת מיקום');
    }, { enableHighAccuracy: false, maximumAge: 30000 });
  }

  if (navigator.permissions) {
    navigator.permissions.query({ name: 'geolocation' }).then(function(result) {
      if (result.state === 'granted' && localStorage.getItem('oref-location-hidden') !== 'true') {
        startWatching();
      }
    }).catch(function() {});
  }

  document.getElementById('location-btn-row').addEventListener('click', function() {
    if (watchId !== null || userLocationMarker) {
      stopWatching();
      showToast('מיקום הוסר מהמפה');
      setIdle();
      localStorage.setItem('oref-location-hidden', 'true');
    } else {
      setTransient('מאתר...');
      startWatching();
      localStorage.removeItem('oref-location-hidden');
    }
  });
}

initUserLocation();

document.getElementById('locate-btn').addEventListener('click', function() {
  maybeZoomToEvent();
});

// --- State ---
var locationStates = {};       // {name: {state, since, marker}}
var locationHistory = {};      // {name: [{title, alertDate, state}, ...]}
var lastHistoryDate = null;    // track newest history entry
var liveErrors = 0;
var historyErrors = 0;
var lastErrorMsg = '';
var lastCfColo = '';
var lastDangerTime = 0;
var initialized = false;
var soundMuted = true;
var soundLocation = 'all';
var audioCtx = null;
var lastSoundTime = 0;
var dangerBuffer = null;

try {
  soundMuted = localStorage.getItem('oref-sound-muted') !== 'false';
  soundLocation = localStorage.getItem('oref-sound-location') || 'all';
} catch(e) {}

// --- Timeline state ---
var extendedHistory = [];     // sorted ascending by alertDate ms
var extendedRids = new Set(); // dedup by rid

var timelineMin = 0;
var timelineMax = 0;
var isLiveMode = true;
var isPlaying = false;
var playRAF = null;
var currentViewTime = 0;
var liveLocationStates = null; // shadow copy of live state
var closeTimelinePanel = function() {}; // set by initTimeline
var openTimelineToLastEvent = function() {}; // set by initTimeline
var currentTimelineDay = null; // track currently selected day in timeline

// --- Stats mode state ---
var isStatsMode = false;
var statsCounts = {}; // name -> count
var maxStatsCount = 0;

// --- Panel history (mobile back button closes panels) ---
var panelHistoryPushed = false;
function pushPanelHistory() {
  if (!panelHistoryPushed) {
    history.pushState({ panel: true }, '');
    panelHistoryPushed = true;
  }
}
function popPanelHistory() {
  if (panelHistoryPushed) {
    panelHistoryPushed = false;
    history.back();
  }
}

// --- Polygon state ---
var locationPolygons = {};  // name → L.polygon

// --- Colors ---
var COLORS = { red: '#ff0000', purple: '#9922cc', yellow: '#ffcc00', green: '#00cc00' };
var BASE_STYLE = { fillColor: '#888', fillOpacity: 0.01, color: '#888', opacity: 0 };

// --- Sound ---
function getAudioContext() {
  if (!audioCtx) {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (AC) audioCtx = new AC();
  }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function playDangerSound() {
  var ctx = getAudioContext();
  if (!ctx) return;

  function playSineHalf(startTime) {
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, startTime);
    osc.frequency.linearRampToValueAtTime(440, startTime + 0.3);
    gain.gain.setValueAtTime(0.3, startTime);
    gain.gain.linearRampToValueAtTime(0, startTime + 0.3);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(startTime);
    osc.stop(startTime + 0.3);
  }

  function playSequence(buffer) {
    var half = buffer.duration / 2;
    var now = ctx.currentTime;
    // 1. First half
    var s1 = ctx.createBufferSource();
    s1.buffer = buffer;
    s1.connect(ctx.destination);
    s1.start(now, 0, half);
    // 2. Repeat first half
    var s2 = ctx.createBufferSource();
    s2.buffer = buffer;
    s2.connect(ctx.destination);
    s2.start(now + half, 0, half);
    // 3. Entire file
    var s3 = ctx.createBufferSource();
    s3.buffer = buffer;
    s3.connect(ctx.destination);
    s3.start(now + (half * 2));
  }

  function playFallback() {
    var now = ctx.currentTime;
    playSineHalf(now);
    playSineHalf(now + 0.4);
    playSineHalf(now + 0.8);
  }

  if (dangerBuffer) {
    playSequence(dangerBuffer);
  } else {
    fetch('mixkit-clear-announce-tones-2861.wav')
      .then(function(r) { 
        if (!r.ok) throw new Error('Fetch failed');
        return r.arrayBuffer(); 
      })
      .then(function(b) { return ctx.decodeAudioData(b); })
      .then(function(buffer) {
        dangerBuffer = buffer;
        playSequence(dangerBuffer);
      })
      .catch(function(err) { 
        console.error('Failed to play danger WAV, falling back to sine:', err);
        playFallback();
      });
  }
}

function playAllClearSound() {
  var ctx = getAudioContext();
  if (!ctx) return;
  // First tone: C5 (523 Hz)
  var osc1 = ctx.createOscillator();
  var gain1 = ctx.createGain();
  osc1.type = 'sine';
  osc1.frequency.value = 523;
  gain1.gain.setValueAtTime(0.25, ctx.currentTime);
  gain1.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.2);
  osc1.connect(gain1);
  gain1.connect(ctx.destination);
  osc1.start(ctx.currentTime);
  osc1.stop(ctx.currentTime + 0.2);
  // Second tone: E5 (659 Hz)
  var osc2 = ctx.createOscillator();
  var gain2 = ctx.createGain();
  osc2.type = 'sine';
  osc2.frequency.value = 659;
  gain2.gain.setValueAtTime(0.25, ctx.currentTime + 0.2);
  gain2.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.45);
  osc2.connect(gain2);
  gain2.connect(ctx.destination);
  osc2.start(ctx.currentTime + 0.2);
  osc2.stop(ctx.currentTime + 0.45);
}

function playSoundForState(state, locationName) {
  if (!initialized || soundMuted || !isLiveMode) return;

  // Filter by location if a specific one is selected
  if (soundLocation && soundLocation !== 'all' && locationName !== soundLocation) {
    return;
  }

  var now = Date.now();
  if (now - lastSoundTime < 500) return;
  lastSoundTime = now;
  if (state === 'green') {
    playAllClearSound();
  } else {
    playDangerSound();
  }
}

// --- Israel bounding box (for GPS validation) ---
function isInIsrael(latlng) {
  return latlng[0] >= 29.4 && latlng[0] <= 33.4 && latlng[1] >= 34.2 && latlng[1] <= 35.9;
}

// --- Build pre-computed polygons from locations_polygons.json ---
function buildPolygons(data) {
  for (var name in data) {
    var coords = data[name];
    if (!Array.isArray(coords)) continue;
    var isNested = Array.isArray(coords[0][0]);
    var latlngs;
    if (isNested) {
      // Polygon with holes: [[[outer]], [[hole1]], ...]
      latlngs = coords.map(function(ring) {
        return ring.map(function(c) { return [c[1], c[0]]; });
      });
    } else {
      // Simple polygon: [[lng,lat], ...]
      latlngs = coords.map(function(c) { return [c[1], c[0]]; });
    }
    var polygon = L.polygon(latlngs, {
      fillColor: '#888',
      fillOpacity: 0.01,
      color: '#888',
      opacity: 0,
      weight: 1,
      interactive: true
    }).addTo(map);
    polygon.bindTooltip(name, { direction: 'top', offset: [0, -20] });
    (function(n, poly) {
      poly.on('click', function() {
        if (document.body.classList.contains('has-overlay')) return;
        if (isStatsMode) return; // Disable standard popup in stats mode
        showPopup(n, poly);
      });
      poly.on('mouseover', function() {
        if (document.body.classList.contains('has-overlay')) return;
        if (isStatsMode) {
          poly.setStyle({ fillOpacity: 0.9, weight: 3 });
        } else {
          poly.setStyle(ACTIVE_STYLE);
        }
      });
      poly.on('mouseout', function() {
        if (isStatsMode) {
           poly.setStyle(getStatsStyle(n));
        } else {
           if (openPopupName === n) return;
           poly.setStyle(currentLocationStyle(n));
        }
      });
    })(name, polygon);
    locationPolygons[name] = polygon;
  }

  // ?debug: show all polygon outlines
  if (location.search.indexOf('debug') !== -1) {
    document.getElementById('test-danger-btn').style.display = 'block';
    document.getElementById('test-all-clear-btn').style.display = 'block';
    var debugStyle = document.createElement('style');
    debugStyle.textContent = '.leaflet-overlay-pane path { stroke: #555 !important; stroke-opacity: 1 !important; stroke-width: 1 !important; }';
    document.head.appendChild(debugStyle);
    for (var n in locationPolygons) {
      locationPolygons[n].setStyle({ fillOpacity: 0.05 });
    }
    L.rectangle([[29.4, 34.2], [33.4, 35.9]], { color: '#0000ff', weight: 2, fill: false }).addTo(map);
  }

  console.log('Loaded pre-computed polygons for', Object.keys(locationPolygons).length, 'locations');
}

function classifyTitle(title) {
  title = title.replace(/\s+/g, ' ').trim();

  // Green — all-clear / event over (fades out)
  if (title.includes('האירוע הסתיים') ||
      (title.includes('ניתן לצאת') && !title.includes('להישאר בקרבתו')) ||
      title.includes('החשש הוסר') ||
      title.includes('יכולים לצאת') ||
      title.includes('אינם צריכים לשהות') ||
      title.includes('סיום שהייה בסמיכות') ||
      title === 'עדכון') {
    return 'green';
  }

  // Yellow — early warning / preparedness / stay near shelter
  if (title === 'בדקות הקרובות צפויות להתקבל התרעות באזורך' ||
      title.includes('לשפר את המיקום למיגון המיטבי') ||
      title === 'יש לשהות בסמיכות למרחב המוגן' ||
      title.includes('להישאר בקרבתו')) {
    return 'yellow';
  }

  // Purple — drone infiltration
  if (title === 'חדירת כלי טיס עוין') {
    return 'purple';
  }

  // Red — active danger (missiles / non-conventional / terrorists / shelter now)
  if (title === 'ירי רקטות וטילים' ||
      title === 'נשק לא קונבנציונלי' ||
      title === 'חדירת מחבלים' ||
      title === 'היכנסו מייד למרחב המוגן' ||
      title === 'היכנסו למרחב המוגן') {
    return 'red';
  }

  console.warn('Unknown alert title:', title);
  return 'red'; // default to danger for unknown
}

// --- Marker management ---
function setLocationState(name, state, since) {
  var existing = locationStates[name];

  // Priority: red > purple > yellow. Green always overrides (all-clear).
  var PRIORITY = { red: 3, purple: 2, yellow: 1, green: 0 };
  if (existing) {
    if (state !== 'green') {
      if (existing.state === state) return;
      if ((PRIORITY[existing.state] || 0) > (PRIORITY[state] || 0)) return;
    } else if (existing.state === 'green') {
      return; // already green — don't reset the fade timer
    }
  }

  var polygon = locationPolygons[name] || null;
  if (!polygon) return;

  var now = Date.now();
  var opacity = state === 'green'
    ? 0.5 * Math.max(0, 1 - ((now - (since || now)) / GREEN_FADE_MS))
    : 0.3;
  polygon.setStyle({
    color: COLORS[state],
    fillColor: COLORS[state],
    fillOpacity: opacity,
    opacity: opacity + 0.15,
    weight: state === 'red' ? 0.5 : 1
  });
  locationStates[name] = {
    state: state,
    since: since || Date.now(),
    marker: polygon
  };

  playSoundForState(state, name);
}

function removeLocation(name) {
  var entry = locationStates[name];
  if (entry && entry.marker) {
    entry.marker.setStyle(BASE_STYLE);
    entry.marker.closePopup();
  }
  delete locationStates[name];
}

// --- Alert history per location ---
var openPopupName = null;
var openPopupMarker = null;

function updateOverlay() {
  var tlBtn = document.getElementById('timeline-btn');
  var statsBtn = document.getElementById('stats-btn');
  var panelOpen = document.getElementById('sound-btn').classList.contains('open') ||
    (tlBtn && tlBtn.classList.contains('open')) ||
    (statsBtn && statsBtn.classList.contains('open'));
  var popupOpen = openPopupName !== null;
  document.body.classList.toggle('has-overlay', panelOpen || popupOpen);
}

function recordHistory(name, title, alertDate, state) {
  if (!locationHistory[name]) locationHistory[name] = [];
  var ts = parseAlertDate(alertDate);
  // Skip entries older than 12 hours
  if (ts && Date.now() - ts > 12 * 60 * 60 * 1000) return;
  var arr = locationHistory[name];
  // Dedup: same title within 1 minute
  for (var i = 0; i < arr.length; i++) {
    if (arr[i].title === title) {
      var existingTs = parseAlertDate(arr[i].alertDate);
      if (ts && existingTs && Math.abs(ts - existingTs) <= 60000) return;
      if (!ts && !existingTs) return;
    }
  }
  arr.push({ title: title, alertDate: alertDate, state: state });
  // Refresh popup if it's open for this location
  if (openPopupName === name && openPopupMarker) {
    openPopupMarker.getPopup().setContent(buildPopupHtml(name));
  }
}

var TITLE_LABELS = {
  'ירי רקטות וטילים': 'אזעקת רקטות וטילים',
  'חדירת כלי טיס עוין': 'חדירת כטב״מ',
  'נשק לא קונבנציונלי': 'נשק לא קונבנציונלי',
  'חדירת מחבלים': 'חדירת מחבלים',
  'בדקות הקרובות צפויות להתקבל התרעות באזורך': 'תיתכן אזעקת טילים בדקות הקרובות',
  'היכנסו מייד למרחב המוגן': 'היכנסו מייד למרחב המוגן',
  'היכנסו למרחב המוגן': 'היכנסו למרחב המוגן',
  'על תושבי האזורים הבאים לשפר את המיקום למיגון המיטבי בקרבתך. במקרה של קבלת התרעה, יש להיכנס למרחב המוגן ולשהות בו עד להודעה חדשה.': 'שיפור מיקום למיגון מיטבי',
  'יש לשהות בסמיכות למרחב המוגן': 'שהייה בסמיכות למרחב המוגן',
  'ירי רקטות וטילים - האירוע הסתיים': 'רקטות וטילים - הסתיים',
  'חדירת כלי טיס עוין - האירוע הסתיים': 'כטב״מ - האירוע הסתיים',
  'ניתן לצאת מהמרחב המוגן': 'ניתן לצאת מהמרחב המוגן',
  'ניתן לצאת מהמרחב המוגן אך יש להישאר בקרבתו': 'ניתן לצאת מהמרחב המוגן',
  'חדירת מחבלים - החשש הוסר': 'חדירת מחבלים - החשש הוסר',
  'השוהים במרחב המוגן יכולים לצאת': 'ניתן לצאת מהמרחב המוגן',
  'האירוע הסתיים': 'האירוע הסתיים',
  'עדכון': 'ניתן לצאת מהמרחב המוגן',
};

function displayLabel(title) {
  var norm = (title || '').replace(/\s+/g, ' ').trim();
  if (TITLE_LABELS[norm]) return TITLE_LABELS[norm];
  var keys = Object.keys(TITLE_LABELS);
  for (var i = 0; i < keys.length; i++) {
    if (norm.includes(keys[i])) return TITLE_LABELS[keys[i]];
  }
  return '\u26A0 ' + norm;
}

function buildPopupHtml(name) {
  var entries = (locationHistory[name] || []).slice()
    .sort(function(a, b) { return (b.alertDate || '').replace('T', ' ').localeCompare((a.alertDate || '').replace('T', ' ')); });
  var rows = entries.map(function(e, i) {
    var color = COLORS[e.state] || '#888';
    var label = displayLabel(e.title);
    var time = e.alertDate ? e.alertDate.slice(11, 16) : '';
    var border = i < entries.length - 1 ? 'border-bottom:1px solid #eee;' : '';
    return '<div style="padding:4px 0;' + border + 'display:flex;align-items:baseline;gap:8px;direction:rtl">' +
      (time ? '<span style="color:' + color + ';font-size:12px;white-space:nowrap;font-weight:bold">' + time + '</span>' : '') +
      '<span style="color:#444;font-size:13px;flex:1;text-align:right">' + label + '</span>' +
    '</div>';
  }).join('');
  return '<div style="direction:rtl;width:min(360px,85vw);text-align:right"><b>' + name + '</b>' +
    (rows ? '<div style="margin-top:6px">' + rows + '</div>' : '<p style="color:#888;margin-top:6px">אין אירועים לאחרונה</p>') +
    '</div>';
}

var ACTIVE_STYLE = { fillOpacity: 0.5, opacity: 0.8, weight: 3 };

function getStatsStyle(name) {
    var count = statsCounts[name] || 0;
    if (count === 0) return BASE_STYLE;

    // heatmap from yellow to red depending on intensity
    var intensity = maxStatsCount > 0 ? (count / maxStatsCount) : 0;
    var r = 255;
    var g = Math.round(255 * (1 - intensity));
    var b = 0;
    var color = 'rgb(' + r + ',' + g + ',' + b + ')';

    return {
        fillColor: color,
        color: color,
        fillOpacity: 0.4 + (intensity * 0.4),
        opacity: 0.6 + (intensity * 0.4),
        weight: 1.5
    };
}

function currentLocationStyle(name) {
  if (isStatsMode) return getStatsStyle(name);

  var entry = locationStates[name];
  if (!entry) return BASE_STYLE;
  if (entry.state === 'green') {
    var opacity = 0.5 * Math.max(0, 1 - ((Date.now() - entry.since) / GREEN_FADE_MS));
    return { color: COLORS.green, fillColor: COLORS.green, fillOpacity: opacity, opacity: opacity + 0.15, weight: 1 };
  }
  return { color: COLORS[entry.state], fillColor: COLORS[entry.state], fillOpacity: 0.3, opacity: 0.45, weight: entry.state === 'red' ? 0.5 : 1 };
}

function showPopup(name, marker) {
  openPopupName = name;
  openPopupMarker = marker;
  marker.setStyle(ACTIVE_STYLE);
  marker.bindPopup(buildPopupHtml(name), { maxWidth: 350 })
    .openPopup()
    .on('popupclose', function() {
      openPopupName = null; openPopupMarker = null;
      marker.setStyle(currentLocationStyle(name));
      updateOverlay();
    });
  updateOverlay();
}

// --- Polygon pulse hint (mobile) ---
function showPolygonHint() {
  // Collect all currently colored polygons and those with recent history
  var targets = []; // [{polygon, name, color, origStyle}]

  for (var name in locationStates) {
    var entry = locationStates[name];
    var polygon = locationPolygons[name];
    if (!polygon) continue;
    var op = entry.state === 'green'
      ? 0.5 * Math.max(0, 1 - ((Date.now() - entry.since) / GREEN_FADE_MS))
      : 0.3;
    targets.push({
      polygon: polygon,
      color: COLORS[entry.state],
      origStyle: { color: COLORS[entry.state], fillColor: COLORS[entry.state], fillOpacity: op, opacity: op + 0.15, weight: entry.state === 'red' ? 0.5 : 1 }
    });
  }

  // Also include recently-faded polygons with history but no active state
  if (targets.length === 0) {
    for (var hName in locationHistory) {
      if (locationHistory[hName].length > 0 && !locationStates[hName]) {
        var hPoly = locationPolygons[hName];
        if (hPoly) {
          targets.push({ polygon: hPoly, color: COLORS.green, origStyle: BASE_STYLE });
        }
      }
    }
  }

  if (targets.length === 0) return;

  var step = 0, totalSteps = 30; // 3 cycles * 10 steps per cycle
  var interval = setInterval(function() {
    var t = (step % 10) / 10;
    var opacity = 0.05 + 0.15 * Math.sin(t * Math.PI);
    for (var i = 0; i < targets.length; i++) {
      targets[i].polygon.setStyle({
        fillColor: targets[i].color, fillOpacity: opacity,
        color: targets[i].color, opacity: Math.min(opacity + 0.15, 0.8), weight: 2
      });
    }
    step++;
    if (step >= totalSteps) {
      clearInterval(interval);
      for (var j = 0; j < targets.length; j++) {
        targets[j].polygon.setStyle(targets[j].origStyle);
      }
    }
  }, 100);
}

// --- Process alerts ---
function processLiveAlert(alert) {
  if (!alert || !alert.data || !alert.title) return;
  var title = (alert.desc || alert.title).replace(/\s+/g, ' ').trim();
  var state = classifyTitle(title);
  if (state !== 'green') lastDangerTime = Date.now();
  var locations = alert.data;
  if (!Array.isArray(locations)) return;
  var now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  for (var i = 0; i < locations.length; i++) {
    var loc = locations[i];
    recordHistory(loc, title, now, state);
    if (isLiveMode && !isStatsMode) {
      setLocationState(loc, state);
    } else if (liveLocationStates) {
      updateShadowState(loc, state);
    }
  }
}

// Expose for debugging/external injection
window.injectAlert = function(mockAlert) {
  console.log('Injecting mock alert:', mockAlert);
  processLiveAlert(mockAlert);
};

function processHistoryEntry(entry) {
  if (!entry || !entry.data || !entry.title) return;
  var title = entry.title.replace(/\s+/g, ' ').trim();
  var state = classifyTitle(title);
  // History `data` is a string (single location)
  var location = (typeof entry.data === 'string' ? entry.data : String(entry.data)).trim();
  var since = parseAlertDate(entry.alertDate) || Date.now();
  if (state !== 'green' && since > lastDangerTime) lastDangerTime = since;
  recordHistory(location, title, entry.alertDate || '', state);

  // Also feed into extendedHistory for timeline
  var key = location + '|' + (entry.alertDate || '');
  if (!extendedRids.has(key) && since) {
    extendedRids.add(key);
    extendedHistory.push({ location: location, title: title, alertDate: since, state: state, category_desc: title });
    // Update global bounds but wait for panel open to re-render timeline day
    timelineMin = timelineMin ? Math.min(timelineMin, since) : since;
    timelineMax = Math.max(timelineMax, since, Date.now());
  }

  // Skip expired green markers — dont briefly flash old all-clears on page load
  var expired = state === 'green' && (Date.now() - since) >= GREEN_FADE_MS;
  if (isLiveMode && !isStatsMode) {
    if (expired) {
      if (locationStates[location]) removeLocation(location);
    } else {
      setLocationState(location, state, since);
    }
  } else if (liveLocationStates) {
    if (expired) {
      delete liveLocationStates[location];
    } else {
      updateShadowState(location, state, since);
    }
  }
}

// --- Green fade-out ---
function fadeGreenMarkers() {
  if (!isLiveMode || isStatsMode) return;
  var now = Date.now();
  var toRemove = [];
  for (var name in locationStates) {
    var entry = locationStates[name];
    if (entry.state !== 'green') {
      if (now - entry.since >= ALERT_MAX_AGE_MS) toRemove.push(name);
      continue;
    }
    var elapsed = now - entry.since;
    if (elapsed >= GREEN_FADE_MS) {
      toRemove.push(name);
    } else {
      var opacity = 0.5 * (1 - elapsed / GREEN_FADE_MS);
      entry.marker.setStyle({ fillOpacity: opacity, opacity: opacity + 0.15 });
    }
  }
  for (var i = 0; i < toRemove.length; i++) {
    removeLocation(toRemove[i]);
  }
  if (toRemove.length > 0) updateLiveStatus();
}

function formatRelativeTime(ts) {
  if (!ts) return '';
  var diffMs = Date.now() - ts;
  if (diffMs < 0) diffMs = 0;
  var mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'לפני פחות מדקה';
  if (mins < 60) return 'לפני ' + mins + ' דקות';
  var hours = Math.floor(mins / 60);
  if (hours < 24) return 'לפני ' + hours + ' שעות';
  return '';
}

function getActiveEventBounds() {
  var allBounds = null;
  for (var name in locationStates) {
    if (locationStates[name].state === 'green') continue;
    var polygon = locationPolygons[name];
    if (!polygon) continue;
    if (!allBounds) {
      allBounds = L.latLngBounds(polygon.getBounds());
    } else {
      allBounds.extend(polygon.getBounds());
    }
  }
  return allBounds;
}

function maybeZoomToEvent() {
  var bounds = getActiveEventBounds();
  if (bounds) {
    map.flyToBounds(bounds, { padding: [80, 80], maxZoom: 10, duration: 0.7 });
  } else {
    map.flyTo(DEFAULT_CENTER, DEFAULT_ZOOM, { duration: 0.7 });
  }
}


function updateLiveStatus() {
  if (!isLiveMode || isStatsMode) return;
  var dominant = null, bestP = -1;
  var P = { red: 3, purple: 2, yellow: 1 };
  for (var name in locationStates) {
    var s = locationStates[name].state;
    if (s !== 'green' && (P[s] || 0) > bestP) {
      bestP = P[s] || 0;
      dominant = s;
    }
  }
  if (dominant) {
    setStatus(dominant, 'התרעות פעילות');
  } else {
    var rel = formatRelativeTime(lastDangerTime);
    if (rel) {
      setStatusHTML('green', 'אין כרגע התרעות<br><a href="#" id="lastAlertLink">התרעה אחרונה ' + rel + '</a>');
    } else {
      setStatus('green', 'אין התרעות פעילות');
    }
  }
}

// --- Status indicator ---
function setStatus(state, text) {
  var dot = document.getElementById('statusDot');
  var txt = document.getElementById('statusText');
  var statusEl = document.getElementById('status');
  dot.className = 'indicator indicator-' + state;
  txt.textContent = text;
  if (state !== 'err') {
    statusEl.style.cursor = '';
    lastErrorMsg = '';
    document.getElementById('errorDetail').style.display = 'none';
  } else {
    statusEl.style.cursor = 'pointer';
  }
}

function setStatusHTML(state, html) {
  var dot = document.getElementById('statusDot');
  var txt = document.getElementById('statusText');
  var statusEl = document.getElementById('status');
  dot.className = 'indicator indicator-' + state;
  txt.innerHTML = html;
  var link = document.getElementById('lastAlertLink');
  if (link) {
    link.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      openTimelineToLastEvent();
    });
  }
  statusEl.style.cursor = '';
  lastErrorMsg = '';
  document.getElementById('errorDetail').style.display = 'none';
}

// --- Fetching ---
function stripBom(text) {
  return text.replace(/^\ufeff/, '');
}

function fetchLiveAlerts() {
  apiFetch('alerts')
    .then(function(resp) {
      lastCfColo = resp.headers.get('X-CF-Colo') || lastCfColo;
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return resp.text();
    })
    .then(function(text) {
      text = stripBom(text).trim();
      liveErrors = 0;
      try { sessionStorage.setItem('oref-last-poll', String(Date.now())); } catch(e) {}
      if (initialized && isLiveMode && !isStatsMode && historyErrors <= 3) updateLiveStatus();
      if (!text) return; // no active alert
      var alert;
      try { alert = JSON.parse(text); }
      catch (e) { console.warn('Live JSON parse failed (' + text.length + ' chars), payload:', JSON.stringify(text), e); return; }
      processLiveAlert(alert);
    })
    .catch(function(err) {
      liveErrors++;
      lastErrorMsg = 'Live alerts: ' + err.message;
      if (liveErrors > 3 && !isStatsMode) {
        setStatus('err', 'בעיית תקשורת לפיקוד העורף. מנסה שוב...');
      }
      console.error('Live poll error:', err);
    });
}

function processHistoryEntries(entries) {
  if (!Array.isArray(entries)) return;

  entries.sort(function(a, b) {
    return (a.alertDate || '').localeCompare(b.alertDate || '');
  });

  var newEntries = 0;
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var alertDate = entry.alertDate || '';
    if (lastHistoryDate && alertDate <= lastHistoryDate) continue;
    processHistoryEntry(entry);
    newEntries++;
  }

  if (entries.length > 0) {
    lastHistoryDate = entries[entries.length - 1].alertDate || lastHistoryDate;
  }

  if (newEntries > 0) {
    console.log('History: processed', newEntries, 'new entries');
  }
}

function fetchHistory(onDone) {
  apiFetch('history')
    .then(function(resp) {
      lastCfColo = resp.headers.get('X-CF-Colo') || lastCfColo;
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return resp.text();
    })
    .then(function(text) {
      text = stripBom(text).trim();
      historyErrors = 0;
      if (initialized && isLiveMode && !isStatsMode && liveErrors <= 3) updateLiveStatus();
      if (!text) { if (onDone) onDone(); return; }
      var entries;
      try {
        entries = JSON.parse(text);
      } catch (parseErr) {
        console.warn('History JSON truncated (' + text.length + ' chars), retrying...', parseErr);
        return fetch(PROXY_BASE + apiPrefix + '/history', { cache: 'no-store' })
          .then(function(r) { return r.text(); })
          .then(function(t) {
            t = stripBom(t).trim();
            try { entries = JSON.parse(t); }
            catch (e) { console.error('History retry also failed (' + t.length + ' chars):', e); throw e; }
            processHistoryEntries(entries);
            if (onDone) onDone();
          });
      }
      processHistoryEntries(entries);
      if (onDone) onDone();
    })
    .catch(function(err) {
      historyErrors++;
      lastErrorMsg = 'Alert history: ' + err.message;
      if (historyErrors > 3 && !isStatsMode) {
        setStatus('err', 'תקלה בטעינת התרעות קודמות. מנסה שוב...');
      }
      console.error('History fetch error:', err);
      if (onDone) onDone();
    });
}

function parseAlertDate(dateStr) {
  // Format: "2026-03-03 12:34:56"
  if (!dateStr) return null;
  var d = new Date(dateStr.replace(' ', 'T'));
  return isNaN(d.getTime()) ? null : d.getTime();
}

function formatDateForApi(dateObj) {
  var dd = String(dateObj.getDate()).padStart(2, '0');
  var mm = String(dateObj.getMonth() + 1).padStart(2, '0');
  var yyyy = dateObj.getFullYear();
  return dd + '.' + mm + '.' + yyyy;
}

// --- Extended history (timeline & stats) ---
function fetchExtendedHistory(fromDateObj, toDateObj, onDone, mode, options) {
  options = options || {};
  var apiPath = 'alarms-history';

  // If mode is specified (1, 2, 3), use it
  if (mode && mode !== '0') {
    apiPath += '?mode=' + mode;
  } else if (fromDateObj && toDateObj) {
    // Custom date range (mode 0)
    var dStrFrom = formatDateForApi(fromDateObj);
    var dStrTo = formatDateForApi(toDateObj);
    apiPath += '?fromDate=' + dStrFrom + '&toDate=' + dStrTo + '&mode=0';
  } else if (fromDateObj) {
    var dStr = formatDateForApi(fromDateObj);
    apiPath += '?fromDate=' + dStr + '&toDate=' + dStr + '&mode=0';
  }

  if (options.replaceHistory) {
    extendedHistory = [];
    extendedRids = new Set();
    timelineMin = 0;
    timelineMax = 0;
  }

  apiFetch(apiPath)
    .then(function(resp) {
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return resp.json();
    })
    .then(function(entries) {
      var parsedEntries = [];
      if (Array.isArray(entries)) {
          for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            if (!e.data || !e.category_desc) continue;
            var rid = String(e.rid || '');
            var title = (e.category_desc || '').replace(/\s+/g, ' ').trim();
            var state = classifyTitle(title);
            var location = (typeof e.data === 'string' ? e.data : String(e.data)).trim();
            var canonicalKey = location + '|' + (e.alertDate || '') + '|' + title;
            if ((rid && extendedRids.has('rid:' + rid)) || extendedRids.has(canonicalKey)) continue;
            var ts = parseAlertDate(e.alertDate);
            if (!ts) continue;
            if (rid) extendedRids.add('rid:' + rid);
            extendedRids.add(canonicalKey);
            var entryObj = { location: location, title: title, alertDate: ts, state: state, category_desc: title };
            extendedHistory.push(entryObj);
            parsedEntries.push(entryObj);
            recordHistory(location, title, e.alertDate || '', state);
          }
          // Sort ascending by time
          extendedHistory.sort(function(a, b) { return a.alertDate - b.alertDate; });
          if (extendedHistory.length > 0) {
            timelineMin = extendedHistory[0].alertDate;
            timelineMax = Math.max(extendedHistory[extendedHistory.length - 1].alertDate, Date.now());
          }
      }
      console.log('Extended history:', extendedHistory.length, 'entries');
      if (onDone) {
          onDone(parsedEntries);
      }
    })
    .catch(function(err) {
      console.error('Extended history fetch error:', err);
      if (onDone) onDone([]);
    });
}

function reconstructStateAt(targetTime) {
  // Clear current markers entirely
  for (var name in locationStates) {
    var entry = locationStates[name];
    if (entry && entry.marker) {
      entry.marker.setStyle(BASE_STYLE);
      if (openPopupName !== name) entry.marker.closePopup();
    }
  }
  locationStates = {};

  var lookbackTime = targetTime - ALERT_MAX_AGE_MS;
  var accumulated = {};
  var PRIORITY = { red: 3, purple: 2, yellow: 1, green: 0 };

  // Replay from lookbackTime to targetTime
  for (var i = 0; i < extendedHistory.length; i++) {
    var e = extendedHistory[i];
    if (e.alertDate > targetTime) break;
    if (e.alertDate < lookbackTime) continue;

    var existing = accumulated[e.location];
    if (existing) {
      if (e.state === 'green') {
        accumulated[e.location] = { state: 'green', since: e.alertDate };
      } else if ((PRIORITY[e.state] || 0) >= (PRIORITY[existing.state] || 0)) {
        accumulated[e.location] = { state: e.state, since: e.alertDate };
      }
    } else {
      accumulated[e.location] = { state: e.state, since: e.alertDate };
    }
  }

  // Apply accumulated state
  for (var loc in accumulated) {
    var s = accumulated[loc].state;
    var sinceTime = accumulated[loc].since;
    var polygon = locationPolygons[loc] || null;
    if (!polygon) continue;

    var elapsed = targetTime - sinceTime;
    if (s === 'green') {
      if (elapsed >= GREEN_FADE_MS) continue;
      var opacity = 0.5 * (1 - elapsed / GREEN_FADE_MS);
      polygon.setStyle({
        color: COLORS.green, fillColor: COLORS.green,
        fillOpacity: opacity, opacity: opacity + 0.15, weight: 1
      });
    } else {
      if (elapsed >= ALERT_MAX_AGE_MS) continue;
      polygon.setStyle({
        color: COLORS[s], fillColor: COLORS[s],
        fillOpacity: 0.3, opacity: 0.45, weight: s === 'red' ? 0.5 : 1
      });
    }
    locationStates[loc] = { state: s, since: sinceTime, marker: polygon };
  }
}

function saveLiveState() {
  if (liveLocationStates) return; // already saved
  liveLocationStates = {};
  for (var name in locationStates) {
    var entry = locationStates[name];
    liveLocationStates[name] = { state: entry.state, since: entry.since };
  }
}

function restoreLiveState() {
  // Clear all polygons
  var names = Object.keys(locationStates);
  for (var i = 0; i < names.length; i++) {
    removeLocation(names[i]);
  }
  // Re-apply saved live state
  if (liveLocationStates) {
    for (var name in liveLocationStates) {
      var s = liveLocationStates[name];
      if (s.state === 'green' && (Date.now() - s.since) >= GREEN_FADE_MS) continue;
      setLocationState(name, s.state, s.since);
    }
  }
  liveLocationStates = null;
}

function updateShadowState(name, state, since) {
  if (!liveLocationStates) return;
  var PRIORITY = { red: 3, purple: 2, yellow: 1, green: 0 };
  var existing = liveLocationStates[name];
  if (existing) {
    if (state === 'green') {
      liveLocationStates[name] = { state: 'green', since: since || Date.now() };
    } else if (existing.state === state) {
      return;
    } else if ((PRIORITY[existing.state] || 0) > (PRIORITY[state] || 0)) {
      return;
    } else {
      liveLocationStates[name] = { state: state, since: since || Date.now() };
    }
  } else {
    liveLocationStates[name] = { state: state, since: since || Date.now() };
  }
}

