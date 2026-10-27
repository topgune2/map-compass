'use client';

import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  ChevronDown,
  ClipboardPaste,
  Compass,
  ExternalLink,
  History,
  Link as LinkIcon,
  MapPin,
  Navigation,
  Navigation2,
  RefreshCw,
  Sun,
} from 'lucide-react';
import {
  calculateBearingDegrees,
  calculateHaversineDistanceMeters,
  extractCoordinatesFromText,
  extractFirstUrl,
  formatDistanceDisplay,
  isValidLatLng,
} from '@/lib/geo';

const STORAGE_LAST_DEST_KEY = 'map_compass_last_dest_v2';

interface DestinationTarget {
  lat: number;
  lng: number;
  name: string;
  resolvedUrl: string;
  pattern?: string;
  savedAt?: number;
}

interface DeviceOrientationEventiOS extends DeviceOrientationEvent {
  webkitCompassHeading?: number;
}

interface DeviceOrientationEventStatic {
  requestPermission?: () => Promise<'granted' | 'denied'>;
}

interface WakeLockSentinelLike {
  release: () => Promise<void>;
}

function degToCompassLabel(deg: number | null): string {
  if (deg === null || Number.isNaN(deg)) return '--';
  const dirs = [
    '北', '北北東', '北東', '東北東',
    '東', '東南東', '南東', '南南東',
    '南', '南南西', '南西', '西南西',
    '西', '西北西', '北西', '北北西',
  ];
  const idx = Math.round((((deg % 360) + 360) % 360) / 22.5) % 16;
  return dirs[idx];
}

/**
 * 要件5: 0°と360°の境界で矢印が1回転してしまわないよう、最短経路でスムーズに回転する角度補間
 */
function isIOSDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const isAppleMobile = /iPad|iPhone|iPod/.test(ua);
  const isIPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return (isAppleMobile || isIPadOS) && !/Android/i.test(ua);
}

function smoothAngle(prevContinuous: number, nextTargetNormalized: number): number {
  const currentMod = ((prevContinuous % 360) + 360) % 360;
  let diff = nextTargetNormalized - currentMod;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return prevContinuous + diff;
}

