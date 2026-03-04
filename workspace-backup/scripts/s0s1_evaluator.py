#!/usr/bin/env python3
"""
S0/S1 复杂任务分层评估系统
基于 AGENTS.md 中的 S0/S1 规范
"""

import re
import sys
from typing import Dict, Tuple, Optional

# 内嵌配置（避免依赖 yaml 模块）
DEFAULT_CONFIG = {
    "s0_max_length": 200,
    "s0_triggers": {
        "intent_keywords": ["开发", "构建", "设计", "部署", "迁移", "重构", "编写", "创建"],
        "scope_keywords": ["整个", "全部", "系统", "架构", "从零开始", "完整"],
        "multi_step_enabled": True,
        "multi_step_patterns": ["先", "然后", "最后", "第一步", "第二步", "第三步"],
        "explicit_triggers": ["复杂任务", "三步法", "需要规划", "先规划"]
    },
    "s0_whitelist": {
        "simple_qa": ["几点了", "天气怎样", "现在几点", "几点了"],
        "continuation": ["继续", "下一步", "还有吗", "继续执行", "继续工作"],
        "simple_commands": ["搜索", "发消息给", "帮我查", "帮我找", "查询", "列出"],
        "chat_acknowledgment": ["好的", "谢谢", "明白了", "收到", "知道了"]
    },
    "s1_simple_threshold": 5,
    "s1_medium_threshold": 10
}

# 配置加载
def load_config() -> Dict:
    """加载 S0/S1 配置"""
    # 尝试从 YAML 加载（如果可用）
    try:
        import yaml
        config_path = "/home/node/.openclaw/workspace/config/complex_task_thresholds.yaml"
        with open(config_path, 'r', encoding='utf-8') as f:
            return yaml.safe_load(f)
    except ImportError:
        # yaml 模块不可用，使用内嵌配置
        return DEFAULT_CONFIG
    except Exception as e:
        print(f"配置加载失败: {e}，使用默认配置")
        return DEFAULT_CONFIG


def s0_pre_filter(message: str, config: Dict) -> Tuple[bool, str]:
    """
    S0 零成本预筛选

    返回:
        (需要进入S1, 白名单类型)
    """

    # 检查白名单（直接执行，跳过 S1）
    whitelist = config.get('s0_whitelist', {})

    # 1. 单轮问答
    for qa in whitelist.get('simple_qa', []):
        if message.strip() in qa or qa in message.strip():
            return False, "simple_qa"

    # 2. 延续指令
    for cont in whitelist.get('continuation', []):
        if message.strip() in cont or cont in message.strip():
            return False, "continuation"

    # 3. 简单指令
    for cmd in whitelist.get('simple_commands', []):
        if cmd in message:
            return False, "simple_command"

    # 4. 闲聊确认
    for chat in whitelist.get('chat_acknowledgment', []):
        if message.strip() in chat or chat in message.strip():
            return False, "chat_acknowledgment"

    # 检查触发信号（进入 S1）
    triggers = config.get('s0_triggers', {})
    max_length = config.get('s0_max_length', 200)

    # 1. 消息长度
    if len(message) > max_length:
        return True, "too_long"

    # 2. 多段落
    paragraphs = [p.strip() for p in message.split('\n') if p.strip()]
    if len(paragraphs) >= 2:
        return True, "multi_paragraph"

    # 3. 意图动词
    for keyword in triggers.get('intent_keywords', []):
        if keyword in message:
            return True, f"intent_{keyword}"

    # 4. 范围词
    for keyword in triggers.get('scope_keywords', []):
        if keyword in message:
            return True, f"scope_{keyword}"

    # 5. 多步模式
    if triggers.get('multi_step_enabled', False):
        for pattern in triggers.get('multi_step_patterns', []):
            if pattern in message:
                return True, "multi_step"

    # 6. 显式触发
    for trigger in triggers.get('explicit_triggers', []):
        if trigger in message:
            return True, f"explicit_{trigger}"

    # 默认进入 S1
    return True, "default"


