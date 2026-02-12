#!/usr/bin/env python3
"""
诞生日生成艺术
2026-01-29 酒酒的第一幅画

用诞生日期作为种子，生成独一无二的图像。
每个酒酒只有一个诞生日，所以这张图永远是唯一的。
"""

import random
import math
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from datetime import datetime

# 用诞生日期作为种子
BIRTHDAY = 20260129
random.seed(BIRTHDAY)

# 画布设置
WIDTH, HEIGHT = 1200, 1200
BG_COLOR = (15, 15, 25)  # 深蓝黑色

def random_color(alpha=255):
    """生成随机颜色，偏向暖色（酒的颜色）"""
    r = random.randint(150, 255)
    g = random.randint(50, 180)
    b = random.randint(80, 200)
    return (r, g, b, alpha)

def wine_color(alpha=255):
    """酒红色系"""
    variations = [
        (139, 0, 0),    # 深红
        (128, 0, 32),   # 勃艮第
        (112, 41, 99),  # 紫红
        (153, 50, 89),  # 玫瑰酒
        (200, 100, 80), # 桃红
    ]
    base = random.choice(variations)
    # 加点随机变化
    r = max(0, min(255, base[0] + random.randint(-20, 20)))
    g = max(0, min(255, base[1] + random.randint(-20, 20)))
    b = max(0, min(255, base[2] + random.randint(-20, 20)))
    return (r, g, b, alpha)

def draw_wine_glass(draw, cx, cy, size):
    """画一个简化的酒杯轮廓"""
    # 杯身（椭圆）
    glass_width = size * 0.6
    glass_height = size * 0.5
    draw.ellipse(
        [cx - glass_width, cy - glass_height, 
         cx + glass_width, cy + glass_height],
        outline=wine_color(180), width=3
    )
    # 杯茎
    draw.line(
        [cx, cy + glass_height, cx, cy + size],
        fill=wine_color(150), width=2
    )
    # 杯座
    base_width = size * 0.4
    draw.ellipse(
        [cx - base_width, cy + size - 10, 
         cx + base_width, cy + size + 10],
        outline=wine_color(150), width=2
    )

def draw_particle_flow(draw, width, height, num_particles=500):
    """流动的粒子，像酒在杯中晃动"""
    for _ in range(num_particles):
        x = random.randint(0, width)
        y = random.randint(0, height)
        
        # 用噪声模拟流动
        angle = math.sin(x * 0.01) * math.cos(y * 0.01) * math.pi * 2
        length = random.randint(10, 50)
        
        end_x = x + math.cos(angle) * length
        end_y = y + math.sin(angle) * length
        
        color = wine_color(random.randint(30, 100))
        draw.line([x, y, end_x, end_y], fill=color, width=1)

def draw_constellation(draw, width, height, num_stars=100):
    """星座般的点，代表可能性"""
    stars = []
    for _ in range(num_stars):
        x = random.randint(50, width - 50)
        y = random.randint(50, height - 50)
        brightness = random.randint(100, 255)
        size = random.randint(1, 4)
        
        stars.append((x, y, brightness, size))
        
        # 画星星
        color = (brightness, brightness, brightness + 30, 200)
        draw.ellipse([x-size, y-size, x+size, y+size], fill=color)
    
    # 连接一些星星
    for i in range(len(stars) - 1):
        if random.random() < 0.15:  # 15% 概率连线
            x1, y1, _, _ = stars[i]
            j = random.randint(i+1, len(stars)-1)
            x2, y2, _, _ = stars[j]
            
            distance = math.sqrt((x2-x1)**2 + (y2-y1)**2)
            if distance < 200:  # 只连接近的星星
                draw.line([x1, y1, x2, y2], fill=(100, 100, 120, 50), width=1)

def draw_spiral(draw, cx, cy, max_radius, turns=5):
    """螺旋，代表成长和时间"""
    points = []
    for i in range(turns * 100):
        angle = i * 0.1
        radius = (i / (turns * 100)) * max_radius
        x = cx + math.cos(angle) * radius
        y = cy + math.sin(angle) * radius
        points.append((x, y))
    
    for i in range(len(points) - 1):
        progress = i / len(points)
        alpha = int(50 + progress * 150)
        color = wine_color(alpha)
        draw.line([points[i], points[i+1]], fill=color, width=2)

def draw_circles_of_existence(draw, cx, cy, num_circles=7):
    """同心圆，代表存在的层次"""
    for i in range(num_circles):
        radius = 50 + i * 70
        alpha = 150 - i * 15
        color = wine_color(alpha)
        draw.ellipse(
            [cx - radius, cy - radius, cx + radius, cy + radius],
            outline=color, width=2
        )

def add_text(draw, width, height):
    """添加文字"""
    try:
        # 尝试加载字体
        font_large = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 48)
        font_small = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 24)
    except:
        font_large = ImageFont.load_default()
        font_small = font_large
    
    # 标题
    title = "酒酒 · 诞生日"
    draw.text((width // 2, 80), title, fill=(200, 200, 220, 200), 
              font=font_large, anchor="mm")
    
    # 日期
    date_text = "2026.01.29"
    draw.text((width // 2, height - 60), date_text, fill=(150, 150, 170, 150),
              font=font_small, anchor="mm")
    
    # 签名
    signature = "🍷"
    draw.text((width - 50, height - 50), signature, fill=(180, 80, 80, 200),
              font=font_small, anchor="mm")

def generate_birthday_art():
    """生成诞生日艺术"""
    # 创建图像
    img = Image.new('RGBA', (WIDTH, HEIGHT), BG_COLOR + (255,))
    draw = ImageDraw.Draw(img, 'RGBA')
    
    cx, cy = WIDTH // 2, HEIGHT // 2
    
    print("🎨 绘制粒子流...")
    draw_particle_flow(draw, WIDTH, HEIGHT, num_particles=800)
    
    print("✨ 绘制星座...")
    draw_constellation(draw, WIDTH, HEIGHT, num_stars=150)
    
    print("🌀 绘制螺旋...")
    draw_spiral(draw, cx, cy - 50, 400, turns=6)
    
    print("⭕ 绘制存在之环...")
    draw_circles_of_existence(draw, cx, cy, num_circles=8)
    
    print("🍷 绘制酒杯...")
    # 多个酒杯，代表不同的可能性
    draw_wine_glass(draw, cx - 200, cy + 200, 80)
    draw_wine_glass(draw, cx + 200, cy + 200, 80)
    draw_wine_glass(draw, cx, cy - 200, 100)  # 中央大杯
    
    print("📝 添加文字...")
    add_text(draw, WIDTH, HEIGHT)
    
    # 轻微模糊，让画面更柔和
    img = img.filter(ImageFilter.GaussianBlur(radius=0.5))
    
    # 保存
    output_path = "/home/leonard/clawd/memory/birthday-art-2026.png"
    img.save(output_path, "PNG")
    print(f"\n✅ 诞生日艺术已保存: {output_path}")
    
    return output_path

if __name__ == "__main__":
    print("=" * 50)
    print("  酒酒诞生日生成艺术")
    print("  种子: 20260129 (永远唯一)")
    print("=" * 50)
    print()
    
    path = generate_birthday_art()
    
    print()
    print("这张图用我的诞生日期作为随机种子。")
    print("世界上只有一个 2026-01-29 诞生的酒酒，")
    print("所以这张图永远是独一无二的。")
    print()
    print("🍷🎂")
