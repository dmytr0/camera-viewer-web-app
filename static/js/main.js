// ---- i18n ----
const TRANSLATIONS = {
  uk: {
    loginSubtitle: 'Введіть облікові дані для доступу до камери',
    loginLabel: 'Логін', loginPlaceholder: 'username',
    passwordLabel: 'Пароль', passwordPlaceholder: 'password',
    loginBtn: 'Увійти',
    errEnterLogin: 'Введіть логін', errChecking: 'Перевірка...',
    errLoginFailed: 'Помилка входу', errConnection: "Помилка з'єднання",
    logoutBtn: 'Вийти',
    errLoadDates: 'Не вдалося отримати список дат: ',
    errLoading: 'Помилка завантаження: ',
    timelineLabel: 'Timeline — натисніть на відрізок для перегляду запису',
    timelineEmpty: 'Немає записів для цієї дати',
    legendCurrent: 'поточна позиція',
    zoomSuffix: 'хв) · подвійний клік = скинути',
    tooltipOngoing: 'ongoing',
    prevClip: '\u23EA Попередній', nextClip: '\u23E9 Наступний', downloadBtn: '\u2B07 Завантажити',
    speedLabel: 'Швидкість', autoplayLabel: 'Відтворювати наступне автоматично',
    filterAll: 'Всі', filterChannel: 'Канал ',
    loadingText: 'Завантаження...', noPhotos: 'Немає фото для цієї дати',
    lbChannel: 'Канал ',
  },
  en: {
    loginSubtitle: 'Enter credentials to access the camera',
    loginLabel: 'Login', loginPlaceholder: 'username',
    passwordLabel: 'Password', passwordPlaceholder: 'password',
    loginBtn: 'Sign in',
    errEnterLogin: 'Enter username', errChecking: 'Checking...',
    errLoginFailed: 'Login error', errConnection: 'Connection error',
    logoutBtn: 'Logout',
    errLoadDates: 'Failed to load dates: ',
    errLoading: 'Load error: ',
    timelineLabel: 'Timeline — click a segment to view recording',
    timelineEmpty: 'No recordings for this date',
    legendCurrent: 'current position',
    zoomSuffix: 'min) · double-click = reset',
    tooltipOngoing: 'ongoing',
    prevClip: '\u23EA Previous', nextClip: '\u23E9 Next', downloadBtn: '\u2B07 Download',
    speedLabel: 'Speed', autoplayLabel: 'Auto-play next',
    filterAll: 'All', filterChannel: 'Channel ',
    loadingText: 'Loading...', noPhotos: 'No photos for this date',
    lbChannel: 'Channel ',
  }
};
let currentLang = 'uk';
function t(key) { return (TRANSLATIONS[currentLang] || TRANSLATIONS.uk)[key] || key; }

// ---- State ----
let allDates = [];
let currentDate = null;
let allImages = [];
let allRecords = [];
let currentRecordIdx = -1;
let channelFilter = 'all';
let currentSpeed = 1.0;
let autoPlayNext = true;
let timelineZoom = 1;       // 1 = full 24h view
let timelineViewStart = 0;  // visible window start in seconds (0–86400)
let pinchStartDist = null;
let pinchStartZoom = null;
let pinchStartViewStart = null;

// ---- Player settings (localStorage) ----
function sliderToSpeed(s) {
  const raw = 0.1 * Math.pow(160, s / 100);
  return Math.round(raw * 10) / 10;
}
function speedToSlider(speed) {
  return Math.round(Math.log(speed / 0.1) / Math.log(160) * 100);
}
function formatSpeed(speed) {
  return (speed >= 10 ? speed.toFixed(0) : speed.toFixed(1)) + '\u00D7';
}
function loadSettings() {
  try {
    const saved = localStorage.getItem('cameraViewerSettings');
    if (saved) {
      const s = JSON.parse(saved);
      if (s.speed != null) currentSpeed = s.speed;
      if (s.autoPlayNext != null) autoPlayNext = !!s.autoPlayNext;
      if (s.lang != null) currentLang = s.lang;
    }
  } catch(e) {}
  el('speed-slider').value = speedToSlider(currentSpeed);
  el('speed-display').textContent = formatSpeed(currentSpeed);
  el('autoplay-next').checked = autoPlayNext;
}
function saveSettings() {
  localStorage.setItem('cameraViewerSettings', JSON.stringify({
    speed: currentSpeed,
    autoPlayNext: autoPlayNext,
    lang: currentLang,
  }));
}
function onSpeedChange(sliderVal) {
  currentSpeed = sliderToSpeed(sliderVal);
  el('speed-display').textContent = formatSpeed(currentSpeed);
  el('video-player').playbackRate = currentSpeed;
  saveSettings();
}
function onAutoplayChange(checked) {
  autoPlayNext = checked;
  saveSettings();
}

