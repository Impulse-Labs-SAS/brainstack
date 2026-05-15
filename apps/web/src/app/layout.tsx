import type { Metadata } from 'next';
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';

import '@/styles/globals.css';

import { Providers } from '@/components/providers';

export const metadata: Metadata = {
  title: 'BrainStack',
  description: 'Shared second brain for humans and AI assistants.',
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
