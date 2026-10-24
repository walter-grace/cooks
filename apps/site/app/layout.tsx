import type { Metadata, Viewport } from 'next';
import { Newsreader } from 'next/font/google';
import './globals.css';
import { Flocks } from '@/components/Flocks';

const newsreader = Newsreader({
  subsets: ['latin'],
  weight: ['400', '500'],
  style: ['normal', 'italic'],
  display: 'swap',
  variable: '--font-newsreader',
});

export const metadata: Metadata = {
  title: 'Cooks: open-source sales engagement',
  description:
    'Cooks is open-source sales engagement you host yourself: sequences, a parallel dialer, buying signals and call coaching, with an MCP server for Claude, Grok and Cursor.',
  metadataBase: new URL('https://cooks-sales.vercel.app'),
  openGraph: {
    title: 'Cooks',
    description: 'Open-source sales engagement with an MCP server for your assistant.',
    type: 'website',
    images: ['/og.png'],
  },
  twitter: { card: 'summary_large_image', title: 'Cooks', description: 'Open-source sales engagement with an MCP server for your assistant.', images: ['/og.png'] },
  icons: { icon: '/icon.svg' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fffbf9' },
    { media: '(prefers-color-scheme: dark)', color: '#170b0e' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={newsreader.variable}>
      <head>
        {/* Defer the decorative river scene until the page has loaded, so fonts and text win the first seconds on slow networks. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "document.documentElement.classList.add('defer-art');window.addEventListener('load',function(){setTimeout(function(){var h=document.documentElement;h.classList.remove('defer-art');h.classList.add('art-in')},50)})",
          }}
        />
      </head>
      <body>
        <div className="bgart" aria-hidden="true">
          <div className="scene" />
          <div className="fade" />
          <div className="sky">
            <Flocks />
          </div>
        </div>
        {children}
      </body>
    </html>
  );
}
