'use client'

import { useEffect, useState } from 'react'
import { Sparkles } from 'lucide-react'

interface ProgressTrackerProps {
  courseId: number
}

interface ProgressState {
  roleSelected: boolean
  daysOpened: number[]
  scrolledToBottom: boolean
  timestamp: number
}

export default function CourseProgressTracker({ courseId }: ProgressTrackerProps) {
  const [progress, setProgress] = useState<ProgressState>({
    roleSelected: false,
    daysOpened: [],
    scrolledToBottom: false,
    timestamp: Date.now()
  })
  const [showAchievement, setShowAchievement] = useState(false)
  const [achievementText, setAchievementText] = useState('')

  const storageKey = `course_${courseId}_progress`

  // 載入進度
  useEffect(() => {
    const saved = localStorage.getItem(storageKey)
    if (saved) {
      try {
        setProgress(JSON.parse(saved))
      } catch (e) {
        console.error('Failed to parse progress:', e)
      }
    }
  }, [storageKey])

  // 儲存進度
  const saveProgress = (newProgress: Partial<ProgressState>) => {
    const updated = { ...progress, ...newProgress, timestamp: Date.now() }
    setProgress(updated)
    localStorage.setItem(storageKey, JSON.stringify(updated))
    return updated
  }

  // 追蹤角色選擇
  const trackRoleSelection = () => {
    if (!progress.roleSelected) {
      const updated = saveProgress({ roleSelected: true })
      triggerAchievement('🎉 解鎖成功！已獲得專屬 Prompt 範本')
    }
  }

  // 追蹤課程展開
  const trackDayOpened = (dayIndex: number) => {
    if (!progress.daysOpened.includes(dayIndex)) {
      const newDaysOpened = [...progress.daysOpened, dayIndex]
      const updated = saveProgress({ daysOpened: newDaysOpened })

      // 如果三天都展開了（0, 1, 2），解鎖成就
      const uniqueDays = new Set(newDaysOpened)
      if (uniqueDays.size === 3) {
        triggerAchievement('🏆 完美探索者！你已看完完整課表，獲得課前準備清單')
      }
    }
  }

  // 追蹤底部滾動
  const trackScrollToBottom = () => {
    if (!progress.scrolledToBottom) {
      saveProgress({ scrolledToBottom: true })
      triggerAchievement('🎁 早鳥彩蛋解鎖！滾動到底部查看專屬優惠')
    }
  }

  // 觸發成就動畫
  const triggerAchievement = (text: string) => {
    setAchievementText(text)
    setShowAchievement(true)
    setTimeout(() => setShowAchievement(false), 4000)
  }

  // 計算探索進度
  const explorationProgress = () => {
    let completed = 0
    let total = 5 // 角色選擇 + 3天課程 + 滾到底部

    if (progress.roleSelected) completed++
    completed += progress.daysOpened.length
    if (progress.scrolledToBottom) completed++

    return Math.round((completed / total) * 100)
  }

  // 將函數暴露給全域，讓其他組件可以調用
  useEffect(() => {
    ;(window as any).trackRoleSelection = trackRoleSelection
    ;(window as any).trackDayOpened = trackDayOpened
    ;(window as any).trackScrollToBottom = trackScrollToBottom
  }, [progress])

  const progressPercent = explorationProgress()
  const allDaysOpened = progress.daysOpened.length === 3

  return (
    <>
      {/* Progress Bar */}
      {progressPercent > 0 && (
        <div className="fixed top-20 right-4 z-50 bg-gray-900/90 backdrop-blur rounded-lg p-4 shadow-lg border border-gray-700 max-w-xs">
          <div className="flex items-center gap-3 mb-2">
            <Sparkles className="w-4 h-4 text-orange-400" />
            <span className="text-sm font-semibold text-white">探索進度</span>
          </div>
          <div className="w-full bg-gray-700 rounded-full h-2 mb-2">
            <div
              className="bg-gradient-to-r from-orange-400 to-pink-500 h-2 rounded-full transition-all duration-500"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <p className="text-xs text-gray-400">
            {progressPercent}% • {progress.roleSelected ? '✓ 角色 ' : ''}
            {progress.daysOpened.length > 0 && `✓ ${progress.daysOpened.length}/3 天`}
            {progress.scrolledToBottom && ' ✓ 完成'}
          </p>
        </div>
      )}

      {/* Achievement Notification */}
      {showAchievement && (
        <div className="fixed top-24 left-1/2 -translate-x-1/2 z-50 animate-fade-in">
          <div className="bg-gradient-to-r from-orange-500 to-pink-500 text-white px-6 py-4 rounded-lg shadow-2xl flex items-center gap-3">
            <Sparkles className="w-6 h-6 animate-pulse" />
            <span className="font-bold text-sm">{achievementText}</span>
          </div>
        </div>
      )}

      {/* All Days Unlocked Reward */}
      {allDaysOpened && !progress.scrolledToBottom && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 max-w-md animate-fade-in">
          <div className="bg-gradient-to-r from-green-500/90 to-emerald-500/90 backdrop-blur text-white px-6 py-4 rounded-lg shadow-2xl">
            <div className="flex items-start gap-3">
              <span className="text-2xl">🏆</span>
              <div>
                <h4 className="font-bold mb-1">恭喜！你已經看完完整課表</h4>
                <p className="text-sm opacity-90 mb-3">
                  獲得課前準備清單。繼續滾動到底部，還有驚喜等你！
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
