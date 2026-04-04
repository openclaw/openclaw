import { FaCheck } from 'react-icons/fa6';
import SyllabusAccordion from '@/components/course/SyllabusAccordion';

// 將文字內容轉換為結構化 HTML
function formatText(text) {
  if (!text) return null;

  // 分段處理
  const lines = text.split('\n').filter(line => line.trim());

  return lines.map((line, index) => {
    const trimmedLine = line.trim();

    // 主標題 (以 ✓ 或 📅 開頭)
    if (trimmedLine.match(/^[✓📅📍👥⏰🎯🚀]/)) {
      return (
        <h3 key={index} className="text-xl font-bold mt-6 mb-3 text-white">
          {trimmedLine}
        </h3>
      );
    }

    // 子標題 (包含 | 或以時間格式開頭)
    if (trimmedLine.includes('|') || trimmedLine.match(/^\d{2}:\d{2}/)) {
      return (
        <div key={index} className="text-base font-semibold mt-4 mb-2 text-gray-200 pl-4">
          {trimmedLine}
        </div>
      );
    }

    // 列表項 (以 • - 開頭)
    if (trimmedLine.match(/^[•\-→]/)) {
      return (
        <div key={index} className="text-base text-gray-300 mb-1.5 pl-6 flex gap-2">
          <span className="text-orange-400 shrink-0">•</span>
          <span>{trimmedLine.replace(/^[•\-→]\s*/, '')}</span>
        </div>
      );
    }

    // 一般段落
    return (
      <p key={index} className="text-base text-gray-300 mb-3 leading-relaxed">
        {trimmedLine}
      </p>
    );
  });
}

export default function Content({ product, courseId }) {
  return (
    <div className="grid grid-cols-1 gap-x-5 gap-y-8 md:grid-cols-3 lg:grid-cols-4">
      <div className="md:col-span-2 md:row-span-2 lg:col-span-2 lg:row-span-1">
        <h2 className="mb-3 text-2xl font-semibold">你將會學到</h2>
        <div className="text-lg">
          {formatText(product.you_will_learn)}
        </div>
      </div>
      <div className="md:col-span-1 lg:col-span-1">
        <h2 className="mb-3 text-2xl font-semibold">技能提升</h2>
        <div className="flex flex-wrap gap-2">
          {product.skill_tags.map(tag => (
            <span key={tag} className="px-3 py-1 border border-slate-400 rounded-full whitespace-nowrap text-sm bg-slate-500">
              {tag}
            </span>
          ))}
        </div>
      </div>
      <div className="md:col-span-1 lg:col-span-1">
        <h2 className="mb-3 text-2xl font-semibold">包含內容</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-1 lg:grid-cols-1">
          {product.content_tags.map(tag => (
            <div key={tag} className="flex items-start gap-x-1 text-base/[1] text-gray-300">
              <FaCheck className="shrink-0" />
              <span>{tag}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="md:col-span-3 lg:col-span-4">
        <h2 className="mb-3 text-2xl font-semibold">課程大綱</h2>
        {courseId === 6 ? (
          <SyllabusAccordion syllabus={product.summery} />
        ) : (
          <div className="text-lg max-w-4xl">
            {formatText(product.summery)}
          </div>
        )}
      </div>
    </div>
  );
}
