'use client';

import Script from 'next/script';
import { useEffect, Suspense } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';

declare global {
  interface Window {
    fbq: any;
    _fbq: any;
  }
}

function MetaPixelTracker() {
  const pixelId = process.env.NEXT_PUBLIC_META_PIXEL_ID;
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (!pixelId || !window.fbq) return;

    // 追蹤頁面瀏覽
    window.fbq('track', 'PageView');
  }, [pathname, searchParams, pixelId]);

  return null;
}

export default function MetaPixel() {
  const pixelId = process.env.NEXT_PUBLIC_META_PIXEL_ID;

  console.log('🔍 MetaPixel Debug:', {
    pixelId,
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV
  });

  if (!pixelId) {
    console.warn('⚠️ Meta Pixel ID not configured. Set NEXT_PUBLIC_META_PIXEL_ID in your environment.');
    return null;
  }

  console.log('✅ Meta Pixel loading with ID:', pixelId);

  return (
    <>
      <Script
        id="meta-pixel"
        strategy="afterInteractive"
        dangerouslySetInnerHTML={{
          __html: `
            !function(f,b,e,v,n,t,s)
            {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
            n.callMethod.apply(n,arguments):n.queue.push(arguments)};
            if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
            n.queue=[];t=b.createElement(e);t.async=!0;
            t.src=v;s=b.getElementsByTagName(e)[0];
            s.parentNode.insertBefore(t,s)}(window, document,'script',
            'https://connect.facebook.net/en_US/fbevents.js');
            fbq('init', '${pixelId}');
          `,
        }}
      />
      <noscript>
        <img
          height="1"
          width="1"
          style={{ display: 'none' }}
          src={`https://www.facebook.com/tr?id=${pixelId}&ev=PageView&noscript=1`}
          alt=""
        />
      </noscript>
      <Suspense fallback={null}>
        <MetaPixelTracker />
      </Suspense>
    </>
  );
}
