/**
 * Curator API - 本地 API 服務
 *
 * 這是 Curator 人格的對外接口
 * 可以被其他 Agent 或腳本調用
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { readFile } from 'fs/promises';
import { join } from 'path';

const execAsync = promisify(exec);

export interface VisualAnalysis {
  analyzed_at: string;
  dominant_colors: string[];
  theme: string;
  mood: string;
  key_elements: string[];
  content_type: 'product' | 'highlight' | 'banner' | 'video' | 'icon';
  analysis_confidence: number;
}

export interface CuratorAPI {
  // 視覺分析
  analyzeImage(imageUrl: string): Promise<VisualAnalysis>;

  // 記憶管理
  getMemory(): Promise<any>;
  refreshMemory(): Promise<void>;
  checkMemoryFreshness(): Promise<{ needs_refresh: boolean; stale_data: string[] }>;

  // 能力查詢
  getCapabilities(): Promise<Record<string, any>>;

  // 課程資料
  getCourse(courseId: number): Promise<any>;
  getAllCourses(): Promise<any[]>;
}

/**
 * 分析圖片（從 course_id 取得最新 URL）
 */
async function analyzeImageByCourseId(courseId: number, imageType: 'main_image' | 'content_video' | string): Promise<VisualAnalysis> {
  // 1. 從 Notion 取得最新圖片 URL（避免過期問題）
  const { getProductById } = await import('@/lib/notion');
  const memory = await getMemory();
  const course = memory.courses.find((c: any) => c.course_id === courseId);

  if (!course) {
    throw new Error(`Course ${courseId} not found`);
  }

  // 2. 從 Notion 取得新鮮的 URL
  const freshData = await getProductById(course.notion_page_id);
  let imageUrl: string | null = null;

  if (imageType === 'main_image') {
    imageUrl = freshData.image;
  } else if (imageType === 'content_video') {
    imageUrl = freshData.content_video;
  } else if (imageType.startsWith('highlight')) {
    const num = parseInt(imageType.replace('highlight', ''));
    imageUrl = (freshData as any)[`content_highlight${num}_image`] || freshData.image;
  }

  if (!imageUrl) {
    throw new Error(`No ${imageType} found for course ${courseId}`);
  }

  // 3. 下載圖片
  const tempDir = '/tmp/curator_images';
  const timestamp = Date.now();
  const imagePath = `${tempDir}/${timestamp}.png`;

  await execAsync(`mkdir -p ${tempDir}`);
  await execAsync(
    `curl -s -A "Mozilla/5.0" -o "${imagePath}" "${imageUrl}"`
  );

  // 4. 返回圖片路徑供分析
  return {
    analyzed_at: new Date().toISOString(),
    dominant_colors: [],
    theme: 'pending_analysis',
    mood: 'pending_analysis',
    key_elements: [],
    content_type: 'product',
    analysis_confidence: 0,
    _downloaded_path: imagePath,
    _course_id: courseId,
    _image_type: imageType,
    _note: '請使用 Read tool 讀取 _downloaded_path 進行實際分析'
  } as any;
}

/**
 * 直接下載 URL
 * 注意：Notion URL 會過期，建議使用 analyzeImageByCourseId()
 */
async function analyzeImage(imageUrl: string): Promise<VisualAnalysis> {
  // 下載圖片
  const tempDir = '/tmp/curator_images';
  const timestamp = Date.now();
  const imagePath = `${tempDir}/${timestamp}.png`;

  await execAsync(`mkdir -p ${tempDir}`);

  try {
    await execAsync(
      `curl -s -L -A "Mozilla/5.0" -o "${imagePath}" "${imageUrl}"`
    );

    // 檢查檔案是否成功下載
    const { stdout } = await execAsync(`file "${imagePath}"`);

    if (stdout.includes('HTML') || stdout.includes('text')) {
      throw new Error('URL 可能已過期或無效（下載到 HTML 而非圖片）。建議使用 analyzeImageByCourseId()。');
    }

    return {
      analyzed_at: new Date().toISOString(),
      dominant_colors: [],
      theme: 'pending_analysis',
      mood: 'pending_analysis',
      key_elements: [],
      content_type: 'product',
      analysis_confidence: 0,
      _downloaded_path: imagePath,
      _source_url: imageUrl,
      _note: '請使用 Read tool 讀取 _downloaded_path 進行實際分析'
    } as any;

  } catch (error: any) {
    throw new Error(`圖片下載失敗: ${error.message}`);
  }
}

/**
 * 讀取記憶
 */
async function getMemory(): Promise<any> {
  const memoryPath = join(process.cwd(), '.kiro/personas/curator/memory.json');
  const content = await readFile(memoryPath, 'utf-8');
  return JSON.parse(content);
}