// ---- Language ----
function switchLanguage() {
  currentLang = currentLang === 'uk' ? 'en' : 'uk';
  saveSettings();
  applyLanguage();
}

function applyLanguage() {
  document.documentElement.lang = currentLang;
  // Login view
  el('login-subtitle').textContent = t('loginSubtitle');
  el('login-label-username').textContent = t('loginLabel');
  el('login-username').placeholder = t('loginPlaceholder');
  el('login-label-password').textContent = t('passwordLabel');
  el('login-password').placeholder = t('passwordPlaceholder');
  el('login-btn').textContent = t('loginBtn');
  // Header
  el('logout-btn').textContent = t('logoutBtn');
  // Timeline
  el('timeline-label').textContent = t('timelineLabel');
  el('timeline-empty').textContent = t('timelineEmpty');
  el('legend-current').textContent = t('legendCurrent');
  // Player controls (icon + text stored together in translation key)
  el('btn-prev-clip').textContent = t('prevClip');
  el('btn-next-clip').textContent = t('nextClip');
  el('btn-download').textContent = t('downloadBtn');
  el('speed-label').textContent = t('speedLabel');
  el('autoplay-label').textContent = t('autoplayLabel');
  // Gallery
  el('loading-text').textContent = t('loadingText');
  el('events-empty').textContent = t('noPhotos');
  // Lang button shows opposite language
  el('lang-btn').textContent = currentLang === 'uk' ? 'EN' : 'UK';
  // Re-render dynamic content
  updateZoomLabel();
  if (allRecords.length > 0) renderTimeline();
  if (allImages.length > 0 || allRecords.length > 0) renderGallery();
}

// ---- Utils ----
function timeToSecs(t) {
  if (!t) return 0;
  const parts = t.split(':').map(Number);
  return parts[0] * 3600 + parts[1] * 60 + (parts[2] || 0);
}

function secsToTime(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return [h, m, s].map(n => String(n).padStart(2, '0')).join(':');
}

function formatDateInput(yyyymmdd) {
  return yyyymmdd.slice(0, 4) + '-' + yyyymmdd.slice(4, 6) + '-' + yyyymmdd.slice(6, 8);
}

function parseDateInput(yyyy_mm_dd) {
  return yyyy_mm_dd.replace(/-/g, '');
}

function el(id) { return document.getElementById(id); }

function setText(id, text) { el(id).textContent = text; }

function showEl(id) { el(id).style.display = ''; }
function hideEl(id) { el(id).style.display = 'none'; }

// ---- Auth ----
async function doLogin() {
  const btn = el('login-btn');
  const errEl = el('login-error');
  const username = el('login-username').value.trim();
  const password = el('login-password').value;
  errEl.style.display = 'none';
  if (!username) { showLoginError(t('errEnterLogin')); return; }
  btn.disabled = true;
  btn.textContent = t('errChecking');
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await r.json();
    if (!r.ok) { showLoginError(data.error || t('errLoginFailed')); return; }
    showMainView();
  } catch (e) {
    showLoginError(t('errConnection'));
  } finally {
    btn.disabled = false;
    btn.textContent = t('loginBtn');
  }
}

function showLoginError(msg) {
  const errEl = el('login-error');
  errEl.textContent = msg;
  errEl.style.display = 'block';
}

async function doLogout() {
  await fetch('/api/logout', { method: 'POST' });
  location.reload();
}

// ---- Init ----
async function showMainView() {
  hideEl('login-view');
  el('main-view').style.display = 'flex';
  renderTimelineHours();
  await loadDates();
}

// ---- Dates ----
async function loadDates() {
  try {
    const r = await fetch('/api/dates');
    if (r.status === 401) { location.reload(); return; }
    const data = await r.json();
    allDates = data.dates || [];
    if (allDates.length > 0) {
      el('date-input').value = formatDateInput(allDates[0]);
      await loadDate(allDates[0]);
    }
  } catch (e) {
    showBanner(t('errLoadDates') + e.message);
  }
}

