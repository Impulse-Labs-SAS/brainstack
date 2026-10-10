import type { Metadata, Viewport } from 'next';
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';

import '@/styles/globals.css';

import { Providers } from '@/components/providers';

export const metadata: Metadata = {
  title: 'BrainStack',
  description: 'Shared second brain for humans and AI assistants.',
};

/*
 * The icons need no entry here: `favicon.ico`, `icon.svg` and `apple-icon.png` sit next to this file,
 * and Next links them itself. They live in `app/` rather than `public/` because the standalone build
 * the Docker image ships does not carry `public/`.
 */
export const viewport: Viewport = {
  themeColor: '#0a0a0a',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable}`}
      style={
        {
          '--font-sans': GeistSans.style.fontFamily,
          '--font-mono': GeistMono.style.fontFamily,
        } as React.CSSProperties
      }
    >
      <body className="min-h-screen bg-bg-base font-sans text-fg-primary antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
