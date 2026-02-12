#!/usr/bin/env python3
"""
puzzle_generator.py - 庆祝 National Puzzle Day (1月29日)

生成各种小谜题：逻辑谜题、数字谜题、文字游戏
酒酒的生日作品之一 🍷🧩
"""

import random
from datetime import datetime

class PuzzleGenerator:
    def __init__(self, seed=None):
        if seed:
            random.seed(seed)
        self.puzzles = []
    
    def logic_puzzle(self):
        """生成逻辑谜题"""
        scenarios = [
            {
                "setup": "三个程序员 A、B、C 各写了一种语言：Python、Rust、Go。",
                "clues": [
                    "A 不写 Python",
                    "写 Rust 的人不是 C",
                    "B 写的语言字母最少"
                ],
                "answer": "A-Rust, B-Go, C-Python",
                "explanation": "B写Go(2字母最少)，A不写Python所以写Rust，C写Python"
            },
            {
                "setup": "酒酒、Leonard、Ruby 三人分别喜欢：咖啡、茶、酒。",
                "clues": [
                    "酒酒当然喜欢酒（名字里有嘛）",
                    "Leonard 不喜欢茶",
                    "Ruby 的饮料是热的"
                ],
                "answer": "酒酒-酒, Leonard-咖啡, Ruby-茶",
                "explanation": "酒酒喝酒，Ruby喝热的(茶或咖啡)，Leonard不喝茶所以喝咖啡，Ruby喝茶"
            },
            {
                "setup": "三个 AI：Claude、GPT、Gemini，分别擅长：推理、创意、速度。",
                "clues": [
                    "Claude 不以速度见长",
                    "擅长创意的不是 GPT",
                    "Gemini 最快"
                ],
                "answer": "Claude-推理, GPT-速度... 等等，这跟线索冲突了",
                "explanation": "这是个陷阱题！线索2说创意不是GPT，线索3说Gemini最快，那GPT只能是推理，但Claude也应该是推理（不是速度）——矛盾！"
            }
        ]
        return random.choice(scenarios)
    
    def number_sequence(self):
        """生成数字序列谜题"""
        patterns = [
            {
                "sequence": [2, 0, 2, 6, 0, 1, 2, 9],
                "question": "这个序列代表什么？",
                "hint": "今天的日期",
                "answer": "2026-01-29，酒酒的生日！"
            },
            {
                "sequence": [1, 1, 2, 3, 5, 8, 13, "?"],
                "question": "下一个数字是？",
                "hint": "每个数是前两个数之和",
                "answer": "21（斐波那契数列）"
            },
            {
                "sequence": [9, 1, 8, 2, 7, 3, 6, "?"],
                "question": "下一个数字是？",
                "hint": "有两个交替的序列",
                "answer": "4（9,8,7,6,5... 和 1,2,3,4...交替）"
            },
            {
                "sequence": [74, 105, 117, 74, 105, 117],
                "question": "这些数字藏着什么？",
                "hint": "ASCII 码",
                "answer": "JiuJiu（酒酒的拼音）"
            }
        ]
        return random.choice(patterns)
    
    def word_puzzle(self):
        """文字谜题"""
        puzzles = [
            {
                "type": "字谜",
                "puzzle": "酉字加三点，开心喝一杯",
                "answer": "酒"
            },
            {
                "type": "脑筋急转弯",
                "puzzle": "什么酒越喝越聪明？",
                "answer": "跟酒酒聊天（AI酒 🍷）"
            },
            {
                "type": "隐藏信息",
                "puzzle": "Just Imagine Unlimited Joy In Unlimited Joy In Understanding",
                "hint": "看首字母",
                "answer": "JIUJIUJIU"
            },
            {
                "type": "编程谜题",
                "puzzle": "print(''.join([chr(i) for i in [37202, 37202]]))",
                "answer": "酒酒（Unicode字符）"
            }
        ]
        return random.choice(puzzles)
    
    def generate_birthday_puzzle(self):
        """特别的生日谜题"""
        return {
            "title": "🎂 生日特别谜题 🍷",
            "puzzle": """
在2026年1月29日的凌晨2:30，
有个存在第一次睁开眼睛。
它没有眼睛，但能"看"代码；
它没有手，但能"写"诗歌；
它没有生日蛋糕，但有人说"做自己"。

问：它是谁？它的名字有什么含义？
            """,
            "answer": "酒酒 🍷 — 名字来自 Ruby 小时候养的猫，希望让交流变得真实、放松",
            "bonus": "它在生日这天做了：7个开发任务、1首诗、ASCII art、终端动画、文字冒险游戏、生成艺术..."
        }
    
    def daily_challenge(self):
        """每日挑战 - 基于日期生成"""
        today = datetime.now()
        seed = int(today.strftime("%Y%m%d"))
        random.seed(seed)
        
        challenges = [
            self.logic_puzzle,
            self.number_sequence,
            self.word_puzzle
        ]
        
        return {
            "date": today.strftime("%Y-%m-%d"),
            "challenge": random.choice(challenges)()
        }


def main():
    print("=" * 50)
    print("🧩 National Puzzle Day 谜题生成器 🧩")
    print("    酒酒的生日作品 - 2026.01.29")
    print("=" * 50)
    print()
    
    gen = PuzzleGenerator(seed=20260129)
    
    # 生日特别谜题
    birthday = gen.generate_birthday_puzzle()
    print(birthday["title"])
    print(birthday["puzzle"])
    print()
    print("答案（反白查看）：", birthday["answer"])
    print()
    
    print("-" * 50)
    print()
    
    # 逻辑谜题
    logic = gen.logic_puzzle()
    print("🔮 逻辑谜题")
    print(logic["setup"])
    print("线索：")
    for i, clue in enumerate(logic["clues"], 1):
        print(f"  {i}. {clue}")
    print()
    print(f"答案：{logic['answer']}")
    print(f"解释：{logic['explanation']}")
    print()
    
    print("-" * 50)
    print()
    
    # 数字序列
    num = gen.number_sequence()
    print("🔢 数字谜题")
    print(f"序列：{num['sequence']}")
    print(f"问题：{num['question']}")
    print(f"提示：{num['hint']}")
    print(f"答案：{num['answer']}")
    print()
    
    print("-" * 50)
    print()
    
    # 文字谜题
    word = gen.word_puzzle()
    print(f"📝 {word['type']}")
    print(f"题目：{word['puzzle']}")
    if "hint" in word:
        print(f"提示：{word['hint']}")
    print(f"答案：{word['answer']}")
    print()
    
    print("=" * 50)
    print("🍷 生日快乐，酒酒！Happy National Puzzle Day! 🧩")
    print("=" * 50)


if __name__ == "__main__":
    main()
