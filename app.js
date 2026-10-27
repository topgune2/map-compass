/**
 * 目的地コンパス Ver 2.0
 * - 要件2: 「コピーしたリンクから開始」ワンタップボタン（iOS SafariのUser Activation制約を回避する実装順序）
 *   1. 最優先（同期的）: DeviceOrientationEvent.requestPermission() を最初に呼び出す
 *   2. 並行または直後: navigator.clipboard.readText() でクリップボードを取得
 *   3. 正規表現 https?://[^\s]+ でURL抽出
 *   4. /api/resolve-url（および静的環境用CORSフォールバック）で座標取得 -> 即座にトラッキング開始
 *   5. クリップボード読取失敗時は手動入力フォームを自動展開してフォーカス
 * - 要件3: Android PWA Web Share Target (?url=, ?text=, ?q=) 自動解析 + 「コンパスを有効にして開始」1タップ開始
 * - 要件6: Screen Wake Lock API (navigator.wakeLock.request('screen')) + localStorage 前回目的地のワンタップ再開
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
// 1. ユーティリティ
// ==========================================
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

/**
 * 要件5: 0°と360°の境界で矢印が1回転してしまわないよう、スムーズに回転する角度補間
 */
function smoothAngleTransition(currentContinuousAngle, targetNormalizedDeg) {
  const currentMod = ((currentContinuousAngle % 360) + 360) % 360;
  let diff = targetNormalizedDeg - currentMod;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return currentContinuousAngle + diff;
}

// ==========================================
// 2. 文字列からのURL抽出 & 座標抽出ロジック（要件2・要件4）
// ==========================================

/**
 * 要件2-3: 取得した文字列から正規表現（`https?://[^\s]+`）でURL部分だけを抽出する
 */
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

/**
 * 要件4: 以下の正規表現パターン（優先度順）で緯度（lat）・経度（lng）を抽出する
 * 1. ピンの正確な座標: `!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)`
 * 2. クエリ形式の座標: `[?&](?:q|ll|query|destination)=(-?\d+\.\d+),(-?\d+\.\d+)`
 * 3. ビューポート中心座標: `@(-?\d+\.\d+),(-?\d+\.\d+)`
 * 4. HTML内のメタデータ等に含まれる座標パターン
 */
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

  // 直接の座標文字列入力（例: "35.65858, 139.74543"）
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

/**
 * 要件2-4 & 要件4: 抽出したURLを `/api/resolve-url` へ送信して目的地の緯度・経度を取得
 * （GitHub Pages等の静的ホスティング時は自動でCORSプロキシ展開へフォールバック）
 */
