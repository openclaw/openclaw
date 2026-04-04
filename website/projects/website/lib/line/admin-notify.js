import { createLineClient } from './client.js';

// 管理員 LINE User ID (Cruz)
const ADMIN_LINE_USER_ID = 'U0675d76b7a4a301d583ba917eda8b32e';

/**
 * 發送新訂單通知給管理員
 * @param {Object} params
 * @param {string} params.studentName - 學員姓名
 * @param {string} params.orderID - 訂單編號
 * @param {string} params.courseName - 課程名稱
 * @param {number} params.amount - 金額
 * @param {string} params.courseVariant - 上課方式 (group/single)
 * @param {string} params.orderURL - 訂單連結
 */
export async function notifyAdminNewOrder({
  studentName,
  orderID,
  courseName,
  amount,
  courseVariant,
  orderURL,
}) {
  try {
    const client = createLineClient();

    const variantText = courseVariant === 'group' ? '小班制' : '一對一';

    const message = {
      type: 'flex',
      altText: `🔔 新訂單 #${orderID}`,
      contents: {
        type: 'bubble',
        header: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'text',
              text: '🔔 新訂單通知',
              weight: 'bold',
              size: 'xl',
              color: '#FFFFFF',
            },
          ],
          backgroundColor: '#FF6B6B',
        },
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'text',
              text: `有新的課程報名！`,
              weight: 'bold',
              size: 'md',
              margin: 'none',
            },
            {
              type: 'separator',
              margin: 'lg',
            },
            {
              type: 'box',
              layout: 'vertical',
              margin: 'lg',
              spacing: 'sm',
              contents: [
                {
                  type: 'box',
                  layout: 'baseline',
                  spacing: 'sm',
                  contents: [
                    {
                      type: 'text',
                      text: '訂單編號',
                      color: '#666666',
                      size: 'sm',
                      flex: 3,
                    },
                    {
                      type: 'text',
                      text: `#${orderID}`,
                      wrap: true,
                      color: '#111111',
                      size: 'sm',
                      flex: 5,
                      weight: 'bold',
                    },
                  ],
                },
                {
                  type: 'box',
                  layout: 'baseline',
                  spacing: 'sm',
                  contents: [
                    {
                      type: 'text',
                      text: '學員姓名',
                      color: '#666666',
                      size: 'sm',
                      flex: 3,
                    },
                    {
                      type: 'text',
                      text: studentName,
                      wrap: true,
                      color: '#111111',
                      size: 'sm',
                      flex: 5,
                      weight: 'bold',
                    },
                  ],
                },
                {
                  type: 'box',
                  layout: 'baseline',
                  spacing: 'sm',
                  contents: [
                    {
                      type: 'text',
                      text: '課程名稱',
                      color: '#666666',
                      size: 'sm',
                      flex: 3,
                    },
                    {
                      type: 'text',
                      text: courseName,
                      wrap: true,
                      color: '#111111',
                      size: 'sm',
                      flex: 5,
                    },
                  ],
                },
                {
                  type: 'box',
                  layout: 'baseline',
                  spacing: 'sm',
                  contents: [
                    {
                      type: 'text',
                      text: '上課方式',
                      color: '#666666',
                      size: 'sm',
                      flex: 3,
                    },
                    {
                      type: 'text',
                      text: variantText,
                      wrap: true,
                      color: '#111111',
                      size: 'sm',
                      flex: 5,
                    },
                  ],
                },
                {
                  type: 'box',
                  layout: 'baseline',
                  spacing: 'sm',
                  contents: [
                    {
                      type: 'text',
                      text: '課程費用',
                      color: '#666666',
                      size: 'sm',
                      flex: 3,
                    },
                    {
                      type: 'text',
                      text: `NT$ ${amount.toLocaleString()}`,
                      wrap: true,
                      color: '#28a745',
                      size: 'md',
                      flex: 5,
                      weight: 'bold',
                    },
                  ],
                },
              ],
            },
            {
              type: 'separator',
              margin: 'lg',
            },
            {
              type: 'box',
              layout: 'vertical',
              margin: 'lg',
              spacing: 'sm',
              contents: [
                {
                  type: 'text',
                  text: '🎉 恭喜！又有一位新學員加入了！',
                  size: 'sm',
                  color: '#28a745',
                  wrap: true,
                  weight: 'bold',
                },
              ],
            },
          ],
        },
        footer: {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          contents: [
            {
              type: 'button',
              style: 'primary',
              height: 'sm',
              action: {
                type: 'uri',
                label: '查看訂單詳情',
                uri: orderURL,
              },
              color: '#FF6B6B',
            },
          ],
          flex: 0,
        },
      },
    };

    await client.pushMessage(ADMIN_LINE_USER_ID, message);
    console.log(`✅ Admin notification sent for order #${orderID}`);

  } catch (error) {
    console.error('❌ Failed to send admin notification:', error);
    // 不 throw error，避免影響主要業務流程
  }
}

/**
 * 發送新用戶註冊通知給管理員
 * @param {Object} params
 * @param {string} params.userName - 用戶姓名
 * @param {string} params.userEmail - 用戶 Email
 * @param {string} params.registrationMethod - 註冊方式 (LINE/Email)
 * @param {string} params.timestamp - 註冊時間
 */
export async function notifyAdminNewRegistration({
  userName,
  userEmail,
  registrationMethod,
  timestamp,
}) {
  try {
    const client = createLineClient();

    const message = {
      type: 'text',
      text: `🆕 新用戶註冊通知\n\n` +
            `用戶姓名：${userName}\n` +
            `Email：${userEmail}\n` +
            `註冊方式：${registrationMethod}\n` +
            `註冊時間：${new Date(timestamp).toLocaleString('zh-TW')}\n\n` +
            `歡迎新朋友加入思考者咖啡大家庭！`,
    };

    await client.pushMessage(ADMIN_LINE_USER_ID, message);
    console.log(`✅ Admin registration notification sent for ${userName}`);

  } catch (error) {
    console.error('❌ Failed to send admin registration notification:', error);
    // 不 throw error，避免影響主要業務流程
  }
}

/**
 * 發送系統錯誤通知給管理員
 * @param {Object} params
 * @param {string} params.errorType - 錯誤類型
 * @param {string} params.errorMessage - 錯誤訊息
 * @param {string} params.context - 錯誤情境
 * @param {string} params.timestamp - 發生時間
 */
export async function notifyAdminError({
  errorType,
  errorMessage,
  context,
  timestamp,
}) {
  try {
    const client = createLineClient();

    const message = {
      type: 'text',
      text: `⚠️ 系統錯誤通知\n\n` +
            `錯誤類型：${errorType}\n` +
            `錯誤訊息：${errorMessage}\n` +
            `發生情境：${context}\n` +
            `發生時間：${new Date(timestamp).toLocaleString('zh-TW')}\n\n` +
            `請檢查系統狀態。`,
    };

    await client.pushMessage(ADMIN_LINE_USER_ID, message);
    console.log(`✅ Admin error notification sent: ${errorType}`);

  } catch (error) {
    console.error('❌ Failed to send admin error notification:', error);
    // 不 throw error，避免影響主要業務流程
  }
}