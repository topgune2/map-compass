import type { MetadataRoute } from 'next';

export const dynamic = 'force-static';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'ココドコ・コンパス - Googleマップ目的地ナビ',
    short_name: '目的地コンパス',
    description:
      'Googleマップの共有リンクから目的地の直線距離と方角（矢印）をリアルタイム表示するコンパスWebアプリ',
    start_url: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#060a12',
    theme_color: '#060a12',
    icons: [
      {
        src: '/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
      },
    ],
    share_target: {
      action: '/',
      method: 'GET',
      params: {
        title: 'title',
        text: 'text',
        url: 'url',
      },
    },
  };
}
