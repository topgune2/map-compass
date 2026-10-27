/**
 * 目的地コンパス Ver 3.0 (iOS Safari / Android Chrome 両対応版)
 * - Android で DeviceOrientationEvent.requestPermission が 'denied' 等を返してもブロックせず、
 *   必ず GPS (watchPosition) とコンパスリスナー (deviceorientationabsolute / deviceorientation) を開始する
 * - クリップボード確認ダイアログ等でハングしないようタイムアウト制御と確実なUI更新を実装
 * - コンパスの N / E / S / W 配置（上:N, 右:E, 下:S, 左:W）および回転方向を正確に制御
 */

const STORAGE_LAST_DEST_KEY = 'map_compass_last_dest_v2';

const state = {
  destination: null,      // { lat, lng, name, resolvedUrl, sourcePattern }
  savedDestination: null, // localStorageから読み込んだ前回の目的地
  currentPos: null,       // { lat, lng, accuracy, timestamp }
  heading: null,          // 0 - 360 (真北=0, 時計回り)
  bearing: null,          // 0 - 360 (現在地から見た目的地の真北基準方位)
  distanceMeters: null,
  watchId: null,
  sensorsStarted: false,
  wakeLockSentinel: null,
  displayedArrowAngle: 0, // 0°と360°の境界で1回転しないための連続角度
  displayedRoseAngle: 0,
};

const els = {
  sensorStatusBadge: document.getElementById('sensorStatusBadge'),
  wakeLockBadge: document.getElementById('wakeLockBadge'),
  destinationCard: document.getElementById('destinationCard'),
  destCoordsText: document.getElementById('destCoordsText'),
  destNameText: document.getElementById('destNameText'),
  btnOpenInGoogleMaps: document.getElementById('btnOpenInGoogleMaps'),
  primaryCtaSection: document.getElementById('primaryCtaSection'),
  btnStartFromClipboard: document.getElementById('btnStartFromClipboard'),
  btnStartFromClipboardLabel: document.getElementById('btnStartFromClipboardLabel'),
  btnStartPreloadedTarget: document.getElementById('btnStartPreloadedTarget'),
  btnStartPreloadedLabel: document.getElementById('btnStartPreloadedLabel'),
  btnResumeSavedTarget: document.getElementById('btnResumeSavedTarget'),
  btnResumeSavedLabel: document.getElementById('btnResumeSavedLabel'),
  ctaHintText: document.getElementById('ctaHintText'),
  compassBezel: document.getElementById('compassBezel'),
  compassRose: document.getElementById('compassRose'),
  arrowRotator: document.getElementById('arrowRotator'),
  distanceNumber: document.getElementById('distanceNumber'),
  distanceUnit: document.getElementById('distanceUnit'),
  arrivalBadge: document.getElementById('arrivalBadge'),
  bearingText: document.getElementById('bearingText'),
  headingText: document.getElementById('headingText'),
  gpsAccuracyText: document.getElementById('gpsAccuracyText'),
  statusToast: document.getElementById('statusToast'),
  btnReloadClipboard: document.getElementById('btnReloadClipboard'),
  btnToggleManual: document.getElementById('btnToggleManual'),
  manualChevron: document.getElementById('manualChevron'),
  manualCollapseArea: document.getElementById('manualCollapseArea'),
  manualUrlForm: document.getElementById('manualUrlForm'),
  manualUrlInput: document.getElementById('manualUrlInput'),
  btnResolveUrl: document.getElementById('btnResolveUrl'),
};

// ==========================================
// 1. OS判定・ユーティリティ
// ==========================================

/**
 * 真の iOS / iPadOS 端末かどうかを判定（Android Chrome 等で requestPermission がダミー定義されているケースを除外）
 */
function isIOSDevice() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const isAppleMobile = /iPad|iPhone|iPod/.test(ua);
  const isIPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return (isAppleMobile || isIPadOS) && !/Android/i.test(ua);
}

