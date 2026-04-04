'use client';

import Link from 'next/link';

export default function TestLineLoginPage() {
  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-lg p-8 max-w-2xl w-full">
        <h1 className="text-3xl font-bold text-gray-900 mb-6">
          LINE Login 測試頁面
        </h1>

        <div className="space-y-6">
          {/* 環境變數檢查 */}
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <h2 className="font-semibold text-blue-900 mb-2">📋 環境變數檢查</h2>
            <div className="space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-600">LIFF ID:</span>
                <span className="font-mono text-gray-900">
                  {process.env.NEXT_PUBLIC_LIFF_ID || '❌ 未設定'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">開發模式:</span>
                <span className="font-mono text-gray-900">
                  {process.env.NEXT_PUBLIC_DEV_MODE || 'false'}
                </span>
              </div>
            </div>
          </div>

          {/* 測試按鈕 */}
          <div className="space-y-3">
            <h2 className="font-semibold text-gray-900">🧪 測試選項</h2>

            <Link
              href="/line-login"
              className="block w-full bg-green-500 hover:bg-green-600 text-white font-semibold py-3 px-4 rounded-lg text-center transition-colors"
            >
              🚀 測試 LINE Login（正式模式）
            </Link>

            <Link
              href="/line-login?dev=true"
              className="block w-full bg-blue-500 hover:bg-blue-600 text-white font-semibold py-3 px-4 rounded-lg text-center transition-colors"
            >
              🔧 測試 LINE Login（開發模式）
            </Link>
          </div>

          {/* API 測試 */}
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
            <h2 className="font-semibold text-yellow-900 mb-2">🔌 API 端點</h2>
            <ul className="space-y-1 text-sm text-gray-700">
              <li>
                <code className="bg-gray-100 px-2 py-1 rounded">POST /api/line/verify-token</code>
              </li>
              <li>
                <code className="bg-gray-100 px-2 py-1 rounded">POST /api/line/login</code>
              </li>
            </ul>
          </div>

          {/* 實作狀態 */}
          <div className="bg-green-50 border border-green-200 rounded-lg p-4">
            <h2 className="font-semibold text-green-900 mb-2">✅ 已完成</h2>
            <ul className="space-y-1 text-sm text-gray-700 list-disc list-inside">
              <li>LINE Login 頁面 (/app/line-login/page.jsx)</li>
              <li>驗證 Token API (/api/line/verify-token)</li>
              <li>登入 API (/api/line/login)</li>
              <li>資料庫 Migration (LINE 欄位)</li>
            </ul>
          </div>

          {/* 待辦事項 */}
          <div className="bg-orange-50 border border-orange-200 rounded-lg p-4">
            <h2 className="font-semibold text-orange-900 mb-2">⏳ 待完成</h2>
            <ul className="space-y-1 text-sm text-gray-700 list-disc list-inside">
              <li>修改 Database Trigger 支援 LINE Login</li>
              <li>整合到現有登入頁面</li>
              <li>移除 Email/Password 登入（完全取代）</li>
              <li>建立舊用戶遷移機制</li>
            </ul>
          </div>

          {/* 說明 */}
          <div className="border-t pt-4 mt-4">
            <p className="text-sm text-gray-600">
              💡 <strong>提示：</strong>正式模式需要在 LINE App 中開啟此頁面，或設定 LIFF Endpoint URL。
              開發模式會跳過 LIFF 初始化，直接模擬登入成功。
            </p>
          </div>

          {/* 返回首頁 */}
          <Link
            href="/"
            className="block w-full bg-gray-200 hover:bg-gray-300 text-gray-800 font-semibold py-3 px-4 rounded-lg text-center transition-colors"
          >
            ← 返回首頁
          </Link>
        </div>
      </div>
    </div>
  );
}
