import {
  Html,
  Head,
  Preview,
  Body,
  Container,
  Section,
  Text,
  Link,
  Hr,
  Button,
} from '@react-email/components';

interface PaymentReminderEmailProps {
  studentName: string;
  orderID: string;
  courseName: string;
  amount: number;
  expiresAt: number; // Unix timestamp
  paymentURL: string;
}

export default function PaymentReminderEmail({
  studentName = '學員',
  orderID = '12345',
  courseName = 'AI 實戰課程',
  amount = 9900,
  expiresAt = Date.now() + 24 * 60 * 60 * 1000,
  paymentURL = 'https://thinker.cafe/order/12345',
}: PaymentReminderEmailProps) {
  const expiresDate = new Date(expiresAt);
  const formattedExpires = expiresDate.toLocaleString('zh-TW', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

  const formattedAmount = new Intl.NumberFormat('zh-TW').format(amount);

  return (
    <Html>
      <Head />
      <Preview>
        您已成功報名 {courseName}，報名序號 #{orderID}，請於 24 小時內完成繳費
      </Preview>
      <Body style={main}>
        <Container style={container}>
          {/* Header */}
          <Section style={header}>
            <Text style={headerText}>思考者咖啡 Thinker Cafe</Text>
          </Section>

          {/* Main Content */}
          <Section style={content}>
            <Text style={greeting}>親愛的 {studentName}，</Text>

            <Text style={paragraph}>
              感謝您報名 <strong>{courseName}</strong>！
            </Text>

            <Text style={paragraph}>
              您的報名已成功建立，以下是您的報名資訊：
            </Text>

            {/* Order Info Box */}
            <Section style={infoBox}>
              <Text style={infoLabel}>報名序號</Text>
              <Text style={infoValue}>#{orderID}</Text>

              <Text style={infoLabel}>課程名稱</Text>
              <Text style={infoValue}>{courseName}</Text>

              <Text style={infoLabel}>課程費用</Text>
              <Text style={infoValueHighlight}>NT$ {formattedAmount}</Text>
            </Section>

            <Hr style={divider} />

            {/* Payment Info */}
            <Text style={sectionTitle}>💰 請完成轉帳繳費</Text>

            <Section style={paymentBox}>
              <Text style={paymentLabel}>收款銀行</Text>
              <Text style={paymentValue}>007 第一銀行 苗栗分行</Text>

              <Text style={paymentLabel}>收款帳號</Text>
              <Text style={paymentValue}>321-10-060407</Text>

              <Text style={paymentLabel}>收款戶名</Text>
              <Text style={paymentValue}>思考者咖啡有限公司</Text>

              <Text style={paymentLabel}>應繳金額</Text>
              <Text style={paymentValueHighlight}>NT$ {formattedAmount}</Text>
            </Section>

            {/* Warning */}
            <Section style={warningBox}>
              <Text style={warningTitle}>⏰ 重要提醒</Text>
              <Text style={warningText}>
                請務必於 <strong>{formattedExpires}</strong> 前完成付款。
              </Text>
              <Text style={warningText}>
                若超過 24 小時，此報名將自動取消。
              </Text>
            </Section>

            {/* CTA Button */}
            <Section style={buttonContainer}>
              <Button style={button} href={paymentURL}>
                前往繳費頁面
              </Button>
            </Section>

            <Text style={paragraph}>
              轉帳完成後，請回到繳費頁面點擊「已完成繳費」按鈕，我們將在 24 小時內完成驗證。
            </Text>

            <Hr style={divider} />

            {/* Tips */}
            <Text style={tipsTitle}>💡 小提醒</Text>
            <ul style={tipsList}>
              <li style={tipsItem}>建議將繳費頁面加入書籤，方便隨時查看</li>
              <li style={tipsItem}>繳費頁面提供「一鍵複製帳號」功能，避免輸入錯誤</li>
              <li style={tipsItem}>如有任何問題，請隨時聯絡我們</li>
            </ul>

            <Hr style={divider} />

            {/* Contact Info */}
            <Text style={contactTitle}>📞 聯絡我們</Text>
            <Text style={contactText}>
              Email: <Link href="mailto:cruz@thinker.cafe" style={link}>cruz@thinker.cafe</Link>
              <br />
              電話: 0937-431-998
            </Text>
          </Section>

          {/* Footer */}
          <Section style={footer}>
            <Text style={footerText}>
              思考者咖啡有限公司 Thinker Cafe
              <br />
              106 台北市大安區信義路四段170號3樓
            </Text>
            <Text style={footerText}>
              <Link href="https://thinker.cafe" style={footerLink}>
                thinker.cafe
              </Link>
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

// Styles
const main = {
  backgroundColor: '#f6f9fc',
  fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Ubuntu,sans-serif',
};

const container = {
  backgroundColor: '#ffffff',
  margin: '0 auto',
  padding: '20px 0',
  marginBottom: '64px',
};

const header = {
  backgroundColor: '#fb923c', // orange-400
  padding: '20px',
  textAlign: 'center' as const,
};

const headerText = {
  color: '#ffffff',
  fontSize: '24px',
  fontWeight: 'bold',
  margin: '0',
};

const content = {
  padding: '40px',
};

const greeting = {
  fontSize: '16px',
  lineHeight: '24px',
  marginBottom: '16px',
};

const paragraph = {
  fontSize: '16px',
  lineHeight: '24px',
  marginBottom: '16px',
  color: '#525252',
};

const infoBox = {
  backgroundColor: '#fef3c7', // amber-100
  borderRadius: '8px',
  padding: '20px',
  marginBottom: '24px',
};

const infoLabel = {
  fontSize: '12px',
  color: '#78716c',
  marginBottom: '4px',
  marginTop: '12px',
};

const infoValue = {
  fontSize: '16px',
  fontWeight: '600',
  color: '#1c1917',
  marginTop: '0',
  marginBottom: '0',
};

const infoValueHighlight = {
  fontSize: '20px',
  fontWeight: 'bold',
  color: '#f97316', // orange-500
  marginTop: '0',
  marginBottom: '0',
};

const sectionTitle = {
  fontSize: '18px',
  fontWeight: 'bold',
  marginBottom: '16px',
  marginTop: '24px',
};

const paymentBox = {
  backgroundColor: '#f5f5f4', // stone-100
  borderRadius: '8px',
  padding: '20px',
  marginBottom: '24px',
  border: '1px solid #e7e5e4',
};

const paymentLabel = {
  fontSize: '12px',
  color: '#78716c',
  marginBottom: '4px',
  marginTop: '12px',
};

const paymentValue = {
  fontSize: '16px',
  fontWeight: '600',
  color: '#1c1917',
  fontFamily: 'monospace',
  marginTop: '0',
  marginBottom: '0',
};

const paymentValueHighlight = {
  fontSize: '24px',
  fontWeight: 'bold',
  color: '#f97316',
  fontFamily: 'monospace',
  marginTop: '0',
  marginBottom: '0',
};

const warningBox = {
  backgroundColor: '#fef3c7',
  borderLeft: '4px solid #f59e0b',
  borderRadius: '4px',
  padding: '16px',
  marginBottom: '24px',
};

const warningTitle = {
  fontSize: '14px',
  fontWeight: 'bold',
  color: '#92400e',
  marginTop: '0',
  marginBottom: '8px',
};

const warningText = {
  fontSize: '14px',
  color: '#92400e',
  marginTop: '0',
  marginBottom: '4px',
};

const buttonContainer = {
  textAlign: 'center' as const,
  marginTop: '24px',
  marginBottom: '24px',
};

const button = {
  backgroundColor: '#f97316',
  borderRadius: '8px',
  color: '#ffffff',
  fontSize: '16px',
  fontWeight: 'bold',
  textDecoration: 'none',
  textAlign: 'center' as const,
  display: 'inline-block',
  padding: '12px 32px',
};

const divider = {
  borderColor: '#e5e5e5',
  margin: '24px 0',
};

const tipsTitle = {
  fontSize: '14px',
  fontWeight: 'bold',
  marginBottom: '12px',
  marginTop: '16px',
};

const tipsList = {
  marginLeft: '20px',
  marginTop: '8px',
};

const tipsItem = {
  fontSize: '14px',
  color: '#525252',
  marginBottom: '8px',
};

const contactTitle = {
  fontSize: '14px',
  fontWeight: 'bold',
  marginBottom: '12px',
  marginTop: '16px',
};

const contactText = {
  fontSize: '14px',
  color: '#525252',
  lineHeight: '20px',
};

const link = {
  color: '#f97316',
  textDecoration: 'underline',
};

const footer = {
  padding: '20px 40px',
  backgroundColor: '#f5f5f5',
  textAlign: 'center' as const,
};

const footerText = {
  fontSize: '12px',
  color: '#737373',
  lineHeight: '20px',
  marginBottom: '8px',
};

const footerLink = {
  color: '#737373',
  textDecoration: 'underline',
};
