'use client';

import { useEffect } from 'react';
import { trackEvent } from '@/lib/analytics';

export default function TestAnalyticsPage() {
  useEffect(() => {
    // 檢查 gtag 是否已載入
    const checkGtag = () => {
      if (typeof window !== 'undefined') {
        const gtag = (window as any).gtag;
        const dataLayer = (window as any).dataLayer;

        console.log('=== GA4 Debug Info ===');
        console.log('1. gtag function exists:', typeof gtag === 'function');
        console.log('2. dataLayer exists:', Array.isArray(dataLayer));
        console.log('3. dataLayer contents:', dataLayer);
        console.log('4. GA Measurement ID:', process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID);
        console.log('=====================');
      }
    };

    // 等待 gtag 載入
    setTimeout(checkGtag, 2000);
  }, []);

  const handleTestEvent = () => {
    console.log('🔥 Testing custom event...');
    trackEvent('test_button_click', {
      button_name: '測試按鈕',
      page: 'test-analytics',
    });
    alert('✅ 測試事件已發送!請檢查瀏覽器 Console 和 Network 分頁');
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-8">
      <div className="max-w-2xl w-full bg-card/50 backdrop-blur rounded-lg p-8 space-y-6">
        <h1 className="text-3xl font-bold text-center">Google Analytics 測試頁面</h1>

        <div className="space-y-4">
          <div className="p-4 bg-blue-500/10 border border-blue-500/20 rounded">
            <h2 className="text-xl font-semibold mb-2">📊 GA4 設定資訊</h2>
            <p className="text-sm text-gray-400">Measurement ID: {process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID || '未設定'}</p>
          </div>

          <div className="p-4 bg-yellow-500/10 border border-yellow-500/20 rounded">
            <h2 className="text-xl font-semibold mb-2">🔍 檢查步驟</h2>
            <ol className="text-sm text-gray-300 space-y-2 list-decimal list-inside">
              <li>開啟瀏覽器開發者工具 (F12)</li>
              <li>切換到 <strong>Console</strong> 分頁,查看 GA4 Debug Info</li>
              <li>切換到 <strong>Network</strong> 分頁</li>
              <li>過濾: 輸入 "google-analytics" 或 "gtag" 或 "collect"</li>
              <li>點擊下方的「發送測試事件」按鈕</li>
              <li>應該會看到發送到 google-analytics.com 的請求</li>
            </ol>
          </div>

          <button
            onClick={handleTestEvent}
            className="w-full py-3 px-6 bg-gradient-to-r from-orange-500 to-pink-500 hover:from-orange-600 hover:to-pink-600 text-white font-semibold rounded-lg transition-all"
          >
            🔥 發送測試事件
          </button>

          <div className="p-4 bg-green-500/10 border border-green-500/20 rounded">
            <h2 className="text-xl font-semibold mb-2">✅ 預期結果</h2>
            <ul className="text-sm text-gray-300 space-y-1 list-disc list-inside">
              <li>Console 顯示 "gtag function exists: true"</li>
              <li>Console 顯示 "dataLayer exists: true"</li>
              <li>Network 分頁看到請求到 www.google-analytics.com/g/collect</li>
            </ul>
          </div>

          <div className="p-4 bg-purple-500/10 border border-purple-500/20 rounded">
            <h2 className="text-xl font-semibold mb-2">📈 GA4 即時報表</h2>
            <p className="text-sm text-gray-300 mb-2">同時打開 Google Analytics 查看即時數據:</p>
            <a
              href="https://analytics.google.com/analytics/web/#/p479667838/reports/intelligenthome"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block px-4 py-2 bg-white/10 hover:bg-white/20 rounded text-sm transition-all"
            >
              🔗 前往 GA4 即時報表
            </a>
          </div>

          <div className="p-4 bg-red-500/10 border border-red-500/20 rounded">
            <h2 className="text-xl font-semibold mb-2">⚠️ localhost 問題</h2>
            <p className="text-sm text-gray-300 mb-2">
              如果在 localhost 看不到資料,這是<strong>正常的</strong>。原因:
            </p>
            <ul className="text-sm text-gray-300 space-y-1 list-disc list-inside">
              <li>某些瀏覽器擴充功能會封鎖 GA (如 AdBlock)</li>
              <li>GA4 可能過濾 localhost 流量</li>
              <li>Cookie 設定問題</li>
            </ul>
            <p className="text-sm text-gray-300 mt-2">
              <strong>解決方案:</strong> 部署到 Vercel 測試,或使用無痕模式
            </p>
          </div>
        </div>

        <div className="text-center pt-4">
          <a href="/" className="text-sm text-gray-400 hover:text-white transition-colors">
            ← 返回首頁
          </a>
        </div>
      </div>
    </div>
  );
}
