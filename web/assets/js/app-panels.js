// --- Stats Feature ---
function initStats() {
  var statsBtn = document.getElementById('stats-btn');
  var btnRow = document.getElementById('stats-btn-row');
  var customDatesDiv = document.getElementById('stats-custom-dates');
  var fromDateInput = document.getElementById('stats-from-date');
  var toDateInput = document.getElementById('stats-to-date');
  var categorySelect = document.getElementById('stats-category');
  var rangeLabelDiv = document.getElementById('stats-range-label');

  var currentStatsMode = 1; // 1=24h, 2=7d, 3=30d, 0=custom
  var currentStatsEntries = [];
  var statsLoadToken = 0;

  var today = new Date();
  var yyyy = today.getFullYear();
  var mm = String(today.getMonth() + 1).padStart(2, '0');
  var dd = String(today.getDate()).padStart(2, '0');
  var maxDateStr = yyyy + '-' + mm + '-' + dd;
  fromDateInput.max = maxDateStr;
  toDateInput.max = maxDateStr;

  var yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  fromDateInput.value = yesterday.getFullYear() + '-' + String(yesterday.getMonth()+1).padStart(2,'0') + '-' + String(yesterday.getDate()).padStart(2,'0');
  toDateInput.value = maxDateStr;

  function parseIsoDayStart(dayStr) {
    var parts = (dayStr || '').split('-');
    if (parts.length !== 3) return null;
    var y = parseInt(parts[0], 10);
    var m = parseInt(parts[1], 10) - 1;
    var d = parseInt(parts[2], 10);
    var dt = new Date(y, m, d, 0, 0, 0, 0);
    return isNaN(dt.getTime()) ? null : dt;
  }

  function endOfDayMs(dayStart) {
    return new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate(), 23, 59, 59, 999).getTime();
  }

  function buildStatsRequest() {
    var now = Date.now();
    if (currentStatsMode === 1 || currentStatsMode === 2 || currentStatsMode === 3) {
      var hours = currentStatsMode === 1 ? 24 : (currentStatsMode === 2 ? 24 * 7 : 24 * 30);
      return {
        mode: String(currentStatsMode),
        fromDate: null,
        toDate: null,
        startMs: now - hours * 60 * 60 * 1000,
        endMs: now
      };
    }

    var fromStart = parseIsoDayStart(fromDateInput.value);
    var toStart = parseIsoDayStart(toDateInput.value);
    if (!fromStart || !toStart) return null;
    if (fromStart.getTime() > toStart.getTime()) return null;

    var endMs = endOfDayMs(toStart);
    if (endMs > now) endMs = now;

    return {
      mode: '0',
      fromDate: fromStart,
      toDate: toStart,
      startMs: fromStart.getTime(),
      endMs: endMs
    };
  }

  function updateRangeLabel() {
    var label = '';
    if (currentStatsMode === 1) {
      label = 'מציג 24 שעות אחרונות';
    } else if (currentStatsMode === 2) {
      label = 'מציג שבוע אחרון';
    } else if (currentStatsMode === 3) {
      label = 'מציג חודש אחרון';
    } else if (currentStatsMode === 0) {
      var fromStr = fromDateInput.value;
      var toStr = toDateInput.value;
      if (fromStr && toStr) label = fromStr + ' עד ' + toStr;
    }
    rangeLabelDiv.textContent = label;
  }

  function setModeButtonStyles(mode) {
    document.querySelectorAll('.stats-mode-btn').forEach(function(btn) {
      if (btn.getAttribute('data-mode') === String(mode)) {
        btn.style.background = '#93c5fd';
        btn.style.borderColor = '#3b82f6';
      } else {
        btn.style.background = '#f0f0f0';
        btn.style.borderColor = '#ccc';
      }
    });
  }

  function populateCategories(entries) {
    var previousSelection = categorySelect.value || 'all';
    var uniqueCategories = new Set();
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].state !== 'green') uniqueCategories.add(entries[i].category_desc);
    }

    categorySelect.innerHTML = '<option value="all">הכל</option>';
    var sorted = Array.from(uniqueCategories).sort();
    for (var j = 0; j < sorted.length; j++) {
      var opt = document.createElement('option');
      opt.value = sorted[j];
      opt.textContent = sorted[j];
      categorySelect.appendChild(opt);
    }

    if (previousSelection === 'all' || sorted.indexOf(previousSelection) >= 0) {
      categorySelect.value = previousSelection;
    } else {
      categorySelect.value = 'all';
    }
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, function(ch) {
      if (ch === '&') return '&amp;';
      if (ch === '<') return '&lt;';
      if (ch === '>') return '&gt;';
      if (ch === '"') return '&quot;';
      return '&#39;';
    });
  }

  function computeTimeHistograms(locationName, selectedCategory) {
    var hourBuckets = [];
    var minuteBuckets = [];
    for (var i = 0; i < 24; i++) hourBuckets.push(0);
    for (var m = 0; m < 60; m++) minuteBuckets.push(0);

    var total = 0;
    for (var j = 0; j < currentStatsEntries.length; j++) {
      var e = currentStatsEntries[j];
      if (e.location !== locationName || e.state === 'green') continue;
      if (selectedCategory !== 'all' && e.category_desc !== selectedCategory) continue;
      var dt = new Date(e.alertDate);
      var hour = dt.getHours();
      var minute = dt.getMinutes();
      if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
        hourBuckets[hour]++;
        minuteBuckets[minute]++;
        total++;
      }
    }

    var maxHourBucket = 0;
    for (var h = 0; h < 24; h++) {
      if (hourBuckets[h] > maxHourBucket) maxHourBucket = hourBuckets[h];
    }

    var maxMinuteBucket = 0;
    for (var mm = 0; mm < 60; mm++) {
      if (minuteBuckets[mm] > maxMinuteBucket) maxMinuteBucket = minuteBuckets[mm];
    }

    return {
      hourBuckets: hourBuckets,
      minuteBuckets: minuteBuckets,
      total: total,
      maxHourBucket: maxHourBucket,
      maxMinuteBucket: maxMinuteBucket
    };
  }

  function buildStatsPopupHtml(locationName) {
    var selectedCategory = categorySelect.value || 'all';
    var stats = computeTimeHistograms(locationName, selectedCategory);
    var safeLocation = escapeHtml(locationName);
    var safeCategory = selectedCategory === 'all' ? 'הכל' : escapeHtml(selectedCategory);

    var rows = '';
    for (var hour = 0; hour < 24; hour++) {
      var count = stats.hourBuckets[hour];
      var barWidth = 0;
      if (stats.maxHourBucket > 0) {
        barWidth = Math.round((count / stats.maxHourBucket) * 100);
        if (count > 0 && barWidth < 8) barWidth = 8;
      }
      var hourLabel = String(hour).padStart(2, '0') + ':00';
      rows += '<div style="display:flex;align-items:center;gap:8px;direction:ltr;margin:3px 0;">' +
        '<span style="width:42px;font-size:11px;color:#555;text-align:left;">' + hourLabel + '</span>' +
        '<div style="flex:1;height:10px;background:#f1f5f9;border-radius:999px;overflow:hidden;">' +
          (count > 0 ? '<span style="display:block;height:100%;width:' + barWidth + '%;background:#f59e0b;"></span>' : '') +
        '</div>' +
        '<span style="width:24px;font-size:11px;color:#111;text-align:right;">' + count + '</span>' +
      '</div>';
    }

    var minuteBars = '';
    for (var minuteIdx = 0; minuteIdx < 60; minuteIdx++) {
      var minuteCount = stats.minuteBuckets[minuteIdx];
      var barHeight = 2;
      if (stats.maxMinuteBucket > 0) {
        barHeight = Math.round((minuteCount / stats.maxMinuteBucket) * 34);
        if (minuteCount > 0 && barHeight < 2) barHeight = 2;
      }
      var minuteLabel = String(minuteIdx).padStart(2, '0');
      var barColor = minuteCount > 0 ? '#3b82f6' : '#e5e7eb';
      minuteBars += '<span title="' + minuteLabel + ' - ' + minuteCount + '" style="display:block;width:100%;height:' + barHeight + 'px;background:' + barColor + ';border-radius:2px;"></span>';
    }

    var minuteHistogramHtml =
      '<div style="margin-top:10px;font-size:12px;color:#333;">\u05e4\u05d9\u05dc\u05d5\u05d7 \u05d4\u05ea\u05e8\u05e2\u05d5\u05ea \u05dc\u05e4\u05d9 \u05d3\u05e7\u05d4 \u05d1\u05e9\u05e2\u05d4 (00-59)</div>' +
      '<div style="margin-top:4px;border:1px solid #e5e7eb;border-radius:6px;padding:6px;">' +
        '<div style="display:grid;grid-template-columns:repeat(60,minmax(0,1fr));column-gap:1px;align-items:end;height:36px;direction:ltr;">' + minuteBars + '</div>' +
        '<div style="display:flex;justify-content:space-between;font-size:10px;color:#666;direction:ltr;margin-top:4px;">' +
          '<span>00</span><span>15</span><span>30</span><span>45</span><span>59</span>' +
        '</div>' +
      '</div>';

    var emptyText = stats.total === 0
      ? '<div style="margin-top:8px;font-size:12px;color:#888;">אין התרעות ליישוב בטווח שנבחר.</div>'
      : '<div style="margin-top:8px;font-size:12px;color:#333;">פילוח התרעות לפי שעה</div><div style="margin-top:4px;">' + rows + '</div>' + minuteHistogramHtml;

    return '<div style="direction:rtl;width:min(430px,88vw);text-align:right;">' +
      '<b>' + safeLocation + '</b>' +
      '<div style="margin-top:4px;font-size:12px;color:#555;">קטגוריה: ' + safeCategory + '</div>' +
      '<div style="margin-top:4px;font-size:13px;color:#111;font-weight:bold;">סה״כ התרעות: ' + stats.total + '</div>' +
      emptyText +
    '</div>';
  }

  function applyStatsHeatMap(entries) {
    if (isLiveMode) {
      saveLiveState();
      isLiveMode = false;
    }
    isStatsMode = true;

    for (var name in locationStates) {
      removeLocation(name);
    }
    locationStates = {};

    var selectedCategory = categorySelect.value || 'all';
    statsCounts = {};
    maxStatsCount = 0;

    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e.state === 'green') continue;
      if (selectedCategory !== 'all' && e.category_desc !== selectedCategory) continue;
      statsCounts[e.location] = (statsCounts[e.location] || 0) + 1;
      if (statsCounts[e.location] > maxStatsCount) maxStatsCount = statsCounts[e.location];
    }

    for (var locName in locationPolygons) {
      var p = locationPolygons[locName];
      var count = statsCounts[locName] || 0;
      p.setStyle(getStatsStyle(locName));
      p.unbindTooltip();
      if (count > 0) {
        p.bindTooltip('<b>' + locName + '</b><br>התרעות: ' + count, { direction: 'top', offset: [0, -20] });
      } else {
        p.bindTooltip(locName, { direction: 'top', offset: [0, -20] });
      }
    }

    document.getElementById('historyTimeLabel').style.display = 'block';
    document.getElementById('historyTimeLabel').textContent = 'מציג מפת חום לפי מספר התרעות';
    setStatus('err', 'מצב סטטיסטיקה');
    updateOverlay();

    if (openPopupName && openPopupMarker && typeof getStatsPopupHtml === 'function') {
      openPopupMarker.getPopup().setContent(getStatsPopupHtml(openPopupName));
    }
  }

  function reloadStatsData() {
    var req = buildStatsRequest();
    if (!req) {
      currentStatsEntries = [];
      populateCategories([]);
      applyStatsHeatMap([]);
      return;
    }

    var myToken = ++statsLoadToken;
    categorySelect.disabled = true;
    categorySelect.innerHTML = '<option value="all">טוען...</option>';

    fetchExtendedHistory(req.fromDate, req.toDate, function(entries) {
      if (myToken !== statsLoadToken) return;

      var filtered = [];
      for (var i = 0; i < entries.length; i++) {
        var ts = entries[i].alertDate;
        if (ts >= req.startMs && ts <= req.endMs) filtered.push(entries[i]);
      }

      currentStatsEntries = filtered;
      populateCategories(filtered);
      categorySelect.disabled = false;
      applyStatsHeatMap(filtered);
    }, req.mode, { replaceHistory: true });
  }

  function setStatsMode(mode) {
    currentStatsMode = parseInt(mode, 10);
    getStatsPopupHtml = buildStatsPopupHtml;
    setModeButtonStyles(currentStatsMode);
    customDatesDiv.style.display = (currentStatsMode === 0) ? 'block' : 'none';
    updateRangeLabel();
    reloadStatsData();
  }

  function closeStats() {
    statsBtn.classList.remove('open');
    getStatsPopupHtml = null;
    isStatsMode = false;
    statsCounts = {};
    maxStatsCount = 0;
    currentStatsEntries = [];
    document.getElementById('historyTimeLabel').style.display = 'none';

    for (var name in locationPolygons) {
      var p = locationPolygons[name];
      p.setStyle(BASE_STYLE);
      p.unbindTooltip();
      p.bindTooltip(name, { direction: 'top', offset: [0, -20] });
    }

    enterLiveMode();
    updateOverlay();
  }

  document.querySelectorAll('.stats-mode-btn').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.preventDefault();
      var mode = btn.getAttribute('data-mode');
      if (String(currentStatsMode) === mode) return;
      setStatsMode(mode);
    });
  });

  var onCustomDateChange = function() {
    if (currentStatsMode !== 0) return;
    updateRangeLabel();
    reloadStatsData();
  };
  fromDateInput.addEventListener('change', onCustomDateChange);
  toDateInput.addEventListener('change', onCustomDateChange);

  categorySelect.addEventListener('change', function() {
    if (!statsBtn.classList.contains('open') || !isStatsMode) return;
    applyStatsHeatMap(currentStatsEntries);
  });

  btnRow.addEventListener('click', function(e) {
    if (e.target.classList.contains('tl-close')) {
      closeStats();
      popPanelHistory();
      return;
    }
    if (statsBtn.classList.contains('open')) return;

    closeTimelinePanel();
    closeSoundPanel();
    map.closePopup();
    statsBtn.classList.add('open');
    pushPanelHistory();
    updateOverlay();

    setStatsMode(1);
  });

  statsBtn.querySelector('.tl-close').addEventListener('click', function(e) {
    e.stopPropagation();
    if (statsBtn.classList.contains('open')) {
      closeStats();
      popPanelHistory();
    }
  });

  window.addEventListener('history-provider-changed', function() {
    if (statsBtn.classList.contains('open')) {
      reloadStatsData();
    }
  });
}

