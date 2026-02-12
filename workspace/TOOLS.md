# TOOLS.md - Local Notes

Skills define *how* tools work. This file is for *your* specifics — the stuff that's unique to your setup.

## 图片生成

### ComfyUI
- **路径:** `/mnt/ugreen/leo/comfyui`
- **端口:** 8188
- **启动:** `bash /home/leonard/start_comfyui.sh`
- **用途:** 本地 Stable Diffusion + 可接外部 API

### Nano Banana Pro (Gemini 3 Pro Image)
- **API Key:** （敏感信息，已迁移到 `tools/secrets.local.md` → `NANO_BANANA_PRO_API_KEY`）
- **用途:** 通过 ComfyUI 调用 Gemini 生成图片

### Google APIs
- **API Key:** （敏感信息，已迁移到 `tools/secrets.local.md` → `GOOGLE_API_KEY`）
- **用途:** Google 系列功能（Maps, Translate, YouTube, etc.）

## 电脑配置

- **主机:** leonardpc (Ubuntu 24.04.3)
- **CPU:** AMD Ryzen 5 7600 (6核)
- **内存:** 32GB
- **GPU:** NVIDIA RTX 5060 Ti (16GB VRAM)
- **硬盘:** 913GB SSD

## 服务

- **RustDesk:** hbbs/hbbr 容器运行中
- **WireGuard:** VPN 已配置
