import type React from "react"
import type { Metadata } from "next"
import { Space_Grotesk, DM_Sans, Fira_Code, Noto_Sans_TC } from "next/font/google"
import "./globals.css"
import { ThemeProvider } from "@/components/theme-provider"
import { Navigation } from "@/components/navigation"
import Footer from './Footer.js';
import GoogleAnalytics from '@/components/analytics/GoogleAnalytics';
import MetaPixel from '@/components/analytics/MetaPixel';
import { Toaster } from "@/components/ui/toaster"

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-space-grotesk",
})

const dmSans = DM_Sans({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-dm-sans",
})

const firaCode = Fira_Code({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  variable: "--font-fira-code",
})

const notoSansTC = Noto_Sans_TC({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
  variable: "--font-noto-sans-tc",
})

export const metadata: Metadata = {
  title: "思考者咖啡廳 — Thinker's Cafe",
  description: "真人。真實的改變。活的數據。",
  keywords: ["AI 課程", "ChatGPT 教學", "AI 實戰", "台灣 AI 課程", "人工智慧課程", "AI 工具", "Midjourney"],
  authors: [{ name: "Thinker Cafe" }],
  alternates: {
    canonical: "https://www.thinker.cafe",
  },
  openGraph: {
    title: "思考者咖啡廳 — Thinker's Cafe",
    description: "真人。真實的改變。活的數據。",
    url: "https://www.thinker.cafe",
    siteName: "思考者咖啡廳",
    images: [
      {
        url: "https://www.thinker.cafe/og-image.png",
        width: 1200,
        height: 630,
        alt: "Thinker Cafe - AI 實戰課程"
      }
    ],
    locale: "zh_TW",
    type: "website"
  },
  twitter: {
    card: "summary_large_image",
    title: "思考者咖啡廳 — Thinker's Cafe",
    description: "真人。真實的改變。活的數據。",
    images: ["https://www.thinker.cafe/og-image.png"]
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-video-preview': -1,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  // Organization Schema for SEO
  const organizationSchema = {
    "@context": "https://schema.org",
    "@type": "Organization",
    "name": "Thinker Cafe",
    "alternateName": "思考者咖啡",
    "url": "https://www.thinker.cafe",
    "logo": "https://www.thinker.cafe/logo.png",
    "description": "AI 時代的實戰課程平台，提供 ChatGPT、Midjourney 等 AI 工具專業培訓",
    "foundingDate": "2024",
    "address": {
      "@type": "PostalAddress",
      "addressCountry": "TW",
      "addressRegion": "台灣"
    },
    "contactPoint": {
      "@type": "ContactPoint",
      "contactType": "customer service",
      "email": "contact@thinkcafe.tw"
    },
    "sameAs": [
      // 社交媒體連結（如有的話可以添加）
      // "https://www.facebook.com/thinkercafe",
      // "https://www.instagram.com/thinkercafe"
    ]
  };

  return (
    <html lang="zh-TW" className={`${spaceGrotesk.variable} ${dmSans.variable} ${firaCode.variable} ${notoSansTC.variable} antialiased`} suppressHydrationWarning>
      <head>
        <link rel="manifest" href="/manifest.json" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="思考者咖啡廳" />
        <meta name="theme-color" content="#0a0705" />
        <meta name="mobile-web-app-capable" content="yes" />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationSchema) }}
        />
      </head>
      <body className="font-sans">
        <GoogleAnalytics />
        <MetaPixel />
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
          <div className="min-h-screen bg-[radial-gradient(circle_at_30%_70%,rgba(120,119,198,0.3),transparent_50%),linear-gradient(to_top_right,rgba(249,115,22,0.2),transparent,rgba(34,197,94,0.2)),linear-gradient(to_bottom_right,#581c87,#1e3a8a,#0f766e)]">
            <Navigation />
            {children}
            <Footer />
          </div>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  )
}
