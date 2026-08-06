import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';

import './globals.css';

/**
 * `next/font` self-hosts these at build time, so there is no render-blocking
 * request to Google and no layout shift from a late font swap.
 */
const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'], display: 'swap' });
const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'Discord Music Platform',
    template: '%s · Discord Music Platform',
  },
  description:
    'Control your Discord music bot from the web: queues, playlists, playback and analytics.',
  applicationName: 'Discord Music Platform',
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#09090b' },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    // `dark` is applied here because the product is dark-first
    // (docs/UI_GUIDELINES.md). A user-facing theme toggle lands in Phase 5.
    // `suppressHydrationWarning` keeps that future toggle from tripping React
    // when it sets the class before hydration.
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className={`${geistSans.variable} ${geistMono.variable} min-h-dvh font-sans`}>
        {children}
      </body>
    </html>
  );
}
