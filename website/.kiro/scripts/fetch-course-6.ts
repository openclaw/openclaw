import { Client } from '@notionhq/client';
import * as fs from 'fs';

// 手動讀取 .env.local
const envContent = fs.readFileSync('.env.local', 'utf-8');
const envLines = envContent.split('\n');
envLines.forEach(line => {
  const match = line.match(/^([^=]+)=(.*)$/);
  if (match) {
    const key = match[1].trim();
    const value = match[2].trim().replace(/^["']|["']$/g, '').replace(/\\n$/, '');
    process.env[key] = value;
  }
});

const notion = new Client({
  auth: process.env.NOTION_TOKEN,
});

const COURSE_6_PAGE_ID = '28805e9de121807aa596f976e32ae474';

async function fetchCourse6() {
  try {
    console.log('📖 讀取第六課完整資料...\n');

    // 讀取頁面內容
    const page = await notion.pages.retrieve({
      page_id: COURSE_6_PAGE_ID,
    });

    console.log('✅ 頁面資料讀取成功\n');
    console.log('=== 頁面屬性 ===\n');

    // 解析並顯示所有屬性
    if ('properties' in page) {
      const properties = page.properties;

      for (const [key, value] of Object.entries(properties)) {
        console.log(`\n【${key}】`);
        console.log(`Type: ${value.type}`);

        // 根據不同類型顯示內容
        switch (value.type) {
          case 'title':
            const title = value.title.map((t: any) => t.plain_text).join('');
            console.log(`Value: "${title}"`);
            break;
          case 'rich_text':
            const text = value.rich_text.map((t: any) => t.plain_text).join('');
            console.log(`Value: "${text}"`);
            break;
          case 'number':
            console.log(`Value: ${value.number}`);
            break;
          case 'select':
            console.log(`Value: ${value.select?.name || 'null'}`);
            break;
          case 'multi_select':
            const options = value.multi_select.map((s: any) => s.name).join(', ');
            console.log(`Value: [${options}]`);
            break;
          case 'date':
            console.log(`Value: ${value.date ? JSON.stringify(value.date) : 'null'}`);
            break;
          case 'files':
            console.log(`Files count: ${value.files.length}`);
            value.files.forEach((f: any, i: number) => {
              if (f.type === 'external') {
                console.log(`  [${i}] External: ${f.external.url}`);
              } else if (f.type === 'file') {
                console.log(`  [${i}] File: ${f.file.url}`);
              }
            });
            break;
          case 'url':
            console.log(`Value: ${value.url || 'null'}`);
            break;
          case 'checkbox':
            console.log(`Value: ${value.checkbox}`);
            break;
          default:
            console.log(`Value: (${value.type}) - 需要特殊處理`);
        }
      }
    }

    // 儲存完整資料到檔案
    const outputPath = '.kiro/personas/curator/course-6-raw.json';
    fs.writeFileSync(outputPath, JSON.stringify(page, null, 2));
    console.log(`\n\n💾 完整資料已儲存到: ${outputPath}`);

  } catch (error: any) {
    console.error('❌ 錯誤:', error.message);
    if (error.body) {
      console.error('詳細資訊:', JSON.stringify(error.body, null, 2));
    }
  }
}

fetchCourse6();
