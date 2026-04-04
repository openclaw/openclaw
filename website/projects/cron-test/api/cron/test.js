// Vercel Cron Job 觸發 Paomateng GitHub Workflow
export default async function handler(req, res) {
  // 檢查是否為 Cron Job 呼叫
  const triggerType = req.headers['user-agent']?.includes('vercel-cron') ? '🤖 Cron job' : '🌐 手動觸發';
  console.log(`${triggerType} 執行中...`);

  const timestamp = new Date().toISOString();
  const taipeiTime = new Date().toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });

  // GitHub API 設定
  const REPO_OWNER = 'ThinkerCafe-tw';
  const REPO_NAME = 'paomateng';
  const WORKFLOW_ID = 'monitor.yml';
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

  let workflowResult = null;
  let workflowError = null;

  // 觸發 GitHub Workflow
  if (GITHUB_TOKEN) {
    try {
      console.log('📡 觸發 Paomateng GitHub Workflow...');

      const workflowResponse = await fetch(
        `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/${WORKFLOW_ID}/dispatches`,
        {
          method: 'POST',
          headers: {
            'Accept': 'application/vnd.github+json',
            'Authorization': `Bearer ${GITHUB_TOKEN}`,
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'Vercel-Cron-Trigger'
          },
          body: JSON.stringify({
            ref: 'main'
          })
        }
      );

      if (workflowResponse.status === 204) {
        workflowResult = {
          success: true,
          httpStatus: 204,
          message: '✅ 成功觸發 Paomateng workflow'
        };
        console.log('✅ GitHub Workflow 觸發成功');
      } else {
        const errorText = await workflowResponse.text();
        workflowResult = {
          success: false,
          httpStatus: workflowResponse.status,
          message: `❌ GitHub API 錯誤: ${workflowResponse.status}`,
          error: errorText
        };
        console.log(`❌ GitHub Workflow 觸發失敗: ${workflowResponse.status}`);
      }
    } catch (error) {
      workflowError = {
        success: false,
        message: `❌ 網路錯誤: ${error.message}`,
        error: error.toString()
      };
      console.log(`❌ 觸發 GitHub Workflow 時發生錯誤: ${error.message}`);
    }
  } else {
    workflowError = {
      success: false,
      message: '❌ 缺少 GITHUB_TOKEN 環境變數',
      error: 'GITHUB_TOKEN not found in environment variables'
    };
    console.log('⚠️ 警告: 找不到 GITHUB_TOKEN');
  }

  const responseData = {
    message: workflowResult ? workflowResult.message : (workflowError?.message || '✅ Cron 執行完成'),
    timestamp: timestamp,
    taipeiTime: taipeiTime,
    environment: process.env.VERCEL_ENV || 'development',
    triggerType: triggerType,
    workflow: workflowResult || workflowError || { message: '未執行 workflow 觸發' },
    paomatengRepo: `${REPO_OWNER}/${REPO_NAME}`,
    headers: {
      userAgent: req.headers['user-agent']
    }
  };

  console.log('📊 執行結果:', JSON.stringify(responseData, null, 2));

  // 設定 CORS 標頭
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // 回傳結果
  res.status(200).json(responseData);
}