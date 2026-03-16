// --- Init ---
function init() {
  fetch('locations_polygons.json').then(function(r) { return r.json(); })
      .then(function(data) {
        buildPolygons(data);

        var historyDone = false;
        function onHistoryDone() {
          initialized = true;
          initTimeline();
          initStats();
          setInterval(fetchLiveAlerts, LIVE_POLL_MS);
          setInterval(function() { fetchHistory(); }, HISTORY_POLL_MS);
          setInterval(fadeGreenMarkers, FADE_TICK_MS);
          fetchLiveAlerts();
          fetchExtendedHistory();
          updateLiveStatus();
          if ('ontouchstart' in window) setTimeout(showPolygonHint, 500);

          // Ensure timeline button starts visible if history data exists from initial live poll
          var container = document.getElementById('timeline-btn');
          if (extendedHistory.length > 0 && container) {
            container.classList.add('has-data');
          }
        }
        fetchHistory(function() { historyDone = true; onHistoryDone(); });
      }).catch(function(err) {
    console.error('Failed to load geo data:', err);
    setStatus('err', 'אירעה שגיאה בטעינת נתונים גאוגרפיים');
  });
}

// --- About control ---
function openAbout() {
  document.getElementById('about-backdrop').classList.add('visible');
}
function closeAbout() {
  document.getElementById('about-backdrop').classList.remove('visible');
}

document.getElementById('status').addEventListener('click', function() {
  var detail = document.getElementById('errorDetail');
  var dot = document.getElementById('statusDot');
  if (!dot.classList.contains('indicator-err')) return;
  if (detail.style.display === 'block') {
    detail.style.display = 'none';
  } else {
    detail.textContent = (lastErrorMsg || 'Unknown error') + (lastCfColo ? ' (CF edge: ' + lastCfColo + ')' : '');
    detail.style.display = 'block';
  }
});
document.addEventListener('click', function(e) {
  var detail = document.getElementById('errorDetail');
  var status = document.getElementById('status');
  if (detail.style.display === 'block' && !status.contains(e.target) && e.target !== detail) {
    detail.style.display = 'none';
  }
});

// Show tap hint for mobile users on first visit
if ('ontouchstart' in window && !localStorage.getItem('tapHintShown')) {
  var hint = document.getElementById('tap-hint');
  hint.style.display = 'block';
  localStorage.setItem('tapHintShown', '1');
  hint.addEventListener('animationend', function() { hint.remove(); });
}

document.getElementById('page-title').addEventListener('click', openAbout);
document.getElementById('about-close').addEventListener('click', closeAbout);
document.getElementById('about-backdrop').addEventListener('click', function(e) {
  if (e.target === this) closeAbout();
});
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    closeAbout();
    if (soundBtn.classList.contains('open')) {
      closeSoundPanel();
      popPanelHistory();
    }
    map.closePopup();
    document.getElementById('errorDetail').style.display = 'none';
  }
});

// --- Sound control & modal ---
var soundBtn = document.getElementById('sound-btn');
var soundBtnRow = document.getElementById('sound-btn-row');
var soundSearch = document.getElementById('sound-search');
var soundResults = document.getElementById('sound-results');

function updateSoundButton() {
  var icon = soundMuted ? '\uD83D\uDD07' : '\uD83D\uDD0A';
  var text = soundMuted ? 'ללא התראה קולית' : (soundLocation === 'all' ? 'צליל מופעל' : soundLocation);
  soundBtnRow.querySelector('.btn-icon').textContent = icon;
  soundBtnRow.querySelector('.btn-text').textContent = text;
  soundBtn.title = soundMuted ? 'השמעת צלילים' : 'צלילים: ' + (soundLocation === 'all' ? 'כל הארץ' : soundLocation);
}
updateSoundButton();

function updateHistoryProviderControls() {
  var provider = getHistoryProvider();
  var selects = document.querySelectorAll('.history-provider-select');
  selects.forEach(function(select) {
    if (select.value !== provider) {
      select.value = provider;
    }
  });
}

