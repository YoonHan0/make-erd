import './globals.css';
import type { Metadata } from 'next';
import { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'make_erd',
  description: 'SQL에서 사용 테이블과 관계를 분석해 ERD를 생성하는 웹앱',
};

interface RootLayoutProps {
  children: ReactNode;
}

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}

