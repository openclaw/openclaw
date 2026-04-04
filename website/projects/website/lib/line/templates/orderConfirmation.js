/**
 * 訂單確認訊息模板
 * @param {Object} params
 * @param {string} params.studentName - 學員姓名
 * @param {string} params.orderID - 訂單編號
 * @param {string} params.courseName - 課程名稱
 * @param {number} params.amount - 金額
 * @param {string} params.paymentURL - 繳費連結
 * @returns {Object} LINE Flex Message
 */
export function createOrderConfirmationMessage({
  studentName,
  orderID,
  courseName,
  amount,
  paymentURL,
}) {
  return {
    type: 'flex',
    altText: `【思考者咖啡】訂單確認 #${orderID}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: '✅ 報名成功',
            weight: 'bold',
            size: 'xl',
            color: '#FFFFFF',
          },
        ],
        backgroundColor: '#28a745',
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
            text: '感謝您報名思考者咖啡的課程',
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
                text: '📌 下一步：請於 24 小時內完成繳費',
                size: 'sm',
                color: '#111111',
                wrap: true,
                weight: 'bold',
              },
              {
                type: 'text',
                text: '完成繳費後，我們會立即通知您',
                size: 'xs',
                color: '#666666',
                wrap: true,
                margin: 'sm',
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
              label: '前往繳費',
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
              label: '查看訂單',
              uri: paymentURL,
            },
          },
        ],
        flex: 0,
      },
    },
  };
}
