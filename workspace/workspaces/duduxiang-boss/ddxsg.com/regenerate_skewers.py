#!/usr/bin/env python3
"""
重新生成东北烤串图片
基于网络搜索的真实东北烧烤特点
"""

import json
import os
import time
from pathlib import Path

try:
    from google import genai
    from google.genai import types
except ImportError:
    print("请先安装 google-genai: pip install google-genai")
    exit(1)

API_KEY = os.environ.get("GEMINI_API_KEY", "")
OUTPUT_DIR = Path(__file__).parent / "assets" / "images"

# 真实东北烤串的通用特点（基于网络搜索）
# 来源:
# - https://news.cnjiwang.com/jwyc/202304/3717404.html
# - https://baike.baidu.com/item/锦州烧烤/772634
# - https://m.xiachufang.com/recipe/102129457/
# - https://zhuanlan.zhihu.com/p/79013501

COMMON_STYLE = """
Photography style: Street food vendor stall at night, warm orange light from charcoal fire.
Meat characteristics: Hand-cut irregular chunks (NOT machine-cut cubes), varying sizes, rustic look.
After grilling: Edges charred and blackened unevenly, meat shrunk and slightly curled, glistening with rendered fat.
Seasoning: HEAVILY covered with cumin powder (孜然) and red chili flakes (辣椒面), looks messy and generous, powder visible everywhere.
Skewer style: Thin metal skewers (bicycle spoke style, 锦州铁签), NOT bamboo.
Background: Smoky, charcoal grill visible, authentic street food atmosphere.
NO vegetables, NO onions, NO peppers on the skewers - meat only!
Quality: Authentic Chinese street food photography, NOT studio-perfect, real and appetizing.
"""

