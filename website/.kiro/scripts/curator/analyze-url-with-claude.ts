#!/usr/bin/env tsx

/**
 * Curator 視覺分析 - URL 版本
 *
 * 直接使用 URL 進行分析（URL 可能過期）
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFile } from 'fs/promises';
import { join } from 'path';

const execAsync = promisify(exec);

// 顏色輸出
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(message: string, color: keyof typeof colors = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function section(title: string, step?: string) {
  console.log('');
  log(`${step ? `[${step}] ` : ''}${title}`, 'cyan');
  log('─'.repeat(60), 'cyan');
}

async function main() {
  const imageUrl = process.argv[2];

  if (!imageUrl) {
    log('❌ 請提供圖片 URL', 'red');
    console.log('');
    console.log('使用方式:');
    console.log('  pnpm tsx .kiro/scripts/curator/analyze-url-with-claude.ts "https://example.com/image.jpg"');
    process.exit(1);
  }

  log('========================================', 'bright');
  log('📸 Curator 視覺分析 (URL 模式)', 'bright');
  log('========================================', 'bright');
  console.log('');

  // Step 1: 顯示執行參數
  section('執行參數', '1/4');
  console.log(`  圖片 URL: ${imageUrl}`);
  log('  ⚠️  注意：Notion URL 可能過期，建議使用 course_id 模式', 'yellow');

  // Step 2: 下載圖片
  section('下載圖片', '2/4');
  log(`執行: pnpm tsx .kiro/api/curator.ts analyze-image "${imageUrl}"`, 'yellow');

  try {
    const { stdout: downloadOutput } = await execAsync(
      `pnpm tsx .kiro/api/curator.ts analyze-image "${imageUrl}"`
    );

    const downloadResult = JSON.parse(downloadOutput);
    const imagePath = downloadResult._downloaded_path;

    log(`✓ 圖片已下載: ${imagePath}`, 'green');

    // Step 3: 準備 Claude Code 提示詞
    section('準備 Claude Code 分析提示詞', '3/4');

    const prompt = `
請分析這張圖片：

圖片路徑: ${imagePath}
來源 URL: ${imageUrl}

請使用 Read tool 讀取該圖片，並從以下角度進行專業的視覺分析：

1. **主色調** (dominant_colors)
   - 提取 3-5 個主要顏色（Hex 格式）
   - 按照出現頻率排序

2. **設計風格/主題** (theme)
   - 描述整體設計風格（例如：現代極簡、復古、科技感、手繪風等）

3. **情緒/氛圍** (mood)
   - 分析圖片傳達的情緒或氛圍（例如：專業、溫暖、活力、沉穩等）

4. **關鍵視覺元素** (key_elements)
   - 列出 3-5 個最重要的視覺元素
   - 例如：人物、文字、圖標、背景元素等

5. **內容類型** (content_type)
   - 從以下選項中選擇：product / highlight / banner / video / icon

6. **分析信心度** (analysis_confidence)
   - 給出 0-1 之間的信心度分數
   - 1 表示非常確定，0 表示不確定

請用以下 JSON 格式輸出結果：

\`\`\`json
{
  "analyzed_at": "ISO 8601 時間戳",
  "dominant_colors": ["#RRGGBB", "#RRGGBB", ...],
  "theme": "設計風格描述",
  "mood": "情緒描述",
  "key_elements": ["元素1", "元素2", ...],
  "content_type": "類型",
  "analysis_confidence": 0.95,
  "source": {
    "url": "${imageUrl}",
    "downloaded_path": "${imagePath}"
  }
}
\`\`\`
`;

    log('提示詞已準備完成', 'green');

    // Step 4: 調用 Claude Code
    section('調用 Claude Code 進行分析', '4/4');
    log('========================= Claude Code 開始執行 =========================', 'yellow');
    console.log('');

    // 將提示詞寫入臨時檔案
    const promptPath = `/tmp/curator_prompt_${Date.now()}.txt`;
    await writeFile(promptPath, prompt);

    log(`提示詞已寫入: ${promptPath}`, 'yellow');
    log('正在調用 Claude Code...', 'yellow');
    console.log('');

    // 調用 Claude Code
    const { stdout, stderr } = await execAsync(
      `cat ${promptPath} | claude-code --verbose`,
      { maxBuffer: 10 * 1024 * 1024 } // 10MB buffer
    );

    console.log('');
    log('========================= Claude Code 執行完成 =========================', 'yellow');
    console.log('');

    log('標準輸出:', 'cyan');
    console.log(stdout);

    if (stderr) {
      log('標準錯誤:', 'yellow');
      console.log(stderr);
    }

    // 嘗試從輸出中提取 JSON
    const jsonMatch = stdout.match(/```json\n([\s\S]*?)\n```/);
    if (jsonMatch) {
      const analysis = JSON.parse(jsonMatch[1]);

      // 儲存結果
      const outputPath = join(
        process.cwd(),
        `.kiro/personas/curator/analysis_url_${Date.now()}.json`
      );

      await writeFile(outputPath, JSON.stringify(analysis, null, 2));

      console.log('');
      log('✓ 分析完成！', 'green');
      log(`結果已儲存至: ${outputPath}`, 'green');
      console.log('');
      console.log(JSON.stringify(analysis, null, 2));
    } else {
      log('⚠️  無法從輸出中提取 JSON 結果', 'yellow');
    }

  } catch (error: any) {
    log('✗ 執行失敗', 'red');
    console.error(error.message);

    if (error.message.includes('URL 可能已過期')) {
      console.log('');
      log('💡 建議使用 course_id 模式:', 'yellow');
      console.log('  pnpm tsx .kiro/scripts/curator/analyze-with-claude.ts <course_id> <image_type>');
    }

    process.exit(1);
  }

  console.log('');
  log('========================================', 'bright');
  log('分析流程完成', 'bright');
  log('========================================', 'bright');
}

// 執行
main().catch((error) => {
  log('執行錯誤:', 'red');
  console.error(error);
  process.exit(1);
});
