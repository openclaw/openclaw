'use client'

import { useState, useEffect } from 'react'
import { Check, Copy } from 'lucide-react'

interface Role {
  id: string
  title: string
  emoji: string
  description: string
  benefits: string[]
  outcomes: string[]
  promptTemplate: {
    title: string
    content: string
  }
}

const roles: Role[] = [
  {
    id: 'social-media-manager',
    title: '小編/社群經理',
    emoji: '📱',
    description: '每天要產出大量內容，希望用 AI 提升效率',
    benefits: [
      '30 分鐘產出一週完整社群素材（圖+文）',
      '建立自動化私訊機制，不用手動回覆',
      '用 AI 分析數據，找出爆款內容公式'
    ],
    outcomes: [
      '一週社群素材（IG/FB/Threads 都有）',
      'ManyChat 自動私訊機制',
      '個人 AI 工具包網頁'
    ],
    promptTemplate: {
      title: 'IG 貼文靈感產生器',
      content: `你是專業的社群內容策劃師。請根據以下主題，生成 5 個 IG 貼文創意：

主題：[在這裡輸入你的主題，例如：咖啡廳新品上市]

每個創意請包含：
1. 吸睛標題（15 字內）
2. 貼文文案（150 字內，包含 emoji）
3. 建議配圖方向
4. 3-5 個相關 hashtag

請用輕鬆、親切的語氣，吸引 25-35 歲都會上班族。`
    }
  },
  {
    id: 'freelancer',
    title: '自由工作者',
    emoji: '💼',
    description: '想經營個人品牌，但不知道如何用 AI 輔助',
    benefits: [
      '建立專屬的個人風格模板，AI 學會你的語氣',
      '用手機就能生成專業圖文，不需要筆電',
      '打造可重複使用的 prompt 工具包，隨時調用'
    ],
    outcomes: [
      '個人風格 prompt 模板庫',
      '專業視覺內容（Logo/封面/貼圖）',
      '專屬 AI 助手網頁'
    ],
    promptTemplate: {
      title: '個人品牌介紹產生器',
      content: `你是專業的個人品牌顧問。請幫我生成 3 種不同場合的自我介紹：

我的背景：
- 職業：[例如：平面設計師]
- 專長：[例如：品牌視覺設計、插畫]
- 特色：[例如：擅長復古風格、喜歡手繪]
- 目標客群：[例如：咖啡廳、文創品牌]

請生成：
1. LinkedIn 個人簡介（100 字，專業正式）
2. IG 個人檔案（50 字，親切有趣）
3. 電梯簡報（30 秒口述版本）

每個版本請突出我的獨特價值，吸引目標客群。`
    }
  },
  {
    id: 'side-hustler',
    title: '上班族斜槓',
    emoji: '⚡',
    description: '下班後想經營副業，但時間有限',
    benefits: [
      '10 分鐘完成以前要 1 小時的工作',
      '學會批量生產內容，週末做好一週素材',
      '自動化互動流程，睡覺也能轉換客戶'
    ],
    outcomes: [
      '高效 AI 工作流（省 80% 時間）',
      '自動化私訊轉換機制',
      '完整自媒體經營 SOP'
    ],
    promptTemplate: {
      title: '週報快速生成器',
      content: `你是專業的工作效率顧問。請根據我本週的工作內容，生成一份專業的週報：

本週工作內容：
[請在這裡列出本週完成的 3-5 項工作，例如：
- 完成客戶 A 的提案簡報
- 參加產品規劃會議
- 處理 15 個客戶詢問]

請生成包含以下結構的週報：
1. 本週摘要（50 字，突出亮點）
2. 完成事項（條列式，量化成果）
3. 遇到的挑戰與解決方案
4. 下週規劃重點

語氣：專業但不過於正式，展現積極態度。`
    }
  }
]

