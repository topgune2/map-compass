export interface ExtractedCoordinates {
  lat: number;
  lng: number;
  pattern: string;
  placeName?: string;
}

export function isValidLatLng(lat: number, lng: number): boolean {
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
 * 要件2: 取得した文字列から正規表現 `https?://[^\s]+` でURL部分だけを抽出する
 */
export function extractFirstUrl(rawText: string): string | null {
  if (!rawText) return null;
  const match = rawText.match(/https?:\/\/[^\s"<>]+/i);
  return match ? match[0] : null;
}

/**
 * 要件4: 最終URLまたはHTMLから指定の優先度順で緯度（lat）・経度（lng）を抽出する
 * 1. ピンの正確な座標: `!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)`
 * 2. クエリ形式の座標: `[?&](?:q|ll|query|destination)=(-?\d+\.\d+),(-?\d+\.\d+)`
 * 3. ビューポート中心座標: `@(-?\d+\.\d+),(-?\d+\.\d+)`
 * 4. HTML内のメタデータ等に含まれる座標パターン
 */
export function extractCoordinatesFromText(sourceStr: string): ExtractedCoordinates | null {
  if (!sourceStr) return null;

  let decodedStr = sourceStr;
  try {
    decodedStr = decodeURIComponent(sourceStr);
  } catch {
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
  const matchDirect = sourceStr.trim().match(/^(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)$/);
  if (matchDirect) {
    const lat = parseFloat(matchDirect[1]);
    const lng = parseFloat(matchDirect[2]);
    if (isValidLatLng(lat, lng)) {
      return { lat, lng, pattern: 'Direct Coordinates' };
    }
  }

  return null;
}

/**
 * 要件5: Haversine公式（球面三角法）で直線距離（メートル）を算出
 */
export function calculateHaversineDistanceMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 6371000; // 地球半径 (m)
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * 要件5: 現在地から見た目的地の真北基準の方位角（Bearing: 0°〜360°）を算出
 */
export function calculateBearingDegrees(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const toDeg = (rad: number) => (rad * 180) / Math.PI;

  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const deltaLambda = toRad(lng2 - lng1);

  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);

  const theta = Math.atan2(y, x);
  return (toDeg(theta) + 360) % 360;
}

/**
 * 残り距離（1km未満は m、1km以上は小数点第2位までの km 表示）
 */
export function formatDistanceDisplay(meters: number | null): { value: string; unit: 'm' | 'km' } {
  if (meters === null || Number.isNaN(meters)) {
    return { value: '---', unit: 'm' };
  }
  if (meters < 1000) {
    return { value: String(Math.round(meters)), unit: 'm' };
  }
  return { value: (meters / 1000).toFixed(2), unit: 'km' };
}
