import { Client } from '@notionhq/client';
import * as fs from 'fs';

// 手動讀取 .env
const envContent = fs.readFileSync('.env', 'utf-8');
const envLines = envContent.split('\n');
envLines.forEach(line => {
  const match = line.match(/^([^=]+)=(.*)$/);
  if (match) {
    const key = match[1].trim();
    const value = match[2].trim().replace(/^["']|["']$/g, '');
    process.env[key] = value;
  }
});

const notion = new Client({
  auth: process.env.NOTION_TOKEN,
});

const COURSE_6_PAGE_ID = '28805e9de121807aa596f976e32ae474';
const MEMORY_PATH = '.kiro/personas/curator/memory.json';

async function refreshCourse6Memory() {
  try {
    console.log('📖 讀取第六課最新資料...\n');

    // 讀取頁面資料
    const page = await notion.pages.retrieve({
      page_id: COURSE_6_PAGE_ID,
    });

    if (!('properties' in page)) {
      throw new Error('No properties found');
    }

    const props = page.properties;

    // 提取資料
    const getTextFromRichText = (richText: any) => {
      if (!richText || !richText.rich_text) return null;
      return richText.rich_text.map((t: any) => t.plain_text).join('');
    };

    const getTitleText = (title: any) => {
      if (!title || !title.title) return null;
      return title.title.map((t: any) => t.plain_text).join('');
    };

    const getFileUrl = (files: any) => {
      if (!files || !files.files || files.files.length === 0) return null;
      const file = files.files[0];
      if (file.type === 'external') return file.external.url;
      if (file.type === 'file') return file.file.url;
      return null;
    };

    const getNumber = (number: any) => number?.number || null;

    const updatedCourse = {
      course_id: 6,
      course_name: getTitleText(props.en_name),
      zh_name: getTextFromRichText(props.zh_name),
      pricing: {
        group_price: getNumber(props.group_price),
        group_price_early: getNumber(props.group_price_early),
        single_price: getNumber(props.single_price),
        single_price_early: getNumber(props.single_price_early),
      },
      descriptions: {
        zh_description: getTextFromRichText(props.zh_description),
        summery: getTextFromRichText(props.summery),
        you_will_learn: getTextFromRichText(props.you_will_learn),
      },
      bar_text: {
        bar_text_1: getTextFromRichText(props.bar_text_1),
        bar_text_2: getTextFromRichText(props.bar_text_2),
        bar_text_3: getTextFromRichText(props.bar_text_3),
        bar_text_4: getTextFromRichText(props.bar_text_4),
      },
      images: {
        main_image: getFileUrl(props.image),
        content_highlight1_image: getFileUrl(props.content_highlight1_image),
        content_highlight2_image: getFileUrl(props.content_highlight2_image),
        content_highlight3_image: getFileUrl(props.content_highlight3_image),
        content_highlight4_image: getFileUrl(props.content_highlight4_image),
        content_highlight5_image: getFileUrl(props.content_highlight5_image),
        content_highlight6_image: getFileUrl(props.content_highlight6_image),
      },
      content_video: getFileUrl(props.content_video),
      notion_page_id: COURSE_6_PAGE_ID,
      last_updated: new Date().toISOString(),
    };

    // 讀取現有 Memory
    let memory: any = { courses: [] };
    if (fs.existsSync(MEMORY_PATH)) {
      const memoryContent = fs.readFileSync(MEMORY_PATH, 'utf-8');
      memory = JSON.parse(memoryContent);
    }

    // 更新或新增第六課
    const course6Index = memory.courses.findIndex((c: any) => c.course_id === 6);
    if (course6Index >= 0) {
      memory.courses[course6Index] = updatedCourse;
      console.log('✅ 已更新第六課記憶');
    } else {
      memory.courses.push(updatedCourse);
      console.log('✅ 已新增第六課記憶');
    }

    memory.last_updated = new Date().toISOString();

    // 儲存回檔案
    fs.writeFileSync(MEMORY_PATH, JSON.stringify(memory, null, 2));
    console.log(`\n💾 記憶已儲存到: ${MEMORY_PATH}`);

    // 顯示摘要
    console.log('\n📋 第六課最新資料：');
    console.log('─────────────────────────────────────');
    console.log(`課程名稱: ${updatedCourse.course_name}`);
    console.log(`中文名稱: ${updatedCourse.zh_name}`);
    console.log(`\nBar 區塊:`);
    console.log(`  1. ${updatedCourse.bar_text.bar_text_1}`);
    console.log(`  2. ${updatedCourse.bar_text.bar_text_2}`);
    console.log(`  3. ${updatedCourse.bar_text.bar_text_3}`);
    console.log(`  4. ${updatedCourse.bar_text.bar_text_4}`);
    console.log(`\n價格:`);
    console.log(`  單人早鳥: ${updatedCourse.pricing.single_price_early} 元`);
    console.log(`  單人原價: ${updatedCourse.pricing.single_price} 元`);
    console.log('─────────────────────────────────────\n');

  } catch (error: any) {
    console.error('❌ 錯誤:', error.message);
    if (error.body) {
      console.error('詳細資訊:', JSON.stringify(error.body, null, 2));
    }
  }
}

refreshCourse6Memory();
