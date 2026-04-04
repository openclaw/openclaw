'use client'

import { useState, useEffect } from 'react'
import { CheckSquare, Download, X } from 'lucide-react'

interface PreparationChecklistProps {
  courseId: number
}

const checklist = [
  {
    category: '📱 手機準備',
    items: [
      '確認手機電量充足（建議 80% 以上）',
      '攜帶充電線 + 行動電源',
      '確保手機有足夠儲存空間（建議至少 2GB）'
    ]
  },
  {
    category: '🤖 App 安裝',
    items: [
      '安裝 ChatGPT app（iOS/Android）',
      '安裝 Claude app（iOS/Android）',
      '安裝 Gemini app（iOS/Android）',
      '註冊 ManyChat 帳號（免費版即可）',
      '註冊 GitHub 帳號（免費）'
    ]
  },
  {
    category: '📊 社群帳號準備',
    items: [
      '準備好 Instagram 或 Facebook 帳號密碼',
      '確認能登入 IG/FB 後台（查看數據用）',
      '如果有經營 Threads/LinkedIn，也可以準備'
    ]
  },
  {
    category: '📝 課前思考',
    items: [
      '想好你想經營的主題或產品',
      '準備 2-3 個你想用 AI 解決的實際問題',
      '帶著開放的心態，準備學習新工具'
    ]
  }
]

export default function PreparationChecklist({ courseId }: PreparationChecklistProps) {
  const [show, setShow] = useState(false)
  const [checked, setChecked] = useState<Record<string, boolean>>({})

  useEffect(() => {
    // 檢查是否三天課程都展開了
    const storageKey = `course_${courseId}_progress`
    const checkUnlock = () => {
      const saved = localStorage.getItem(storageKey)
      if (saved) {
        try {
          const progress = JSON.parse(saved)
          // 必須是三個不同的 day index (0, 1, 2)
          const daysOpened = progress.daysOpened || []
          const uniqueDays = new Set(daysOpened)

          if (uniqueDays.size === 3) {
            setShow(true)
          }
        } catch (e) {
          console.error('Failed to parse progress:', e)
        }
      }
    }

    checkUnlock()
    const interval = setInterval(checkUnlock, 1000)
    return () => clearInterval(interval)
  }, [courseId])

  const toggleCheck = (item: string) => {
    setChecked(prev => ({ ...prev, [item]: !prev[item] }))
  }

  const downloadChecklist = () => {
    const text = checklist.map(cat =>
      `${cat.category}\n${cat.items.map(item => `☐ ${item}`).join('\n')}`
    ).join('\n\n')

    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'AI自媒體工作流實戰營_課前準備清單.txt'
    a.click()
    URL.revokeObjectURL(url)
  }

  if (!show) return null

  return (
    <div className="my-8 animate-fade-in">
      <div className="bg-gradient-to-r from-purple-500/10 to-blue-500/10 rounded-xl p-6 border-2 border-purple-400/30 shadow-lg">
        <div className="flex items-start gap-4 mb-6">
          <div className="flex-shrink-0">
            <div className="w-12 h-12 bg-gradient-to-br from-purple-400 to-blue-500 rounded-full flex items-center justify-center">
              <CheckSquare className="w-6 h-6 text-white" />
            </div>
          </div>

          <div className="flex-1">
            <h3 className="text-xl font-bold text-purple-400 mb-2 flex items-center gap-2">
              <span>🏆</span>
              <span>解鎖成功！課前準備清單</span>
            </h3>
            <p className="text-sm text-gray-400">
              你已經看完完整課表，以下是上課前需要準備的事項
            </p>
          </div>

          <button
            onClick={downloadChecklist}
            className="flex-shrink-0 bg-purple-500/20 hover:bg-purple-500/30 text-purple-400 px-3 py-2 rounded-lg text-xs flex items-center gap-2 transition-colors"
          >
            <Download className="w-4 h-4" />
            <span>下載清單</span>
          </button>
        </div>

        <div className="space-y-6">
          {checklist.map((category, catIndex) => (
            <div key={catIndex} className="bg-gray-900/30 rounded-lg p-4">
              <h4 className="font-bold text-white mb-3 text-sm">
                {category.category}
              </h4>
              <div className="space-y-2">
                {category.items.map((item, itemIndex) => {
                  const key = `${catIndex}-${itemIndex}`
                  return (
                    <label
                      key={key}
                      className="flex items-start gap-3 cursor-pointer group hover:bg-gray-800/30 p-2 rounded transition-colors"
                    >
                      <input
                        type="checkbox"
                        checked={checked[key] || false}
                        onChange={() => toggleCheck(key)}
                        className="mt-0.5 w-4 h-4 rounded border-gray-600 text-purple-500 focus:ring-purple-500 focus:ring-offset-gray-900"
                      />
                      <span className={`text-sm ${checked[key] ? 'text-gray-500 line-through' : 'text-gray-300'}`}>
                        {item}
                      </span>
                    </label>
                  )
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-6 pt-4 border-t border-gray-700">
          <p className="text-xs text-gray-400 flex items-center gap-2">
            <span>💡</span>
            <span>提示：點擊項目可以打勾標記已完成。這些內容都可以在手機上完成！</span>
          </p>
        </div>
      </div>
    </div>
  )
}