# 需要重新生成的烤串，使用真实描述
SKEWERS = [
    {
        "id": 29,
        "name": "烤羊排",
        "image": "kaoyangpai.jpg",
        "prompt": f"""东北烤羊排 authentic grilled lamb ribs:
Large rack of lamb ribs on metal plate, charred BLACK edges with visible grill marks.
Fat fully rendered and crispy, meat pulling away from bones.
HEAVILY dusted with cumin seeds and red chili flakes - powder everywhere, messy and generous.
Some areas burnt black, some golden - uneven natural grilling.
Served on cheap metal tray, street food style.
{COMMON_STYLE}"""
    },
    {
        "id": 33,
        "name": "牛肉串",
        "image": "niurouchuan.jpg",
        "prompt": f"""东北牛肉串 5 skewers of grilled beef:
5 thin METAL skewers (not bamboo), each with 4-5 IRREGULAR hand-cut beef chunks.
Meat pieces are different sizes, NOT uniform cubes - some bigger, some smaller, rough edges.
Charred blackened spots, some pink juicy parts visible where meat split.
SMOTHERED in cumin powder and chili flakes - can barely see the meat under the seasoning.
Fat dripping, sizzling appearance.
NO vegetables between meat - pure beef only.
{COMMON_STYLE}"""
    },
    {
        "id": 34,
        "name": "羊肉串",
        "image": "yangrouchuan.jpg",
        "prompt": f"""东北羊肉串 5 skewers of grilled lamb:
5 thin METAL skewers, each with irregular chunks of lamb meat alternating with small pieces of lamb tail fat (羊尾油).
Pattern: 2-3 lean meat pieces, then 1 fat piece, repeat. Fat is white/translucent when raw, golden when grilled.
Meat hand-cut and uneven, NOT perfect cubes.
Edges burnt black, fat rendered and slightly crispy.
COVERED in thick layer of cumin and chili - the signature 东北 heavy seasoning style.
Classic street BBQ look, messy and delicious.
{COMMON_STYLE}"""
    },
    {
        "id": 35,
        "name": "猪肉串",
        "image": "zhurouchuan.jpg",
        "prompt": f"""东北猪肉串 5 skewers of grilled pork:
5 thin METAL skewers with hand-cut pork pieces showing natural fat marbling.
Irregular chunks, some with visible fat layers (肥瘦相间), NOT uniform.
Caramelized golden-brown with blackened charred spots.
Heavy cumin and chili coating, seasoning powder visible.
Fat rendered and glistening.
{COMMON_STYLE}"""
    },
    {
        "id": 36,
        "name": "鸡肉串",
        "image": "jirouchuan.jpg",
        "prompt": f"""东北鸡肉串 5 skewers of grilled chicken:
5 thin METAL skewers with irregular chunks of chicken thigh meat (NOT breast - too dry).
Pieces are hand-cut, uneven sizes, some with skin attached.
Golden char marks, slightly blackened edges.
Moderate cumin and chili coating.
Juicy appearance, NOT dried out.
{COMMON_STYLE}"""
    },
    {
        "id": 37,
        "name": "牛蹄筋",
        "image": "niutijin.jpg",
        "prompt": f"""东北烤牛蹄筋 5 skewers of grilled beef tendon:
5 thin METAL skewers with beef tendon pieces - translucent, amber-colored, gelatinous texture.
Tendons are chewy-looking, irregular shapes, slightly charred on edges.
QQ弹弹 bouncy texture visible.
Light seasoning - cumin and salt.
{COMMON_STYLE}"""
    },
    {
        "id": 38,
        "name": "牛胸口",
        "image": "niuxiongkou.jpg",
        "prompt": f"""东北烤牛胸口 5 skewers of grilled beef brisket:
5 thin METAL skewers with beef brisket chunks showing beautiful fat marbling.
Hand-cut irregular pieces, rich marbling pattern visible.
Charred edges, juicy center, fat rendered.
Heavy seasoning with cumin and chili.
{COMMON_STYLE}"""
    },
    {
        "id": 39,
        "name": "肥瘦",
        "image": "feishou.jpg",
        "prompt": f"""东北烤肥瘦 5 skewers of grilled pork belly:
5 thin METAL skewers with pork belly pieces showing distinct alternating layers - white fat, pink lean.
The 肥瘦 pattern clearly visible in each piece.
Fat fully rendered, translucent and crispy.
Caramelized golden surface with black char spots.
Heavy cumin and chili.
{COMMON_STYLE}"""
    },
    {
        "id": 40,
        "name": "酱油筋",
        "image": "jiangyoujin.jpg",
        "prompt": f"""东北烤酱油筋 5 skewers of soy-glazed tendons:
5 thin METAL skewers with pork tendons glazed in dark soy sauce.
Shiny dark brown/black color, sticky caramelized glaze.
Chewy gelatinous texture visible.
Irregular pieces, some curled from heat.
{COMMON_STYLE}"""
    },
    {
        "id": 41,
        "name": "板筋",
        "image": "banjin.jpg",
        "prompt": f"""东北烤板筋 5 skewers of grilled neck tendon:
5 thin METAL skewers with pork neck tendon (板筋) - flat chewy pieces.
Distinctive flat shape, slightly curled and charred.
Chewy crunchy texture, golden with char marks.
Light seasoning.
{COMMON_STYLE}"""
    },
    {
        "id": 42,
        "name": "心管",
        "image": "xinguan.jpg",
        "prompt": f"""东北烤心管 5 skewers of grilled aorta:
5 thin METAL skewers with pork heart tubes (aorta) - tubular ring shapes.
Crispy and curled from grilling, crunchy texture.
Golden brown color, some blackened edges.
Light cumin seasoning.
{COMMON_STYLE}"""
    },
    {
        "id": 43,
        "name": "猪腰子",
        "image": "zhuyaozi.jpg",
        "prompt": f"""东北烤猪腰子 5 skewers of grilled pork kidney:
5 thin METAL skewers with pork kidney slices.
Scored cross-hatch pattern (花刀) on surface, opened up from heat.
Pink interior visible, cooked through but not overdone.
Charred grill marks, cumin and chili seasoning.
{COMMON_STYLE}"""
    },
    {
        "id": 44,
        "name": "猪肥肠",
        "image": "zhufeichang.jpg",
        "prompt": f"""东北烤猪肥肠 5 skewers of grilled large intestine:
5 thin METAL skewers with pork large intestine pieces.
Curled tubular shapes, crispy golden exterior.
Some blackened charred spots, fat rendered.
Heavy cumin and chili to mask any smell.
{COMMON_STYLE}"""
    },
    {
        "id": 45,
        "name": "大油边",
        "image": "dayoubian.jpg",
        "prompt": f"""东北烤大油边 5 skewers of grilled pork fat:
5 thin METAL skewers with pure pork fat trim pieces.
Rendered translucent and crispy, golden color.
Slightly charred edges, crispy crackling texture.
Light salt and cumin.
{COMMON_STYLE}"""
    },
    {
        "id": 46,
        "name": "梅花肉",
        "image": "meihuarou.jpg",
        "prompt": f"""东北烤梅花肉 5 skewers of grilled pork shoulder:
5 thin METAL skewers with pork shoulder (plum blossom cut) chunks.
Beautiful marbling pattern visible, hand-cut irregular pieces.
Juicy and tender appearance, charred edges.
Heavy cumin and chili seasoning.
{COMMON_STYLE}"""
    },
    {
        "id": 47,
        "name": "鸡胗",
        "image": "jizhen.jpg",
        "prompt": f"""东北烤鸡胗 5 skewers of grilled chicken gizzards:
5 thin METAL skewers with chicken gizzards - firm dense texture.
Dark reddish-brown color, scored surface, slightly split from heat.
Crunchy exterior, chewy interior.
Cumin and chili seasoning.
{COMMON_STYLE}"""
    },
    {
        "id": 48,
        "name": "烤脆骨",
        "image": "kaocuigu.jpg",
        "prompt": f"""东北烤脆骨 5 skewers of grilled cartilage:
5 thin METAL skewers with pork cartilage pieces.
Translucent white with golden char marks.
Small irregular pieces, crunchy chewy texture.
Light seasoning, cumin visible.
{COMMON_STYLE}"""
    },
    {
        "id": 49,
        "name": "烤鸡翅",
        "image": "kaojichi.jpg",
        "prompt": f"""东北烤鸡翅 2 skewers of grilled chicken wings:
2 thin METAL skewers, each piercing through a whole chicken wing (all 3 sections connected).
Crispy golden-brown skin, bubbled and charred in spots.
Juicy meat visible where skin split.
Cumin and chili dusting.
{COMMON_STYLE}"""
    },
    {
        "id": 50,
        "name": "大块肉",
        "image": "dakuairou.jpg",
        "prompt": f"""东北烤大块肉 1 large meat chunk on skewer:
1 thick METAL skewer with one BIG chunk of pork (about 100g), not cut into small pieces.
Charred exterior with grill marks, pink juicy center visible where cut/torn.
Substantial size - this is the "big meat" 大块肉.
Heavy cumin and chili coating.
{COMMON_STYLE}"""
    },
    {
        "id": 51,
        "name": "羊腰子",
        "image": "yangyaozi.jpg",
        "prompt": f"""东北烤羊腰子 1 skewer of grilled lamb kidney:
1 thin METAL skewer with lamb kidney, butterflied and scored.
The classic 补肾 street food, charred edges.
Pink interior, cumin heavily applied.
Single portion, substantial size.
{COMMON_STYLE}"""
    },
    {
        "id": 32,
        "name": "烤鸡头",
        "image": "kaojitou.jpg",
        "prompt": f"""东北烤鸡头 3 skewers of grilled chicken heads:
3 thin METAL skewers, each with a whole chicken head.
Crispy golden-brown skin, beaks visible, charred in spots.
Northeastern street food delicacy.
Cumin and chili seasoning.
{COMMON_STYLE}"""
    },
    {
        "id": 30,
        "name": "烤羊蛋",
        "image": "kaoyangdan.jpg",
        "prompt": f"""东北烤羊蛋 grilled lamb testicles:
Several grilled lamb testicles on thin METAL skewers.
Oval shapes, golden-brown charred exterior.
Cut open to show creamy white interior.
Northeastern delicacy, cumin and chili seasoning.
{COMMON_STYLE}"""
    },
    {
        "id": 31,
        "name": "烤猪脚",
        "image": "kaozhujiao.jpg",
        "prompt": f"""东北烤猪脚 grilled pig trotter:
Grilled pig trotter, heavily charred and caramelized.
Dark brown/black surface from caramelization.
Cut to show layers of crispy skin, melted fat, tender meat.
Brushed with sweet sauce, charred edges.
{COMMON_STYLE}"""
    },
    # 海鲜类烤串
    {
        "id": 52,
        "name": "烤生蚝",
        "image": "kaoshenghao.jpg",
        "prompt": f"""蒜蓉烤生蚝 4 grilled oysters:
4 grilled oysters on half shell, arranged on cheap metal tray.
Topped with LOTS of minced garlic (蒜蓉), chopped green onions, glass vermicelli noodles.
Garlic golden and fragrant, edges slightly charred.
Oyster plump and juicy.
{COMMON_STYLE}"""
    },
    {
        "id": 53,
        "name": "烤大虾",
        "image": "kaodaxia.jpg",
        "prompt": f"""东北烤大虾 6 skewers of grilled prawns:
6 thin METAL skewers, each with 1 large prawn.
Orange-red shell with char marks, head and tail intact.
Butterflied to show meat, shell crispy.
Light salt and cumin seasoning.
{COMMON_STYLE}"""
    },
    {
        "id": 54,
        "name": "大鱿鱼",
        "image": "dayouyu.jpg",
        "prompt": f"""烤大鱿鱼 2 large grilled squid:
2 whole squid on thick METAL skewers.
Scored diamond pattern on body, charred grill marks.
Tentacles crispy and curled.
Brushed with sauce, street food style.
{COMMON_STYLE}"""
    },
    {
        "id": 55,
        "name": "烤干针鱼",
        "image": "kaoganzhenyu.jpg",
        "prompt": f"""烤干针鱼 3 skewers of dried needlefish:
3 thin METAL skewers with small dried fish (多春鱼), grilled until crispy.
Golden-brown, whole fish with visible eyes.
Crispy salty snack, simple seasoning.
{COMMON_STYLE}"""
    },
    # 素烤类
    {
        "id": 56,
        "name": "烤蚕蛹",
        "image": "kaocanyu.jpg",
        "prompt": f"""烤蚕蛹 3 skewers of grilled silkworm pupae:
3 thin METAL skewers with silkworm pupae.
Oval golden-brown shapes, crispy and split open from heat.
High protein Northeastern snack.
Cumin and chili seasoning.
{COMMON_STYLE}"""
    },
    {
        "id": 57,
        "name": "烤茄子",
        "image": "kaoqiezi.jpg",
        "prompt": f"""蒜蓉烤茄子 grilled eggplant:
1 whole Chinese eggplant split open lengthwise on metal tray.
Flesh soft and creamy, skin charred.
GENEROUSLY topped with minced garlic, green onions, red chili oil, cilantro.
Classic street food presentation.
{COMMON_STYLE}"""
    },
    {
        "id": 58,
        "name": "烤面筋",
        "image": "kaomianjin.jpg",
        "prompt": f"""烤面筋 3 skewers of grilled wheat gluten:
3 thin METAL skewers with wheat gluten spirals (螺旋形).
Expanded spongy texture, soaked up spicy sauce.
Charred edges, reddish from sauce.
Classic street food.
{COMMON_STYLE}"""
    },
    {
        "id": 59,
        "name": "烤金针菇",
        "image": "kaojinzhengu.jpg",
        "prompt": f"""烤金针菇 grilled enoki mushrooms:
Bundle of enoki mushrooms wrapped in foil, foil opened to show.
Mushrooms golden and slightly crispy on edges.
Drizzled with garlic butter sauce, green onions.
{COMMON_STYLE}"""
    },
    {
        "id": 60,
        "name": "烤油麦菜",
        "image": "kaoyoumaicai.jpg",
        "prompt": f"""烤油麦菜 grilled Chinese lettuce:
Grilled Chinese lettuce (A菜/油麦菜), wilted with charred edges.
Drizzled with garlic sauce and oyster sauce.
Simple vegetable side dish.
{COMMON_STYLE}"""
    },
    {
        "id": 61,
        "name": "烤面包",
        "image": "kaomianbao.jpg",
        "prompt": f"""烤面包片 grilled bread:
Several slices of white bread, toasted golden-brown with butter.
Cut into triangles, crispy exterior.
Sprinkled with sugar or garlic butter.
Simple street snack.
{COMMON_STYLE}"""
    },
    {
        "id": 62,
        "name": "烤豆皮",
        "image": "kaodoupi.jpg",
        "prompt": f"""烤豆皮 15 small skewers of grilled tofu skin:
15 thin METAL skewers with tofu skin strips (干豆腐).
Curled and slightly crispy from heat.
Brushed with sauce, sprinkled with sesame and chili.
Cheap street snack, many skewers.
{COMMON_STYLE}"""
    },
    {
        "id": 63,
        "name": "豆皮卷香菜",
        "image": "doupijuanxiangcai.jpg",
        "prompt": f"""豆皮卷香菜 3 skewers of tofu skin rolled cilantro:
3 thin METAL skewers with grilled tofu skin rolled around fresh cilantro bunches.
Tofu skin crispy outside, fresh cilantro inside.
Unique combination, light seasoning.
{COMMON_STYLE}"""
    },
    {
        "id": 64,
        "name": "烤辣椒",
        "image": "kaolajiao.jpg",
        "prompt": f"""烤辣椒 3 skewers of grilled green peppers:
3 thin METAL skewers with green long peppers (尖椒/虎皮椒).
Blistered and charred skin with brown/black spots (虎皮 tiger skin pattern).
Soft and slightly collapsed, smoky.
{COMMON_STYLE}"""
    },
    {
        "id": 65,
        "name": "烤实蛋",
        "image": "kaoshidan.jpg",
        "prompt": f"""烤实蛋 2 skewers of grilled solid eggs:
2 thin METAL skewers with 鹤岗实蛋 (eggs made firm with alkali).
Halved showing dense firm white interior (no soft yolk).
Brushed with sauce, cumin and chili.
Northeastern specialty.
{COMMON_STYLE}"""
    },
    {
        "id": 66,
        "name": "烤香肠",
        "image": "kaoxiangchang.jpg",
        "prompt": f"""烤香肠 2 skewers of grilled Chinese sausage:
2 thin METAL skewers with Chinese sausage (腊肠 style).
Red-brown color, white fat visible in cross-section.
Charred and slightly split from heat.
{COMMON_STYLE}"""
    },
    {
        "id": 67,
        "name": "烤火腿肠",
        "image": "kaohuotuichang.jpg",
        "prompt": f"""烤火腿肠 2 skewers of grilled ham sausage:
2 thin METAL skewers with ham sausage (火腿肠).
Scored spiral pattern, pink color with golden grill marks.
Classic cheap street food, slightly charred.
{COMMON_STYLE}"""
    },
    {
        "id": 68,
        "name": "烤活珠子",
        "image": "kaohuozhuzi.jpg",
        "prompt": f"""烤活珠子 1 skewer of grilled fertilized egg:
1 skewer with grilled fertilized duck egg (毛蛋/活珠子).
Charred shell cracked open, showing partially developed embryo inside.
Northeastern delicacy, not for everyone.
Cumin seasoning.
{COMMON_STYLE}"""
    },
]