export default function RoleSelector() {
  const [selectedRole, setSelectedRole] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [unlocked, setUnlocked] = useState(false)

  // 追蹤解鎖狀態
  useEffect(() => {
    if (selectedRole) {
      // 觸發進度追蹤
      if (typeof window !== 'undefined' && (window as any).trackRoleSelection) {
        (window as any).trackRoleSelection()
      }

      const timeout = setTimeout(() => setUnlocked(true), 300)
      return () => clearTimeout(timeout)
    } else {
      setUnlocked(false)
    }
  }, [selectedRole])

  const copyPrompt = (content: string) => {
    navigator.clipboard.writeText(content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const selected = roles.find(r => r.id === selectedRole)

  return (
    <div className="bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 rounded-xl p-8 mb-12 border border-gray-700">
      {/* Title */}
      <div className="text-center mb-8">
        <h2 className="text-2xl md:text-3xl font-bold text-white mb-3">
          選擇你的角色，看看這堂課能幫你什麼
        </h2>
        <p className="text-gray-400 text-sm">
          點擊最符合你的身份，查看客製化學習路徑
        </p>
      </div>

      {/* Role Cards */}
      <div className="grid md:grid-cols-3 gap-4 mb-8">
        {roles.map(role => (
          <button
            key={role.id}
            onClick={() => setSelectedRole(role.id)}
            className={`p-6 rounded-lg border-2 transition-all text-left ${
              selectedRole === role.id
                ? 'border-orange-400 bg-orange-400/10 shadow-lg shadow-orange-400/20'
                : 'border-gray-600 bg-gray-800/50 hover:border-gray-500'
            }`}
          >
            <div className="text-4xl mb-3">{role.emoji}</div>
            <h3 className="text-xl font-bold text-white mb-2">{role.title}</h3>
            <p className="text-sm text-gray-400">{role.description}</p>
          </button>
        ))}
      </div>

      {/* Selected Role Details */}
      {selected && (
        <div className="bg-gray-800/50 rounded-lg p-6 border border-orange-400/30 animate-fade-in">
          <div className="grid md:grid-cols-2 gap-6">
            {/* Benefits */}
            <div>
              <h4 className="text-lg font-bold text-orange-400 mb-4 flex items-center gap-2">
                <span>✨</span>
                <span>你將獲得的能力</span>
              </h4>
              <ul className="space-y-2">
                {selected.benefits.map((benefit, index) => (
                  <li key={index} className="flex gap-3 text-sm text-gray-300">
                    <span className="text-orange-400 shrink-0">•</span>
                    <span>{benefit}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Outcomes */}
            <div>
              <h4 className="text-lg font-bold text-orange-400 mb-4 flex items-center gap-2">
                <span>🎁</span>
                <span>三天帶走的成果</span>
              </h4>
              <ul className="space-y-2">
                {selected.outcomes.map((outcome, index) => (
                  <li key={index} className="flex gap-3 text-sm text-gray-300">
                    <span className="text-green-400 shrink-0">✓</span>
                    <span>{outcome}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* Unlocked Prompt Template */}
          {unlocked && (
            <div className="mt-6 pt-6 border-t border-gray-700 animate-fade-in">
              <div className="bg-gradient-to-r from-orange-500/10 to-pink-500/10 rounded-lg p-5 border border-orange-400/20">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-2xl">🎉</span>
                  <h4 className="text-lg font-bold text-orange-400">
                    解鎖成功！專屬 Prompt 範本
                  </h4>
                </div>

                <p className="text-sm text-gray-300 mb-4">
                  恭喜！你已解鎖「{selected.promptTemplate.title}」，複製後可直接貼到 ChatGPT 使用。
                </p>

                <div className="bg-gray-900/50 rounded-lg p-4 relative">
                  <pre className="text-xs text-gray-300 whitespace-pre-wrap font-mono leading-relaxed max-h-64 overflow-y-auto">
                    {selected.promptTemplate.content}
                  </pre>

                  <button
                    onClick={() => copyPrompt(selected.promptTemplate.content)}
                    className="absolute top-2 right-2 bg-gray-800 hover:bg-gray-700 text-white px-3 py-1.5 rounded text-xs flex items-center gap-1.5 transition-colors"
                  >
                    {copied ? (
                      <>
                        <Check className="w-3 h-3" />
                        <span>已複製</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" />
                        <span>複製</span>
                      </>
                    )}
                  </button>
                </div>

                <p className="text-xs text-gray-400 mt-3">
                  💡 提示：把 [方括號] 的內容換成你自己的資訊，就能立刻使用！
                </p>
              </div>
            </div>
          )}

          {/* CTA */}
          <div className="mt-6 pt-6 border-t border-gray-700 text-center">
            <p className="text-sm text-gray-400 mb-3">
              💡 這堂課 100% 用手機就能學，回家立刻能用
            </p>
            <a
              href="#registration"
              className="inline-block bg-orange-500 hover:bg-orange-600 text-white font-bold py-3 px-8 rounded-lg transition-colors"
            >
              立即報名 →
            </a>
          </div>
        </div>
      )}
    </div>
  )
}
