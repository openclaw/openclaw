'use client';

import { GoogleAnalytics as GA } from '@next/third-parties/google';

export default function GoogleAnalytics() {
  const gaId = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;

  if (!gaId) {
    console.warn('⚠️ Google Analytics Measurement ID not configured. Set NEXT_PUBLIC_GA_MEASUREMENT_ID in your environment.');
    return null;
  }

  return <GA gaId={gaId} />;
}