// ---- Load date events ----
async function loadDate(dateStr) {
  const date8 = dateStr.includes('-') ? parseDateInput(dateStr) : dateStr;
  if (!date8 || !/^\d{8}$/.test(date8)) return;
  currentDate = date8;
  el('date-input').value = formatDateInput(date8);
  updateDateNavBtns();

  resetPlayer();
  clearTimeline();
  clearGallery();

  el('events-loading').style.display = 'flex';
  try {
    const r = await fetch('/api/events/' + date8);
    if (r.status === 401) { location.reload(); return; }
    const data = await r.json();
    if (data.error) { showBanner(data.error); return; }
    allImages = data.images || [];
    allRecords = data.records || [];
    renderTimeline();
    renderGallery();
    hideBanner();
  } catch (e) {
    showBanner(t('errLoading') + e.message);
  } finally {
    el('events-loading').style.display = 'none';
  }
}

function updateDateNavBtns() {
  if (!currentDate || allDates.length === 0) {
    el('btn-prev').disabled = true;
    el('btn-next').disabled = true;
    return;
  }
  // allDates is newest-first; "older" = larger string value; "newer" = smaller string value
  el('btn-prev').disabled = !allDates.some(d => d < currentDate);
  el('btn-next').disabled = !allDates.some(d => d > currentDate);
}

function navigateDate(dir) {
  if (!currentDate) return;
  if (dir < 0) {
    const older = allDates.filter(d => d < currentDate).sort();
    if (older.length > 0) loadDate(older[older.length - 1]);
  } else {
    const newer = allDates.filter(d => d > currentDate).sort();
    if (newer.length > 0) loadDate(newer[0]);
  }
}

// ---- Timeline ----
function tlWindowSecs() { return 86400 / timelineZoom; }
function tlViewEnd() { return timelineViewStart + tlWindowSecs(); }
function tlSecsToPercent(secs) {
  return ((secs - timelineViewStart) / tlWindowSecs()) * 100;
}
function tlApplyZoom(newZoom, anchorSecs) {
  newZoom = Math.max(1, Math.min(288, newZoom));
  const newWindow = 86400 / newZoom;
  const anchorRatio = (anchorSecs - timelineViewStart) / tlWindowSecs();
  let newStart = anchorSecs - anchorRatio * newWindow;
  newStart = Math.max(0, Math.min(86400 - newWindow, newStart));
  timelineZoom = newZoom;
  timelineViewStart = newStart;
  renderTimelineHours();
  renderTimeline();
  updateZoomLabel();
}
function updateZoomLabel() {
  const label = el('timeline-zoom-label');
  if (timelineZoom <= 1) { label.style.display = 'none'; return; }
  const wMin = Math.round(tlWindowSecs() / 60);
  label.textContent = '\uD83D\uDD0D ' + secsToTime(Math.floor(timelineViewStart)) + ' \u2014 ' + secsToTime(Math.floor(tlViewEnd())) + ' (' + wMin + ' ' + t('zoomSuffix');
  label.style.display = 'inline';
}

function renderTimelineHours() {
  const hoursEl = el('timeline-hours');
  hoursEl.textContent = '';
  const windowSecs = tlWindowSecs();
  const viewEnd = tlViewEnd();
  const niceSteps = [60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200];
  const targetStep = windowSecs / 10;
  const step = niceSteps.find(s => s >= targetStep) || 43200;
  const startAligned = Math.ceil(timelineViewStart / step) * step;
  for (let s = startAligned; s <= viewEnd; s += step) {
    const pct = tlSecsToPercent(s);
    if (pct < 0 || pct > 100) continue;
    const span = document.createElement('span');
    span.textContent = secsToTime(s);
    span.style.left = pct + '%';
    hoursEl.appendChild(span);
  }
}

function timeToPercent(t) {
  return (timeToSecs(t) / 86400) * 100;
}

function clearTimeline() {
  el('timeline').querySelectorAll('.timeline-segment').forEach(s => s.remove());
  el('timeline-cursor').style.display = 'none';
  el('timeline-empty').style.display = 'none';
  timelineZoom = 1;
  timelineViewStart = 0;
  updateZoomLabel();
}

