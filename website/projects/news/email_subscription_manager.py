#!/usr/bin/env python3
"""
Email 訂閱管理系統
用於管理和發送 email 訂閱內容
"""

import os
import json
from datetime import datetime
from typing import List, Dict, Optional
from supabase import create_client, Client

class EmailSubscriptionManager:
    def __init__(self):
        # Supabase 配置
        supabase_url = "https://ygcmxeimfjaivzdtzpct.supabase.co"
        supabase_key = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlnY214ZWltZmphaXZ6ZHR6cGN0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg0NTI5MjYsImV4cCI6MjA3NDAyODkyNn0.qWA3Jj0muFqZbVx-3Jf2JKfb3Ch9Pb5VbpsU_nD8x5A"
        
        self.supabase: Client = create_client(supabase_url, supabase_key)
        
    def get_all_subscribers(self, status: str = 'active') -> List[Dict]:
        """
        從 semantic_insights 表獲取所有會員 (包含訂閱者)
        """
        try:
            response = self.supabase.table("semantic_insights").select("*").eq("category", "member_profile").execute()
            
            members = []
            for record in response.data:
                try:
                    profile = json.loads(record['content'])
                    identity = profile.get('identity', {})
                    subscription = profile.get('subscription', {})
                    ai_prefs = profile.get('ai_preferences', {})
                    crm_data = profile.get('crm_data', {})
                    
                    if identity.get('status') == status:
                        members.append({
                            'id': record['id'],
                            'email': identity.get('email'),
                            'name': identity.get('name'),
                            'member_id': identity.get('member_id'),
                            'source': identity.get('source'),
                            'interested_topics': subscription.get('interested_topics', []),
                            'subscription_date': identity.get('registration_date'),
                            'status': identity.get('status'),
                            'lifecycle_stage': crm_data.get('lifecycle_stage', 'subscriber'),
                            'communication_style': ai_prefs.get('communication_style', 'professional'),
                            'complexity_level': ai_prefs.get('complexity_level', 'beginner'),
                            'created_at': record['created_at'],
                            'full_profile': profile  # 完整的 profile 供進階使用
                        })
                except json.JSONDecodeError:
                    continue
            
            return members
        except Exception as e:
            print(f"❌ 獲取會員失敗: {str(e)}")
            return []
    
    def get_member_stats(self) -> Dict[str, any]:
        """
        獲取會員統計 (更詳細的統計資料)
        """
        try:
            response = self.supabase.table("semantic_insights").select("content").eq("category", "member_profile").execute()
            
            stats = {
                'total': 0,
                'active': 0,
                'inactive': 0,
                'lifecycle_stages': {},
                'communication_styles': {},
                'complexity_levels': {},
                'top_interests': {},
                'sources': {}
            }
            
            for record in response.data:
                try:
                    profile = json.loads(record['content'])
                    identity = profile.get('identity', {})
                    subscription = profile.get('subscription', {})
                    ai_prefs = profile.get('ai_preferences', {})
                    crm_data = profile.get('crm_data', {})
                    
                    stats['total'] += 1
                    
                    # 狀態統計
                    if identity.get('status') == 'active':
                        stats['active'] += 1
                    else:
                        stats['inactive'] += 1
                    
                    # 生命週期階段
                    stage = crm_data.get('lifecycle_stage', 'subscriber')
                    stats['lifecycle_stages'][stage] = stats['lifecycle_stages'].get(stage, 0) + 1
                    
                    # 溝通風格
                    style = ai_prefs.get('communication_style', 'professional')
                    stats['communication_styles'][style] = stats['communication_styles'].get(style, 0) + 1
                    
                    # 複雜度等級
                    level = ai_prefs.get('complexity_level', 'beginner')
                    stats['complexity_levels'][level] = stats['complexity_levels'].get(level, 0) + 1
                    
                    # 興趣主題
                    for topic in subscription.get('interested_topics', []):
                        stats['top_interests'][topic] = stats['top_interests'].get(topic, 0) + 1
                    
                    # 來源統計
                    source = identity.get('source', 'unknown')
                    stats['sources'][source] = stats['sources'].get(source, 0) + 1
                    
                except json.JSONDecodeError:
                    continue
            
            return stats
        except Exception as e:
            print(f"❌ 獲取統計失敗: {str(e)}")
            return {'total': 0, 'active': 0, 'inactive': 0}
    
    def get_subscribers_by_interests(self, topic: str) -> List[Dict]:
        """
        根據興趣主題獲取訂閱者
        """
        try:
            all_subscribers = self.get_all_subscribers('active')
            interested_subscribers = []
            
            for subscriber in all_subscribers:
                if topic in subscriber.get('interested_topics', []):
                    interested_subscribers.append(subscriber)
            
            return interested_subscribers
        except Exception as e:
            print(f"❌ 獲取主題訂閱者失敗: {str(e)}")
            return []
    
    def update_last_sent_date(self, email: str) -> bool:
        """
        更新最後發送日期
        """
        try:
            response = self.supabase.table("email_subscriptions").update({
                "last_sent_date": datetime.now().isoformat()
            }).eq("email", email).execute()
            return True
        except Exception as e:
            print(f"❌ 更新發送日期失敗: {str(e)}")
            return False
    
    def unsubscribe_email(self, email: str) -> bool:
        """
        取消訂閱
        """
        try:
            response = self.supabase.table("email_subscriptions").update({
                "status": "unsubscribed",
                "updated_at": datetime.now().isoformat()
            }).eq("email", email).execute()
            return True
        except Exception as e:
            print(f"❌ 取消訂閱失敗: {str(e)}")
            return False
    
    def create_insight_email_content(self, insight_data: Dict) -> Dict[str, str]:
        """
        創建洞察郵件內容
        """
        title = insight_data.get('title', '新學習洞察')
        content = insight_data.get('content', '')
        category = insight_data.get('category', '學習洞察')
        url = insight_data.get('url', 'https://thinkercafe-tw.github.io/thinker-news/')
        
        # HTML 版本
        html_content = f"""
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <style>
                body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }}
                .container {{ max-width: 600px; margin: 0 auto; padding: 20px; }}
                .header {{ background: linear-gradient(45deg, #667eea, #764ba2); color: white; padding: 30px; border-radius: 10px; text-align: center; }}
                .content {{ background: #f9f9f9; padding: 30px; margin: 20px 0; border-radius: 10px; }}
                .button {{ background: linear-gradient(45deg, #667eea, #764ba2); color: white; padding: 12px 24px; text-decoration: none; border-radius: 25px; display: inline-block; margin: 20px 0; }}
                .footer {{ text-align: center; color: #666; font-size: 14px; }}
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>🧠 {title}</h1>
                    <p>{category}</p>
                </div>
                
                <div class="content">
                    <p>{content}</p>
                    
                    <a href="{url}" class="button">🔗 查看完整內容</a>
                </div>
                
                <div class="footer">
                    <p>📧 來自 ThinkerCafe 的學習洞察</p>
                    <p><a href="{url}#unsubscribe">取消訂閱</a> | <a href="{url}">訪問網站</a></p>
                </div>
            </div>
        </body>
        </html>
        """
        
        # 純文字版本
        text_content = f"""
🧠 {title}

{category}

{content}

🔗 完整內容：{url}

---
📧 來自 ThinkerCafe 的學習洞察
取消訂閱：{url}#unsubscribe
        """
        
        return {
            'subject': f"🧠 {title} - ThinkerCafe 學習洞察",
            'html': html_content,
            'text': text_content
        }
    
    def export_subscribers_for_email_service(self, format: str = 'csv') -> str:
        """
        匯出訂閱者資料供外部郵件服務使用
        """
        subscribers = self.get_all_subscribers()
        
        if format == 'csv':
            import csv
            import io
            
            output = io.StringIO()
            writer = csv.writer(output)
            
            # 標題行
            writer.writerow(['Email', 'Name', 'Subscription Date', 'Interests'])
            
            # 資料行
            for sub in subscribers:
                writer.writerow([
                    sub.get('email', ''),
                    sub.get('name', ''),
                    sub.get('subscription_date', ''),
                    ', '.join(sub.get('interested_topics', []))
                ])
            
            return output.getvalue()
        
        elif format == 'json':
            return json.dumps(subscribers, indent=2, ensure_ascii=False)

