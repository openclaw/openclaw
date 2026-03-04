#!/usr/bin/env python3
"""
TF-IDF 相似度匹配器
纯 Python 实现，无需外部库
替代 ONNX Embeddings 向量相似度
"""

import re
import math
import json
from typing import List, Dict, Tuple
from collections import Counter
from dataclasses import dataclass


@dataclass
class MatchResult:
    """匹配结果"""
    market_title: str
    market_id: str
    similarity_score: float
    confidence: float  # 置信度 (0-100%)


class TFIDFMatcher:
    """TF-IDF 相似度匹配器（纯 Python）"""

    def __init__(self):
        """初始化"""
        self.documents = []  # (title, tokens)
        self.idf_cache = {}  # 词 -> IDF 值

    def tokenize(self, text: str) -> List[str]:
        """分词（中英文混合）"""
        # 转小写
        text = text.lower()

        # 英文分词（按空格和标点）
        english_words = re.findall(r'\b[a-z]+\b', text)

        # 中文分词（按字符，简化版）
        chinese_chars = re.findall(r'[\u4e00-\u9fff]', text)

        # 合并
        tokens = english_words + chinese_chars

        # 过滤停用词
        stopwords = {
            'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by',
            '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '一个',
            '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好',
            'will', 'by', 'march', '2026', 'q1', 'q2', 'q3', 'q4'
        }

        tokens = [t for t in tokens if t not in stopwords and len(t) > 1]

        return tokens

    def compute_tf(self, tokens: List[str]) -> Dict[str, float]:
        """计算 TF (Term Frequency)"""
        tf = {}
        total = len(tokens)

        for token in tokens:
            tf[token] = tf.get(token, 0) + 1

        # 归一化
        for token in tf:
            tf[token] = tf[token] / total

        return tf

    def compute_idf(self, documents_tokens: List[List[str]]) -> Dict[str, float]:
        """计算 IDF (Inverse Document Frequency)"""
        n_docs = len(documents_tokens)
        idf = {}

        # 统计每个词出现在多少个文档中
        doc_freq = Counter()
        for tokens in documents_tokens:
            unique_tokens = set(tokens)
            for token in unique_tokens:
                doc_freq[token] += 1

        # 计算 IDF
        for token, freq in doc_freq.items():
            idf[token] = math.log(n_docs / freq)

        self.idf_cache = idf
        return idf

    def compute_tfidf(self, tokens: List[str], tf: Dict[str, float]) -> Dict[str, float]:
        """计算 TF-IDF"""
        tfidf = {}

        for token in tokens:
            tfidf[token] = tf[token] * self.idf_cache.get(token, 1.0)

        return tfidf

    def cosine_similarity(self, vec1: Dict[str, float], vec2: Dict[str, float]) -> float:
        """计算余弦相似度"""
        # 获取所有词
        all_terms = set(vec1.keys()) | set(vec2.keys())

        # 计算点积
        dot_product = sum(vec1.get(t, 0) * vec2.get(t, 0) for t in all_terms)

        # 计算模长
        norm1 = math.sqrt(sum(v ** 2 for v in vec1.values()))
        norm2 = math.sqrt(sum(v ** 2 for v in vec2.values()))

        if norm1 == 0 or norm2 == 0:
            return 0.0

        # 余弦相似度
        return dot_product / (norm1 * norm2)

    def add_documents(self, titles: List[str]):
        """添加文档（市场标题）"""
        self.documents = []

        for title in titles:
            tokens = self.tokenize(title)
            self.documents.append({
                "title": title,
                "tokens": tokens,
                "tf": self.compute_tf(tokens)
            })

        # 计算 IDF
        all_tokens = [doc["tokens"] for doc in self.documents]
        self.compute_idf(all_tokens)

        # 计算 TF-IDF
        for doc in self.documents:
            doc["tfidf"] = self.compute_tfidf(doc["tokens"], doc["tf"])

    def match(self, query: str, top_k: int = 5, min_confidence: float = 0.6) -> List[MatchResult]:
        """匹配查询与文档"""
        # 计算查询的 TF-IDF
        query_tokens = self.tokenize(query)
        query_tf = self.compute_tf(query_tokens)
        query_tfidf = self.compute_tfidf(query_tokens, query_tf)

        # 计算相似度
        results = []
        for doc in self.documents:
            similarity = self.cosine_similarity(query_tfidf, doc["tfidf"])

            # 转换为置信度 (0-100%)
            confidence = similarity * 100

            if confidence >= min_confidence * 100:
                results.append(MatchResult(
                    market_title=doc["title"],
                    market_id=doc["title"],  # 简化：用 title 作为 ID
                    similarity_score=similarity,
                    confidence=confidence
                ))

        # 按置信度排序
        results.sort(key=lambda x: x.confidence, reverse=True)

        # 返回 top-k
        return results[:top_k]