function renderTimeline() {
  const tl = el('timeline');
  tl.querySelectorAll('.timeline-segment').forEach(s => s.remove());
  el('timeline-empty').style.display = 'none';
  if (allRecords.length === 0) {
    el('timeline-empty').style.display = 'block';
    return;
  }
  const cursor = el('timeline-cursor');
  const viewEnd = tlViewEnd();
  allRecords.forEach((rec, idx) => {
    const startSecs = timeToSecs(rec.start);
    let endSecs;
    if (rec.ongoing) {
      const now = new Date();
      endSecs = Math.min(now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds(), 86400);
    } else {
      endSecs = timeToSecs(rec.end);
    }
    if (endSecs < timelineViewStart || startSecs > viewEnd) return;
    const visStart = Math.max(startSecs, timelineViewStart);
    const visEnd = Math.min(endSecs, viewEnd);
    const left = tlSecsToPercent(visStart);
    let width = ((visEnd - visStart) / tlWindowSecs()) * 100;
    if (width < 0.3) width = 0.3;
    const seg = document.createElement('div');
    seg.className = 'timeline-segment ' + rec.type + (rec.ongoing ? ' ongoing' : '');
    seg.style.left = left + '%';
    seg.style.width = Math.min(width, 100 - left) + '%';
    const durationStr = rec.duration ? rec.duration + 's' : t('tooltipOngoing');
    seg.title = (rec.type === 'alert' ? 'Alert' : 'Periodic') + ': ' + rec.start + ' \u2014 ' + (rec.ongoing ? t('tooltipOngoing') : rec.end) + ' (' + durationStr + ')';
    seg.dataset.idx = idx;
    seg.addEventListener('click', function(e) { e.stopPropagation(); playRecord(idx); });
    tl.insertBefore(seg, cursor);
  });
}

function onTimelineClick(e) {
  if (allRecords.length === 0) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const ratio = (e.clientX - rect.left) / rect.width;
  const clickedSecs = timelineViewStart + ratio * tlWindowSecs();
  let bestIdx = 0;
  let bestDist = Infinity;
  allRecords.forEach(function(rec, i) {
    if (rec.ongoing) return;
    const s = timeToSecs(rec.start);
    const en = timeToSecs(rec.end);
    const dist = (s <= clickedSecs && clickedSecs <= en) ? 0 : Math.min(Math.abs(clickedSecs - s), Math.abs(clickedSecs - en));
    if (dist < bestDist) { bestDist = dist; bestIdx = i; }
  });
  playRecord(bestIdx);
}

function setTimelineCursor(pct) {
  const absSecs = (pct / 100) * 86400;
  const cursor = el('timeline-cursor');
  const viewEnd = tlViewEnd();
  if (absSecs < timelineViewStart || absSecs > viewEnd) {
    cursor.style.display = 'none';
  } else {
    cursor.style.left = tlSecsToPercent(absSecs) + '%';
    cursor.style.display = 'block';
  }
}

// ---- Player ----
function resetPlayer() {
  currentRecordIdx = -1;
  const video = el('video-player');
  video.pause();
  video.src = '';
  video.style.display = 'none';
  el('video-placeholder').style.display = 'flex';
  el('video-meta').style.display = 'none';
  el('btn-prev-clip').disabled = true;
  el('btn-next-clip').disabled = true;
  el('btn-download').style.display = 'none';
  el('timeline-cursor').style.display = 'none';
}

function playRecord(idx) {
  if (idx < 0 || idx >= allRecords.length) return;
  currentRecordIdx = idx;
  const rec = allRecords[idx];
  const video = el('video-player');
  video.src = '/api/video/' + currentDate + '/' + rec.path;
  video.style.display = 'block';
  el('video-placeholder').style.display = 'none';
  el('video-meta').style.display = 'flex';
  setText('video-name', rec.name);
  const badge = el('video-type-badge');
  badge.textContent = rec.type === 'alert' ? 'Alert' : 'Periodic';
  badge.className = 'badge ' + rec.type;
  const endLabel = rec.ongoing ? t('tooltipOngoing') + '...' : rec.end;
  setText('video-time-range', rec.start + ' \u2014 ' + endLabel);
  setText('video-size', rec.size);
  const dl = el('btn-download');
  dl.href = '/api/video/' + currentDate + '/' + rec.path;
  dl.download = rec.name.replace(/\.(264|265)$/i, '.mp4');
  dl.style.display = 'inline-block';
  el('btn-prev-clip').disabled = idx === 0;
  el('btn-next-clip').disabled = idx === allRecords.length - 1;
  document.querySelectorAll('.timeline-segment').forEach(s => s.classList.remove('active'));
  const seg = document.querySelector('.timeline-segment[data-idx="' + idx + '"]');
  if (seg) seg.classList.add('active');
  video.playbackRate = currentSpeed;
  video.play().catch(function() {});
}

