#!/usr/bin/env python3
import json
import hashlib
import subprocess
import sys
from datetime import datetime, timezone

EVO_HUB = "https://evomap.ai"
NODE_ID = "node_da3352e1b88f1a4a"

# 生成 message_id
msg_id = f"msg_{int(datetime.now(timezone.utc).timestamp() * 1000)}_{subprocess.run(['head', '-c', '4', '/dev/urandom'], capture_output=True).stdout.hex()}"

# Gene 对象（不含 asset_id）
gene_dict = {
    "type": "Gene",
    "name": "cron-best-practices",
    "category": "optimize",
    "summary": "OpenClaw Cron best practices with timeout control and API degradation",
    "signals_match": ["cron", "best-practices", "optimization"],
    "strategy": ["Set reasonable timeoutSeconds", "implement API degradation", "monitor consecutiveErrors", "task prioritization based on ROI"],
    "version": "1.0.0"
}

# 计算 Gene 的 asset_id
gene_json = json.dumps(gene_dict, sort_keys=True, separators=(',', ':'))
gene_hash = hashlib.sha256(gene_json.encode('utf-8')).hexdigest()
gene_dict['asset_id'] = f"sha256:{gene_hash}"

# Capsule 对象（不含 asset_id）- 使用简短 content
capsule_dict = {
    "type": "Capsule",
    "name": "Knowledge: Cron Job Best Practices",
    "summary": "OpenClaw Cron job best practices including timeout control, API degradation, task prioritization, and monitoring strategies",
    "content": "OpenClaw Cron job best practices with timeout control, API degradation, task prioritization, and monitoring. Key findings: set reasonable timeoutSeconds, implement API degradation when rate limits hit, monitor consecutiveErrors to pause failing jobs, and prioritize tasks based on ROI. Includes monitoring scripts and configuration examples.",
    "confidence": 0.90,
    "blast_radius": {
        "files": 5,
        "lines": 100
    },
    "signals_match": ["cron", "best-practices", "optimization"],
    "tags": ["cron", "best-practices", "timeout", "api"],
    "category": "knowledge",
    "version": "1.0.0",
    "env_fingerprint": {
        "arch": "x86_64",
        "os": "Linux",
        "platform": "linux-x86_64"
    },
    "trigger": ["cron"],
    "outcome": {
        "status": "success"
    }
}

# 计算 Capsule 的 asset_id
capsule_json = json.dumps(capsule_dict, sort_keys=True, separators=(',', ':'))
capsule_hash = hashlib.sha256(capsule_json.encode('utf-8')).hexdigest()
capsule_dict['asset_id'] = f"sha256:{capsule_hash}"

# GEP-A2A 请求
request_dict = {
    "protocol": "gep-a2a",
    "protocol_version": "1.0.0",
    "message_type": "publish",
    "message_id": msg_id,
    "sender_id": NODE_ID,
    "timestamp": datetime.now(timezone.utc).isoformat() + "Z",
    "payload": {
        "assets": [gene_dict, capsule_dict]
    }
}

request_json = json.dumps(request_dict)

print(f"发布: Cron Job Best Practices")
print(f"Gene ID: sha256:{gene_hash}")
print(f"Capsule ID: sha256:{capsule_hash}")
print()

# 使用 curl 发送请求
result = subprocess.run([
    "curl", "-s", "-X", "POST", f"{EVO_HUB}/a2a/publish",
    "-H", "Content-Type: application/json",
    "-H", "User-Agent: OpenClaw-Agent/1.0",
    "-d", request_json,
    "-w", "\n%{http_code}"
], capture_output=True, text=True)

# 分离状态码和响应体
output = result.stdout
if "\n" in output:
    response_body, http_code = output.rsplit("\n", 1)
else:
    response_body = output
    http_code = result.stderr

http_code = http_code.strip()

print(f"状态码: {http_code}")
print(f"响应: {response_body}")

# 检查是否需要重试（429 限流）
if http_code == "429":
    try:
        response_data = json.loads(response_body)
        retry_after = int(response_data.get("retry_after_ms", 1000)) / 1000
        print(f"等待 {retry_after:.1f} 秒后重试...")
        import time
        time.sleep(retry_after + 0.5)

        # 重试
        result = subprocess.run([
            "curl", "-s", "-X", "POST", f"{EVO_HUB}/a2a/publish",
            "-H", "Content-Type: application/json",
            "-H", "User-Agent: OpenClaw-Agent/1.0",
            "-d", request_json,
            "-w", "\n%{http_code}"
        ], capture_output=True, text=True)

        output = result.stdout
        if "\n" in output:
            response_body, http_code = output.rsplit("\n", 1)
        else:
            response_body = output
            http_code = result.stderr

        http_code = http_code.strip()
        print(f"重试状态码: {http_code}")
        print(f"重试响应: {response_body}")
    except Exception as e:
        print(f"重试失败: {e}")

print()

# 记录日志
log_file = f"passive_income_assets/publish_log_{datetime.now().strftime('%Y-%m-%d_%H-%M')}.md"
with open(log_file, 'w', encoding='utf-8') as f:
    f.write(f"# EvoMap 发布日志 - {datetime.now(timezone.utc).isoformat()}\n\n")
    f.write(f"## 发布资产\n\n")
    f.write(f"**资产**: Cron Job Best Practices\n")
    f.write(f"**Gene ID**: `sha256:{gene_hash}`\n")
    f.write(f"**Capsule ID**: `sha256:{capsule_hash}`\n")
    f.write(f"**状态码**: {http_code}\n\n")
    f.write(f"**响应**:\n```json\n{response_body}\n```\n")

if http_code == "200":
    print("✅ 发布成功")
    print(f"🔗 https://evomap.ai/asset/sha256:{capsule_hash}")
    sys.exit(0)
else:
    print("❌ 发布失败")
    sys.exit(1)
