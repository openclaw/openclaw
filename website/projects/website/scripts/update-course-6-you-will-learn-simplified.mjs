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

// 精簡版的「你將會學到」（只保留手機課程說明）
const SIMPLIFIED_YOU_WILL_LEARN = `⚡ 超重要！這是「手機課程」

✅ 你只需要帶：
• 你的手機（iOS/Android 都可以）
• 充電線 + 行動電源
• 一顆想學習的心

❌ 你不需要：
• 筆電（真的不用！）
• 寫程式（完全不用！）
• 任何技術背景

💡 為什麼用手機？
因為你平常就是用手機經營自媒體，直接學會在手機上操作，回家立刻能用！

━━━━━━━━━━━━━━━━━━━━

🎮 想知道這堂課能幫你什麼？
👇 選擇你的角色，看看專屬於你的學習路徑`;

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

// 更新 you_will_learn
async function updateYouWillLearn() {
  console.log('🔍 查詢第六課 page_id...');
  const COURSE_6_PAGE_ID = await getCourse6PageId();
  console.log('📄 Page ID:', COURSE_6_PAGE_ID);

  console.log('\n📝 更新「你將會學到」為精簡版...');

  const response = await fetch(`https://api.notion.com/v1/pages/${COURSE_6_PAGE_ID}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${NOTION_API_KEY}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      properties: {
        you_will_learn: {
          rich_text: [{
            type: 'text',
            text: { content: SIMPLIFIED_YOU_WILL_LEARN }
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
  console.log('\n📊 新的「你將會學到」內容：');
  console.log(SIMPLIFIED_YOU_WILL_LEARN);
}

// 執行
try {
  await updateYouWillLearn();
} catch (error) {
  console.error('❌ 錯誤:', error.message);
  process.exit(1);
}