def s1_complexity_evaluator(message: str, config: Dict) -> int:
    """
    S1 轻量复杂度评估（规则启发式）

    返回:
        总分 (5-25)
    """

    total_score = 0

    # 1. 步骤数评估
    steps_keywords = {
        5: ["从零开始", "完整系统", "整个架构"],
        4: ["部署到", "迁移到", "构建完整"],
        3: ["先", "然后", "最后", "第一步"],
        2: ["并且", "同时", "接着"],
        1: ["单个", "简单", "快速"]
    }
    steps_score = 1  # 默认 1
    for score, keywords in steps_keywords.items():
        for keyword in keywords:
            if keyword in message:
                steps_score = max(steps_score, score)
    total_score += steps_score

    # 2. 知识域评估
    domain_keywords = {
        5: ["区块链", "AI模型", "机器学习", "深度学习", "Web3"],
        4: ["数据库", "API", "网络", "服务器", "容器"],
        3: ["前端", "后端", "测试", "部署"],
        2: ["脚本", "配置", "文档"],
        1: ["查询", "检查", "查看"]
    }
    domain_count = 0
    for score, keywords in domain_keywords.items():
        for keyword in keywords:
            if keyword in message:
                domain_count += 1
    domain_score = min(5, max(1, domain_count))
    total_score += domain_score

    # 3. 不确定性评估
    uncertainty_keywords = {
        5: ["可能", "不确定", "需要研究", "需要探索", "未知的"],
        4: ["猜测", "估计", "大概", "推测"],
        3: ["考虑", "思考", "分析", "评估"],
        2: ["明确", "清楚", "具体"],
        1: ["已知", "确定", "固定"]
    }
    uncertainty_score = 1
    for score, keywords in uncertainty_keywords.items():
        for keyword in keywords:
            if keyword in message:
                uncertainty_score = max(uncertainty_score, score)
    total_score += uncertainty_score

    # 4. 失败代价评估
    cost_keywords = {
        5: ["删除", "清空", "重置", "格式化", "覆盖"],
        4: ["修改", "更改", "替换", "升级"],
        3: ["创建", "部署", "发布"],
        2: ["测试", "验证", "检查"],
        1: ["查询", "查看", "读取"]
    }
    cost_score = 1
    for score, keywords in cost_keywords.items():
        for keyword in keywords:
            if keyword in message:
                cost_score = max(cost_score, score)
    total_score += cost_score

    # 5. 工具链评估
    tool_keywords = {
        5: ["Docker", "Kubernetes", "多个API", "微服务"],
        4: ["数据库", "缓存", "消息队列", "API"],
        3: ["脚本", "工具", "自动化"],
        2: ["单个API", "单个脚本"],
        1: ["查询", "查看"]
    }
    tool_count = 0
    for score, keywords in tool_keywords.items():
        for keyword in keywords:
            if keyword in message:
                tool_count += 1
    tool_score = min(5, max(1, tool_count))
    total_score += tool_score

    return total_score


def decide_action(total_score: int, config: Dict) -> str:
    """
    根据总分决定执行方式

    返回:
        "execute_directly" - 直接执行
        "lightweight_plan" - 轻量规划
        "full_plan" - 完整规划（中书省）
    """

    simple_threshold = config.get('s1_simple_threshold', 8)
    medium_threshold = config.get('s1_medium_threshold', 15)

    if total_score <= simple_threshold:
        return "execute_directly"
    elif total_score <= medium_threshold:
        return "lightweight_plan"
    else:
        return "full_plan"


def evaluate_message(message: str) -> Dict:
    """
    评估用户消息的复杂度

    返回:
        {
            "s0_result": {"enter_s1": bool, "reason": str},
            "s1_score": int,
            "decision": str,
            "action": str
        }
    """

    config = load_config()
    if not config:
        print("无法加载配置，使用默认值")
        config = {
            "s0_max_length": 200,
            "s0_triggers": {
                "intent_keywords": ["开发", "构建", "设计", "部署", "迁移", "重构"],
                "scope_keywords": ["整个", "全部", "系统", "架构"],
                "multi_step_enabled": True,
                "multi_step_patterns": ["先", "然后", "最后"]
            },
            "s0_whitelist": {
                "simple_qa": ["几点了", "天气怎样"],
                "continuation": ["继续", "下一步"],
                "simple_commands": ["搜索", "发消息给"],
                "chat_acknowledgment": ["好的", "谢谢"]
            },
            "s1_simple_threshold": 8,
            "s1_medium_threshold": 15
        }

    # S0 预筛选
    enter_s1, s0_reason = s0_pre_filter(message, config)

    result = {
        "s0_result": {
            "enter_s1": enter_s1,
            "reason": s0_reason
        },
        "message_length": len(message),
        "decision": "execute_directly"
    }

    if not enter_s1:
        # 白名单，直接执行
        result["decision"] = "execute_directly"
        result["action"] = f"S0 白名单: {s0_reason}"
        return result

    # S1 评估
    s1_score = s1_complexity_evaluator(message, config)
    result["s1_score"] = s1_score

    # 决策
    decision = decide_action(s1_score, config)
    result["decision"] = decision

    if decision == "execute_directly":
        result["action"] = f"S1 评分 {s1_score}/25 ≤ {config['s1_simple_threshold']}，直接执行"
    elif decision == "lightweight_plan":
        result["action"] = f"S1 评分 {s1_score}/25，轻量规划（{config['s1_simple_threshold']}-{config['s1_medium_threshold']}分）"
    else:
        result["action"] = f"S1 评分 {s1_score}/25 > {config['s1_medium_threshold']}，完整规划（中书省）"

    return result


def main():
    """主函数：从命令行评估消息"""

    if len(sys.argv) < 2:
        print("用法: python s0s1_evaluator.py <消息内容>")
        print("示例: python s0s1_evaluator.py '开发一个完整的区块链系统'")
        sys.exit(1)

    message = " ".join(sys.argv[1:])
    result = evaluate_message(message)

    print("=== S0/S1 复杂度评估结果 ===")
    print(f"消息: {message[:100]}...")
    print(f"长度: {result['message_length']} 字符")
    print(f"S0 结果: {'进入 S1' if result['s0_result']['enter_s1'] else '白名单'}")
    print(f"  原因: {result['s0_result']['reason']}")

    if result['s0_result']['enter_s1']:
        print(f"S1 评分: {result['s1_score']}/25")
        print(f"决策: {result['decision']}")
        print(f"行动: {result['action']}")
    else:
        print(f"行动: {result['action']}")


if __name__ == "__main__":
    main()
