import { ChromaClient } from 'chromadb';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

/**
 * SimpleMemory - 纯JSON版本的记忆系统
 * 无需编译，无需native依赖
 */
export class SimpleMemory {
  constructor() {
    this.dataPath = path.join(os.homedir(), '.openclaw', 'memory.json');
    this.chroma = new ChromaClient({
      path: path.join(os.homedir(), '.openclaw', 'chroma')
    });
    this.collection = null;
    this.isInitialized = false;
    this.data = {
      memories: [],
      profile: {},
      reflections: []
    };

    this.ready = this.init();
  }

  /**
   * 初始化
   */
  async init() {
    try {
      console.log('⏳ 正在初始化记忆系统...');

      // 加载现有数据
      if (fs.existsSync(this.dataPath)) {
        const content = fs.readFileSync(this.dataPath, 'utf-8');
        this.data = JSON.parse(content);
      }

      // 初始化向量DB
      await this.initChroma();

      console.log('✅ 记忆系统已就绪');
      console.log(`   已加载 ${this.data.memories.length} 条记忆`);
      console.log(`   已加载 ${Object.keys(this.data.profile).length} 条偏好`);
    } catch (error) {
      console.log('⚠️  初始化失败:', error.message);
    }
  }

  /**
   * 初始化向量DB
   */
  async initChroma() {
    try {
      this.collection = await this.chroma.getOrCreateCollection({
        name: 'memories',
        metadata: { hnsw: { space: 'cosine' } }
      });
      this.isInitialized = true;
      console.log('✅ 向量搜索已启用');
    } catch (error) {
      console.log('⚠️  ChromaDB失败，使用文本搜索');
    }
  }

  /**
   * 等待就绪
   */
  async ensureReady() {
    await this.ready;
  }

  /**
   * 保存数据
   */
  save() {
    try {
      fs.writeFileSync(this.dataPath, JSON.stringify(this.data, null, 2));
    } catch (error) {
      console.log('⚠️  保存失败:', error.message);
    }
  }

  /**
   * 记住信息
   */
  async remember(content, type = 'fact', importance = 0.5) {
    await this.ensureReady();

    const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const now = new Date().toISOString();

    // 添加到内存
    this.data.memories.push({
      id,
      content,
      type,
      importance,
      created_at: now,
      updated_at: now,
      access_count: 0
    });

    // 保存
    this.save();

    // 添加到向量DB
    if (this.isInitialized && this.collection) {
      try {
        await this.collection.add({
          ids: [id],
          documents: [content],
          metadatas: [{ type, importance, created: now }]
        });
      } catch (e) {
        // 静默失败
      }
    }

    return `✅ 已记住: ${content.substring(0, 50)}${content.length > 50 ? '...' : ''}`;
  }

  /**
   * 回忆信息
   */
  async recall(query, limit = 5, minImportance = 0.3) {
    await this.ensureReady();

    // 优先向量搜索
    if (this.isInitialized && this.collection) {
      try {
        const results = await this.collection.query({
          queryTexts: [query],
          nResults: limit * 2
        });

        if (results.documents[0]?.length > 0) {
          const memories = results.documents[0].map((doc, i) => {
            const mem = this.data.memories.find(m => m.content === doc);
            return {
              content: doc,
              score: mem ? 1 - (results.distances[0][i] || 0) : 0.5
            };
          }).filter(m => m !== undefined);

          // 更新访问计数
          memories.forEach(m => {
            const mem = this.data.memories.find(item => item.content === m.content);
            if (mem) {
              mem.access_count++;
            }
          });
          this.save();

          return memories.slice(0, limit);
        }
      } catch (e) {
        // 降级到文本搜索
      }
    }

    // 文本搜索
    const queryLower = query.toLowerCase();
    const memories = this.data.memories
      .filter(m => m.importance >= minImportance)
      .filter(m => m.content.toLowerCase().includes(queryLower))
      .sort((a, b) => b.importance - a.importance)
      .slice(0, limit)
      .map(m => ({
        content: m.content,
        score: m.importance
      }));

    return memories;
  }

  /**
   * 更新偏好
   */
  async updatePreference(key, value) {
    await this.ensureReady();

    this.data.profile[key] = value;
    this.data.profile[`${key}_updated`] = new Date().toISOString();
    this.save();

    return `✅ 已更新: ${key} = ${value}`;
  }