function initTimeline() {
  var container = document.getElementById('timeline-btn');
  var btnRow = document.getElementById('timeline-btn-row');
  var slider = document.getElementById('timeline-slider');
  var label = document.getElementById('timeline-label');
  var playBtn = document.getElementById('tl-play');
  var datePicker = document.getElementById('timeline-date-picker');
  var mode3hBtn = document.getElementById('tl-mode-3h');
  var mode24hBtn = document.getElementById('tl-mode-24h');
  var modeDateBtn = document.getElementById('tl-mode-date');

  var prevBtn = document.getElementById('tl-prev');
  var nextBtn = document.getElementById('tl-next');
  var ticksEl = document.getElementById('timeline-ticks');

  var TICK_COLORS = { red: '#e74c3c', purple: '#9b59b6', yellow: '#f1c40f', green: '#2ecc71' };
  var PLAY_SPEED = 600;

  var viewTimelineMin = 0;
  var viewTimelineMax = 0;
  var timelineMode = '3h'; // '3h', '24h' or 'date'

  // init the input date to today by default
  var today = new Date();
  var yyyy = today.getFullYear();
  var mm = String(today.getMonth() + 1).padStart(2, '0');
  var dd = String(today.getDate()).padStart(2, '0');
  datePicker.max = yyyy + '-' + mm + '-' + dd;
  datePicker.value = yyyy + '-' + mm + '-' + dd;
  datePicker.style.display = 'none'; // Hidden by default in 24h mode

  // Set mode button styling
  function setTimelineMode(mode) {
    // 1. Update the state
    timelineMode = mode;

    // 2. Reset all buttons to default
    const buttons = {
      '3h': mode3hBtn,
      '24h': mode24hBtn,
      'date': modeDateBtn
    };

    Object.values(buttons).forEach(btn => {
      btn.style.background = '#f0f0f0';
      btn.style.borderColor = '#ccc';
    });

    // 3. Highlight the active button
    const activeBtn = buttons[mode];
    if (activeBtn) {
      activeBtn.style.background = '#93c5fd';
      activeBtn.style.borderColor = '#3b82f6';
    }

    // 4. Toggle DatePicker visibility
    // Only show if mode is 'date'
    datePicker.style.display = (mode === 'date') ? 'inline-block' : 'none';
  }

  function getTodayIsoDate() {
    var now = new Date();
    return now.getFullYear() + '-' +
           String(now.getMonth() + 1).padStart(2, '0') + '-' +
           String(now.getDate()).padStart(2, '0');
  }

  function parseIsoDayStart(dayStr) {
    var parts = (dayStr || '').split('-');
    if (parts.length !== 3) return null;
    var y = parseInt(parts[0], 10);
    var m = parseInt(parts[1], 10) - 1;
    var d = parseInt(parts[2], 10);
    var dt = new Date(y, m, d, 0, 0, 0, 0);
    return isNaN(dt.getTime()) ? null : dt;
  }

  function buildTimelineRequest() {
    var now = Date.now();
    if (timelineMode === '3h') {
      currentTimelineDay = null;
      return {
        mode: '1',
        fromDate: null,
        toDate: null,
        startMs: now - (3 * 60 * 60 * 1000),
        endMs: now
      };
    } else if (timelineMode === '24h') {
      currentTimelineDay = null;
      return {
        mode: '1',
        fromDate: null,
        toDate: null,
        startMs: now - (24 * 60 * 60 * 1000),
        endMs: now
      };
    }

    var selectedDay = datePicker.value || getTodayIsoDate();
    var startDateObj = parseIsoDayStart(selectedDay);
    if (!startDateObj) {
      selectedDay = getTodayIsoDate();
      datePicker.value = selectedDay;
      startDateObj = parseIsoDayStart(selectedDay);
    }
    currentTimelineDay = selectedDay;

    var y = startDateObj.getFullYear();
    var m = startDateObj.getMonth();
    var d = startDateObj.getDate();
    var startMs = startDateObj.getTime();
    var endMs = new Date(y, m, d, 23, 59, 59, 999).getTime();
    if (endMs > now) endMs = now;

    return {
      mode: '0',
      fromDate: new Date(y, m, d, 0, 0, 0, 0),
      toDate: new Date(y, m, d, 0, 0, 0, 0),
      startMs: startMs,
      endMs: endMs
    };
  }

  function applyTimelineRange(startMs, endMs) {
    viewTimelineMin = startMs;
    viewTimelineMax = endMs;
    if (viewTimelineMax <= viewTimelineMin) {
      viewTimelineMax = viewTimelineMin + 1000;
    }

    computeEventPeaks();
    renderTicks();
    slider.value = 999;
    enterHistoryMode(viewTimelineMax);
  }

  var timelineLoadToken = 0;
  function reloadTimelineData() {
    var req = buildTimelineRequest();
    var myToken = ++timelineLoadToken;
    fetchExtendedHistory(req.fromDate, req.toDate, function() {
      if (myToken !== timelineLoadToken) return;
      container.classList.add('has-data');
      applyTimelineRange(req.startMs, req.endMs);
    }, req.mode, { replaceHistory: true });
  }


  // Mode button handlers
  mode3hBtn.addEventListener('click', function() {
    stopPlay();
    datePicker.value = getTodayIsoDate();
    setTimelineMode('3h');
    reloadTimelineData();
  });
  mode24hBtn.addEventListener('click', function() {
    stopPlay();
    datePicker.value = getTodayIsoDate();
    setTimelineMode('24h');
    reloadTimelineData();
  });

  modeDateBtn.addEventListener('click', function() {
    stopPlay();
    setTimelineMode('date');
    reloadTimelineData();
  });

  datePicker.addEventListener('change', function() {
    if (timelineMode !== 'date') return;
    stopPlay();
    reloadTimelineData();
  });

  // --- Open / Close ---
  function isOpen() { return container.classList.contains('open'); }

  function openTimeline() {
    closeSoundPanel();
    var statsBtn = document.getElementById('stats-btn');
    if (statsBtn && statsBtn.classList.contains('open')) {
      statsBtn.querySelector('.tl-close').click();
    }
    map.closePopup();
    container.classList.add('open');
    pushPanelHistory();

    // Make sure mode is styled correctly on open
    datePicker.value = getTodayIsoDate();
    setTimelineMode('3h');
    reloadTimelineData();
    updateOverlay();
  }

  function closeTimeline() {
    container.classList.remove('open');
    stopPlay();

    enterLiveMode();
    updateOverlay();
  }
  closeTimelinePanel = closeTimeline;

  openTimelineToLastEvent = function() {
    if (!isOpen()) openTimeline();
  };

  btnRow.addEventListener('click', function(e) {
    if (e.target.classList.contains('tl-close')) {
       closeTimeline();
       popPanelHistory();
       return;
    }

    if (isOpen()) {
      // Do nothing if clicking bar while open, user must use 'X'
    } else {
      openTimeline();
    }
  });

  // Explicit close handler for the X button
  container.querySelector('.tl-close').addEventListener('click', function(e) {
      e.stopPropagation();
      if (isOpen()) {
          closeTimeline();
          popPanelHistory();
      }
  });

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      var statsBtn = document.getElementById('stats-btn');
      if (statsBtn && statsBtn.classList.contains('open')) {
           statsBtn.querySelector('.tl-close').click();
      }
      if (isOpen()) {
          closeTimeline();
          popPanelHistory();
      }
    }
  });

  // --- Helpers ---
  function timeFromSlider(val) {
    var range = viewTimelineMax - viewTimelineMin;
    if (range <= 0) return viewTimelineMin;
    return viewTimelineMin + (val / 999) * range;
  }

  function sliderFromTime(time) {
    var range = viewTimelineMax - viewTimelineMin;
    if (range <= 0) return 999;
    return Math.round(((time - viewTimelineMin) / range) * 999);
  }

  function formatTime(ms) {
    var d = new Date(ms);
    return String(d.getHours()).padStart(2, '0') + ':' +
           String(d.getMinutes()).padStart(2, '0') + ':' +
           String(d.getSeconds()).padStart(2, '0');
  }

  function clampTime(t) {
    return Math.max(viewTimelineMin, Math.min(viewTimelineMax, t));
  }

  // --- Mode switching ---
  window.enterLiveMode = function() {
    if (isLiveMode && !isStatsMode) return;
    isLiveMode = true;
    isStatsMode = false;
    currentViewTime = 0;
    document.getElementById('historyTimeLabel').style.display = 'none';
    restoreLiveState();
    updateLiveStatus();
  }

  function enterHistoryMode(time) {
    if (isLiveMode) {
      saveLiveState();
      isLiveMode = false;
    }
    isStatsMode = false;
    currentViewTime = time;
    var timeStr = formatTime(time);
    label.textContent = timeStr;
    document.getElementById('historyTimeLabel').style.display = 'block';
    document.getElementById('historyTimeLabel').textContent = 'מראה התרעות משעה ' + timeStr;
    reconstructStateAt(time);
    }

  function seekTo(time) {
    time = clampTime(time);
    slider.value = Math.min(sliderFromTime(time), 999);
    enterHistoryMode(time);
    maybeZoomToEvent();
  }

  // --- Slider input ---
  slider.addEventListener('input', function() {
    stopPlay();
    enterHistoryMode(timeFromSlider(parseInt(slider.value)));
  });

  // --- Timeline bands (show duration of active alerts) ---
  var STATE_PRIORITY = { red: 3, purple: 2, yellow: 1, green: 0 };
  var computedBands = []; // [{start, end, state}] - visual tick bands
  var eventPeaks = []; // [timestamp] - last non-green before each all-clear wave

  function computeEventPeaks() {
    var peaks = new Set();
    for (var i = 0; i < extendedHistory.length; i++) {
      var e = extendedHistory[i];
      if (e.alertDate >= viewTimelineMin && e.alertDate <= viewTimelineMax && e.state !== 'green') {
        var rounded = Math.floor(e.alertDate / 10000) * 10000;
        peaks.add(rounded);
      }
    }
    eventPeaks = Array.from(peaks).sort(function(a,b){return a-b;});
  }

  function renderTicks() {
    ticksEl.innerHTML = '';
    var range = viewTimelineMax - viewTimelineMin;
    if (range <= 0) return;

    var frag = document.createDocumentFragment();
    for (var i = 0; i < extendedHistory.length; i++) {
      var e = extendedHistory[i];
      if (e.alertDate < viewTimelineMin || e.alertDate > viewTimelineMax || e.state === 'green') continue;

      var pct = ((e.alertDate - viewTimelineMin) / range) * 100;
      var span = document.createElement('span');
      span.style.left = pct + '%';
      span.style.width = '2px';
      span.style.background = TICK_COLORS[e.state] || TICK_COLORS.red;
      frag.appendChild(span);
    }
    ticksEl.appendChild(frag);
  }

  // --- Play / Pause ---
  function stopPlay() {
    isPlaying = false;
    playBtn.textContent = '\u25B6';
    if (playRAF) { cancelAnimationFrame(playRAF); playRAF = null; }
  }

  function startPlay() {

    isPlaying = true;
    playBtn.textContent = '\u23F8';
    var lastFrame = performance.now();
    if (parseInt(slider.value) >= 999) {
      slider.value = 0;
      enterHistoryMode(viewTimelineMin);
    }
    function tick(now) {
      if (!isPlaying) return;
      var dt = now - lastFrame;
      lastFrame = now;
      var newTime = currentViewTime + dt * PLAY_SPEED;
      if (newTime >= viewTimelineMax) {
        slider.value = 0;
        enterHistoryMode(viewTimelineMin);
        lastFrame = now;
        playRAF = requestAnimationFrame(tick);
        return;
      }
      slider.value = Math.min(sliderFromTime(newTime), 999);
      currentViewTime = newTime;
      var timeStr = formatTime(newTime);
      label.textContent = timeStr;
      document.getElementById('historyTimeLabel').textContent = 'מראה התרעות משעה ' + timeStr;
      reconstructStateAt(newTime);
      playRAF = requestAnimationFrame(tick);
    }
    playRAF = requestAnimationFrame(tick);
  }

  playBtn.addEventListener('click', function() {
    if (isPlaying) stopPlay(); else startPlay();
  });

  // --- Prev / Next event peak ---
  prevBtn.addEventListener('click', function() {
    stopPlay();
    for (var i = eventPeaks.length - 1; i >= 0; i--) {
      if (eventPeaks[i] < currentViewTime - 5000) {
        seekTo(eventPeaks[i]);
        return;
      }
    }
    seekTo(viewTimelineMin);
  });

  nextBtn.addEventListener('click', function() {
    stopPlay();
    for (var i = 0; i < eventPeaks.length; i++) {
      if (eventPeaks[i] > currentViewTime + 5000) {
        seekTo(eventPeaks[i]);
        return;
      }
    }
    seekTo(viewTimelineMax);
  });

  window.addEventListener('history-provider-changed', function() {
    if (isOpen()) {
      reloadTimelineData();
    }
  });
}