function CompassMainContent() {
  const searchParams = useSearchParams();

  const [destination, setDestination] = useState<DestinationTarget | null>(null);
  const [savedDestination, setSavedDestination] = useState<DestinationTarget | null>(null);
  const [currentPos, setCurrentPos] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);
  const [heading, setHeading] = useState<number | null>(null);
  const [sensorsStarted, setSensorsStarted] = useState(false);
  const [wakeLockActive, setWakeLockActive] = useState(false);
  const [manualInput, setManualInput] = useState('');
  const [manualOpen, setManualOpen] = useState(false);
  const [isResolving, setIsResolving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ text: string; isError?: boolean } | null>(null);

  const arrowAngleRef = useRef<number>(0);
  const roseAngleRef = useRef<number>(0);
  const watchIdRef = useRef<number | null>(null);
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);
  const manualInputRef = useRef<HTMLInputElement | null>(null);

  // 要件6: Screen Wake Lock API (`navigator.wakeLock.request('screen')`) の有効化
  const requestScreenWakeLock = useCallback(async () => {
    try {
      if (typeof navigator !== 'undefined' && 'wakeLock' in navigator) {
        const wl = await (navigator as unknown as { wakeLock: { request: (t: 'screen') => Promise<WakeLockSentinelLike> } }).wakeLock.request('screen');
        wakeLockRef.current = wl;
        setWakeLockActive(true);
      }
    } catch {
      // Wake Lock 非対応またはバッテリーセーバー時は無視
    }
  }, []);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && sensorsStarted) {
        requestScreenWakeLock();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [sensorsStarted, requestScreenWakeLock]);

  // 要件6: localStorage から前回の目的地を読み込み
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_LAST_DEST_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as DestinationTarget;
        if (parsed && isValidLatLng(parsed.lat, parsed.lng)) {
          setSavedDestination(parsed);
        }
      }
    } catch {}
  }, []);

  const saveDestination = useCallback((target: DestinationTarget) => {
    setDestination(target);
    setSavedDestination(target);
    try {
      localStorage.setItem(STORAGE_LAST_DEST_KEY, JSON.stringify({ ...target, savedAt: Date.now() }));
    } catch {}
  }, []);

  /**
   * 共有テキストまたはURLから目的地の緯度・経度を解決する（`/api/resolve-url` + 静的環境フォールバック）
   */
  const resolveTargetFromText = useCallback(
    async (rawText: string, sharedTitle = ''): Promise<DestinationTarget> => {
      const trimmed = rawText.trim();
      if (!trimmed) {
        throw new Error('テキストが空です。Googleマップで場所を「共有」→「コピー」してください。');
      }

      // 要件2-3: 取得した文字列から正規表現 (`https?://[^\s]+`) でURL部分だけを抽出する
      const extractedUrl = extractFirstUrl(trimmed);
      const nameCandidate =
        sharedTitle.trim() ||
        trimmed
          .replace(/https?:\/\/[^\s"<>]+/gi, '')
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean)[0] ||
        '';

      // すでに文字列内に座標が含まれている場合
      const direct = extractCoordinatesFromText(extractedUrl || trimmed);
      if (direct) {
        const target: DestinationTarget = {
          lat: direct.lat,
          lng: direct.lng,
          name: nameCandidate || '指定された目的地',
          resolvedUrl:
            extractedUrl || `https://www.google.com/maps/search/?api=1&query=${direct.lat},${direct.lng}`,
          pattern: direct.pattern,
        };
        saveDestination(target);
        return target;
      }

      if (!extractedUrl) {
        throw new Error('コピーされたテキスト内にGoogleマップのURL（https://...）が見つかりませんでした。');
      }

      // 要件2-4 & 要件4: 抽出したURLを `/api/resolve-url` へ送信して目的地の緯度・経度を取得
      try {
        const res = await fetch(`./api/resolve-url?url=${encodeURIComponent(extractedUrl)}`);
        if (res.ok && res.headers.get('content-type')?.includes('application/json')) {
          const data = await res.json();
          if (data && isValidLatLng(data.lat, data.lng)) {
            const target: DestinationTarget = {
              lat: data.lat,
              lng: data.lng,
              name: nameCandidate || data.placeName || 'Googleマップの目的地',
              resolvedUrl: data.resolvedUrl || extractedUrl,
              pattern: data.pattern || 'API (/api/resolve-url)',
            };
            saveDestination(target);
            return target;
          }
        }
      } catch {
        // GitHub Pages 等の静的ホスティング時は下のクライアントサイド展開へフォールバック
      }

      // GitHub Pages 等向けのクライアントサイド短縮URL展開フォールバック
      const proxyRes = await fetch(`https://r.jina.ai/${extractedUrl}`, {
        headers: { 'X-Return-Format': 'html', 'X-Engine': 'direct' },
      });
      if (proxyRes.ok) {
        const html = await proxyRes.text();
        const cleaned = html
          .replace(/center=35\.11333295%2C136\.9559495/g, '')
          .replace(/center=45\.263187%2C-121\.0885805/g, '');
        const coords = extractCoordinatesFromText(cleaned);
        if (coords) {
          const target: DestinationTarget = {
            lat: coords.lat,
            lng: coords.lng,
            name: nameCandidate || 'Googleマップの目的地',
            resolvedUrl: extractedUrl,
            pattern: coords.pattern,
          };
          saveDestination(target);
          return target;
        }

        const previewMatch = html.match(/\/maps\/preview\/place\?[^\s"<>']+/);
        if (previewMatch) {
          const previewPath = previewMatch[0]
            .replace(/&amp;/g, '&')
            .replace(/hl=en/g, 'hl=ja')
            .replace(/gl=us/g, 'gl=jp');
          const pRes = await fetch(`https://r.jina.ai/https://www.google.com${previewPath}`, {
            headers: { 'X-Return-Format': 'text', 'X-Engine': 'direct' },
          });
          if (pRes.ok) {
            const pText = await pRes.text();
            const pCoords = extractCoordinatesFromText(pText);
            if (pCoords) {
              const nameMatch = pText.match(/"0x[0-9a-f]+:0x[0-9a-f]+"\s*,\s*"([^"]+)"/i);
              const target: DestinationTarget = {
                lat: pCoords.lat,
                lng: pCoords.lng,
                name: nameCandidate || (nameMatch ? nameMatch[1] : 'Googleマップの目的地'),
                resolvedUrl: extractedUrl,
                pattern: pCoords.pattern,
              };
              saveDestination(target);
              return target;
            }
          }
        }
      }

      throw new Error('短縮URLから座標を抽出できませんでした。');
    },
    [saveDestination]
  );

  // 要件3: URLクエリパラメータ（?url=..., ?text=..., ?q=...）付きでページが開かれた場合は、自動でURLを抽出して目的地座標をセット済みの状態で待機
  useEffect(() => {
    const urlParam = searchParams.get('url') || '';
    const textParam = searchParams.get('text') || '';
    const qParam = searchParams.get('q') || '';
    const titleParam = searchParams.get('title') || '';

    const combined = [urlParam, textParam, qParam].filter(Boolean).join('\n');
    if (combined) {
      setManualInput(combined.replace(/\r?\n/g, ' '));
      setIsResolving(true);
      setStatusMessage({ text: '共有されたリンクから目的地を自動解析しています...' });
      resolveTargetFromText(combined, titleParam)
        .then((t) => {
          setStatusMessage({
            text: `目的地「${t.name}」をセットしました！「コンパスを有効にして開始」をタップしてください。`,
          });
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : '解析エラー';
          setStatusMessage({ text: msg, isError: true });
        })
        .finally(() => setIsResolving(false));
    }
  }, [searchParams, resolveTargetFromText]);

  // 要件5: 電子コンパス（スマホの向き）の取得
  const handleOrientation = useCallback((event: Event) => {
    const e = event as DeviceOrientationEventiOS;
    let nextHeading: number | null = null;

    if (typeof e.webkitCompassHeading === 'number' && !Number.isNaN(e.webkitCompassHeading)) {
      // iOSの場合: webkitCompassHeading（真北=0°、時計回り）を使用
      nextHeading = e.webkitCompassHeading;
    } else if (e.alpha !== null && e.alpha !== undefined && !Number.isNaN(e.alpha)) {
      // Android等の場合: alpha を使用し (360 - alpha) % 360 で北基準の角度に変換
      nextHeading = (360 - e.alpha + 360) % 360;
    }

    if (nextHeading !== null) {
      setHeading((nextHeading + 360) % 360);
    }
  }, []);

  /**
   * GPS測位とコンパスイベントリスナー・WakeLockを開始する内部ヘルパー
   */
  const activateTrackingListeners = useCallback(() => {
    if ('ondeviceorientationabsolute' in window) {
      window.addEventListener('deviceorientationabsolute', handleOrientation as EventListener, true);
    }
    window.addEventListener('deviceorientation', handleOrientation as EventListener, true);

    if ('geolocation' in navigator) {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }
      watchIdRef.current = navigator.geolocation.watchPosition(
        (pos) => {
          setCurrentPos({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
          });
        },
        (err) => {
          setStatusMessage({ text: `GPS取得エラー: ${err.message}`, isError: true });
        },
        {
          enableHighAccuracy: true,
          maximumAge: 0,
          timeout: 15000,
        }
      );
    }

    requestScreenWakeLock();
    setSensorsStarted(true);
  }, [handleOrientation, requestScreenWakeLock]);

  /**
   * 要件2【超重要：iOS SafariのUser Activation制約を回避する実装順序】
   * 「コピーしたリンクから開始」ワンタップボタンの onClick ハンドラ
   */
  const handleOneTapClipboardStart = async () => {
    // 1. 最優先（同期的）: 他の非同期処理より先に DeviceOrientationEvent.requestPermission() を呼び出す
    const DOEvent =
      typeof window !== 'undefined'
        ? (window.DeviceOrientationEvent as unknown as DeviceOrientationEventStatic)
        : undefined;
    const permissionPromise =
      DOEvent && typeof DOEvent.requestPermission === 'function'
        ? DOEvent.requestPermission()
        : Promise.resolve('granted' as const);

    // 2. 並行または直後: navigator.clipboard.readText() を実行してクリップボードのテキストを取得する
    const clipboardPromise =
      typeof navigator !== 'undefined' &&
      navigator.clipboard &&
      typeof navigator.clipboard.readText === 'function'
        ? navigator.clipboard.readText()
        : Promise.reject(new Error('Clipboard API unavailable'));

    setIsResolving(true);
    setStatusMessage({ text: 'コンパス有効化とコピー済みリンクの読み取りを実行中...' });

    activateTrackingListeners();

    try {
      const permState = await permissionPromise;
      if (permState !== 'granted' && isIOSDevice()) {
        setStatusMessage({
          text: 'iOSコンパスの権限が拒否されました。Safariを再読み込みして許可してください。',
          isError: true,
        });
      }
    } catch {
      // デスクトップ・Android等で requestPermission が例外を投げた場合もそのまま続行
    }

    // 3 & 4. クリップボードからテキスト取得 -> 正規表現でURL抽出 -> /api/resolve-url で座標解決
    try {
      const clipText = await clipboardPromise;
      if (!clipText || !clipText.trim()) {
        throw new Error('クリップボードが空です。');
      }
      setManualInput(clipText.replace(/\r?\n/g, ' '));
      const target = await resolveTargetFromText(clipText);
      setStatusMessage({ text: `「${target.name}」へのナビを開始しました！` });
    } catch {
      // 5. 万が一クリップボードの読み取りが拒否された場合や失敗した場合は、フォールバックとして手動ペースト用の入力欄をフォーカスして表示する
      setManualOpen(true);
      setStatusMessage({
        text: 'クリップボードを読み取れませんでした。下の入力欄にペーストしてください（コンパスは有効化済みです）。',
        isError: true,
      });
      setTimeout(() => {
        manualInputRef.current?.focus();
      }, 60);
    } finally {
      setIsResolving(false);
    }
  };

  /**
   * 要件3 & 要件6: すでに目的地がセットされている状態（Android共有起動時・前回の目的地再開時）で
   * 「コンパスを有効にして開始」をワンタップした時のハンドラ
   */
  const handleStartWithTarget = async (targetToUse: DestinationTarget) => {
    // 1. 最優先（同期的）: DeviceOrientationEvent.requestPermission() を最初に呼び出す
    const DOEvent =
      typeof window !== 'undefined'
        ? (window.DeviceOrientationEvent as unknown as DeviceOrientationEventStatic)
        : undefined;
    const permissionPromise =
      DOEvent && typeof DOEvent.requestPermission === 'function'
        ? DOEvent.requestPermission()
        : Promise.resolve('granted' as const);

    saveDestination(targetToUse);
    activateTrackingListeners();

    try {
      const perm = await permissionPromise;
      if (perm !== 'granted' && isIOSDevice()) {
        setStatusMessage({
          text: 'iOSコンパスの利用が拒否されました。Safariを再読み込みして許可してください。',
          isError: true,
        });
        return;
      }
    } catch {}

    setStatusMessage({ text: `「${targetToUse.name}」へのリアルタイム計測を開始しました！` });
  };

  useEffect(() => {
    return () => {
      if (watchIdRef.current !== null && 'geolocation' in navigator) {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }
      if (wakeLockRef.current) {
        wakeLockRef.current.release().catch(() => {});
      }
    };
  }, []);

  // 距離・方位角・矢印回転角の計算
  const distanceMeters =
    destination && currentPos
      ? calculateHaversineDistanceMeters(
          currentPos.lat,
          currentPos.lng,
          destination.lat,
          destination.lng
        )
      : null;

  const bearingDeg =
    destination && currentPos
      ? calculateBearingDegrees(
          currentPos.lat,
          currentPos.lng,
          destination.lat,
          destination.lng
        )
      : null;

  // 要件5: (目的地の方位角 Bearing - 端末の向き Heading + 360) % 360 で相対角度を算出
  const relativeArrowTarget =
    bearingDeg !== null ? ((bearingDeg - (heading ?? 0) + 360) % 360) : 0;
  arrowAngleRef.current = smoothAngle(arrowAngleRef.current, relativeArrowTarget);

  const roseTarget = heading !== null ? (360 - heading + 360) % 360 : 0;
  roseAngleRef.current = smoothAngle(roseAngleRef.current, roseTarget);

  const formattedDist = formatDistanceDisplay(distanceMeters);

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-between gap-3 px-4 py-3">
      {/* Header */}
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-sky-400/30 bg-sky-500/10 text-sky-400">
            <Compass className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-base font-extrabold tracking-tight">目的地コンパス</h1>
            <p className={`text-xs ${sensorsStarted ? 'font-semibold text-emerald-400' : 'text-slate-400'}`}>
              {sensorsStarted ? 'GPS・コンパス連動中' : 'ワンタップ開始待機中'}
            </p>
          </div>
        </div>
        {wakeLockActive && (
          <div className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-300">
            <Sun className="h-3.5 w-3.5" />
            <span>画面常時ON</span>
          </div>
        )}
      </header>

      {/* Destination Info Card */}
      <section className="rounded-2xl border border-slate-800 bg-slate-900/80 p-3 shadow-lg backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-rose-500/30 bg-rose-500/15 text-rose-400">
            <MapPin className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-extrabold tracking-wider text-sky-400">DESTINATION</span>
              <span className="font-mono text-xs text-slate-400">
                {destination ? `${destination.lat.toFixed(5)}, ${destination.lng.toFixed(5)}` : '未設定'}
              </span>
            </div>
            <h2 className="truncate text-sm font-bold text-slate-100">
              {destination
                ? destination.name
                : 'Googleマップで「共有」→「コピー」して下のボタンをタップ'}
            </h2>
          </div>
          {destination && (
            <a
              href={destination.resolvedUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-sky-400/30 bg-sky-500/15 text-sky-400"
              title="Googleマップで開く"
            >
              <ExternalLink className="h-4 w-4" />
            </a>
          )}
        </div>
      </section>

      {/* Main Action CTA (Before Tracking Starts) */}
      {!sensorsStarted && (
        <section className="flex flex-col gap-2">
          {/* 要件3: クエリパラメータ等で目的地が既にセット済みの場合は「コンパスを有効にして開始」を最優先表示 */}
          {destination ? (
            <button
              type="button"
              onClick={() => handleStartWithTarget(destination)}
              className="flex w-full items-center justify-center gap-2.5 rounded-2xl border border-emerald-400/60 bg-gradient-to-r from-emerald-600 to-sky-600 px-5 py-4 text-base font-extrabold text-white shadow-xl shadow-emerald-500/25 active:scale-[0.98]"
            >
              <Navigation className="h-5 w-5" />
              <span>コンパスを有効にして開始</span>
            </button>
          ) : (
            /* 要件2: 「コピーしたリンクから開始」ワンタップボタン（iOS / Android共通のメイン導線） */
            <button
              type="button"
              onClick={handleOneTapClipboardStart}
              disabled={isResolving}
              className="flex w-full items-center justify-center gap-2.5 rounded-2xl border border-sky-400/60 bg-gradient-to-r from-sky-500 to-emerald-500 px-5 py-4 text-base font-extrabold text-slate-950 shadow-xl shadow-sky-500/25 active:scale-[0.98] disabled:opacity-60"
            >
              <ClipboardPaste className="h-5 w-5" />
              <span>{isResolving ? 'リンクを解析中...' : 'コピーしたリンクから開始'}</span>
            </button>
          )}

          {/* 要件6: 前回の目的地が localStorage にある場合、ワンタップで再開できるボタン */}
          {!destination && savedDestination && (
            <button
              type="button"
              onClick={() => handleStartWithTarget(savedDestination)}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-800/90 px-4 py-2.5 text-xs font-bold text-slate-200 active:scale-[0.99]"
            >
              <History className="h-4 w-4 text-sky-400" />
              <span className="truncate">前回の目的地「{savedDestination.name}」で再開</span>
            </button>
          )}
        </section>
      )}

      {/* Compass & Distance Display */}
      <main className="flex flex-1 flex-col items-center justify-center gap-3 py-1">
        <div className="relative flex h-60 w-60 items-center justify-center rounded-full border-2 border-slate-700 bg-slate-950 shadow-[0_0_40px_rgba(14,165,233,0.15)]">
          {/* Rotating Cardinal Ring */}
          <div
            className="absolute inset-2 rounded-full border border-dashed border-slate-700/70 transition-transform duration-100 ease-linear"
            style={{ transform: `rotate(${roseAngleRef.current.toFixed(1)}deg)` }}
          >
            <span className="absolute left-1/2 top-1.5 -translate-x-1/2 text-xs font-extrabold text-rose-500">
              N
            </span>
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs font-bold text-slate-400">
              E
            </span>
            <span className="absolute bottom-1.5 left-1/2 -translate-x-1/2 text-xs font-bold text-slate-400">
              S
            </span>
            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs font-bold text-slate-400">
              W
            </span>
          </div>

          {/* Rotating Target Arrow (Bearing - Heading) */}
          <div
            className="relative z-10 flex h-full w-full items-center justify-center transition-transform duration-150 ease-out"
            style={{ transform: `rotate(${arrowAngleRef.current.toFixed(1)}deg)` }}
          >
            <Navigation2 className="h-32 w-32 fill-sky-400 text-sky-300 drop-shadow-[0_6px_18px_rgba(56,189,248,0.5)]" />
          </div>
        </div>

        {/* Distance Readout */}
        <div className="text-center">
          <div className="text-xs font-bold uppercase tracking-wider text-slate-400">
            目的地までの直線距離
          </div>
          <div className="mt-0.5 flex items-baseline justify-center gap-1.5">
            <span className="text-5xl font-black tabular-nums tracking-tight text-white">
              {formattedDist.value}
            </span>
            <span className="text-2xl font-extrabold text-sky-400">{formattedDist.unit}</span>
          </div>
        </div>

        {/* Telemetry */}
        <div className="grid w-full grid-cols-3 gap-2">
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-2 text-center">
            <span className="block text-[10px] text-slate-400">目的地の方角</span>
            <span className="text-xs font-bold tabular-nums">
              {bearingDeg !== null ? `${Math.round(bearingDeg)}° (${degToCompassLabel(bearingDeg)})` : '--°'}
            </span>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-2 text-center">
            <span className="block text-[10px] text-slate-400">スマホの向き</span>
            <span className="text-xs font-bold tabular-nums">
              {heading !== null ? `${Math.round(heading)}° (${degToCompassLabel(heading)})` : '--°'}
            </span>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-2 text-center">
            <span className="block text-[10px] text-slate-400">GPS精度</span>
            <span className="text-xs font-bold tabular-nums">
              {currentPos ? `±${Math.round(currentPos.accuracy)}m` : '未取得'}
            </span>
          </div>
        </div>
      </main>

      {statusMessage && (
        <div
          className={`rounded-xl border px-3 py-2 text-center text-xs font-semibold ${
            statusMessage.isError
              ? 'border-rose-500/50 bg-rose-950/60 text-rose-200'
              : 'border-sky-500/40 bg-slate-900/90 text-slate-200'
          }`}
        >
          {statusMessage.text}
        </div>
      )}

      {/* 要件6: 目的地を変更するための「新しいコピーリンクを読み込む」ボタンと、手動入力用の折りたたみフォーム */}
      <footer className="flex flex-col gap-2 rounded-2xl border border-slate-800 bg-slate-900/80 p-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleOneTapClipboardStart}
            disabled={isResolving}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-sky-400/40 bg-sky-500/15 px-3 py-2.5 text-xs font-extrabold text-sky-300 active:scale-[0.99] disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isResolving ? 'animate-spin' : ''}`} />
            <span>新しいコピーリンクを読み込む</span>
          </button>

          <button
            type="button"
            onClick={() => setManualOpen((prev) => !prev)}
            className="flex items-center gap-1 rounded-xl border border-slate-700 bg-slate-800 px-3 py-2.5 text-xs font-semibold text-slate-300"
          >
            <span>手動入力</span>
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${manualOpen ? 'rotate-180' : ''}`} />
          </button>
        </div>

        {manualOpen && (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              // 手動フォーム送信時もコンパス未開始なら同期的に requestPermission を呼ぶ
              if (!sensorsStarted) {
                const DOEvent =
                  typeof window !== 'undefined'
                    ? (window.DeviceOrientationEvent as unknown as DeviceOrientationEventStatic)
                    : undefined;
                if (DOEvent && typeof DOEvent.requestPermission === 'function') {
                  try {
                    const p = await DOEvent.requestPermission();
                    if (p === 'granted') activateTrackingListeners();
                  } catch {}
                } else {
                  activateTrackingListeners();
                }
              }
              setIsResolving(true);
              try {
                const t = await resolveTargetFromText(manualInput);
                setStatusMessage({ text: `「${t.name}」を目的地に設定しました！` });
              } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : '解析エラー';
                setStatusMessage({ text: msg, isError: true });
              } finally {
                setIsResolving(false);
              }
            }}
            className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-950 px-2.5 py-1.5"
          >
            <LinkIcon className="h-4 w-4 shrink-0 text-slate-400" />
            <input
              ref={manualInputRef}
              type="text"
              value={manualInput}
              onChange={(e) => setManualInput(e.target.value)}
              placeholder="Googleマップの共有リンクや座標をペースト..."
              className="min-w-0 flex-1 bg-transparent text-xs text-white placeholder-slate-500 outline-none"
            />
            <button
              type="submit"
              disabled={isResolving}
              className="rounded-lg bg-sky-400 px-3 py-1.5 text-xs font-extrabold text-slate-950 disabled:opacity-50"
            >
              {isResolving ? '解析中' : '開始'}
            </button>
          </form>
        )}
      </footer>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-dvh items-center justify-center text-sm text-slate-400">
          読み込み中...
        </div>
      }
    >
      <CompassMainContent />
    </Suspense>
  );
}