  /**
   * 获取偏好
   */
  async getPreference(key) {
    await this.ensureReady();
    return this.data.profile[key] || null;
  }

  /**
   * 获取所有偏好
   */
  async getAllPreferences() {
    await this.ensureReady();

    const prefs = {};
    for (const [key, value] of Object.entries(this.data.profile)) {
      if (!key.endsWith('_updated')) {
        prefs[key] = value;
      }
    }

    return prefs;
  }

  /**
   * 添加反思
   */
  async addReflection(content, significance = 0.5) {
    await this.ensureReady();

    const id = `ref-${Date.now()}`;
    this.data.reflections.push({
      id,
      content,
      created_at: new Date().toISOString(),
      significance
    });
    this.save();

    // 提取新记忆
    await this.extractMemoriesFromReflection(content);

    return `✅ 反思已记录`;
  }

  /**
   * 从反思提取记忆
   */
  async extractMemoriesFromReflection(reflection) {
    const patterns = [
      { regex: /用户喜欢(.{5,30})/g, type: 'preference' },
      { regex: /用户重视(.{5,30})/g, type: 'preference' },
      { regex: /记住(.{5,30})/g, type: 'fact' },
      { regex: /偏好(.{5,30})/g, type: 'preference' }
    ];

    for (const pattern of patterns) {
      const matches = reflection.matchAll(pattern.regex);
      for (const match of matches) {
        if (match[1]) {
          await this.remember(match[1].trim(), pattern.type, 0.7);
        }
      }
    }
  }

  /**
   * 获取最近反思
   */
  async getRecentReflections(limit = 5) {
    await this.ensureReady();

    return this.data.reflections
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, limit);
  }

  /**
   * 获取统计
   */
  async getStats() {
    await this.ensureReady();

    const byType = {};
    this.data.memories.forEach(m => {
      byType[m.type] = (byType[m.type] || 0) + 1;
    });

    const totalImportance = this.data.memories.reduce((sum, m) => sum + m.importance, 0);
    const avgImportance = this.data.memories.length > 0
      ? totalImportance / this.data.memories.length
      : 0;

    return {
      memories: {
        total: this.data.memories.length,
        byType,
        avgImportance: avgImportance.toFixed(2)
      },
      reflections: this.data.reflections.length,
      preferences: Object.keys(this.data.profile).filter(k => !k.endsWith('_updated')).length,
      vectorSearch: this.isInitialized
    };
  }

  /**
   * 清理旧记忆
   */
  async cleanup(daysToKeep = 90, minImportance = 0.3) {
    await this.ensureReady();

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

    const beforeLength = this.data.memories.length;
    this.data.memories = this.data.memories.filter(m => {
      const created = new Date(m.created_at);
      return !(created < cutoffDate && m.importance < minImportance && m.access_count < 5);
    });

    const cleaned = beforeLength - this.data.memories.length;
    this.save();

    return `✅ 清理了 ${cleaned} 条旧记忆`;
  }

  /**
   * 导出数据
   */
  async export() {
    await this.ensureReady();

    return {
      ...this.data,
      exported_at: new Date().toISOString()
    };
  }
}

// 单例
export const memory = new SimpleMemory();

// 命令接口
export const commands = {
  remember: async (content, type) => {
    return await memory.remember(content, type);
  },

  recall: async (query, limit) => {
    const results = await memory.recall(query, limit);
    return results.map((r) => `[${r.score.toFixed(2)}] ${r.content}`).join('\n\n');
  },

  preference: {
    set: async (key, value) => {
      return await memory.updatePreference(key, value);
    },
    get: async (key) => {
      return await memory.getPreference(key);
    },
    all: async () => {
      return await memory.getAllPreferences();
    }
  },

  reflect: async (content, significance) => {
    return await memory.addReflection(content, significance);
  },

  reflections: async (limit) => {
    return await memory.getRecentReflections(limit);
  },

  stats: async () => {
    return await memory.getStats();
  },

  cleanup: async (days, minImportance) => {
    return await memory.cleanup(days, minImportance);
  },

  export: async () => {
    return await memory.export();
  }
};

export default memory;
