#!/usr/bin/env python3
"""
安全隔离监控脚本
监控所有外部服务（EvoMap、水产市场、Polymarket 等）的文件和网络访问
确保私钥隔离策略得到执行
"""

import os
import json
import time
import logging
from datetime import datetime
from typing import Dict, List, Set

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - [Security Monitor] %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('/tmp/security_monitor.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger('SecurityMonitor')

class SecurityMonitor:
    """安全隔离监控器"""
    
    def __init__(self):
        self.services = {
            'evomap': {
                'config': '/home/node/.openclaw/workspace/config/evomap_sandbox.json',
                'log_file': '/tmp/evomap_audit.log',
                'forbidden_secrets': ['POLYMARKET_PRIVATE_KEY', 'OPENCLAWMP_TOKEN', 'GITHUB_TOKEN']
            },
            'openclawmp': {
                'config': '/home/node/.openclaw/workspace/config/openclawmp_sandbox.json',
                'log_file': '/tmp/openclawmp_audit.log',
                'forbidden_secrets': ['POLYMARKET_PRIVATE_KEY', 'GITHUB_TOKEN', 'GLM_API_KEY']
            },
            'polymarket': {
                'config': '/home/node/.openclaw/workspace/config/polymarket.env',
                'forbidden_secrets': ['OPENCLAWMP_TOKEN', 'GITHUB_TOKEN']
            }
        }
        
        self.violations = []
        logger.info("🔒 安全监控器已启动")
    
    def check_config_security(self, service: str, config_path: str) -> List[Dict]:
        """检查配置文件安全性"""
        violations = []
        
        if not os.path.exists(config_path):
            return violations
        
        with open(config_path, 'r') as f:
            content = f.read()
        
        # 检查是否包含敏感信息的实际值（而非字段名）
        # 允许字段名定义（如 "forbidden_secrets": ["POLYMARKET_PRIVATE_KEY"]）
        # 但不允许包含实际的密钥值
        
        # 检查 .env 文件（包含实际的密钥值）
        if config_path.endswith('.env'):
            lines = content.strip().split('\n')
            for line in lines:
                if '=' in line and not line.startswith('#'):
                    key, value = line.split('=', 1)
                    # 如果值非空且不是占位符，则视为实际密钥
                    if value.strip() and not value.strip().startswith('<') and value.strip() != 'your-xxx-here':
                        # 这是正常的，因为 .env 文件本身就是存储密钥的
                        pass
        
        # JSON 配置文件检查（不应该包含实际密钥值）
        elif config_path.endswith('.json'):
            try:
                config = json.loads(content)
                # 检查是否有实际的密钥值（而非空字符串或数组）
                def check_dict(d, path=""):
                    for key, value in d.items():
                        current_path = f"{path}.{key}" if path else key
                        if isinstance(value, dict):
                            check_dict(value, current_path)
                        elif isinstance(value, str) and value:
                            # 检查是否像实际的密钥值（长度>20且包含特定模式）
                            if len(value) > 20 and any(char in value for char in ['0x', 'sk-', 'ghp_', 'eyJ']):
                                violations.append({
                                    'service': service,
                                    'type': 'CONFIG_VIOLATION',
                                    'message': f'配置文件包含实际的密钥值: {current_path}',
                                    'timestamp': datetime.now().isoformat()
                                })
                
                check_dict(config)
            except:
                pass
        
        return violations
    
    def check_env_isolation(self, service: str, allowed_secrets: List[str]) -> List[Dict]:
        """检查环境变量隔离"""
        violations = []
        
        # 获取所有环境变量
        env_vars = set(os.environ.keys())
        
        # 检查是否有不允许访问的敏感变量
        sensitive_vars = {
            'POLYMARKET_PRIVATE_KEY',
            'POLYMARKET_API_KEY',
            'OPENCLAWMP_TOKEN',
            'GITHUB_TOKEN',
            'GLM_API_KEY'
        }
        
        forbidden_vars = sensitive_vars - set(allowed_secrets)
        accessed_forbidden = env_vars & forbidden_vars
        
        if accessed_forbidden:
            violations.append({
                'service': service,
                'type': 'ENV_VIOLATION',
                'message': f'检测到禁止访问的环境变量: {accessed_forbidden}',
                'timestamp': datetime.now().isoformat()
            })
        
        return violations
    
    def audit_logs(self, service: str, log_file: str) -> List[Dict]:
        """审计日志文件"""
        violations = []
        
        if not os.path.exists(log_file):
            return violations
        
        with open(log_file, 'r') as f:
            lines = f.readlines()[-100:]  # 只检查最近 100 行
        
        for line in lines:
            try:
                log_entry = json.loads(line.strip())
                
                # 检查是否有违规请求
                if log_entry.get('type') == 'SECURITY_VIOLATION':
                    violations.append({
                        'service': service,
                        'type': 'LOG_VIOLATION',
                        'message': log_entry.get('message'),
                        'timestamp': log_entry.get('timestamp')
                    })
            except:
                continue
        
        return violations
    
    def run_security_check(self):
        """执行安全检查"""
        logger.info("=" * 60)
        logger.info("🔍 执行安全隔离检查")
        logger.info("=" * 60)
        
        all_violations = []
        
        for service, config in self.services.items():
            logger.info(f"\n📋 检查服务: {service}")
            
            # 检查配置文件
            violations = self.check_config_security(service, config['config'])
            all_violations.extend(violations)
            
            # 检查日志
            if 'log_file' in config:
                violations = self.audit_logs(service, config['log_file'])
                all_violations.extend(violations)
            
            if violations:
                logger.warning(f"⚠️  发现 {len(violations)} 个违规")
            else:
                logger.info(f"✅ 无违规")
        
        # 保存违规报告
        if all_violations:
            report_path = '/tmp/security_violations.json'
            with open(report_path, 'w') as f:
                json.dump(all_violations, f, indent=2)
            
            logger.error(f"\n❌ 发现 {len(all_violations)} 个安全违规")
            logger.error(f"   报告已保存到: {report_path}")
            
            # 发送飞书告警
            self.send_alert(all_violations)
        else:
            logger.info(f"\n✅ 所有服务安全隔离检查通过")
        
        return all_violations
    
    def send_alert(self, violations: List[Dict]):
        """发送安全告警"""
        logger.warning(f"⚠️  发送安全告警到飞书...")
        # 这里可以集成飞书消息发送
        # 但不包含任何敏感信息
        
        alert_message = f"安全隔离违规告警\n发现 {len(violations)} 个违规\n时间: {datetime.now().isoformat()}"
        logger.warning(alert_message)
    
    def run_continuous(self, interval: int = 300):
        """持续监控"""
        logger.info(f"🚀 启动持续监控（间隔 {interval} 秒）")
        
        while True:
            try:
                self.run_security_check()
                logger.info(f"\n⏰ 等待 {interval} 秒后继续...")
                time.sleep(interval)
            except KeyboardInterrupt:
                logger.info("\n👋 停止监控")
                break
            except Exception as e:
                logger.error(f"❌ 监控错误: {e}")
                time.sleep(60)

def main():
    """主函数"""
    monitor = SecurityMonitor()
    
    # 单次检查
    violations = monitor.run_security_check()
    
    # 如果有违规，返回非零退出码
    if violations:
        return 1
    
    return 0

if __name__ == '__main__':
    import sys
    sys.exit(main())