let toastTimer = null;
function showToast(message, isError = false, durationMs = 4500) {
  if (!els.statusToast) return;
  els.statusToast.textContent = message;
  els.statusToast.classList.toggle('error', Boolean(isError));
  els.statusToast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  if (durationMs > 0) {
    toastTimer = setTimeout(() => {
      els.statusToast.hidden = true;
    }, durationMs);
  }
}

function degToCompassDirection(deg) {
  if (deg === null || deg === undefined || Number.isNaN(deg)) return '--';
  const dirs = [
    '北', '北北東', '北東', '東北東',
    '東', '東南東', '南東', '南南東',
    '南', '南南西', '南西', '西南西',
    '西', '西北西', '北西', '北北西',
  ];
  const idx = Math.round((((deg % 360) + 360) % 360) / 22.5) % 16;
  return dirs[idx];
}

function isValidLatLng(lat, lng) {
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    !Number.isNaN(lat) &&
    !Number.isNaN(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180 &&
    !(lat === 0 && lng === 0)
  );
}

function smoothAngleTransition(currentContinuousAngle, targetNormalizedDeg) {
  const currentMod = ((currentContinuousAngle % 360) + 360) % 360;
  let diff = targetNormalizedDeg - currentMod;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return currentContinuousAngle + diff;
}

function withTimeout(promise, ms, errorMessage) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(errorMessage)), ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

// ==========================================
// 2. 文字列からのURL抽出 & 座標抽出ロジック
// ==========================================

