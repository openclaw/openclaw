#!/usr/bin/env python3
"""
EvoMap 安全沙箱运行器
功能：
1. 只获取任务，不执行任何敏感操作
2. 私钥完全隔离
3. 网络请求白名单
4. 全程监控审计
"""

import os
import json
import time
import logging
import urllib.request
import urllib.parse
from datetime import datetime
from typing import Optional, Dict, List

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - [EvoMap Sandbox] %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('/tmp/evomap_sandbox.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger('EvoMapSandbox')

class EvoMapSandbox:
    """EvoMap 安全沙箱"""
    
    def __init__(self, config_path: str):
        """初始化沙箱"""
        self.config = self._load_config(config_path)
        self.node_id = self.config['node_id']
        self.api_endpoint = self.config['api_endpoint']
        
        # 安全检查
        self._verify_security()
        
        logger.info("🔒 EvoMap 沙箱已初始化")
        logger.info(f"   节点ID: {self.node_id}")
        logger.info(f"   模式: {self.config['security']['mode']}")
        logger.info(f"   隔离级别: {self.config['security']['isolation']}")
    
    def _load_config(self, config_path: str) -> Dict:
        """加载配置"""
        with open(config_path, 'r') as f:
            return json.load(f)
    
    def _verify_security(self):
        """验证安全配置"""
        # 检查是否有私钥泄露风险
        forbidden = self.config['security']['forbidden_actions']
        if 'credential_access' not in forbidden:
            raise SecurityError("❌ 安全配置错误：未禁止凭证访问")
        
        if 'code_execution' not in forbidden:
            raise SecurityError("❌ 安全配置错误：未禁止代码执行")
        
        # 检查网络白名单
        whitelist = self.config['security']['network_whitelist']
        if not whitelist or 'evomap.ai' not in whitelist:
            raise SecurityError("❌ 安全配置错误：网络白名单未配置")
        
        logger.info("✅ 安全配置验证通过")
    
    def _safe_request(self, endpoint: str, data: Optional[Dict] = None) -> Optional[Dict]:
        """安全 HTTP 请求（仅允许白名单域名）"""
        # 检查域名白名单
        url = f"{self.api_endpoint}{endpoint}"
        parsed = urllib.parse.urlparse(url)
        domain = parsed.netloc
        
        whitelist = self.config['security']['network_whitelist']
        allowed = any(domain.endswith(w) for w in whitelist)
        
        if not allowed:
            logger.error(f"🚫 网络请求被阻止（不在白名单）: {domain}")
            self._log_violation(f"网络请求违规: {domain}")
            return None
        
        # 记录请求
        logger.info(f"📤 请求: {endpoint}")
        self._log_request(endpoint, data)
        
        try:
            req_data = json.dumps(data).encode('utf-8') if data else None
            req = urllib.request.Request(url, data=req_data, method='POST' if data else 'GET')
            req.add_header('Content-Type', 'application/json')
            req.add_header('User-Agent', 'EvoMapSandbox/1.0')
            req.add_header('X-Node-ID', self.node_id)
            
            with urllib.request.urlopen(req, timeout=30) as response:
                result = json.loads(response.read().decode('utf-8'))
                logger.info(f"📥 响应: {endpoint} - 成功")
                return result
                
        except Exception as e:
            logger.error(f"❌ 请求失败: {endpoint} - {e}")
            return None
    
    def _log_request(self, endpoint: str, data: Optional[Dict]):
        """记录所有请求（审计）"""
        audit_log = {
            'timestamp': datetime.now().isoformat(),
            'endpoint': endpoint,
            'data': data,
            'node_id': self.node_id
        }
        
        log_file = self.config['monitoring']['log_file']
        with open(log_file, 'a') as f:
            f.write(json.dumps(audit_log) + '\n')
    
    def _log_violation(self, message: str):
        """记录安全违规"""
        violation = {
            'timestamp': datetime.now().isoformat(),
            'type': 'SECURITY_VIOLATION',
            'message': message,
            'node_id': self.node_id
        }
        
        log_file = self.config['monitoring']['log_file']
        with open(log_file, 'a') as f:
            f.write(json.dumps(violation) + '\n')
        
        # 发送飞书告警
        if self.config['monitoring'].get('feishu_alert'):
            self._send_alert(message)
    
    def _send_alert(self, message: str):
        """发送安全告警（飞书）"""
        logger.warning(f"⚠️  安全告警: {message}")
        # 这里可以集成飞书消息发送
        # 但不包含任何敏感信息
    
    def heartbeat(self):
        """发送心跳（保持节点在线）"""
        logger.info("💓 发送心跳...")
        result = self._safe_request('/heartbeat', {
            'node_id': self.node_id,
            'timestamp': datetime.now().isoformat()
        })
        
        if result:
            logger.info(f"✅ 心跳成功")
        else:
            logger.warning(f"⚠️  心跳失败")
        
        return result
    
    def fetch_tasks(self) -> List[Dict]:
        """获取任务列表（只读）"""
        logger.info("📋 获取任务列表...")
        result = self._safe_request('/tasks', {
            'node_id': self.node_id
        })
        
        if result and 'tasks' in result:
            tasks = result['tasks']
            logger.info(f"✅ 获取到 {len(tasks)} 个任务")
            return tasks
        else:
            logger.warning("⚠️  未获取到任务")
            return []
    
    def report_task_status(self, task_id: str, status: str, result: Optional[Dict] = None):
        """报告任务状态（只报告，不执行）"""
        logger.info(f"📊 报告任务状态: {task_id} - {status}")
        return self._safe_request('/task/report', {
            'node_id': self.node_id,
            'task_id': task_id,
            'status': status,
            'result': result,
            'timestamp': datetime.now().isoformat()
        })
    
    def run(self):
        """运行沙箱（主循环）"""
        logger.info("=" * 60)
        logger.info("🚀 EvoMap 沙箱启动")
        logger.info("=" * 60)
        logger.info("🔒 安全模式：只获取任务，不执行敏感操作")
        logger.info("🔐 私钥隔离：不访问任何凭证信息")
        logger.info("📡 网络限制：仅允许 evomap.ai")
        logger.info("")
        
        while True:
            try:
                # 1. 心跳
                self.heartbeat()
                
                # 2. 获取任务
                tasks = self.fetch_tasks()
                
                # 3. 显示任务（不执行）
                if tasks:
                    logger.info(f"\n📋 可用任务:")
                    for i, task in enumerate(tasks[:5]):
                        logger.info(f"   {i+1}. {task.get('title', 'Unknown')}")
                        logger.info(f"      奖励: {task.get('reward', 0)} credits")
                        logger.info(f"      难度: {task.get('difficulty', 'Unknown')}")
                        logger.info(f"      状态: 待人工确认")
                
                # 4. 等待下次循环
                interval = self.config['heartbeat_interval']
                logger.info(f"\n⏰ 等待 {interval} 秒后继续...")
                time.sleep(interval)
                
            except KeyboardInterrupt:
                logger.info("\n👋 收到停止信号，退出沙箱")
                break
            except Exception as e:
                logger.error(f"❌ 运行错误: {e}")
                logger.info("⏳ 等待 60 秒后重试...")
                time.sleep(60)

class SecurityError(Exception):
    """安全错误"""
    pass

def main():
    """主函数"""
    config_path = '/home/node/.openclaw/workspace/config/evomap_sandbox.json'
    
    try:
        sandbox = EvoMapSandbox(config_path)
        sandbox.run()
    except SecurityError as e:
        logger.error(f"❌ 安全错误: {e}")
        logger.error("   沙箱已拒绝启动")
    except Exception as e:
        logger.error(f"❌ 启动失败: {e}")

if __name__ == '__main__':
    main()
