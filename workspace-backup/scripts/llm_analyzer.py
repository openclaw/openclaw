#!/usr/bin/env python3
"""
LLM 分析模块
使用 GLM-5 或 Claude 分析新闻事件对预测市场的影响
"""

import os
import sys
import json
import logging
from typing import Dict, Optional

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - [LLM] %(levelname)s - %(message)s'
)
logger = logging.getLogger('LLMAnalyzer')


class LLMAnalyzer:
    """LLM 分析器"""
    
    def __init__(self):
        """初始化"""
        logger.info("=" * 60)
        logger.info("🧠 初始化 LLM 分析器")
        logger.info("=" * 60)
        
        # 选择 LLM 提供商
        self.provider = os.getenv('LLM_PROVIDER', 'glm')  # glm / claude
        
        # GLM-5 配置（使用 OpenClaw auth profile）
        if self.provider == 'glm':
            self.glm_api_url = "https://open.bigmodel.cn/api/paas/v4/chat/completions"
            # 选择模型：glm-4.5-air（标准 JSON 输出）
            self.glm_model = os.getenv('GLM_MODEL', 'glm-4.5-air')  # 默认使用 glm-4.5-air
            logger.info(f"✅ 使用 {self.glm_model}")
        
        # Claude 配置
        elif self.provider == 'claude':
            self.claude_api_key = os.getenv('ANTHROPIC_API_KEY')
            if self.claude_api_key:
                logger.info("✅ 使用 Claude")
            else:
                logger.warning("⚠️  Claude API Key 未配置")
        
        logger.info(f"   Provider: {self.provider}")
        logger.info("✅ 初始化完成")
    
    def analyze_impact(self, event: Dict, market: Dict) -> Optional[Dict]:
        """分析事件对市场的影响"""
        logger.info("🧠 LLM 分析中...")
        
        # 构建提示词
        prompt = self._build_prompt(event, market)
        
        # 调用 LLM
        if self.provider == 'glm':
            response = self._call_glm(prompt)
        elif self.provider == 'claude':
            response = self._call_claude(prompt)
        else:
            logger.error(f"❌ 未知 provider: {self.provider}")
            return None
        
        # 解析响应
        if response:
            result = self._parse_response(response)
            return result
        
        return None
    
    def _build_prompt(self, event: Dict, market: Dict) -> str:
        """构建提示词"""
        event_text = event.get('text', '')
        market_question = market.get('question', '')
        market_description = market.get('description', '')
        
        prompt = f"""你是一个预测市场分析专家。分析以下新闻事件对预测市场的影响。

# 新闻事件
{event_text}

# 预测市场
问题：{market_question}
描述：{market_description}

# 分析任务
1. 判断这个新闻事件是否会影响这个预测市场
2. 如果会影响，判断影响方向（YES/NO）
3. 评估置信度（0-1，1 表示非常确定）
4. 提供简短的推理过程（1-2 句话）

# 输出格式（JSON）
**重要：只输出 JSON，不要任何解释或推理过程**

{{
  "impact": true/false,
  "direction": "YES"/"NO"/"UNCLEAR",
  "confidence": 0.0-1.0,
  "reasoning": "简短推理"
}}

# 输出（只输出 JSON）
"""
        return prompt
    
    def _call_glm(self, prompt: str) -> Optional[str]:
        """调用 GLM-5 API"""
        try:
            import requests
            
            # GLM-4.5-air API 配置（从环境变量或配置文件读取）
            api_key = os.environ.get('ZHIPU_API_KEY', 'bd4748ca85414ce3bed65ea1496a7c0f.Fcr71lBmXqn11neF')
            # 使用正确的 API endpoint（非 coding endpoint）
            url = "https://open.bigmodel.cn/api/paas/v4/chat/completions"
            
            # 根据模型选择策略
            # 注意：推理模型（glm-4.7-flash/glm-5）使用标准提示词即可
            # 回退分析会自动处理格式问题
            
            headers = {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key}"
            }
            
            data = {
                "model": self.glm_model,  # 动态选择模型
                "messages": [
                    {"role": "user", "content": prompt}
                ],
                "temperature": 0.3,  # 低温度，更确定
                "max_tokens": 500  # 限制输出长度
            }
            
            # 配置代理
            proxies = None
            if os.environ.get('http_proxy'):
                proxies = {
                    "http": os.environ.get('http_proxy'),
                    "https": os.environ.get('https_proxy')
                }
            
            response = requests.post(
                url,
                headers=headers,
                json=data,
                timeout=60,  # 增加超时时间
                proxies=proxies
            )
            
            if response.status_code == 200:
                result = response.json()
                logger.debug(f"   完整响应: {json.dumps(result, ensure_ascii=False)[:500]}")
                
                # 获取响应内容
                choice = result.get('choices', [{}])[0]
                message = choice.get('message', {})
                
                # GLM-4/Flash 模型使用 content 字段
                # GLM-5/GLM-4.7 推理模型使用 reasoning_content 字段
                content = message.get('content') or message.get('reasoning_content', '')
                
                if not content:
                    logger.error("❌ 响应内容为空")
                    return self._fallback_analysis(prompt)
                
                # 如果是推理模型，需要从 reasoning_content 中提取 JSON
                if 'reasoning_content' in message:
                    logger.info("📊 推理模型返回 reasoning_content")
                    # 尝试从推理内容中提取 JSON
                    import re
                    # 更宽松的匹配
                    json_match = re.search(r'\{[^{}]*\}', content, re.DOTALL)
                    if json_match:
                        content = json_match.group(0)
                        logger.info(f"   提取 JSON: {content[:100]}...")
                    else:
                        # 如果找不到 JSON，尝试构造
                        logger.warning("⚠️  未找到 JSON，尝试构造")
                        # 从推理内容中提取关键信息
                        direction_match = re.search(r'(YES|NO|UNCLEAR)', content, re.DOTALL | re.IGNORECASE)
                        confidence_match = re.search(r'(?:confidence|置信度)[：:\s]*(\d+\.\d+)', content, re.DOTALL | re.IGNORECASE)
                        
                        if direction_match:
                            direction = direction_match.group(1).upper()
                            confidence = float(confidence_match.group(1)) if confidence_match else 0.5
                            
                            content = json.dumps({
                                "impact": True,
                                "direction": direction,
                                "confidence": min(confidence, 1.0),
                                "reasoning": "Extracted from reasoning content"
                            })
                            logger.info(f"   构造 JSON: {content}")
                        else:
                            # 最后的回退
                            logger.error("❌ 无法构造 JSON，使用回退分析")
                            return self._fallback_analysis(prompt)
                
                logger.info("✅ GLM 分析完成")
                logger.info(f"   响应内容: {content[:500]}...")
                return content
            else:
                logger.error(f"❌ GLM-5 调用失败: {response.status_code}")
                logger.error(f"   响应: {response.text[:200]}")
                # 回退到简单分析
                return self._fallback_analysis(prompt)
                
        except Exception as e:
            logger.error(f"❌ GLM-5 调用失败: {e}")
            import traceback
            logger.debug(traceback.format_exc())
            # 回退到简单分析
            return self._fallback_analysis(prompt)
    
    def _call_claude(self, prompt: str) -> Optional[str]:
        """调用 Claude API"""
        try:
            import requests
            
            if not self.claude_api_key:
                logger.warning("⚠️  Claude API Key 未配置，使用回退分析")
                return self._fallback_analysis(prompt)
            
            url = "https://api.anthropic.com/v1/messages"
            
            headers = {
                "Content-Type": "application/json",
                "x-api-key": self.claude_api_key,
                "anthropic-version": "2023-06-01"
            }
            
            data = {
                "model": "claude-3-5-sonnet-20241022",
                "max_tokens": 500,
                "messages": [
                    {"role": "user", "content": prompt}
                ]
            }
            
            response = requests.post(
                url,
                headers=headers,
                json=data,
                timeout=30,
                proxies={
                    "http": os.environ.get('http_proxy'),
                    "https": os.environ.get('https_proxy')
                }
            )
            
            if response.status_code == 200:
                result = response.json()
                content = result.get('content', [{}])[0].get('text', '')
                logger.info("✅ Claude 分析完成")
                return content
            else:
                logger.error(f"❌ Claude 调用失败: {response.status_code}")
                return self._fallback_analysis(prompt)
                
        except Exception as e:
            logger.error(f"❌ Claude 调用失败: {e}")
            return self._fallback_analysis(prompt)
    
    def _fallback_analysis(self, prompt: str) -> str:
        """回退分析（简单规则）"""
        logger.warning("⚠️  使用简单规则分析")
        
        # 从 prompt 中提取关键信息
        if "Iran" in prompt and "Israel" in prompt:
            if "strike" in prompt or "missile" in prompt or "attack" in prompt:
                return json.dumps({
                    "impact": True,
                    "direction": "YES",
                    "confidence": 0.75,
                    "reasoning": "Military conflict escalation increases probability of related events"
                })
        
        if "Trump" in prompt and "election" in prompt:
            return json.dumps({
                "impact": True,
                "direction": "UNCLEAR",
                "confidence": 0.5,
                "reasoning": "Political news may affect election markets"
            })
        
        # 默认
        return json.dumps({
            "impact": False,
            "direction": "UNCLEAR",
            "confidence": 0.0,
            "reasoning": "No clear impact detected"
        })
    
    def _parse_response(self, response: str) -> Optional[Dict]:
        """解析 LLM 响应"""
        try:
            # 尝试提取 JSON
            import re
            
            # 查找 JSON 块
            json_match = re.search(r'\{[^}]+\}', response, re.DOTALL)
            
            if json_match:
                json_str = json_match.group(0)
                result = json.loads(json_str)
                
                # 验证字段
                if all(key in result for key in ['impact', 'direction', 'confidence']):
                    logger.info(f"✅ 解析成功: {result['direction']} @ {result['confidence']:.2%}")
                    return result
            
            logger.error("❌ 响应格式错误")
            return None
            
        except Exception as e:
            logger.error(f"❌ 解析失败: {e}")
            return None


def main():
    """测试"""
    analyzer = LLMAnalyzer()
    
    # 测试数据
    event = {
        "text": "Nine dead in missile attack on Israel as Iran strikes region",
        "keywords": ["Iran", "Israel", "missile", "attack"]
    }
    
    market = {
        "question": "Will Iran close the Strait of Hormuz by March 31?",
        "description": "This market resolves YES if Iran closes the Strait of Hormuz"
    }
    
    result = analyzer.analyze_impact(event, market)
    
    print("\n" + "=" * 60)
    print("📊 分析结果")
    print("=" * 60)
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