def delete_existing_images():
    """删除现有的烤串图片"""
    deleted = 0
    for item in SKEWERS:
        img_path = OUTPUT_DIR / item["image"]
        if img_path.exists():
            img_path.unlink()
            print(f"  [删除] {item['image']}")
            deleted += 1
    return deleted

def generate_image(client, item, retry_count=3):
    """生成单张图片"""
    output_path = OUTPUT_DIR / item["image"]

    for attempt in range(retry_count):
        try:
            print(f"  [生成] {item['name']} ({attempt + 1}/{retry_count})...")

            response = client.models.generate_images(
                model="imagen-4.0-generate-001",  # 使用标准版，质量更好
                prompt=item["prompt"],
                config=types.GenerateImagesConfig(
                    number_of_images=1,
                    aspect_ratio="1:1",
                )
            )

            if response.generated_images:
                img_data = response.generated_images[0].image.image_bytes
                with open(output_path, "wb") as f:
                    f.write(img_data)
                size_kb = len(img_data) / 1024
                print(f"  [完成] {item['name']} -> {item['image']} ({size_kb:.0f}KB)")
                return True
            else:
                print(f"  [警告] {item['name']} - 未生成图片")

        except Exception as e:
            error_msg = str(e)
            print(f"  [错误] {item['name']}: {error_msg[:100]}")

            if "quota" in error_msg.lower() or "rate" in error_msg.lower():
                print("  [限流] 等待 60 秒...")
                time.sleep(60)
            elif attempt < retry_count - 1:
                time.sleep(3)

    return False