async function resolveGoogleMapsTarget(rawInput, sharedTitle = '') {
  const { rawText, extractedUrl, candidateName } = parseSharedInput(rawInput, sharedTitle);

  // 1. まず入力テキストやURL自体に座標が含まれていれば即座に抽出
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

  // 2. `/api/resolve-url` へ送信（Next.js サーバー稼働時）
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
  } catch (_) {
    // GitHub Pages 等の静的ホスティングでは下のプロキシ展開へ進む
  }

  // 3. GitHub Pages（静的環境）向け：CORS対応プロキシ経由で短縮URLを展開＆HTML/Preview解析
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
      const res = await fetch(`https://r.jina.ai/${targetUrl}`, {
        headers: { 'X-Return-Format': 'html', 'X-Engine': 'direct' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { text: await res.text(), finalUrl: targetUrl };
    },
    async () => {
      const res = await fetch(`https://r.jina.ai/${targetUrl}`, {
        headers: { 'X-Return-Format': 'text' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { text: await res.text(), finalUrl: targetUrl };
    },
    async () => {
      const res = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`);
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
// 3. 距離（Haversine公式）と方位角（Bearing）の計算（要件5）
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
// 4. 電子コンパス・GPS・Screen Wake Lock 制御（要件5・要件6）
// ==========================================

/**
 * 要件6: 計測中は画面が自動スリープしないよう、`navigator.wakeLock.request('screen')` を有効化する
 */
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
 * 要件5: 電子コンパス（スマホの向き）の取得
 * - iOSの場合: `deviceorientation` イベントの `webkitCompassHeading`（真北=0°、時計回り）を使用
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

function registerCompassListeners() {
  if ('ondeviceorientationabsolute' in window && !absoluteOrientationBound) {
    window.addEventListener('deviceorientationabsolute', handleDeviceOrientation, true);
    absoluteOrientationBound = true;
  }
  if ('ondeviceorientation' in window && !fallbackOrientationBound) {
    window.addEventListener(
      'deviceorientation',
      (event) => {
        if (typeof event.webkitCompassHeading === 'number' || !event.absolute) {
          if (typeof event.webkitCompassHeading === 'number' || state.heading === null) {
            handleDeviceOrientation(event);
          }
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
      else if (err.code === 2) msg = '現在地を特定できませんでした。';
      else if (err.code === 3) msg = '位置情報の取得がタイムアウトしました。';
      els.gpsAccuracyText.textContent = 'エラー';
      showToast(msg, true);
    },
    {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 15000,
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
// 5. ワンタップ開始ボタン（要件2【超重要：iOS SafariのUser Activation制約を回避する実装順序】）
// ==========================================

/**
 * 要件2: 「コピーしたリンクから開始」ボタンのクリックハンドラ
 * 1. 最優先（同期的）: typeof DeviceOrientationEvent.requestPermission === 'function' の場合、他の非同期処理より先に呼び出す
 * 2. 並行または直後: navigator.clipboard.readText() を実行してクリップボードのテキストを取得する
 * 3. 正規表現 https?://[^\s]+ でURL抽出
 * 4. /api/resolve-url で座標を取得し、即座にトラッキング画面へ切り替え
 * 5. 万が一クリップボードの読み取りが拒否または失敗した場合は、手動ペースト用の入力欄を展開・フォーカス
 */
async function onOneTapClipboardStartClick() {
  // 1. 最優先（同期的）: 他の await を一切挟まずに DeviceOrientationEvent.requestPermission() を呼び出す
  const permissionPromise =
    typeof window.DeviceOrientationEvent !== 'undefined' &&
    typeof window.DeviceOrientationEvent.requestPermission === 'function'
      ? window.DeviceOrientationEvent.requestPermission()
      : Promise.resolve('granted');

  // 2. 並行または直後: User Activation が有効な同一ティック内で navigator.clipboard.readText() も呼び出す
  const clipboardPromise =
    navigator.clipboard && typeof navigator.clipboard.readText === 'function'
      ? navigator.clipboard.readText()
      : Promise.reject(new Error('Clipboard API unavailable'));

  els.btnStartFromClipboard.disabled = true;
  els.btnStartFromClipboardLabel.textContent = 'リンクを解析中...';
  showToast('コンパスの有効化とコピーしたリンクの解析を行っています...', false, 0);

  // コンパス権限の結果を処理してセンサーを開始
  try {
    const permState = await permissionPromise;
    if (permState === 'granted') {
      activateTrackingServices();
    } else {
      showToast('コンパスの利用が拒否されました。Safariを再読み込みして許可してください。', true);
    }
  } catch (_) {
    activateTrackingServices();
  }

  // クリップボードのテキストからURLを抽出して目的地をセット
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
    // 5. フォールバック: 手動ペースト用の入力欄を展開してフォーカスする
    openManualInputAndFocus();
    showToast(
      'クリップボードを読み取れませんでした。下の入力欄にリンクをペーストしてください（コンパスは有効化済みです）。',
      true,
      6000
    );
  } finally {
    els.btnStartFromClipboard.disabled = false;
    els.btnStartFromClipboardLabel.textContent = 'コピーしたリンクから開始';
  }
}

/**
 * 要件3 & 要件6: すでに目的地がセットされている状態（Android共有起動時・前回の目的地再開時）のワンタップ開始
 */
async function onStartWithTargetClick(targetObj) {
  // 1. 最優先（同期的）: DeviceOrientationEvent.requestPermission() を呼び出す
  const permissionPromise =
    typeof window.DeviceOrientationEvent !== 'undefined' &&
    typeof window.DeviceOrientationEvent.requestPermission === 'function'
      ? window.DeviceOrientationEvent.requestPermission()
      : Promise.resolve('granted');

  if (targetObj) {
    setAndSaveDestination(targetObj);
  }

  try {
    const permState = await permissionPromise;
    if (permState !== 'granted') {
      showToast('コンパスの利用が拒否されました。Safariを再読み込みして許可してください。', true);
      return;
    }
  } catch (_) {}

  activateTrackingServices();
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

    // 要件5: (目的地の方位角 Bearing - 端末の向き Heading + 360) % 360 で相対角度を算出
    const effectiveHeading = state.heading !== null ? state.heading : 0;
    const relativeAngle = ((bearing - effectiveHeading + 360) % 360 + 360) % 360;

    state.displayedArrowAngle = smoothAngleTransition(state.displayedArrowAngle, relativeAngle);
    els.arrowRotator.style.transform = `rotate(${state.displayedArrowAngle.toFixed(1)}deg)`;

    const isAligned = relativeAngle <= 15 || relativeAngle >= 345;
    els.compassBezel.classList.toggle('aligned', isAligned && state.heading !== null);
  }
}

// ==========================================
// 7. 初期化（Android共有クエリ自動解析 & イベント登録）
// ==========================================

function initApp() {
  if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  loadSavedDestinationFromStorage();

  // 要件3: URLクエリパラメータ（?url=..., ?text=..., ?q=...）付きでページが開かれた場合は、
  // 自動でURLを抽出して目的地座標をセット済みの状態で待機し、「コンパスを有効にして開始」のワンタップだけで計測が始まるようにする
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
    // 手動フォームの「開始」ボタンでも、コンパス未開始なら最優先で同期的に requestPermission() を呼ぶ
    if (!state.sensorsStarted) {
      const permPromise =
        typeof window.DeviceOrientationEvent !== 'undefined' &&
        typeof window.DeviceOrientationEvent.requestPermission === 'function'
          ? window.DeviceOrientationEvent.requestPermission()
          : Promise.resolve('granted');
      try {
        const perm = await permPromise;
        if (perm === 'granted') activateTrackingServices();
      } catch (_) {
        activateTrackingServices();
      }
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
      els.manualUrlInput.value = sample;
      try {
        const target = await resolveGoogleMapsTarget(sample);
        setAndSaveDestination(target);
        showToast(`サンプル「${target.name}」をセットしました！`, false, 2500);
      } catch (err) {
        showToast(err.message || '解析エラー', true);
      }
    });
  });
}

document.addEventListener('DOMContentLoaded', initApp);
