import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'Goal-Guided Brain',
  description: '面向个人目标的多模型智能协作工作空间。',
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
