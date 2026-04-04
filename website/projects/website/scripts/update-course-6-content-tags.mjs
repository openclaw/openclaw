import { readFileSync } from 'fs';

// 手動讀取 .env.local
const envFile = readFileSync('.env.local', 'utf8');
const env = {};
envFile.split('\n').forEach(line => {
  const [key, ...values] = line.split('=');
  if (key) {
    env[key.trim()] = values.join('=').trim().replace(/\\n|"|'/g, '');
  }
});

const NOTION_API_KEY = env.NOTION_TOKEN;
const PRODUCTS_DATABASE_ID = env.NOTION_PRODUCTS_DATABASE_ID;
const NOTION_VERSION = '2022-06-28';

// 新的包含內容標籤（符合自媒體工作流）
const NEW_CONTENT_TAGS = [
  '📱 手機友善教學',
  '📜 研習證書',
  '🤖 AI 工具包網頁',
  '👥 LINE 社群支援',
  '📚 課後錄影回放',
  '🎯 實作專案產出'
];

// 查詢第六課的 page_id
async function getCourse6PageId() {
  const response = await fetch(`https://api.notion.com/v1/databases/${PRODUCTS_DATABASE_ID}/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${NOTION_API_KEY}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      page_size: 100
    })
  });

  const data = await response.json();

  if (!response.ok) {
    console.error('❌ API 錯誤:', JSON.stringify(data, null, 2));
    throw new Error(`Notion API failed: ${data.message || 'Unknown error'}`);
  }

  const course6 = data.results.find(page => page.properties.course_id?.number === 6);

  if (!course6) {
    throw new Error('找不到第六課 (course_id = 6)');
  }

  return course6.id;
}

// 更新 content_tags
async function updateCourse6ContentTags() {
  console.log('🔍 查詢第六課 page_id...');
  const COURSE_6_PAGE_ID = await getCourse6PageId();
  console.log('📄 Page ID:', COURSE_6_PAGE_ID);

  console.log('\n📝 更新包含內容標籤...');
  console.log('新標籤:', NEW_CONTENT_TAGS);

  const response = await fetch(`https://api.notion.com/v1/pages/${COURSE_6_PAGE_ID}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${NOTION_API_KEY}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      properties: {
        content_tags: {
          multi_select: NEW_CONTENT_TAGS.map(tag => ({ name: tag }))
        }
      }
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`更新失敗: ${error}`);
  }

  console.log('✅ 更新成功！');
  console.log('\n📊 新的包含內容標籤：');
  NEW_CONTENT_TAGS.forEach((tag, i) => {
    console.log(`  ${i + 1}. ${tag}`);
  });
}

// 執行
try {
  await updateCourse6ContentTags();
} catch (error) {
  console.error('❌ 錯誤:', error.message);
  process.exit(1);
}
