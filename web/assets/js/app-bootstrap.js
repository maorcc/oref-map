(function() {
  'use strict';

  // --- State ---
  var initialized = false;
  var lastErrorMsg = '';
  var lastCfColo = '';
  var panelHistoryPushed = false;

  // --- Panel history management ---
  function pushPanelHistory() {
    if (!panelHistoryPushed) {
      try {
        history.pushState({ panelOpen: true }, '');
        panelHistoryPushed = true;
      } catch (e) {
        console.warn('Could not push panel history state', e);
      }
    }
  }

  function popPanelHistory() {
    if (panelHistoryPushed) {
      try {
        history.back();
        panelHistoryPushed = false;
      } catch (e) {
        console.warn('Could not pop panel history state', e);
      }
    }
  }

  // --- Init ---
  function init() {
    fetch('locations_polygons.json').then(function(r) { return r.json(); })
      .then(function(data) {
        buildPolygons(data);

        function onHistoryDone() {
          if (initialized) return;
          initialized = true;

          // Initialize UI components
          if (typeof window.initTimeline === 'function') window.initTimeline();
          if (typeof window.initStats === 'function') window.initStats();
          initHistoryProviderControls();
          initSoundPanel();
          initAboutPanel();
          initErrorDisplay();
          initTestButtons();
          initLocationButton();
          initLocateButton();

          // Start data polling and UI updates
          setInterval(fetchLiveAlerts, LIVE_POLL_MS);
          setInterval(function() { fetchHistory(); }, HISTORY_POLL_MS);
          setInterval(fadeGreenMarkers, FADE_TICK_MS);
          fetchLiveAlerts();
          fetchExtendedHistory(null, null, null, '1', { context: 'bootstrap', modeKey: '1' });
          updateLiveStatus();

          // Show hint for mobile users
          if ('ontouchstart' in window) {
            setTimeout(showPolygonHint, 500);
          }

          // Ensure timeline button starts visible if history data exists
          var container = document.getElementById('timeline-btn');
          if (extendedHistory.length > 0 && container) {
            container.classList.add('has-data');
          }
        }

        fetchHistory(onHistoryDone);

      }).catch(function(err) {
        console.error('Failed to load geo data:', err);
        setStatus('err', 'אירעה שגיאה בטעינת נתונים גאוגרפיים');
      });
  }

  // --- Panel initializers ---
  function initAboutPanel() {
    document.getElementById('page-title').addEventListener('click', function() {
      document.getElementById('about-backdrop').classList.add('visible');
    });
    document.getElementById('about-close').addEventListener('click', function() {
      document.getElementById('about-backdrop').classList.remove('visible');
    });
    document.getElementById('about-backdrop').addEventListener('click', function(e) {
      if (e.target === this) {
        document.getElementById('about-backdrop').classList.remove('visible');
      }
    });
  }

  function initErrorDisplay() {
    var statusEl = document.getElementById('status');
    var detailEl = document.getElementById('errorDetail');
    statusEl.addEventListener('click', function() {
      var dot = document.getElementById('statusDot');
      if (!dot.classList.contains('indicator-err')) return;
      if (detailEl.style.display === 'block') {
        detailEl.style.display = 'none';
      } else {
        detailEl.textContent = (lastErrorMsg || 'Unknown error') + (lastCfColo ? ' (CF edge: ' + lastCfColo + ')' : '');
        detailEl.style.display = 'block';
      }
    });
    document.addEventListener('click', function(e) {
      if (detailEl.style.display === 'block' && !statusEl.contains(e.target) && e.target !== detailEl) {
        detailEl.style.display = 'none';
      }
    });
  }

  function initSoundPanel() {
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

    function openSoundPanel() {
      if (typeof closeTimelinePanel === 'function') closeTimelinePanel();
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

    window.closeSoundPanel = function() {
      soundBtn.classList.remove('open');
      updateOverlay();
    };

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

    updateSoundButton();

    soundBtnRow.addEventListener('click', function() {
      if (soundBtn.classList.contains('open')) {
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
  }

  function initHistoryProviderControls() {
    var autoText = 'אוטומטי (מומלץ)';
    var officialText = 'רשמי - פיקוד העורף';
    var tzevaAdomText = 'ארכיון - צבע אדום';
    var labelMap = {
      auto: autoText,
      official: officialText,
      'tzeva-adom': tzevaAdomText
    };

    document.querySelectorAll('.history-provider-control').forEach(function(wrapper) {
      wrapper.title = 'מקור נתוני היסטוריה';
    });

    function updateSelects() {
      var provider = getHistoryProvider();
      document.querySelectorAll('.history-provider-select').forEach(function(select) {
        if (select.value !== provider) {
          select.value = provider;
        }
      });
    }

    document.querySelectorAll('.history-provider-select').forEach(function(select) {
      function getContext() {
        return select.getAttribute('data-history-context') || 'default';
      }

      function getModeKey() {
        var context = getContext();
        if (context === 'stats' && typeof window.getStatsModeKey === 'function') {
          return window.getStatsModeKey();
        }
        if (context === 'timeline' && typeof window.getTimelineModeKey === 'function') {
          return window.getTimelineModeKey();
        }
        return '1';
      }

      function rebuildOptions() {
        var context = getContext();
        var modeKey = getModeKey();
        var choices = (typeof getHistoryProviderChoices === 'function')
          ? getHistoryProviderChoices(modeKey, context)
          : null;

        select.innerHTML = '';

        if (Array.isArray(choices) && choices.length > 0) {
          for (var i = 0; i < choices.length; i++) {
            var val = choices[i];
            var opt = document.createElement('option');
            opt.value = val;
            opt.textContent = labelMap[val] || val;
            select.appendChild(opt);
          }
          select.disabled = false;
          var current = getHistoryProvider();
          if (choices.indexOf(current) === -1) current = choices[0];
          select.value = current;
        } else {
          var locked = choices || getHistoryProvider();
          var optSingle = document.createElement('option');
          optSingle.value = locked;
          optSingle.textContent = labelMap[locked] || locked;
          select.appendChild(optSingle);
          select.disabled = true;
          select.value = locked;
        }
      }

      rebuildOptions();

      select.addEventListener('change', function(e) {
        setHistoryProvider(e.target.value);
      });

      window.addEventListener('history-provider-changed', rebuildOptions);
      window.addEventListener('history-provider-mode-changed', rebuildOptions);
    });

    window.addEventListener('history-provider-changed', updateSelects);
    updateSelects();
  }

  function initTestButtons() {
    document.getElementById('test-danger-btn').addEventListener('click', function() {
      playDangerSound();
    });
    document.getElementById('test-all-clear-btn').addEventListener('click', function() {
      playAllClearSound();
    });
  }

  function initLocationButton() {
    var locationBtn = document.getElementById('location-btn');
    locationBtn.addEventListener('click', function() {
      if (userMarker) {
        map.setView(userMarker.getLatLng(), 13);
      } else {
        map.locate({ setView: true, maxZoom: 13 });
      }
    });
  }

  function initLocateButton() {
    var locateBtn = document.getElementById('locate-btn');
    locateBtn.addEventListener('click', function() {
      if (isZoomedToEvent) {
        isZoomingProgrammatically = true;
        map.flyTo(DEFAULT_CENTER, DEFAULT_ZOOM, { duration: 0.7 });
        isZoomedToEvent = false;
      } else {
        maybeZoomToEvent();
      }
    });
  }

  // --- Global event listeners ---
  window.addEventListener('popstate', function() {
    panelHistoryPushed = false;
    if (typeof closeSoundPanel === 'function') closeSoundPanel();
    if (typeof closeTimelinePanel === 'function') closeTimelinePanel();
    var statsBtn = document.getElementById('stats-btn');
    if (statsBtn && statsBtn.classList.contains('open')) {
      statsBtn.querySelector('.tl-close').click();
    }
    map.closePopup();
  });

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      document.getElementById('about-backdrop').classList.remove('visible');
      if (typeof closeSoundPanel === 'function' && document.getElementById('sound-btn').classList.contains('open')) {
        closeSoundPanel();
        popPanelHistory();
      }
      map.closePopup();
      document.getElementById('errorDetail').style.display = 'none';
    }
  });

  document.addEventListener('click', function(e) {
    var soundBtn = document.getElementById('sound-btn');
    if (soundBtn.classList.contains('open') && !soundBtn.contains(e.target)) {
      if (typeof closeSoundPanel === 'function') {
        closeSoundPanel();
        popPanelHistory();
      }
    }
    if (openPopupName && !isStatsMode) {
      var mapContainer = document.getElementById('map');
      var popupEl = document.querySelector('.leaflet-popup');
      if (!mapContainer.contains(e.target) && (!popupEl || !popupEl.contains(e.target))) {
        map.closePopup();
      }
    }
  });

  // --- Mobile resume handling ---
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState !== 'visible') return;
    try {
      var lastPoll = Number(sessionStorage.getItem('oref-last-poll')) || 0;
      if (Date.now() - lastPoll < 30000) return;
      var lastReload = Number(sessionStorage.getItem('oref-reload-ts')) || 0;
      if (Date.now() - lastReload < 60000) return;
      sessionStorage.setItem('oref-reload-ts', String(Date.now()));
      location.reload();
    } catch(e) { /* ignore */ }
  });

  // --- PWA adjustments ---
  if (window.matchMedia('(display-mode: standalone)').matches) {
    document.title = '';
  }

  // --- Tap hint for mobile ---
  if ('ontouchstart' in window && !localStorage.getItem('tapHintShown')) {
    var hint = document.getElementById('tap-hint');
    if (hint) {
      hint.style.display = 'block';
      localStorage.setItem('tapHintShown', '1');
      hint.addEventListener('animationend', function() { hint.remove(); });
    }
  }

  // --- Start the app ---
  init();

})();