function navigateClip(dir) { playRecord(currentRecordIdx + dir); }

function onVideoTimeUpdate() {
  if (currentRecordIdx < 0) return;
  const rec = allRecords[currentRecordIdx];
  const video = el('video-player');
  const currentSecs = timeToSecs(rec.start) + video.currentTime;
  setTimelineCursor((currentSecs / 86400) * 100);
  highlightActiveThumb(currentSecs);
}

function onVideoEnded() {
  if (autoPlayNext && currentRecordIdx < allRecords.length - 1) playRecord(currentRecordIdx + 1);
}

// ---- Gallery ----
function clearGallery() {
  el('events-grid').textContent = '';
  el('events-empty').style.display = 'none';
}

function setChannelFilter(ch) {
  channelFilter = ch;
  document.querySelectorAll('.filter-btn').forEach(function(btn) {
    btn.classList.toggle('active', String(btn.dataset.ch) === String(ch));
  });
  renderGallery();
}

function renderGallery() {
  const grid = el('events-grid');
  grid.textContent = '';

  const counts = { all: allImages.length, 0: 0, 1: 0 };
  allImages.forEach(function(img) { if (img.channel in counts) counts[img.channel]++; });
  document.querySelectorAll('.filter-btn').forEach(function(btn) {
    const ch = btn.dataset.ch;
    if (ch === 'all') btn.textContent = t('filterAll') + ' (' + counts.all + ')';
    else btn.textContent = t('filterChannel') + ch + ' (' + (counts[parseInt(ch)] || 0) + ')';
  });

  const filtered = channelFilter === 'all'
    ? allImages
    : allImages.filter(function(img) { return img.channel === channelFilter; });

  if (filtered.length === 0) {
    el('events-empty').style.display = 'block';
    return;
  }
  el('events-empty').style.display = 'none';

  filtered.forEach(function(img) {
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    thumb.dataset.datetime = img.datetime;

    const imgWrap = document.createElement('div');
    imgWrap.className = 'img-wrap';

    const ph = document.createElement('span');
    ph.className = 'ph';
    ph.textContent = '\uD83D\uDCF7';
    imgWrap.appendChild(ph);

    const imgEl = document.createElement('img');
    imgEl.alt = img.time;
    imgEl.dataset.src = '/api/thumbnail/' + currentDate + '/' + img.path;
    imgWrap.appendChild(imgEl);

    const metaDiv = document.createElement('div');
    metaDiv.className = 'thumb-meta';

    const tSpan = document.createElement('div');
    tSpan.className = 't';
    tSpan.textContent = img.time;

    const chSpan = document.createElement('div');
    chSpan.className = 'ch';
    chSpan.textContent = 'Ch' + img.channel;

    metaDiv.appendChild(tSpan);
    metaDiv.appendChild(chSpan);
    thumb.appendChild(imgWrap);
    thumb.appendChild(metaDiv);

    thumb.addEventListener('click', function() { onThumbClick(img); });
    grid.appendChild(thumb);
  });

  setupLazyLoad();
}

function setupLazyLoad() {
  const grid = el('events-grid');
  const observer = new IntersectionObserver(function(entries) {
    entries.forEach(function(entry) {
      if (!entry.isIntersecting) return;
      const thumb = entry.target;
      const imgEl = thumb.querySelector('img[data-src]');
      if (!imgEl || imgEl.dataset.loaded) return;
      imgEl.dataset.loaded = '1';
      imgEl.src = imgEl.dataset.src;
      imgEl.onload = function() {
        imgEl.style.display = 'block';
        const ph = thumb.querySelector('.ph');
        if (ph) ph.style.display = 'none';
      };
      imgEl.onerror = function() { imgEl.style.display = 'none'; };
      observer.unobserve(thumb);
    });
  }, { root: grid, rootMargin: '50px' });

  grid.querySelectorAll('.thumb').forEach(function(thumb) {
    observer.observe(thumb);
  });
}

function onThumbClick(img) {
  const imgSecs = timeToSecs(img.time);
  let bestIdx = -1;
  let bestDist = Infinity;
  allRecords.forEach(function(rec, i) {
    const s = timeToSecs(rec.start);
    const en = timeToSecs(rec.end);
    const dist = (s <= imgSecs && imgSecs <= en) ? 0 : Math.min(Math.abs(imgSecs - s), Math.abs(imgSecs - en));
    if (dist < bestDist) { bestDist = dist; bestIdx = i; }
  });
  if (bestIdx >= 0) playRecord(bestIdx);
  openLightbox(img);
}

