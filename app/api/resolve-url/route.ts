import { NextRequest, NextResponse } from 'next/server';
import { extractCoordinatesFromText, extractFirstUrl } from '@/lib/geo';

async function resolveAndExtract(rawInput: string) {
  const targetUrl = extractFirstUrl(rawInput) || rawInput.trim();
  if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
    return NextResponse.json({ error: '有効なURLを指定してください。' }, { status: 400 });
  }

  // 1. すでにURL文字列自体に座標が含まれていれば即座に返す
  const initialExtracted = extractCoordinatesFromText(targetUrl);
  if (initialExtracted) {
    return NextResponse.json({
      lat: initialExtracted.lat,
      lng: initialExtracted.lng,
      resolvedUrl: targetUrl,
      pattern: initialExtracted.pattern,
    });
  }

  // 2. サーバー側から fetch (redirect: 'follow') を実行し、リダイレクト後の最終URLとHTMLを取得
  const response = await fetch(targetUrl, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
    },
  });

  const resolvedUrl = response.url || targetUrl;

  // 2-A. リダイレクト後の最終URLからパターンA/B/Cで抽出
  const fromResolvedUrl = extractCoordinatesFromText(resolvedUrl);
  if (fromResolvedUrl) {
    return NextResponse.json({
      lat: fromResolvedUrl.lat,
      lng: fromResolvedUrl.lng,
      resolvedUrl,
      pattern: fromResolvedUrl.pattern,
    });
  }

  // 2-B. レスポンスHTML内から抽出
  const html = await response.text();
  // Google Maps 静的OGPの日本全体デフォルト中心座標 (35.11333295, 136.9559495) は除外
  const cleanedHtml = html.replace(/center=35\.11333295%2C136\.9559495/g, '');
  const fromHtml = extractCoordinatesFromText(cleanedHtml);
  if (fromHtml) {
    return NextResponse.json({
      lat: fromHtml.lat,
      lng: fromHtml.lng,
      resolvedUrl,
      pattern: fromHtml.pattern,
    });
  }

  // 2-C. maps.app.goo.gl が /maps/place//data=!4m2!3m1!1s0x... (FTID形式) へリダイレクトされた場合、
  // HTML内の `/maps/preview/place` リンクを辿って正確なピン座標を取得
  const previewMatch = html.match(/\/maps\/preview\/place\?[^\s"<>']+/);
  if (previewMatch) {
    const previewUrl = `https://www.google.com${previewMatch[0].replace(/&amp;/g, '&')}`;
    const previewRes = await fetch(previewUrl, {
      headers: { 'Accept-Language': 'ja,en-US;q=0.9' },
    });
    const previewText = await previewRes.text();
    const fromPreview = extractCoordinatesFromText(previewText);
    if (fromPreview) {
      const nameMatch = previewText.match(/"0x[0-9a-f]+:0x[0-9a-f]+"\s*,\s*"([^"]+)"/i);
      return NextResponse.json({
        lat: fromPreview.lat,
        lng: fromPreview.lng,
        resolvedUrl,
        placeName: nameMatch ? nameMatch[1] : undefined,
        pattern: fromPreview.pattern,
      });
    }
  }

  return NextResponse.json(
    { error: 'URLから緯度・経度を抽出できませんでした。', resolvedUrl },
    { status: 422 }
  );
}

export async function GET(request: NextRequest) {
  try {
    const urlParam =
      request.nextUrl.searchParams.get('url') ||
      request.nextUrl.searchParams.get('text') ||
      request.nextUrl.searchParams.get('q') ||
      '';
    if (!urlParam) {
      return NextResponse.json({ error: 'url パラメータが必要です。' }, { status: 400 });
    }
    return await resolveAndExtract(urlParam);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const urlParam = body?.url || body?.text || body?.q || '';
    if (!urlParam) {
      return NextResponse.json({ error: 'リクエストボディに url が必要です。' }, { status: 400 });
    }
    return await resolveAndExtract(String(urlParam));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