class JaccardMatcher:
    """Jaccard 相似度匹配器（备用方案）"""

    def __init__(self):
        """初始化"""
        self.documents = []

    def tokenize(self, text: str) -> set:
        """分词"""
        tokens = re.findall(r'\b[a-z]+\b|[\u4e00-\u9fff]', text.lower())
        return set(tokens)

    def jaccard_similarity(self, set1: set, set2: set) -> float:
        """计算 Jaccard 相似度"""
        intersection = len(set1 & set2)
        union = len(set1 | set2)

        if union == 0:
            return 0.0

        return intersection / union

    def add_documents(self, titles: List[str]):
        """添加文档"""
        for title in titles:
            self.documents.append({
                "title": title,
                "tokens": self.tokenize(title)
            })

    def match(self, query: str, top_k: int = 5, min_confidence: float = 0.5) -> List[MatchResult]:
        """匹配查询"""
        query_tokens = self.tokenize(query)

        results = []
        for doc in self.documents:
            similarity = self.jaccard_similarity(query_tokens, doc["tokens"])

            # 转换为置信度 (0-100%)
            confidence = similarity * 100

            if confidence >= min_confidence * 100:
                results.append(MatchResult(
                    market_title=doc["title"],
                    market_id=doc["title"],
                    similarity_score=similarity,
                    confidence=confidence
                ))

        # 按置信度排序
        results.sort(key=lambda x: x.confidence, reverse=True)

        return results[:top_k]


def test_tfidf_matcher():
    """测试 TF-IDF 匹配器"""
    print("=" * 60)
    print("TF-IDF 相似度匹配器 - 测试")
    print("=" * 60)

    # 创建匹配器
    matcher = TFIDFMatcher()

    # 添加 Polymarket 市场标题（模拟）
    market_titles = [
        "Will oil prices exceed $100/barrel by March 2026?",
        "Will US-Iran conflict escalate to full war by Q1 2026?",
        "Will Bitcoin fall below $60,000 in March 2026?",
        "Will GPT-5 be released by March 2026?",
        "Will Elon Musk's net worth exceed $710B by 2026?",
        "Will Nice mayoral election be won by Eric Ciotti?"
    ]

    matcher.add_documents(market_titles)
    print(f"✅ 添加 {len(market_titles)} 个市场标题\n")

    # 测试查询
    queries = [
        "Iran attacks Saudi oil refinery, oil prices surge",
        "Bitcoin slips below $66,000",
        "GPT-5.3 rumored to release soon"
    ]

    for query in queries:
        print(f"\n🔍 查询: {query}")
        results = matcher.match(query, top_k=3, min_confidence=0.4)

        if results:
            print(f"   匹配结果:")
            for i, result in enumerate(results, 1):
                print(f"   {i}. {result.market_title}")
                print(f"      相似度: {result.similarity_score:.3f}")
                print(f"      置信度: {result.confidence:.1f}%")
        else:
            print(f"   ❌ 未找到匹配")


def test_jaccard_matcher():
    """测试 Jaccard 匹配器"""
    print("\n" + "=" * 60)
    print("Jaccard 相似度匹配器 - 测试")
    print("=" * 60)

    matcher = JaccardMatcher()

    # 添加文档
    market_titles = [
        "Iran conflict escalates, oil prices surge",
        "Bitcoin falls below $60,000",
        "AI model releases new version"
    ]

    matcher.add_documents(market_titles)
    print(f"✅ 添加 {len(market_titles)} 个市场标题\n")

    # 测试查询
    query = "Iran attacks Saudi Arabia"
    print(f"🔍 查询: {query}")

    results = matcher.match(query, top_k=3, min_confidence=0.3)

    if results:
        print(f"   匹配结果:")
        for i, result in enumerate(results, 1):
            print(f"   {i}. {result.market_title}")
            print(f"      相似度: {result.similarity_score:.3f}")
            print(f"      置信度: {result.confidence:.1f}%")
    else:
        print(f"   ❌ 未找到匹配")


if __name__ == "__main__":
    test_tfidf_matcher()
    test_jaccard_matcher()
