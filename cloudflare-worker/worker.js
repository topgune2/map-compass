/**
 * Cloudflare Workers - Googleマップ短縮URL展開 & 座標抽出プロキシ
 */
export default {
  async fetch(request) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json; charset=utf-8',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      const reqUrl = new URL(request.url);
      let rawInput = reqUrl.searchParams.get('url') || reqUrl.searchParams.get('text') || reqUrl.searchParams.get('q') || '';

      if (!rawInput && request.method === 'POST') {
        const body = await request.json();
        rawInput = body.url || body.text || body.q || '';
      }

      const urlMatch = String(rawInput).match(/https?:\/\/[^\s"<>]+/i);
      if (!urlMatch) {
        return new Response(JSON.stringify({ error: 'URLが見つかりません' }), { status: 400, headers: corsHeaders });
      }

      const targetUrl = urlMatch[0];
      const res = await fetch(targetUrl, {
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
          'Accept-Language': 'ja,en-US;q=0.9',
        },
      });

      const resolvedUrl = res.url || targetUrl;
      const html = await res.text();

      const extract = (str) => {
        if (!str) return null;
        let dec = str;
        try { dec = decodeURIComponent(str); } catch (_) {}
        for (const s of [str, dec]) {
          // 1. ピンの正確な座標
          const m1 = s.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
          if (m1) return { lat: parseFloat(m1[1]), lng: parseFloat(m1[2]), pattern: '1: Pin (!3d!4d)' };
          // 2. クエリ形式の座標
          const m2 = s.match(/[?&](?:q|ll|query|destination|daddr|center)=(-?\d+\.\d+),(-?\d+\.\d+)/i);
          if (m2) return { lat: parseFloat(m2[1]), lng: parseFloat(m2[2]), pattern: '2: Query (?q=lat,lng)' };
          // 3. ビューポート中心座標
          const m3 = s.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
          if (m3) return { lat: parseFloat(m3[1]), lng: parseFloat(m3[2]), pattern: '3: Viewport (@lat,lng)' };
        }
        return null;
      };

      let coords = extract(resolvedUrl) || extract(html.replace(/center=35\.11333295%2C136\.9559495/g, ''));

      // 4. HTML内のメタデータ・Place Previewデータ
      if (!coords) {
        const previewMatch = html.match(/\/maps\/preview\/place\?[^\s"<>']+/);
        if (previewMatch) {
          const pUrl = 'https://www.google.com' + previewMatch[0].replace(/&amp;/g, '&');
          const pRes = await fetch(pUrl, { headers: { 'Accept-Language': 'ja,en-US;q=0.9' } });
          const pText = await pRes.text();
          const mPrev = pText.match(/\[null,null,(-?\d+\.\d+),(-?\d+\.\d+)\]/);
          if (mPrev) {
            coords = { lat: parseFloat(mPrev[1]), lng: parseFloat(mPrev[2]), pattern: '4: HTML Metadata / Place Data' };
          }
        }
      }

      if (!coords) {
        return new Response(JSON.stringify({ error: '座標を抽出できませんでした', resolvedUrl }), { status: 422, headers: corsHeaders });
      }

      return new Response(
        JSON.stringify({
          lat: coords.lat,
          lng: coords.lng,
          resolvedUrl,
          pattern: coords.pattern,
        }),
        { status: 200, headers: corsHeaders }
      );
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
    }
  },
};