function parseSharedInput(rawInput, sharedTitle = '') {
  const text = (rawInput || '').trim();
  const urlMatch = text.match(/https?:\/\/[^\s"<>]+/i);
  const extractedUrl = urlMatch ? urlMatch[0] : null;

  let candidateName = (sharedTitle || '').trim();
  if (!candidateName && text) {
    const withoutUrl = text
      .replace(/https?:\/\/[^\s"<>]+/gi, '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (withoutUrl.length > 0) {
      candidateName = withoutUrl[0].replace(/^[「『"']|[」』"']$/g, '');
    }
  }

  return {
    rawText: text,
    extractedUrl,
    candidateName,
  };
}

function extractCoordinatesFromText(sourceStr) {
  if (!sourceStr) return null;

  let decodedStr = sourceStr;
  try {
    decodedStr = decodeURIComponent(sourceStr);
  } catch (_) {
    decodedStr = sourceStr.replace(/%21/gi, '!').replace(/%2C/gi, ',').replace(/%40/gi, '@');
  }

  const targets = [sourceStr, decodedStr];

  for (const str of targets) {
    // 1. ピンの正確な座標: !3d(-?\d+\.\d+)!4d(-?\d+\.\d+)
    const matchPin = str.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
    if (matchPin) {
      const lat = parseFloat(matchPin[1]);
      const lng = parseFloat(matchPin[2]);
      if (isValidLatLng(lat, lng)) {
        return { lat, lng, pattern: '1: Pin (!3d!4d)' };
      }
    }

    // 2. クエリ形式の座標: [?&](?:q|ll|query|destination)=(-?\d+\.\d+),(-?\d+\.\d+)
    const matchQuery = str.match(/[?&](?:q|ll|query|destination|daddr|center)=(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/i);
    if (matchQuery) {
      const lat = parseFloat(matchQuery[1]);
      const lng = parseFloat(matchQuery[2]);
      if (isValidLatLng(lat, lng)) {
        return { lat, lng, pattern: '2: Query (?q=lat,lng)' };
      }
    }

    // 3. ビューポート中心座標: @(-?\d+\.\d+),(-?\d+\.\d+)
    const matchViewport = str.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (matchViewport) {
      const lat = parseFloat(matchViewport[1]);
      const lng = parseFloat(matchViewport[2]);
      if (isValidLatLng(lat, lng)) {
        return { lat, lng, pattern: '3: Viewport (@lat,lng)' };
      }
    }
  }

  // 4. HTML内のメタデータ・Place Previewデータ等に含まれる座標パターン
  const matchPreview = sourceStr.match(/\[null,null,(-?\d+\.\d+),(-?\d+\.\d+)\]/);
  if (matchPreview) {
    const lat = parseFloat(matchPreview[1]);
    const lng = parseFloat(matchPreview[2]);
    if (isValidLatLng(lat, lng)) {
      return { lat, lng, pattern: '4: HTML Metadata / Place Data' };
    }
  }

  const matchRawCoords = sourceStr.trim().match(/^(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)$/);
  if (matchRawCoords) {
    const lat = parseFloat(matchRawCoords[1]);
    const lng = parseFloat(matchRawCoords[2]);
    if (isValidLatLng(lat, lng)) {
      return { lat, lng, pattern: 'Direct Coordinates' };
    }
  }

  return null;
}

function extractPlaceNameFromUrl(urlStr) {
  if (!urlStr) return '';
  try {
    const decoded = decodeURIComponent(urlStr.replace(/\+/g, ' '));
    const placeMatch = decoded.match(/\/maps\/(?:place|search)\/([^/@?]+)/);
    if (placeMatch && placeMatch[1] && placeMatch[1].trim() !== '') {
      const name = placeMatch[1].trim();
      if (!/^-?\d+\.\d+,-?\d+\.\d+$/.test(name)) {
        return name;
      }
    }
    const urlObj = new URL(urlStr);
    const q = urlObj.searchParams.get('q') || urlObj.searchParams.get('query');
    if (q && !/^-?\d+\.\d+\s*,\s*-?\d+\.\d+$/.test(q)) {
      return q.trim();
    }
  } catch (_) {}
  return '';
}

async function resolveGoogleMapsTarget(rawInput, sharedTitle = '') {
  const { rawText, extractedUrl, candidateName } = parseSharedInput(rawInput, sharedTitle);

  const directCoords = extractCoordinatesFromText(extractedUrl || rawText);
  if (directCoords) {
    const placeName = candidateName || extractPlaceNameFromUrl(extractedUrl || rawText) || '指定された目的地';
    return {
      lat: directCoords.lat,
      lng: directCoords.lng,
      name: placeName,
      resolvedUrl: extractedUrl || `https://www.google.com/maps/search/?api=1&query=${directCoords.lat},${directCoords.lng}`,
      sourcePattern: directCoords.pattern,
    };
  }

  if (!extractedUrl) {
    throw new Error('コピーされたテキストにGoogleマップのURL（https://...）が見つかりませんでした。');
  }

  // `/api/resolve-url` へ送信（Next.jsサーバー環境の場合）
  try {
    const apiRes = await fetch(`./api/resolve-url?url=${encodeURIComponent(extractedUrl)}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (apiRes.ok) {
      const contentType = apiRes.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const data = await apiRes.json();
        if (data && isValidLatLng(data.lat, data.lng)) {
          return {
            lat: data.lat,
            lng: data.lng,
            name: candidateName || data.placeName || extractPlaceNameFromUrl(data.resolvedUrl) || 'Googleマップの目的地',
            resolvedUrl: data.resolvedUrl || extractedUrl,
            sourcePattern: data.pattern || 'API (/api/resolve-url)',
          };
        }
      }
    }
  } catch (_) {}

  // GitHub Pages（静的環境）向け：CORS対応プロキシ経由で短縮URLを展開＆HTML/Preview解析
  const proxyHtmlRes = await fetchViaCorsProxies(extractedUrl);
  if (proxyHtmlRes) {
    const cleanedHtml = proxyHtmlRes.text
      .replace(/center=35\.11333295%2C136\.9559495/g, '')
      .replace(/center=45\.263187%2C-121\.0885805/g, '');
    const htmlCoords = extractCoordinatesFromText(cleanedHtml);
    if (htmlCoords) {
      const extractedTitle = extractPlaceTitleFromHtml(proxyHtmlRes.text);
      return {
        lat: htmlCoords.lat,
        lng: htmlCoords.lng,
        name: candidateName || extractedTitle || 'Googleマップの目的地',
        resolvedUrl: proxyHtmlRes.finalUrl || extractedUrl,
        sourcePattern: htmlCoords.pattern,
      };
    }

    const previewMatch = proxyHtmlRes.text.match(/\/maps\/preview\/place\?[^\s"<>']+/);
    if (previewMatch) {
      const previewPath = previewMatch[0]
        .replace(/&amp;/g, '&')
        .replace(/hl=en/g, 'hl=ja')
        .replace(/gl=us/g, 'gl=jp');
      const previewUrl = `https://www.google.com${previewPath}`;
      const previewRes = await fetchViaCorsProxies(previewUrl);
      if (previewRes && previewRes.text) {
        const previewCoords = extractCoordinatesFromText(previewRes.text);
        if (previewCoords) {
          const placeNameFromPreview = extractPlaceNameFromPreviewJson(previewRes.text);
          return {
            lat: previewCoords.lat,
            lng: previewCoords.lng,
            name: candidateName || placeNameFromPreview || 'Googleマップの目的地',
            resolvedUrl: extractedUrl,
            sourcePattern: previewCoords.pattern,
          };
        }
      }
    }
  }

  throw new Error('短縮URLから座標を抽出できませんでした。');
}

async function fetchViaCorsProxies(targetUrl) {
  const attempts = [
    async () => {
      const res = await withTimeout(
        fetch(`https://r.jina.ai/${targetUrl}`, {
          headers: { 'X-Return-Format': 'html', 'X-Engine': 'direct' },
        }),
        8000,
        'Timeout'
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { text: await res.text(), finalUrl: targetUrl };
    },
    async () => {
      const res = await withTimeout(
        fetch(`https://r.jina.ai/${targetUrl}`, {
          headers: { 'X-Return-Format': 'text' },
        }),
        8000,
        'Timeout'
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { text: await res.text(), finalUrl: targetUrl };
    },
    async () => {
      const res = await withTimeout(
        fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`),
        8000,
        'Timeout'
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { text: await res.text(), finalUrl: targetUrl };
    },
  ];

  for (const fn of attempts) {
    try {
      const result = await fn();
      if (result && result.text && result.text.length > 20) {
        return result;
      }
    } catch (_) {}
  }
  return null;
}

function extractPlaceTitleFromHtml(html) {
  if (!html) return '';
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch && titleMatch[1]) {
    const cleaned = titleMatch[1].replace(/\s*-\s*Google\s*(マップ|Maps).*$/i, '').trim();
    if (cleaned && cleaned !== 'Google Maps' && cleaned !== 'Google マップ') {
      return cleaned;
    }
  }
  return '';
}

function extractPlaceNameFromPreviewJson(previewText) {
  if (!previewText) return '';
  const ftidNameMatch = previewText.match(/"0x[0-9a-f]+:0x[0-9a-f]+"\s*,\s*"([^"]+)"/i);
  if (ftidNameMatch && ftidNameMatch[1]) {
    return ftidNameMatch[1];
  }
  return '';
}

// ==========================================
// 3. 距離（Haversine公式）と方位角（Bearing）の計算
// ==========================================

function calculateHaversineDistanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function calculateBearingDegrees(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const toDeg = (rad) => (rad * 180) / Math.PI;

  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const deltaLambda = toRad(lng2 - lng1);

  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);

  const theta = Math.atan2(y, x);
  return (toDeg(theta) + 360) % 360;
}

function formatDistance(meters) {
  if (meters === null || meters === undefined || Number.isNaN(meters)) {
    return { numberText: '---', unitText: 'm' };
  }
  if (meters < 1000) {
    return { numberText: String(Math.round(meters)), unitText: 'm' };
  }
  return { numberText: (meters / 1000).toFixed(2), unitText: 'km' };
}

// ==========================================
// 4. 電子コンパス・GPS・Screen Wake Lock 制御
// ==========================================

async function requestScreenWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    state.wakeLockSentinel = await navigator.wakeLock.request('screen');
    if (els.wakeLockBadge) els.wakeLockBadge.hidden = false;
    state.wakeLockSentinel.addEventListener('release', () => {
      if (els.wakeLockBadge) els.wakeLockBadge.hidden = true;
    });
  } catch (_) {}
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.sensorsStarted) {
    requestScreenWakeLock();
  }
});

/**
 * 電子コンパス（スマホの向き）の取得
 * - iOSの場合: `webkitCompassHeading`（真北=0°、時計回り）を使用
 * - Android等の場合: `deviceorientationabsolute`（非対応なら `deviceorientation`）の `alpha` を使用し、`(360 - alpha) % 360` で北基準の角度に変換
 */
function handleDeviceOrientation(event) {
  let heading = null;

  if (typeof event.webkitCompassHeading === 'number' && !Number.isNaN(event.webkitCompassHeading)) {
    heading = event.webkitCompassHeading;
  } else if (event.alpha !== null && event.alpha !== undefined && !Number.isNaN(event.alpha)) {
    heading = (360 - event.alpha + 360) % 360;
  }

  if (heading !== null) {
    state.heading = (heading + 360) % 360;
    updateNavigationUI();
  }
}

let absoluteOrientationBound = false;
let fallbackOrientationBound = false;
let hasReceivedAbsoluteEvent = false;

function registerCompassListeners() {
  if ('ondeviceorientationabsolute' in window && !absoluteOrientationBound) {
    window.addEventListener(
      'deviceorientationabsolute',
      (event) => {
        if (event.alpha !== null && event.alpha !== undefined) {
          hasReceivedAbsoluteEvent = true;
          handleDeviceOrientation(event);
        }
      },
      true
    );
    absoluteOrientationBound = true;
  }

  if ('ondeviceorientation' in window && !fallbackOrientationBound) {
    window.addEventListener(
      'deviceorientation',
      (event) => {
        // iOS (webkitCompassHeadingあり) または Android でまだ absolute イベントが来ていない場合に処理
        if (typeof event.webkitCompassHeading === 'number' || !hasReceivedAbsoluteEvent) {
          handleDeviceOrientation(event);
        }
      },
      true
    );
    fallbackOrientationBound = true;
  }
}

function startGeolocationWatch() {
  if (!('geolocation' in navigator)) {
    showToast('お使いのブラウザは位置情報(Geolocation)に対応していません。', true);
    return;
  }

  if (state.watchId !== null) {
    navigator.geolocation.clearWatch(state.watchId);
  }

  els.gpsAccuracyText.textContent = '測位中...';

  state.watchId = navigator.geolocation.watchPosition(
    (pos) => {
      state.currentPos = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        timestamp: pos.timestamp,
      };
      if (state.heading === null && typeof pos.coords.heading === 'number' && !Number.isNaN(pos.coords.heading)) {
        state.heading = pos.coords.heading;
      }
      updateNavigationUI();
    },
    (err) => {
      let msg = '位置情報の取得に失敗しました。';
      if (err.code === 1) msg = '位置情報の利用が許可されていません。ブラウザ設定から許可してください。';
      else if (err.code === 2) msg = '現在地を特定できませんでした（屋外や窓際でお試しください）。';
      else if (err.code === 3) msg = '位置情報の取得がタイムアウトしました。再試行しています...';
      els.gpsAccuracyText.textContent = '再測位中';
      showToast(msg, true);
    },
    {
      enableHighAccuracy: true,
      maximumAge: 2000,
      timeout: 20000,
    }
  );
}

function activateTrackingServices() {
  registerCompassListeners();
  startGeolocationWatch();
  requestScreenWakeLock();

  state.sensorsStarted = true;
  els.primaryCtaSection.hidden = true;
  els.sensorStatusBadge.textContent = 'GPS・コンパス連動中';
  els.sensorStatusBadge.classList.add('active');
}

// ==========================================
// 5. ワンタップ開始ボタン（iOS / Android 両対応）
// ==========================================

async function onOneTapClipboardStartClick() {
  // 1. 最優先（同期的）: iOS Safari の User Activation 制約を回避するため、最初に同期的に requestPermission() を呼ぶ
  const permissionPromise =
    typeof window.DeviceOrientationEvent !== 'undefined' &&
    typeof window.DeviceOrientationEvent.requestPermission === 'function'
      ? window.DeviceOrientationEvent.requestPermission().catch(() => 'granted')
      : Promise.resolve('granted');

  // 2. 並行または直後: クリップボード読み取りを開始（ポップアップ放置で永久ハングしないよう12秒タイムアウト付き）
  const clipboardPromise =
    navigator.clipboard && typeof navigator.clipboard.readText === 'function'
      ? withTimeout(navigator.clipboard.readText(), 12000, 'Clipboard timeout')
      : Promise.reject(new Error('Clipboard API unavailable'));

  // Android 等でも即座に GPS (watchPosition) とコンパスイベントの待受を開始する
  activateTrackingServices();

  els.btnStartFromClipboard.disabled = true;
  els.btnStartFromClipboardLabel.textContent = 'リンクを解析中...';
  showToast('コピーしたリンクを読み取っています...', false, 0);

  // iOS端末で明示的にコンパス権限が拒否された場合のみ案内を出す（Androidでは誤検知させない）
  try {
    const permState = await permissionPromise;
    if (permState !== 'granted' && isIOSDevice()) {
      showToast('iOSコンパスの権限が拒否されました。Safariを再読み込みして許可してください。', true, 6000);
    }
  } catch (_) {}

  // クリップボードからテキスト取得 -> 正規表現でURL抽出 -> 座標解決
  try {
    const clipText = await clipboardPromise;
    if (!clipText || !clipText.trim()) {
      throw new Error('クリップボードが空です');
    }
    els.manualUrlInput.value = clipText.replace(/\r?\n/g, ' ');
    const target = await resolveGoogleMapsTarget(clipText);
    setAndSaveDestination(target);
    showToast(`目的地「${target.name}」へのナビを開始しました！`, false, 3500);
  } catch (err) {
    // クリップボードが空だった場合、もし前回の目的地（例：玉の湯）が保存されていればそれをセットしつつ手動入力欄も開く
    if (!state.destination && state.savedDestination) {
      setAndSaveDestination(state.savedDestination);
    }
    openManualInputAndFocus();
    showToast(
      'クリップボードの読み取りがブロックされたか空でした。下の入力欄にGoogleマップのリンクを貼り付けて「開始」を押してください。',
      true,
      6500
    );
  } finally {
    els.btnStartFromClipboard.disabled = false;
    els.btnStartFromClipboardLabel.textContent = 'コピーしたリンクから開始';
  }
}

/**
 * すでに目的地がセットされている状態（Android共有起動時・前回の目的地「〇〇」で再開ボタンタップ時）のワンタップ開始
 */
async function onStartWithTargetClick(targetObj) {
  // 1. 最優先（同期的）: iOS向けに requestPermission() を呼び出す
  const permissionPromise =
    typeof window.DeviceOrientationEvent !== 'undefined' &&
    typeof window.DeviceOrientationEvent.requestPermission === 'function'
      ? window.DeviceOrientationEvent.requestPermission().catch(() => 'granted')
      : Promise.resolve('granted');

  if (targetObj) {
    setAndSaveDestination(targetObj);
  }

  // 即座にGPSとコンパスを開始
  activateTrackingServices();

  try {
    const permState = await permissionPromise;
    if (permState !== 'granted' && isIOSDevice()) {
      showToast('iOSコンパスの利用が拒否されました。Safariを再読み込みして許可してください。', true);
      return;
    }
  } catch (_) {}

  showToast(`「${state.destination?.name || '目的地'}」へのリアルタイム計測を開始しました！`, false, 3000);
}

// ==========================================
// 6. UI更新・localStorage 保存・折りたたみ制御
// ==========================================

function setAndSaveDestination(target) {
  state.destination = target;
  state.savedDestination = target;
  try {
    localStorage.setItem(
      STORAGE_LAST_DEST_KEY,
      JSON.stringify({
        ...target,
        savedAt: Date.now(),
      })
    );
  } catch (_) {}
  updateDestinationUI();
  updateNavigationUI();
}

function loadSavedDestinationFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_LAST_DEST_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && isValidLatLng(parsed.lat, parsed.lng)) {
      state.savedDestination = parsed;
      els.btnResumeSavedLabel.textContent = `前回の目的地「${parsed.name}」で再開`;
      els.btnResumeSavedTarget.hidden = false;
    }
  } catch (_) {}
}

function openManualInputAndFocus() {
  els.manualCollapseArea.hidden = false;
  els.btnToggleManual.setAttribute('aria-expanded', 'true');
  els.manualChevron.classList.add('open');
  setTimeout(() => {
    els.manualUrlInput.focus();
  }, 60);
}

function updateDestinationUI() {
  if (!state.destination) {
    els.destinationCard.classList.remove('has-target');
    els.destCoordsText.textContent = '未設定';
    els.destNameText.textContent = 'Googleマップで「共有」→「コピー」して下のボタンをタップ';
    els.btnOpenInGoogleMaps.hidden = true;
    return;
  }

  const { lat, lng, name, resolvedUrl } = state.destination;
  els.destinationCard.classList.add('has-target');
  els.destCoordsText.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  els.destNameText.textContent = name || '指定された目的地';

  els.btnOpenInGoogleMaps.href = resolvedUrl || `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
  els.btnOpenInGoogleMaps.hidden = false;
}

function updateNavigationUI() {
  if (state.currentPos) {
    const acc = Math.round(state.currentPos.accuracy || 0);
    els.gpsAccuracyText.textContent = `±${acc}m`;
  }

  if (state.heading !== null) {
    const hDeg = Math.round(state.heading);
    els.headingText.textContent = `${hDeg}° (${degToCompassDirection(state.heading)})`;

    const targetRoseDeg = (360 - state.heading + 360) % 360;
    state.displayedRoseAngle = smoothAngleTransition(state.displayedRoseAngle, targetRoseDeg);
    els.compassRose.style.transform = `rotate(${state.displayedRoseAngle.toFixed(1)}deg)`;
  } else {
    els.headingText.textContent = '--° (--)';
  }

  if (state.destination && state.currentPos) {
    const dist = calculateHaversineDistanceMeters(
      state.currentPos.lat,
      state.currentPos.lng,
      state.destination.lat,
      state.destination.lng
    );
    const bearing = calculateBearingDegrees(
      state.currentPos.lat,
      state.currentPos.lng,
      state.destination.lat,
      state.destination.lng
    );

    state.distanceMeters = dist;
    state.bearing = bearing;

    const { numberText, unitText } = formatDistance(dist);
    els.distanceNumber.textContent = numberText;
    els.distanceUnit.textContent = unitText;

    els.arrivalBadge.hidden = dist > 30;

    const bDeg = Math.round(bearing);
    els.bearingText.textContent = `${bDeg}° (${degToCompassDirection(bearing)})`;

    const effectiveHeading = state.heading !== null ? state.heading : 0;
    const relativeAngle = ((bearing - effectiveHeading + 360) % 360 + 360) % 360;

    state.displayedArrowAngle = smoothAngleTransition(state.displayedArrowAngle, relativeAngle);
    els.arrowRotator.style.transform = `rotate(${state.displayedArrowAngle.toFixed(1)}deg)`;

    const isAligned = relativeAngle <= 15 || relativeAngle >= 345;
    els.compassBezel.classList.toggle('aligned', isAligned && state.heading !== null);
  }
}

// ==========================================
// 7. 初期化
// ==========================================

function initApp() {
  if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js?v=3.0').catch(() => {});
  }

  loadSavedDestinationFromStorage();

  // Android ではページ読み込み時点からコンパスイベントを先行登録しておく（ボタンタップ前でも方角が取れるようにする）
  if (!isIOSDevice()) {
    registerCompassListeners();
  }

  // URLクエリパラメータ（?url=..., ?text=..., ?q=...）付きで開かれた場合の自動解析
  const params = new URLSearchParams(window.location.search);
  const sharedUrl = params.get('url') || '';
  const sharedText = params.get('text') || '';
  const sharedQuery = params.get('q') || '';
  const sharedTitle = params.get('title') || '';

  const combinedInput = [sharedUrl, sharedText, sharedQuery].filter(Boolean).join('\n');
  if (combinedInput) {
    els.manualUrlInput.value = combinedInput.replace(/\r?\n/g, ' ');
    els.btnStartFromClipboard.hidden = true;
    els.btnResumeSavedTarget.hidden = true;
    els.btnStartPreloadedTarget.hidden = false;
    els.ctaHintText.textContent = '共有された目的地の座標をセットしました！上のボタンを1回タップすると計測が始まります';

    showToast('共有されたリンクから目的地座標を自動取得しています...', false, 0);
    resolveGoogleMapsTarget(combinedInput, sharedTitle)
      .then((target) => {
        setAndSaveDestination(target);
        els.btnStartPreloadedLabel.textContent = 'コンパスを有効にして開始';
        showToast(`目的地「${target.name}」をセットしました！「コンパスを有効にして開始」をタップしてください。`, false, 4500);
      })
      .catch((err) => {
        showToast(err.message || '共有URLの解析に失敗しました。', true, 5000);
        els.btnStartFromClipboard.hidden = false;
        els.btnStartPreloadedTarget.hidden = true;
      });
  }

  // イベント登録
  els.btnStartFromClipboard.addEventListener('click', onOneTapClipboardStartClick);
  els.btnReloadClipboard.addEventListener('click', onOneTapClipboardStartClick);

  els.btnStartPreloadedTarget.addEventListener('click', () => {
    onStartWithTargetClick(state.destination);
  });

  els.btnResumeSavedTarget.addEventListener('click', () => {
    if (state.savedDestination) {
      onStartWithTargetClick(state.savedDestination);
    }
  });

  els.btnToggleManual.addEventListener('click', () => {
    const isHidden = els.manualCollapseArea.hidden;
    els.manualCollapseArea.hidden = !isHidden;
    els.btnToggleManual.setAttribute('aria-expanded', String(isHidden));
    els.manualChevron.classList.toggle('open', isHidden);
    if (isHidden) {
      setTimeout(() => els.manualUrlInput.focus(), 50);
    }
  });

  els.manualUrlForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.sensorsStarted) {
      if (
        typeof window.DeviceOrientationEvent !== 'undefined' &&
        typeof window.DeviceOrientationEvent.requestPermission === 'function'
      ) {
        window.DeviceOrientationEvent.requestPermission().catch(() => {});
      }
      activateTrackingServices();
    }

    const raw = els.manualUrlInput.value;
    if (!raw || !raw.trim()) return;

    els.btnResolveUrl.disabled = true;
    els.btnResolveUrl.textContent = '解析中';
    try {
      const target = await resolveGoogleMapsTarget(raw);
      setAndSaveDestination(target);
      showToast(`目的地「${target.name}」を設定しました！`, false, 3000);
    } catch (err) {
      showToast(err.message || 'URLの解析に失敗しました。', true, 5000);
    } finally {
      els.btnResolveUrl.disabled = false;
      els.btnResolveUrl.textContent = '開始';
    }
  });

  document.querySelectorAll('.preset-chip[data-sample]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const sample = btn.getAttribute('data-sample');
      if (!sample) return;
      if (!state.sensorsStarted) {
        activateTrackingServices();
      }
      els.manualUrlInput.value = sample;
      try {
        const target = await resolveGoogleMapsTarget(sample);
        setAndSaveDestination(target);
        showToast(`サンプル「${target.name}」をセットして計測を開始しました！`, false, 2500);
      } catch (err) {
        showToast(err.message || '解析エラー', true);
      }
    });
  });
}

document.addEventListener('DOMContentLoaded', initApp);