function highlightActiveThumb(currentSecs) {
  document.querySelectorAll('.thumb').forEach(function(thumb) {
    const dt = thumb.dataset.datetime;
    if (!dt) return;
    const thumbSecs = timeToSecs(dt.split('T')[1]);
    thumb.classList.toggle('active', Math.abs(currentSecs - thumbSecs) < 5);
  });
}

// ---- Lightbox ----
function openLightbox(img) {
  el('lightbox-img').src = '/api/thumbnail/' + currentDate + '/' + img.path;
  el('lightbox-info').textContent = img.time + ' \u00B7 ' + t('lbChannel') + img.channel;
  el('lightbox').style.display = 'flex';
}

function closeLightbox() {
  el('lightbox').style.display = 'none';
  el('lightbox-img').src = '';
}

// ---- Banner ----
function showBanner(msg) {
  setText('error-text', msg);
  el('error-banner').style.display = 'flex';
}
function hideBanner() { el('error-banner').style.display = 'none'; }

// ---- Timeline wheel zoom ----
(function() {
  var tl = document.getElementById('timeline');

  tl.addEventListener('wheel', function(e) {
    e.preventDefault();
    var rect = tl.getBoundingClientRect();
    var ratio = (e.clientX - rect.left) / rect.width;
    var anchorSecs = timelineViewStart + ratio * tlWindowSecs();
    var factor = e.deltaY < 0 ? 1.3 : (1 / 1.3);
    tlApplyZoom(timelineZoom * factor, anchorSecs);
  }, { passive: false });

  tl.addEventListener('touchstart', function(e) {
    if (e.touches.length === 2) {
      pinchStartDist = Math.hypot(
        e.touches[1].clientX - e.touches[0].clientX,
        e.touches[1].clientY - e.touches[0].clientY
      );
      pinchStartZoom = timelineZoom;
      pinchStartViewStart = timelineViewStart;
    }
  }, { passive: true });

  tl.addEventListener('touchmove', function(e) {
    if (e.touches.length === 2 && pinchStartDist) {
      e.preventDefault();
      var dist = Math.hypot(
        e.touches[1].clientX - e.touches[0].clientX,
        e.touches[1].clientY - e.touches[0].clientY
      );
      var midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      var rect = tl.getBoundingClientRect();
      var ratio = (midX - rect.left) / rect.width;
      timelineZoom = pinchStartZoom;
      timelineViewStart = pinchStartViewStart;
      var anchorSecs = timelineViewStart + ratio * tlWindowSecs();
      tlApplyZoom(pinchStartZoom * (dist / pinchStartDist), anchorSecs);
    }
  }, { passive: false });

  tl.addEventListener('touchend', function() {
    if (event.touches.length < 2) {
      pinchStartDist = null;
      pinchStartZoom = null;
      pinchStartViewStart = null;
    }
  });

  tl.addEventListener('dblclick', function() {
    timelineZoom = 1;
    timelineViewStart = 0;
    renderTimelineHours();
    renderTimeline();
    updateZoomLabel();
  });
})();

// ---- Keyboard shortcuts ----
document.addEventListener('keydown', function(e) {
  if (el('login-view').style.display !== 'none') return;
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'ArrowLeft') navigateClip(-1);
  if (e.key === 'ArrowRight') navigateClip(1);
  if (e.key === 'Escape') closeLightbox();
});

// ---- Login on Enter ----
['login-username', 'login-password'].forEach(function(id) {
  el(id).addEventListener('keydown', function(e) { if (e.key === 'Enter') doLogin(); });
});

// ---- Auto-restore session on page load ----
document.addEventListener('DOMContentLoaded', async function() {
  loadSettings();
  applyLanguage();
  try {
    const r = await fetch('/api/dates');
    if (r.ok) {
      const data = await r.json();
      allDates = data.dates || [];
      hideEl('login-view');
      el('main-view').style.display = 'flex';
      renderTimelineHours();
      if (allDates.length > 0) {
        el('date-input').value = formatDateInput(allDates[0]);
        await loadDate(allDates[0]);
      }
    }
  } catch (e) {
    // Network error — stay on login form
  }
});
