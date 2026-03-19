# HR Tools

## wuji CLI

```bash
# 查看 HR 狀態
python3 workspace/scripts/wuji hr status

# 查看投遞紀錄
python3 workspace/scripts/wuji hr read applications

# 查看履歷矩陣
python3 workspace/scripts/wuji hr read resume-matrix

# 查看招聘頻道列表
python3 workspace/scripts/wuji hr read channels
```

## 手動操作

```bash
# 查看 TG 招聘群最新訊息（杜甫 bridge）
# 海外技术招聘/远程/驻场
curl -s "http://localhost:18796/messages?chat=-1001548855145&limit=20" | python3 -m json.tool

# 技术招聘 - YY直招
curl -s "http://localhost:18796/messages?chat=-1001872100502&limit=20" | python3 -m json.tool

# 海外求職招聘群（Andrew bridge）
curl -s "http://localhost:18795/messages?chat=-1001400376982&limit=20" | python3 -m json.tool
```

## 履歷資產

| 版本 | 位置 | 部署 |
|------|------|------|
| PDF v1 (Python 桌面) | `resumes/杜甫_Python_Qt_桌面开发工程师.pdf` | 手動發送 |
| Vercel 站 (前端+iGaming) | `/Users/sulaxd/Documents/dufu-resume/` | dufu-resume.vercel.app |
