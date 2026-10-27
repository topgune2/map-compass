import type { NextConfig } from 'next';

const isGithubPages = process.env.GITHUB_PAGES === 'true';
const repoName = process.env.GITHUB_REPOSITORY ? `/${process.env.GITHUB_REPOSITORY.split('/')[1]}` : '';

const nextConfig: NextConfig = {
  // GitHub Pages 向けビルド時は静的エクスポートを有効化（ローカル/Vercel実行時はAPI Route `/api/resolve-url` も動作）
  output: isGithubPages ? 'export' : undefined,
  basePath: isGithubPages ? repoName : '',
  assetPrefix: isGithubPages ? repoName : undefined,
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
