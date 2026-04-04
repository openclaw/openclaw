'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { TriangleAlert, LoaderCircle, Copy, Check, Mail } from 'lucide-react';
import FormCard from '@/components/core/FormCard.js';
import FormFooter from '@/components/core/FormFooter.js';
import FormButton from '@/components/core/FormButton.js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createClient } from '@/utils/supabase/client.ts';
import { parseStudentIdString, parseStudentName } from '@/utils/profile.js';
import { parseOrderIdString } from '@/utils/order.js';
import { parseCourseName, parseCourseVariantName } from '@/utils/course.js';
import parsePriceString from '@/utils/parsePriceString.js';
import { useToast } from '@/hooks/use-toast';

export default function CreatedOrderForm({ order, profile, course }) {
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [copiedAccount, setCopiedAccount] = useState(false);
  const [copiedBankCode, setCopiedBankCode] = useState(false);

  // 新增：帳號後五碼和轉帳時間
  const [accountLast5, setAccountLast5] = useState('');
  const [transferTime, setTransferTime] = useState('');

  // Countdown timer state (client-side only to avoid hydration error)
  const [remainingHours, setRemainingHours] = useState(null);
  const [remainingMinutes, setRemainingMinutes] = useState(null);

  const router = useRouter();
  const { toast } = useToast();

  // Calculate countdown on client side only
  useEffect(() => {
    const createdAt = new Date(order.created_at);
    const expiresAt = new Date(createdAt.getTime() + 24 * 60 * 60 * 1000);

    const updateCountdown = () => {
      const now = new Date();
      const hours = Math.max(0, Math.floor((expiresAt - now) / (1000 * 60 * 60)));
      const minutes = Math.max(0, Math.floor(((expiresAt - now) % (1000 * 60 * 60)) / (1000 * 60)));
      setRemainingHours(hours);
      setRemainingMinutes(minutes);
    };

    updateCountdown();
    const interval = setInterval(updateCountdown, 60000); // Update every minute

    return () => clearInterval(interval);
  }, [order.created_at]);

  // 複製銀行代碼
  const copyBankCode = async () => {
    try {
      await navigator.clipboard.writeText('007');
      setCopiedBankCode(true);
      toast({
        title: "已複製銀行代碼",
        description: "007（第一銀行）",
      });
      setTimeout(() => setCopiedBankCode(false), 2000);
    } catch (err) {
      toast({
        title: "複製失敗",
        description: "請手動複製銀行代碼",
        variant: "destructive",
      });
    }
  };

  // 複製帳號（去掉連字號）
  const copyAccountNumber = async () => {
    try {
      await navigator.clipboard.writeText('32110060407');
      setCopiedAccount(true);
      toast({
        title: "已複製帳號",
        description: "32110060407",
      });
      setTimeout(() => setCopiedAccount(false), 2000);
    } catch (err) {
      toast({
        title: "複製失敗",
        description: "請手動複製帳號",
        variant: "destructive",
      });
    }
  };

  async function updateOrderState() {
    setErrorMessage('');
    setLoading(true);

    const supabase = createClient();

    // 準備更新資料
    const updateData = {
      state: 'payed',
      // 儲存帳號後五碼和轉帳時間（如果有填寫）
      ...(accountLast5 && { transfer_account_last5: accountLast5 }),
      ...(transferTime && { transfer_time: new Date(transferTime).toISOString() }),
    };

    const { error } = await supabase
      .from('orders')
      .update(updateData)
      .eq('order_id', order.order_id);

    if (error) {
      const { code, message } = error;
      setErrorMessage(`[${code}] ${message}`);
      setLoading(false);
      return;
    }

    toast({
      title: "已送出驗證申請",
      description: "我們將在 24 小時內完成驗證",
    });

    router.replace(`/order/${order.order_id}`);
    router.refresh();
  }

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      {/* 訂單資訊 */}
      <FormCard singleColumn title="步驟 3. 轉帳繳費">
        <div className="space-y-4">
          <div className="bg-primary/5 p-4 rounded-lg">
            <p className="text-sm space-y-1">
              <span className="text-muted-foreground">學員編號：</span>
              <span className="font-mono font-semibold">{parseStudentIdString(profile)}</span>
              <br />
              <span className="text-muted-foreground">學員姓名：</span>
              <span className="font-semibold">{parseStudentName(profile)}</span>
              <br />
              <span className="text-muted-foreground">報名序號：</span>
              <span className="font-mono font-semibold">{parseOrderIdString(order)}</span>
              <br />
              <span className="text-muted-foreground">報名課程：</span>
              <span className="font-semibold">{parseCourseName(course)}</span>
              <br />
              <span className="text-muted-foreground">上課方式：</span>
              <span className="font-semibold">{parseCourseVariantName(order.course_variant)}</span>
              <br />
              <span className="text-muted-foreground">課程費用：</span>
              <span className="font-mono font-bold text-primary text-lg">NT$ {parsePriceString(order.total)}</span>
            </p>
          </div>

          <hr className="border-foreground/20" />

          {/* 繳費資訊 - 改善版 */}
          <div className="space-y-3">
            <h4 className="font-semibold text-base">轉帳資訊</h4>

            <div className="space-y-2">
              <div className="flex items-center justify-between p-3 bg-background/50 rounded-lg border border-foreground/10">
                <div>
                  <p className="text-xs text-muted-foreground mb-1">收款銀行</p>
                  <p className="font-mono font-semibold">007 第一銀行 苗栗分行</p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={copyBankCode}
                  className="ml-2"
                >
                  {copiedBankCode ? (
                    <>
                      <Check className="h-4 w-4 mr-1 text-green-500" />
                      已複製
                    </>
                  ) : (
                    <>
                      <Copy className="h-4 w-4 mr-1" />
                      複製代碼
                    </>
                  )}
                </Button>
              </div>

              <div className="flex items-center justify-between p-3 bg-background/50 rounded-lg border border-foreground/10">
                <div>
                  <p className="text-xs text-muted-foreground mb-1">收款帳號</p>
                  <p className="font-mono font-semibold text-lg">321-10-060407</p>
                  <p className="text-xs text-muted-foreground mt-1">（複製時會自動去除連字號）</p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={copyAccountNumber}
                  className="ml-2"
                >
                  {copiedAccount ? (
                    <>
                      <Check className="h-4 w-4 mr-1 text-green-500" />
                      已複製
                    </>
                  ) : (
                    <>
                      <Copy className="h-4 w-4 mr-1" />
                      複製帳號
                    </>
                  )}
                </Button>
              </div>

              <div className="p-3 bg-background/50 rounded-lg border border-foreground/10">
                <p className="text-xs text-muted-foreground mb-1">收款戶名</p>
                <p className="font-semibold">思考者咖啡有限公司</p>
              </div>

              <div className="p-3 bg-primary/10 rounded-lg border border-primary/20">
                <p className="text-xs text-muted-foreground mb-1">應繳金額</p>
                <p className="font-mono font-bold text-primary text-2xl">NT$ {parsePriceString(order.total)}</p>
              </div>
            </div>
          </div>
        </div>
      </FormCard>

      {/* 轉帳完成後填寫 */}
      <FormCard singleColumn title="轉帳完成後，請填寫以下資訊（選填）">
        <p className="text-sm text-muted-foreground mb-4">
          填寫以下資訊可加快我們的驗證速度
        </p>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="accountLast5">
              您的轉帳帳號後五碼
            </Label>
            <Input
              id="accountLast5"
              placeholder="例如：12345"
              maxLength={5}
              value={accountLast5}
              onChange={(e) => setAccountLast5(e.target.value.replace(/\D/g, ''))}
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">
              請填寫您用來轉帳的銀行帳號後五碼，方便我們核對
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="transferTime">
              轉帳時間（大約即可）
            </Label>
            <Input
              id="transferTime"
              type="datetime-local"
              value={transferTime}
              onChange={(e) => setTransferTime(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              填寫轉帳時間可協助我們更快找到您的款項
            </p>
          </div>
        </div>
      </FormCard>

      {/* 重要提醒 */}
      <FormCard singleColumn>
        <div className="space-y-3">
          <div className="flex items-start gap-2 text-orange-500">
            <TriangleAlert size={20} className="mt-0.5 flex-shrink-0" />
            <div className="space-y-2 text-sm">
              {remainingHours !== null && remainingMinutes !== null && (
                <p className="font-bold">
                  ⏰ 繳費期限倒數：{remainingHours} 小時 {remainingMinutes} 分鐘
                </p>
              )}
              <p>
                請務必於 24 小時內完成付款。若超過期限，此報名將自動取消。
              </p>
            </div>
          </div>

          <hr className="border-foreground/20" />

          <div className="flex items-start gap-2 text-blue-500">
            <Mail size={20} className="mt-0.5 flex-shrink-0" />
            <div className="space-y-1 text-sm">
              <p className="font-bold">📧 已寄送繳費提醒信至您的信箱</p>
              <p className="text-muted-foreground">
                我們已將繳費資訊寄送至 <span className="font-mono">{profile.email}</span>，
                請檢查您的信箱（包含垃圾郵件匣）。
              </p>
            </div>
          </div>

          <hr className="border-foreground/20" />

          <div className="text-sm space-y-2 text-muted-foreground">
            <p>💡 <span className="font-semibold">小提醒：</span></p>
            <ul className="ml-6 list-disc space-y-1">
              <li>請使用上方的「複製」按鈕，避免手動輸入錯誤</li>
              <li>轉帳完成後，請回到本頁面點擊下方按鈕</li>
              <li>建議將本頁面加入書籤，方便隨時查看</li>
              <li>如有任何問題，請聯絡客服：0937-431-998</li>
            </ul>
          </div>
        </div>
      </FormCard>

      {/* 錯誤訊息 */}
      {errorMessage && (
        <FormCard error singleColumn>
          <p className="flex items-center gap-2">
            <TriangleAlert size={18} />
            {errorMessage}
          </p>
        </FormCard>
      )}

      {/* 提交按鈕 */}
      <FormFooter>
        <FormButton
          primary
          type="button"
          onClick={updateOrderState}
          disabled={loading}
        >
          {loading && <LoaderCircle size={20} className="mr-1 animate-spin" />}
          已完成繳費，前往驗證
        </FormButton>
      </FormFooter>
    </div>
  );
}