def main():
    if not API_KEY:
        print("错误: 请设置 GEMINI_API_KEY 环境变量")
        print("export GEMINI_API_KEY='your-api-key'")
        return

    print("=" * 60)
    print("东北烤串图片重新生成器")
    print("基于网络搜索的真实东北烧烤特点")
    print("=" * 60)

    # 显示主要改进
    print("\n主要改进:")
    print("  - 肉块: 手切不规则形状，不是机器切的整齐方块")
    print("  - 签子: 铁签（锦州风格），不是竹签")
    print("  - 配料: 纯肉，不夹洋葱蔬菜")
    print("  - 撒料: 孜然辣椒面撒得更厚更狂野")
    print("  - 烤后: 边缘焦黑不规则，不是完美均匀")

    print(f"\n共 {len(SKEWERS)} 种烤串需要重新生成")

    # 删除现有图片
    print("\n步骤 1: 删除现有烤串图片")
    deleted = delete_existing_images()
    print(f"  共删除 {deleted} 张图片")

    # 生成新图片
    print("\n步骤 2: 生成新图片")
    client = genai.Client(api_key=API_KEY)

    success = 0
    fail = 0

    for i, item in enumerate(SKEWERS, 1):
        print(f"\n[{i}/{len(SKEWERS)}] {item['name']}")
        if generate_image(client, item):
            success += 1
            time.sleep(2)  # 避免限流
        else:
            fail += 1

    print("\n" + "=" * 60)
    print("完成!")
    print(f"  成功: {success}")
    print(f"  失败: {fail}")
    print("=" * 60)

if __name__ == "__main__":
    main()
