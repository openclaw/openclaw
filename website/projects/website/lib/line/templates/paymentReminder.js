/**
 * 繳費提醒訊息模板
 * @param {Object} params
 * @param {string} params.studentName - 學員姓名
 * @param {string} params.orderID - 訂單編號
 * @param {string} params.courseName - 課程名稱
 * @param {number} params.amount - 金額
 * @param {number} params.expiresAt - 繳費期限 (timestamp)
 * @param {string} params.paymentURL - 繳費連結
 * @returns {Object} LINE Flex Message
 */
export function createPaymentReminderMessage({
  studentName,
  orderID,
  courseName,
  amount,
  expiresAt,
  paymentURL,
}) {
  // 格式化繳費期限（台灣時間）
  const expiryDate = new Date(expiresAt);
  const dateStr = expiryDate.toLocaleDateString('zh-TW', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Taipei'
  });

  const message = {
    type: 'flex',
    altText: `【思考者咖啡】繳費提醒 #${orderID}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: '💰 繳費提醒',
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
            text: `${studentName} 您好！`,
            weight: 'bold',
            size: 'md',
            margin: 'none',
          },
          {
            type: 'text',
            text: '您的課程報名尚未完成繳費',
            size: 'sm',
            color: '#666666',
            margin: 'sm',
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
                    text: '應繳金額',
                    color: '#666666',
                    size: 'sm',
                    flex: 3,
                  },
                  {
                    type: 'text',
                    text: `NT$ ${amount.toLocaleString()}`,
                    wrap: true,
                    color: '#FF6B6B',
                    size: 'md',
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
                    text: '繳費期限',
                    color: '#666666',
                    size: 'sm',
                    flex: 3,
                  },
                  {
                    type: 'text',
                    text: dateStr,
                    wrap: true,
                    color: '#111111',
                    size: 'sm',
                    flex: 5,
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
                text: '⚠️ 請於期限內完成繳費，逾期訂單將自動取消',
                size: 'xs',
                color: '#FF6B6B',
                wrap: true,
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
              label: '立即繳費',
              uri: paymentURL,
            },
            color: '#28a745',
          },
          {
            type: 'button',
            style: 'link',
            height: 'sm',
            action: {
              type: 'uri',
              label: '查看訂單詳情',
              uri: paymentURL,
            },
          },
        ],
        flex: 0,
      },
    },
  };

  return message;
}
