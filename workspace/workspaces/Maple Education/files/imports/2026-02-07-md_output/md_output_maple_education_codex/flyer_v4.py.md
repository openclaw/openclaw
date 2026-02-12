---
title: "flyer_v4.py"
source_path: "flyer_v4.py"
tags: ["宣传", "服务", "说明", "新加坡", "Maple", "py"]
ocr: false
---

# flyer_v4.py

简介：该脚本使用 Gemini API 和本地素材生成 Maple Education 新加坡留学营销传单四页图片并合成 PDF。

## 内容

```text
"""
Maple Education Pte. Ltd. 新加坡枫叶留学 - Marketing Flyer V4
更认真版本：基于服务项目拆解的 4 页营销传单
- 使用 Google Nano Banana Pro (Gemini 3 Pro Image) 生成 4K 竖版图片
"""

import os
import shutil
from pathlib import Path

from google import genai
from google.genai import types

from PIL import Image

# ============================================================
# 配置
# ============================================================

# 为安全起见，从环境变量读取 Key（建议在系统中配置 GEMINI_API_KEY）
API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
if not API_KEY:
    raise RuntimeError("请先在环境变量 GEMINI_API_KEY 中配置 GEMINI API Key（例如你的 nano banana pro key）。")

client = genai.Client(api_key=API_KEY)

BASE_DIR = Path("/mnt/b/Desktop/maple education")
ASSETS_DIR = BASE_DIR / "assets"
OUTPUT_DIR = BASE_DIR / "marketing_flyers_v4"
OUTPUT_DIR.mkdir(exist_ok=True)

# ============================================================
# 品牌颜色与设计规范（沿用 Logo 提取色）
# ============================================================

BRAND_COLORS = """
BRAND COLORS（必须严格使用 Logo 中的颜色）：

主色调：
- 天蓝色 #7EC8E3：大面积背景、标题条
- 建筑蓝 #2196F3：图标、强调元素
- 新加坡绿 #A4C639：地图、标记、标签

辅助色：
- 深灰色 #333333：中文/英文正文
- 纯白色 #FFFFFF：卡片、对话框背景

点缀色（极少量）：
- 枫叶橙 #E85A3C：仅用于 CTA 按钮或价格标签，不要大面积使用

禁止：
- 不要使用 Logo 之外的乱七八糟颜色
- 不要在页面中到处加枫叶装饰，枫叶只出现在 Logo 里即可
"""

DESIGN_SPECS = """
DESIGN SPECIFICATIONS：

画面参数：
- 分辨率：4K 高清（3:4 竖版，接近 A4）
- 风格：现代、简洁、偏企业级咨询公司风格
- 版式：清晰的信息层级 + 充足留白 + 卡片式分块

Logo 使用：
- 每一页都要出现水獭吉祥物 Logo（完整、清晰）
- Logo 位置：建议顶部左侧或右上角，类似企业画册

文字与排版：
- 中英文双语并存，中文为主，英文为补充
- 关键数字（价格、成功案例数量）要突出
- 尽量避免花里胡哨的艺术字体，使用干净的无衬线字体

新加坡元素：
- 可以使用金沙酒店剪影、新加坡地图轮廓作为背景元素，但要低饱和度、低对比度
"""

# ============================================================
# 素材路径
# ============================================================

ASSETS = {
    "logo": ASSETS_DIR / "logo.jpg",
    "consultant_male": ASSETS_DIR / "cover_consultant_male.jpg",
    "consultant_female": ASSETS_DIR / "consultant_female.jpg",
    "student_male": ASSETS_DIR / "student_male.png",
    "student_female": ASSETS_DIR / "student_female.png",
    "acra": ASSETS_DIR / "acra_certificate.png",
}


# ============================================================
# 工具函数
# ============================================================

def load_image(path: Path) -> types.Part:
    """加载图片为 Gemini API 的 Part 对象。"""
    with open(path, "rb") as f:
        data = f.read()
    mime = "image/jpeg" if path.suffix.lower() in [".jpg", ".jpeg"] else "image/png"
    return types.Part.from_bytes(data=data, mime_type=mime)


# ============================================================
# 传单页面定义（更贴近“服务项目表 + 产品手册”）
# ============================================================

FLYERS = [
    # ========== 第 1 页：我们是谁 ==========
    {
        "name": "01_cover_who_we_are",
        "assets": ["logo", "consultant_male"],
        "prompt": f"""
基于我提供的公司 Logo 和男顾问照片，设计一张专业的【封面页】。

{BRAND_COLORS}
{DESIGN_SPECS}

页面目标：
- 让中国家长一眼知道：这是“新加坡枫叶留学”，在新加坡正式注册的本土机构，可信、专业、不是某个模板号。

结构建议（请在视觉上体现这种分区，而不是一团乱）：

1. 顶部栏（品牌区）：
   - 左侧：完整的水獭吉祥物 Logo
   - 右侧/附近：公司名称
     - 中文主名：新加坡枫叶留学
     - 英文法定名称：Maple Education Pte. Ltd.
   - 底部一行小字：ACRA UEN 202349302E · Registered in Singapore

2. 中央主视觉（顾问 + 新加坡）：
   - 使用男顾问照片作为主体人物，呈现专业、可靠的留学顾问形象
   - 背景可以融入新加坡天际线（金沙酒店）、地图轮廓，保持低饱和度

3. 核心卖点区域（最多 4 点，图标 + 短句）：
   - “新加坡本土团队 · 常驻新加坡”
   - “政府注册公司 · ACRA 正式备案”
   - “官方认证 · 院校授权官方身份 权威拉满（Kaplan / PSB / Amity 等）”
   - “400+ 成功案例 · 覆盖本科 / 硕士 / 低龄”

4. 底部引导（小 CTA）：
   - 简短一句话：例如“为中国家庭提供一站式新加坡留学服务”
   - 可以留出二维码占位区域（白色方块），但二维码内容可后期替换

整体风格：
- 类似专业咨询公司画册封面，而不是海报或 PPT 截图
- 信息层级清晰：品牌 → 主视觉 → 卖点 → CTA
"""
    },

    # ========== 第 2 页：19800 本科项目拆解 ==========
    {
        "name": "02_undergrad_19800",
        "assets": ["acra"],
        "prompt": f"""
基于 ACRA 注册文件，设计一张【本科项目服务拆解页】，
主题是“新加坡本科北京办事中心 · 示例项目费 19,800 RMB”，
画面要像服务项目表 + 产品手册的结合。

{BRAND_COLORS}
{DESIGN_SPECS}

整体结构：

1. 标题区域（仅使用文字呈现品牌信息，不需要在页面中绘制公司 Logo 图形）：
   - 中文主标题：新加坡本科留学服务 · 示例项目费 19,800 RMB
   - 英文副标题：Singapore Undergraduate Pathway · Example Package
   - 在标题附近用较小字号标注：
     - “Maple Education Pte. Ltd.（新加坡枫叶留学） · ACRA UEN 202349302E”
   - 用一条细线或色条与正文区隔开

2. 服务项目模块（横向或纵向分成三个大卡片块，对应“录取服务 / 入学服务 / 全程服务”）：

   模块 1：录取服务 · Admission
   - 留学国家及院校咨询服务：根据学生学术背景及个人需求制定适合学生的留学方案（以三所院校为基准）
   - 指导准备留学申请材料（含成绩单、公证件、推荐信等）
   - 指导或协助办理纸质材料公证及学信网认证（第三方费用由学生自行承担）
   - 递交院校申请服务（申请费由院校或官方机构收取）
   - 申请材料的润色、审核及整理服务
   - 院校录取进度跟进与补交材料服务
   - 下发录取 Offer 并解读要点

   模块 2：入学服务 · Enrollment
   - 指导或协助安排境外住宿（住宿费用自理）
   - 境外接机服务（首次入学，接机车辆：丰田埃尔法或同等级七座商务车）
   - 指导缴纳学费及相关费用
   - 协助指导办理 IPA 换 STP 等学生准证手续
   - 协助指导办理入学报到、体检等流程
   - 协助指导办理手机卡、银行卡及地铁卡等基础生活配置
   - 视情况提供单次陪同办理日常生活用品采购等服务

   模块 3：全程服务 · Ongoing Support
   - 全程跟踪升学服务直至毕业，提供必要的路径调整建议
   - 免费转学服务（新的院校申请费由学生自理）
   - 校方毕业文件办理指导服务
   - 赠送一次作业辅导或学术支持体验课

3. 价格与说明：
   - 标注：标准版 Standard Package · 费用示例：RMB 19,800（一站式全程服务，服务至学生毕业）
   - 说明文字：以上为示例项目费，用于展示服务结构与预算区间。Maple Education 采用透明报价与分阶段付款安排，具体费用、优惠及服务明细以当期价目表和双方签署的正式服务合同为准，不承诺任何形式的“保证录取”“保签”等结果。
   - 一行小字：费用不包含外部机构的第三方必然性支出（如考试报名费、签证费、保险、体检、住宿、机票等）；透明报价 · 分阶段付款 · 全程信息留痕

4. 权威背书区域：
   - 使用 ACRA 文件截图作为背景的一部分，突出“新加坡注册公司”
   - 放一行小字：MAPLE EDUCATION PTE. LTD. · UEN 202349302E

视觉风格：
- 像严肃的服务项目列表，而不是花哨海报
- 每个模块像卡片，有标题 + 项目条目 + 适量图标
"""
    },

    # ========== 第 3 页：境外管家 + 全程陪跑 ==========
    {
        "name": "03_overseas_butler",
        "assets": ["logo"],
        "prompt": f"""
只基于公司 Logo，设计一张【境外管家服务与全程陪跑】页面，
突出“孩子到了新加坡之后，Maple Education 仍然在新加坡本地持续提供支持”。

重要：这一页不需要真实人物照片或大面积人脸特写。
如需人物元素，只使用小比例、抽象化的人物图标或远景剪影，避免出现夸张或失真的面部细节。

{BRAND_COLORS}
{DESIGN_SPECS}

页面结构：

1. 标题：
   - 中文主标题：境外管家服务 · 孩子落地后的 90 天
   - 英文副标题：Overseas Butler Service · First 3 Months in Singapore

2. 可视化结构（建议信息图形式，而非写实照片）：
   - 使用时间轴（Timeline）或三步流程图的形式，清晰展示：
     - 抵达与安置（Arrival & Settlement）
     - 入学与手续（Enrollment & Formalities）
     - 持续陪跑（Ongoing Support）
   - 每个阶段使用简单图标，如机场/行李、校园/证件、日历/对勾等。

3. 服务项目分组（图标 + 文本为主）：
   - 抵达与安置：
     - 接机与送达宿舍 / 学校
     - 协助办理电话卡、交通卡
     - 带看周边生活区（超市、医疗点等）
   - 入学与手续：
     - 指导完成入学报到、体检和学生证相关流程（官方费用由学生自理）
     - 指导开立本地银行账户
     - 提供重要文件归档与备份建议
   - 持续陪跑：
     - 抵达后 90 天内定期回访学习与生活状态
     - 提醒续签与重要考试节点
     - 如需可协助对接额外学术辅导与课程调整（费用另行约定）

4. 价值主张小框：
   - “家长不在新加坡，Maple Education 也在本地为孩子提供持续支持”
   - “服务过程有记录可查，重要节点有人提醒、关键手续有人负责”

风格要求：
- 整体以信息图表（icons + timeline + cards）为主，不依赖人物照片。
- 使用品牌蓝色和绿色作为阶段区分色，布局清晰、有逻辑，方便家长一眼理解服务范围。
"""
    },

    # ========== 第 4 页：联系方式 + 常见疑问 ==========
    {
        "name": "04_contact_faq",
        "assets": ["logo"],
        "prompt": f"""
只基于公司 Logo，设计一张【联系方式 + 常见疑问】页面，
用来作为整套传单的收尾页面，适合打印或截图发给家长。

{BRAND_COLORS}
{DESIGN_SPECS}

页面结构：

1. 顶部：
   - 大 Logo（水獭吉祥物），强调亲和力
   - 标题：开启你的新加坡留学之旅 | Start Your Journey

2. 左侧：联系方式与二维码（动作区）：
   - 大号二维码占位框（白色圆角方块），标注：
     - “扫码添加顾问微信”
     - “获取 1 对 1 留学方案”
   - 文字联系方式列表（配小图标）：
     - WeChat：maple_edu_sg（示例，可留空让后期填写）
     - WhatsApp：+65 8686 3695
     - Email：Maple@maplesgedu.com
     - 地址：111 North Bridge Road, #25-01, Peninsula Plaza, Singapore 179098

3. 右侧：家长常见疑问（Q&A，写得简短有力）：
   Q1：你们和国内中介有什么不同？
       - 简答：我们是新加坡本土团队，常驻新加坡，直接对接当地院校和资源。

   Q2：19,800 的服务费包含什么？会不会有隐形收费？
       - 简答：按前期规划 / 申请 / 落地三个阶段透明拆分，
         额外收费项（如考试报名费、签证费）由官方机构收取，我们不会代收。

   Q3：如果孩子英语一般，还能申请吗？
       - 简答：可以，我们会根据成绩和预算设计合适的预科 / 语言课程与后续衔接路径。

4. 底部：
   - 一句话结束语：
     - “欢迎各位学子和家长与 Maple Education 一起规划新加坡留学之路”
     - 英文小字：Plan your Singapore education journey with Maple Education

风格要求：
- 这一页更偏“说明书 + 联系卡”，信息清晰、易于截图转发
- 不要复杂背景，整体保持干净，让文字和二维码成为主角
"""
    },
]


# ============================================================
# 生成与导出
# ============================================================

def generate_flyer(config: dict) -> str | None:
    """调用 Gemini 生成单页传单图片。"""
    name = config["name"]
    print(f"\n{'=' * 50}")
    print(f"正在生成: {name}")
    print(f"{'=' * 50}")

    contents: list[types.Part | str] = []

    # 1. 加载并附上相关素材（Logo / 顾问 / 学生 / ACRA）
    for asset_key in config["assets"]:
        path = ASSETS.get(asset_key)
        if path and path.exists():
            print(f"  + 加载素材: {asset_key} -> {path.name}")
            contents.append(load_image(path))
        else:
            print(f"  ! 素材不存在或路径错误: {asset_key}")

    # 2. 添加文本 prompt
    contents.append(config["prompt"])

    try:
        response = client.models.generate_content(
            model="nano-banana-pro-preview",
            contents=contents,
            config=types.GenerateContentConfig(
                response_modalities=["TEXT", "IMAGE"],
                image_config=types.ImageConfig(
                    aspectRatio="3:4",
                    imageSize="4K",
                ),
            ),
        )

        output_path = OUTPUT_DIR / f"{name}.png"

        for part in response.candidates[0].content.parts:
            if hasattr(part, "inline_data") and part.inline_data:
                with open(output_path, "wb") as f:
                    f.write(part.inline_data.data)
                print(f"  ✓ 已保存图片: {output_path}")
                return str(output_path)

        print("  ✗ 模型未返回图片数据")
        return None

    except Exception as e:
        print(f"  ✗ 生成失败: {e}")
        return None


def create_pdf(images: list[str], output: str) -> None:
    """将若干 PNG 合成为一个多页 PDF。"""
    pil_images: list[Image.Image] = []

    for p in images:
        if not p:
            continue
        path = Path(p)
        if not path.exists():
            continue

        img = Image.open(path)
        if img.mode == "RGBA":
            img = img.convert("RGB")
        pil_images.append(img)

    if not pil_images:
        print("✗ 没有可用图片，无法生成 PDF")
        return

    pil_images[0].save(
        output,
        "PDF",
        resolution=300.0,
        save_all=True,
        append_images=pil_images[1:],
    )
    print(f"\n✓ PDF 已生成: {output}")


def main() -> None:
    print("=" * 60)
    print("Maple Education SG - Marketing Flyer Generator V4")
    print("=" * 60)
    print(f"\n输出目录: {OUTPUT_DIR}")

    results: list[str | None] = []
    for flyer in FLYERS:
        result = generate_flyer(flyer)
        results.append(result)

    success = sum(1 for r in results if r)
    print(f"\n生成成功: {success}/{len(FLYERS)}")

    if success == 0:
        return

    # 合成 PDF 并复制到 Downloads，方便在 Windows 端查看
    pdf_path = OUTPUT_DIR / "Maple_Education_Flyer_V4.pdf"
    create_pdf([r for r in results if r], str(pdf_path))

    downloads_pdf = Path("/mnt/b/Downloads/Maple_Education_Flyer_V4.pdf")
    try:
        shutil.copy(pdf_path, downloads_pdf)
        print(f"✓ PDF 已复制到: {downloads_pdf}")
    except Exception as e:
        print(f"! 复制到 Downloads 失败: {e}")


if __name__ == "__main__":
    main()
```