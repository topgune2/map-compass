import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '目的地コンパス - Googleマップ直線距離＆方角ナビ',
  description:
    'Googleマップの共有リンクから目的地の緯度・経度を取得し、現在地から目的地までの直線距離と方角（矢印）をリアルタイムで示すモバイル向けWebアプリ（PWA）',
  manifest: './manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: '目的地コンパス',
  },
};

export const viewport: Viewport = {
  themeColor: '#060a12',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja" className="dark">
      <body className="min-h-dvh bg-[#060a12] text-slate-50 antialiased">
        {children}
      </body>
    </html>
  );
}
