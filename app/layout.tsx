import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Goal-Guided Brain',
  description: '面向个人目标的多模型智能协作工作空间。',
};

// Keep iOS safe-area insets available to the mobile bottom navigation,
// composer, and bottom-sheet dialogs. Without viewport-fit=cover Safari can
// place those controls under the home indicator even when the CSS uses env().
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#f7fbf9',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