function initHistoryProviderControls() {
  var officialText = 'רשמי - פיקוד העורף';
  var tzevaAdomText = 'ארכיון - צבע אדום';

  document.querySelectorAll('.history-provider-control').forEach(function(wrapper) {
    wrapper.title = 'מקור נתוני היסטוריה';
  });

  document.querySelectorAll('.history-provider-select').forEach(function(select) {
    var officialOpt = select.querySelector('option[value="official"]');
    var tzevaOpt = select.querySelector('option[value="tzeva-adom"]');
    if (officialOpt) officialOpt.textContent = officialText;
    if (tzevaOpt) tzevaOpt.textContent = tzevaAdomText;

    select.addEventListener('change', function(e) {
      setHistoryProvider(e.target.value);
    });
  });

  window.addEventListener('history-provider-changed', updateHistoryProviderControls);
  updateHistoryProviderControls();
}

initHistoryProviderControls();

function isSoundOpen() { return soundBtn.classList.contains('open'); }

function openSoundPanel() {
  closeTimelinePanel();
  var statsBtn = document.getElementById('stats-btn');
  if (statsBtn && statsBtn.classList.contains('open')) {
    statsBtn.querySelector('.tl-close').click();
  }

  map.closePopup();
  soundBtn.classList.add('open');
  pushPanelHistory();
  soundSearch.value = '';
  soundResults.innerHTML = '';
  soundSearch.focus();
  updateOverlay();
}

function closeSoundPanel() {
  soundBtn.classList.remove('open');
  updateOverlay();
}

function selectSoundLocation(loc) {
  soundLocation = loc;
  soundMuted = false;
  updateSoundButton();
  try {
    localStorage.setItem('oref-sound-muted', 'false');
    localStorage.setItem('oref-sound-location', loc);
  } catch(e) {}
  getAudioContext();
  closeSoundPanel();
  popPanelHistory();
}

soundBtnRow.addEventListener('click', function() {
  if (isSoundOpen()) {
    closeSoundPanel();
    popPanelHistory();
  } else if (soundMuted) {
    openSoundPanel();
  } else {
    soundMuted = true;
    updateSoundButton();
    try { localStorage.setItem('oref-sound-muted', 'true'); } catch(e) {}
  }
});

document.getElementById('sound-all-btn').addEventListener('click', function() {
  selectSoundLocation('all');
});

document.getElementById('test-danger-btn').addEventListener('click', function() {
  playDangerSound();
});
document.getElementById('test-all-clear-btn').addEventListener('click', function() {
  playAllClearSound();
});

soundSearch.addEventListener('input', function() {
  var q = soundSearch.value.trim();
  if (q.length < 2) {
    soundResults.innerHTML = '';
    return;
  }
  var matches = Object.keys(locationPolygons).filter(function(name) {
    return name.includes(q);
  }).slice(0, 20);

  soundResults.innerHTML = matches.map(function(m) {
    return '<div class="location-item" data-name="' + m + '">' + m + '</div>';
  }).join('');
});

soundResults.addEventListener('click', function(e) {
  var item = e.target.closest('.location-item');
  if (item) {
    selectSoundLocation(item.getAttribute('data-name'));
  }
});

// --- Mobile back button closes panels ---
window.addEventListener('popstate', function() {
  panelHistoryPushed = false;
  closeSoundPanel();
  closeTimelinePanel();

  var statsBtn = document.getElementById('stats-btn');
  if (statsBtn && statsBtn.classList.contains('open')) {
    statsBtn.querySelector('.tl-close').click();
  }

  map.closePopup();
});

// --- Click outside to close panels ---
document.addEventListener('click', function(e) {
  var closed = false;
  if (soundBtn.classList.contains('open') && !soundBtn.contains(e.target)) {
    closeSoundPanel();
    closed = true;
  }
  if (closed) popPanelHistory();
  if (openPopupName && !isStatsMode) {
    var mapContainer = document.getElementById('map');
    var popupEl = document.querySelector('.leaflet-popup');
    if (!mapContainer.contains(e.target) && (!popupEl || !popupEl.contains(e.target))) {
      map.closePopup();
    }
  }
});

// --- Mobile resume: reload if data is stale ---
document.addEventListener('visibilitychange', function() {
  if (document.visibilityState !== 'visible') return;
  try {
    var lastPoll = Number(sessionStorage.getItem('oref-last-poll')) || 0;
    if (Date.now() - lastPoll < 30000) return;
    var lastReload = Number(sessionStorage.getItem('oref-reload-ts')) || 0;
    if (Date.now() - lastReload < 60000) return; // prevent reload loop
    sessionStorage.setItem('oref-reload-ts', String(Date.now()));
  } catch(e) { return; }
  location.reload();
});

if (window.matchMedia('(display-mode: standalone)').matches) {
  document.title = '';
}

init();
