import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// 1. 모바일 뷰포트 & PWA 테마 색상 설정
export const viewport: Viewport = {
  themeColor: "#4f46e5",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

// 2. 검색엔진(SEO) 및 카카오톡/SNS 공유(Open Graph), 파비콘 메타데이터
export const metadata: Metadata = {
  metadataBase: new URL("https://briefing.soulcomfortstudio.com"),
  title: "모닝 브리핑 (Morning Briefing) - 오늘 아침 핵심 3줄 요약 & 오디오 뉴스",
  description: "바쁜 아침, 세상 돌아가는 소식을 1분 만에! 국내외 주요 시사 이슈와 뉴욕 증시 마켓 브리핑을 AI 음성(TTS)으로 들어보세요.",
  keywords: ["모닝브리핑", "간추린뉴스", "주식모닝브리핑", "뉴욕증시", "코스피", "경제뉴스", "오디오뉴스", "3줄요약"],
  authors: [{ name: "Morning Briefing Team" }],
  creator: "Morning Briefing",
  publisher: "Soul Comfort Studio",
  applicationName: "모닝 브리핑",
  manifest: "/manifest.json",
  
  // 👉 바로 이 위치에 들어갑니다!
  icons: {
    icon: "/icon.svg",
    shortcut: "/icon.svg",
    apple: "/icon.svg",
  },

  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "모닝 브리핑",
  },
  openGraph: {
    type: "website",
    locale: "ko_KR",
    url: "https://briefing.soulcomfortstudio.com",
    siteName: "모닝 브리핑 (Morning Briefing)",
    title: "모닝 브리핑 - 오늘 아침 핵심 3줄 요약 & 오디오 뉴스",
    description: "바쁜 아침, 세상 돌아가는 소식을 1분 만에! 국내외 주요 이슈와 뉴욕 증시 마켓 브리핑을 AI 음성으로 들어보세요.",
    images: [
      {
        url: "/og-image.svg",
        width: 1200,
        height: 630,
        alt: "모닝 브리핑 대표 카드 썸네일",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "모닝 브리핑 - 오늘 아침 핵심 3줄 요약 & 오디오 뉴스",
    description: "출근길 1분 완독! 핵심 3줄 요약 & 오디오 음성 브리핑",
    images: ["/og-image.svg"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <head>
        <link rel="apple-touch-icon" href="/icon.svg" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        {children}
      </body>
    </html>
  );
}