/**
 * 重新整理記憶
 */
async function refreshMemory(): Promise<void> {
  const scriptPath = join(process.cwd(), '.kiro/scripts/curator/run-v1.5.sh');
  await execAsync(scriptPath);
}

/**
 * 檢查記憶時效性
 */
async function checkMemoryFreshness(): Promise<{ needs_refresh: boolean; stale_data: string[] }> {
  const scriptPath = join(process.cwd(), '.kiro/scripts/curator/check-memory-freshness.ts');
  const { stdout } = await execAsync(`pnpm tsx ${scriptPath}`);

  // 解析輸出判斷是否需要更新
  const needsRefresh = stdout.includes('建議執行');
  const staleData: string[] = [];

  if (stdout.includes('過期課程資料')) staleData.push('courses');
  if (stdout.includes('過期定價資料')) staleData.push('pricing');
  if (stdout.includes('過期圖片資料')) staleData.push('images');

  return { needs_refresh: needsRefresh, stale_data: staleData };
}

/**
 * 取得能力狀態
 */
async function getCapabilities(): Promise<Record<string, any>> {
  const memory = await getMemory();
  return memory.capabilities;
}

/**
 * 取得單一課程
 */
async function getCourse(courseId: number): Promise<any> {
  const memory = await getMemory();
  return memory.courses.find((c: any) => c.course_id === courseId);
}

/**
 * 取得所有課程
 */
async function getAllCourses(): Promise<any[]> {
  const memory = await getMemory();
  return memory.courses;
}

// 導出 API
export const curator = {
  analyzeImage, // 支援直接 URL
  analyzeImageByCourseId, // 推薦使用（避免 URL 過期）
  getMemory,
  refreshMemory,
  checkMemoryFreshness,
  getCapabilities,
  getCourse,
  getAllCourses
};

// CLI 使用
if (require.main === module) {
  const command = process.argv[2];
  const args = process.argv.slice(3);

  (async () => {
    switch (command) {
      case 'analyze-image':
        // 支援三種模式：URL、course_id 或本地檔案路徑
        const firstArg = args[0];

        let result;
        if (firstArg.startsWith('http://') || firstArg.startsWith('https://')) {
          // URL 模式
          result = await analyzeImage(firstArg);
        } else if (firstArg.startsWith('/') || firstArg.startsWith('./') || firstArg.startsWith('~/')) {
          // 本地檔案路徑模式
          result = {
            analyzed_at: new Date().toISOString(),
            dominant_colors: [],
            theme: 'pending_analysis',
            mood: 'pending_analysis',
            key_elements: [],
            content_type: 'product',
            analysis_confidence: 0,
            _local_path: firstArg,
            _note: '請使用 Read tool 讀取 _local_path 進行實際分析'
          };
        } else {
          // course_id 模式
          const courseId = parseInt(firstArg);
          const imageType = args[1] || 'main_image';
          result = await analyzeImageByCourseId(courseId, imageType);
        }

        console.log(JSON.stringify(result, null, 2));
        break;

      case 'get-memory':
        const memory = await getMemory();
        console.log(JSON.stringify(memory, null, 2));
        break;

      case 'check-freshness':
        const freshness = await checkMemoryFreshness();
        console.log(JSON.stringify(freshness, null, 2));
        break;

      case 'get-capabilities':
        const caps = await getCapabilities();
        console.log(JSON.stringify(caps, null, 2));
        break;

      default:
        console.log(`
Curator API

使用方式:
  pnpm tsx .kiro/api/curator.ts <command> [args]

指令:
  analyze-image <course_id> [image_type]     分析圖片（使用 course_id）
  analyze-image <url>                        分析圖片（使用 URL，可能過期）
  analyze-image <file_path>                  分析圖片（使用本地檔案路徑）
  get-memory                                  取得記憶
  check-freshness                            檢查時效性
  get-capabilities                           取得能力狀態

範例:
  # 使用 course_id（推薦）
  pnpm tsx .kiro/api/curator.ts analyze-image 2 main_image
  pnpm tsx .kiro/api/curator.ts analyze-image 5 highlight1

  # 使用本地檔案
  pnpm tsx .kiro/api/curator.ts analyze-image /Users/thinkercafe/Downloads/screenshot.png

  # 使用 URL（URL 可能過期）
  pnpm tsx .kiro/api/curator.ts analyze-image "https://example.com/image.jpg"

  # 其他指令
  pnpm tsx .kiro/api/curator.ts get-memory
  pnpm tsx .kiro/api/curator.ts check-freshness
        `);
    }
  })();
}
