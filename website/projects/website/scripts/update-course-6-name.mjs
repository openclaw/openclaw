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

// 新的課程名稱和描述
const NEW_NAME = '【006】AI 自媒體工作流實戰營';
const NEW_DESCRIPTION = '三天手機課程，帶走三樣成果：一週社群素材、自動化私訊機制、專屬 AI 工具包。不需要筆電，用你平常發文的手機就能學。小班制教學，每個人都完成個人專案。';

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

// 更新課程名稱和描述
async function updateCourse6Name() {
  console.log('🔍 查詢第六課 page_id...');
  const COURSE_6_PAGE_ID = await getCourse6PageId();
  console.log('📄 Page ID:', COURSE_6_PAGE_ID);

  console.log('\n📝 更新課程名稱和描述...');
  console.log('新名稱:', NEW_NAME);
  console.log('新描述:', NEW_DESCRIPTION);

  const response = await fetch(`https://api.notion.com/v1/pages/${COURSE_6_PAGE_ID}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${NOTION_API_KEY}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      properties: {
        zh_name: {
          rich_text: [{
            type: 'text',
            text: { content: NEW_NAME }
          }]
        },
        zh_description: {
          rich_text: [{
            type: 'text',
            text: { content: NEW_DESCRIPTION }
          }]
        }
      }
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`更新失敗: ${error}`);
  }

  console.log('✅ 更新成功！');
}

// 執行
try {
  await updateCourse6Name();
} catch (error) {
  console.error('❌ 錯誤:', error.message);
  process.exit(1);
}
