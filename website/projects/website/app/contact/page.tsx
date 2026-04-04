import { ContactForm } from "@/components/contact-form";
import parseMetadataTitle from '@/utils/parseMetadataTitle.js';

export const metadata = {
  title: parseMetadataTitle('聯絡我們'),
  description: '有任何課程問題或合作提案？歡迎透過聯絡表單與 Thinker Cafe 團隊聯繫，我們將儘快回覆您。',
  alternates: {
    canonical: 'https://www.thinker.cafe/contact',
  },
  openGraph: {
    title: '聯絡我們 | Thinker Cafe',
    description: '有任何課程問題或合作提案？歡迎透過聯絡表單與 Thinker Cafe 團隊聯繫',
    url: 'https://www.thinker.cafe/contact',
    siteName: 'Thinker Cafe',
    locale: 'zh_TW',
    type: 'website',
  },
};

export default function ContactPage() {
  // ContactPage Schema for SEO
  const contactPageSchema = {
    "@context": "https://schema.org",
    "@type": "ContactPage",
    "name": "聯絡 Thinker Cafe",
    "description": "有任何課程問題或合作提案？歡迎透過聯絡表單與 Thinker Cafe 團隊聯繫",
    "mainEntity": {
      "@type": "Organization",
      "name": "Thinker Cafe",
      "url": "https://www.thinker.cafe",
      "contactPoint": {
        "@type": "ContactPoint",
        "contactType": "customer service",
        "email": "contact@thinkcafe.tw",
        "availableLanguage": ["zh-TW"]
      }
    }
  };

  const faqs = [
    {
      question: '課程適合誰？我沒有技術背景可以參加嗎？',
      answer: '課程設計以「AI + 創作」為核心，不需要寫程式基礎也能上手。我們從零開始帶你打造屬於自己的創作品牌，包括內容風格定位、簡單自動化、AI 工具實作與實際社群應用，讓你用自己熟悉的方式駕馭 AI 助手。'
    },
    {
      question: '上完課我會有什麼產出？具體能做出什麼？',
      answer: '每堂課都有「對外可用」的成果輸出，像是：AI 品牌角色設定、語音輸入內容、短影音腳本、生圖素材、自動化產線流程、內容成效追蹤模型等。你將擁有一套可以反覆使用的 AI 創作流程。'
    },
    {
      question: '這不是 AI 工程師課程，我真的能學會嗎？',
      answer: '絕對可以。我們強調的是「用 AI 當助手」，不是學 AI 的原理。你會學到怎麼給 AI 指令、設計腳本、整合工具，甚至用它幫你規劃流程與創作，核心是「概念轉現金」的實戰操作。'
    },
    /*
    {
      question: '我可以邊工作邊上課嗎？每週進度會不會跟不上？',
      answer: '課程設計採「模組化｜任務驅動」的方式，你可以依照自己的步調完成每章任務。我們也會提供每週回顧、群組討論、AI 小助理支援，協助你持續前進。'
    },
    */
    {
      question: '課程內容會一直過時嗎？AI 進步這麼快，學了會不會馬上被淘汰？',
      answer: '正因為 AI 太快，我們不教單一工具，而是幫你建立：通用創作邏輯、AI 提示語感、內容模組結構、Notion 流程架構。這樣不論工具怎麼變，你都能持續使用與優化。'
    },
    /*
    {
      question: '我還沒有明確的品牌主題或定位，這樣可以參加嗎？',
      answer: '完全可以。Lesson 1–3 就是為此設計，幫助你釐清方向、試驗風格、錄製 Podcast、產出短影音，邊做邊找到你真正想說的話與對的人群。'
    },
    */
    /*
    {
      question: '你們有提供錄影回放嗎？我無法固定時間參與。',
      answer: '有，所有課程皆同步錄製，可於 Notion 教室中觀看、下載講義與提交作業。我們也會開放錄影現場觀摩，讓你貼近實戰節奏。'
    },
    */
    /*
    {
      question: '完課之後，我可以怎麼繼續和 Thinker Cafe 保持連結？',
      answer: '我們會邀請學員進入共學社群、專案實作、Podcast 訪談，並可進一步參與創作者飛輪計畫，讓作品走向收入變現。'
    },
    */
    {
      question: '你們會協助曝光嗎？我內容做好了但沒人看怎麼辦？',
      answer: '我們會教你設計內容金句、分析貼文成效（按讚數、觀看數、短連結點擊）、透過 Threads / IG 建立飛輪。未來也會選出優秀學員協助曝光與合作。'
    }
  ];

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(contactPageSchema) }}
      />
      <section className="relative overflow-hidden py-16 sm:py-20 lg:py-32">
        <div className="container mx-auto px-4 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-2xl text-center">
            <h1 className="font-heading text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight">
              開啟與我們的 <span className="text-primary">對話</span>
            </h1>
            <p className="mt-4 sm:mt-6 text-sm sm:text-base lg:text-lg text-gray-400 max-w-xl mx-auto">
              無論您想更深入了解課程、討論合作、或交流心得，都歡迎與我們聯繫！
            </p>
          </div>
        </div>

        <div className="absolute inset-0 -z-10 overflow-hidden">
          <div className="absolute left-1/2 top-1/2 h-[400px] sm:h-[600px] w-[400px] sm:w-[600px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-gradient-to-r from-primary/5 to-accent/5 blur-3xl" />
        </div>
      </section>

      <section className="pb-16 sm:pb-20">
        <div className="container mx-auto px-4 sm:px-6 lg:px-8">
          <ContactForm />
        </div>
      </section>

      <section className="py-16 sm:py-20 bg-muted/30">
        <div className="container mx-auto px-4 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-2xl text-center mb-12 sm:mb-16">
            <h2 className="font-heading text-2xl sm:text-3xl lg:text-4xl font-bold">
              常見問題
            </h2>
          </div>
          <div className="mx-auto max-w-3xl space-y-4 sm:space-y-6">
            {faqs.map(({ question, answer }) => (
              <div key={question} className="rounded-lg bg-card/50 backdrop-blur p-4 sm:p-6">
                <h3 className="font-heading text-base sm:text-lg font-semibold mb-2">
                  {question}
                </h3>
                <p className="text-muted-foreground text-xs sm:text-sm">
                  {answer}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