def main():
    """
    統一會員系統展示
    """
    manager = EmailSubscriptionManager()
    
    print("🎯 統一會員系統 - 詳細分析報告")
    print("=" * 50)
    
    # 顯示詳細統計
    stats = manager.get_member_stats()
    print(f"📊 會員總覽:")
    print(f"  📧 總會員: {stats['total']}")
    print(f"  ✅ 活躍會員: {stats['active']}")
    print(f"  ❌ 非活躍會員: {stats['inactive']}")
    
    # 生命週期分析
    print(f"\n🚀 生命週期分布:")
    for stage, count in stats.get('lifecycle_stages', {}).items():
        print(f"  • {stage}: {count} 人")
    
    # AI 偏好分析
    print(f"\n🤖 AI 偏好設定:")
    print(f"  溝通風格分布:")
    for style, count in stats.get('communication_styles', {}).items():
        print(f"    • {style}: {count} 人")
    
    print(f"  複雜度偏好:")
    for level, count in stats.get('complexity_levels', {}).items():
        print(f"    • {level}: {count} 人")
    
    # 興趣主題熱門度
    print(f"\n🎯 熱門興趣主題:")
    sorted_interests = sorted(stats.get('top_interests', {}).items(), 
                            key=lambda x: x[1], reverse=True)
    for topic, count in sorted_interests[:5]:
        print(f"  • {topic}: {count} 人")
    
    # 來源分析
    print(f"\n📍 會員來源:")
    for source, count in stats.get('sources', {}).items():
        print(f"  • {source}: {count} 人")
    
    # 顯示會員樣本
    members = manager.get_all_subscribers()
    if members:
        print(f"\n👥 會員樣本 (最近 3 位):")
        for member in members[-3:]:
            print(f"  📧 {member.get('email')}")
            print(f"    • 階段: {member.get('lifecycle_stage')}")
            print(f"    • 風格: {member.get('communication_style')}")
            print(f"    • 等級: {member.get('complexity_level')}")
            print(f"    • 興趣: {', '.join(member.get('interested_topics', []))}")
            print()
    
    # 演示個人化提示詞生成 (如果有測試用戶)
    if members:
        test_member = members[0]
        profile = test_member.get('full_profile', {})
        ai_prefs = profile.get('ai_preferences', {})
        
        print(f"🎭 個人化提示詞示例 (基於 {test_member.get('email')}):")
        prompt = f"""你是一個{ai_prefs.get('communication_style', 'professional')}的 AI 助手。
用戶偏好{ai_prefs.get('complexity_level', 'beginner')}難度的內容。
請用{ai_prefs.get('response_length', 'concise')}的方式回應。
用戶特別關心：{', '.join(profile.get('subscription', {}).get('interested_topics', []))}。"""
        
        print(f"  {prompt}")
        
    print(f"\n💡 統一 JSON 結構的優勢:")
    print(f"  ✅ 從簡單訂閱無縫升級到完整會員系統")
    print(f"  ✅ AI 偏好設定與會員資料完美整合")
    print(f"  ✅ 支援複雜的 CRM 分析和個人化服務")
    print(f"  ✅ 單一資料源，避免資料不同步問題")

if __name__ == "__main__":
    main()