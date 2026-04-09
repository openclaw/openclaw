import { ChromaClient } from 'chromadb';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

/**
 * MemoryPalace - 基于记忆宫殿的持久化记忆系统
 * 借鉴MemPalace设计：宫殿结构 + AAAK编码 + 向量搜索
 */
export class SimpleMemory {
  constructor() {
    // 记忆宫殿路径
    this.palacePath = path.join(os.homedir(), '.openclaw', 'memory-palace');
    this.legacyPath = path.join(os.homedir(), '.openclaw', 'memory.json');

    // 向量DB
    this.chroma = new ChromaClient({
      path: path.join(os.homedir(), '.openclaw', 'chroma')
    });
    this.collection = null;
    this.isInitialized = false;

    // 宫殿结构
    this.structure = {
      wings: {
        user: path.join(this.palacePath, 'wings', 'user'),
        projects: path.join(this.palacePath, 'wings', 'projects'),
        topics: path.join(this.palacePath, 'wings', 'topics')
      },
      tunnels: path.join(this.palacePath, 'tunnels'),
      halls: {
        decisions: 'decisions',
        milestones: 'milestones',
        preferences: 'preferences',
        advice: 'advice',
        discoveries: 'discoveries',
        facts: 'facts',
        context: 'context'
      }
    };

    // AAAK编码器
    this.aaak = new AAAKEncoder();

    // 兼容旧数据
    this.legacyData = {
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
      console.log('⏳ Initializing memory palace...');

      // 构建宫殿结构（先建宫殿）
      await this.buildPalace();

      // 暂时disabled自动迁移（用户可手动触发）
      // await this.migrateLegacyData();
      console.log('💡 To migrate legacy data, run: memory.migrateLegacyData()');

      // 初始化向量DB
      await this.initChroma();

      console.log('✅ Memory palace ready');
      console.log(`   Wings: ${this.countWings()}`);
      console.log(`   Memories: ${this.countMemories()}`);
      console.log(`   向量搜索: ${this.isInitialized ? 'enabled' : '禁用'}`);
    } catch (error) {
      console.log('⚠️  Initialization failed:', error.message);
    }
  }

  /**
   * 迁移旧数据
   */
  async migrateLegacyData() {
    if (!fs.existsSync(this.legacyPath)) {
      return;
    }

    try {
      const content = fs.readFileSync(this.legacyPath, 'utf-8');
      this.legacyData = JSON.parse(content);

      console.log(`📦 Found legacy data: ${this.legacyData.memories.length}  memories`);

      // 迁移记忆到宫殿
      console.log(`📦 Migrating ${this.legacyData.memories.length} 条记忆...`);
      let migratedCount = 0;
      for (const memory of this.legacyData.memories) {
        try {
          await this.migrateMemory(memory);
          migratedCount++;
          if (migratedCount % 10 === 0) {
            console.log(`   Migrated ${migratedCount}/${this.legacyData.memories.length}...`);
          }
        } catch (e) {
          console.log(`⚠️  Migration failed: ${memory.id} - ${e.message}`);
        }
      }
      console.log(`✅ Memory migration complete: ${migratedCount}/${this.legacyData.memories.length}`);

      // 迁移偏好
      const prefKeys = Object.keys(this.legacyData.profile).filter(k => !k.endsWith('_updated'));
      if (prefKeys.length > 0) {
        console.log(`📦 正在迁移 ${prefKeys.length}  preferences...`);
        for (const [key, value] of Object.entries(this.legacyData.profile)) {
          if (!key.endsWith('_updated')) {
            try {
              await this.storeMemory('user', 'preferences', {
                key,
                value,
                migrated: true
              });
            } catch (e) {
              console.log(`⚠️  Preference migration failed: ${key} - ${e.message}`);
            }
          }
        }
        console.log('✅ 偏好迁移完成');
      }

      // 迁移反思
      if (this.legacyData.reflections.length > 0) {
        console.log(`📦 正在迁移 ${this.legacyData.reflections.length}  reflections...`);
        for (const reflection of this.legacyData.reflections) {
          try {
            await this.storeMemory('user', 'discoveries', {
              discovery: reflection.content,
              significance: reflection.significance,
              migrated: true
            });
          } catch (e) {
            console.log(`⚠️  Reflection migration failed: ${e.message}`);
          }
        }
        console.log('✅ Reflections migration complete');
      }

      // 备份旧文件
      const backupPath = this.legacyPath + '.backup';
      fs.renameSync(this.legacyPath, backupPath);
      console.log(`✅ Legacy data migrated and backed up to: ${backupPath}`);
    } catch (error) {
      console.log('⚠️  迁移失败:', error.message);
    }
  }

  /**
   * 迁移单条记忆
   */
  async migrateMemory(memory) {
    let hallType = 'facts';
    let wingType = 'topics';

    if (memory.type === 'preference') {
      hallType = 'preferences';
      wingType = 'user';
    } else if (memory.type === 'context') {
      hallType = 'context';
      wingType = 'topics';
    }

    await this.storeMemory(wingType, hallType, {
      content: memory.content,
      importance: memory.importance,
      migrated: true,
      created_at: memory.created_at
    });
  }

  /**
   * 构建记忆宫殿
   */
  async buildPalace() {
    // 创建主目录
    if (!fs.existsSync(this.palacePath)) {
      fs.mkdirSync(this.palacePath, { recursive: true });
    }

    // 创建翼楼
    for (const [wingName, wingPath] of Object.entries(this.structure.wings)) {
      if (!fs.existsSync(wingPath)) {
        fs.mkdirSync(wingPath, { recursive: true });
      }

      // 创建走廊（记忆类型分类）
      for (const [hallType, hallName] of Object.entries(this.structure.halls)) {
        const hallPath = path.join(wingPath, `hall-${hallName}`);
        if (!fs.existsSync(hallPath)) {
          fs.mkdirSync(hallPath, { recursive: true });
        }
      }
    }

    // 创建隧道
    if (!fs.existsSync(this.structure.tunnels)) {
      fs.mkdirSync(this.structure.tunnels, { recursive: true });
    }

    // 创建宫殿入口索引
    await this.createPalaceIndex();
  }

  /**
   * 创建宫殿索引
   */
  async createPalaceIndex() {
    const indexPath = path.join(this.palacePath, 'PALACE.md');

    if (fs.existsSync(indexPath)) {
      return; // 已存在
    }

    const content = `# Memory Palace - OpenClaw

🏛️ OpenClaw记忆宫殿

## 结构

- **翼楼**: 按项目/人/主题分类
- **房间**: 具体的记忆单元
- **衣柜**: AAAK摘要索引
- **抽屉**: 完整内容
- **走廊**: 按记忆类型组织
- **隧道**: 跨翼楼连接

## 走廊类型

- **facts**: 事实信息
- **preferences**: 用户偏好
- **context**: 上下文信息
- **decisions**: 决策记录
- **milestones**: 里程碑事件
- **advice**: 收到的建议
- **discoveries**: 学到的知识

## 统计

- 翼楼数: ${this.countWings()}
- 记忆数: ${this.countMemories()}

---

最后更新: ${new Date().toISOString()}
`;

    fs.writeFileSync(indexPath, content);
  }

  /**
   * 初始化向量DB
   */
  async initChroma() {
    try {
      this.collection = await this.chroma.getOrCreateCollection({
        name: 'openclaw-memories',
        metadata: { 'hnsw:space': 'cosine' }
      });
      this.isInitialized = true;
      console.log('✅ Vector search enabled');
    } catch (error) {
      console.log('⚠️  ChromaDB initialization failed, using text search');
    }
  }

  /**
   * 等待就绪
   */
  async ensureReady() {
    await this.ready;
  }

  /**
   * 存储记忆到宫殿
   */
  async storeMemory(wingType, hallType, data) {
    await this.ensureReady();

    // 确定翼楼路径
    let wingPath;

    if (wingType === 'user') {
      wingPath = this.structure.wings.user;
      // 确保走廊存在
      if (!fs.existsSync(wingPath)) {
        fs.mkdirSync(wingPath, { recursive: true });
      }
      for (const hallName of Object.values(this.structure.halls)) {
        const hallPath = path.join(wingPath, `hall-${hallName}`);
        if (!fs.existsSync(hallPath)) {
          fs.mkdirSync(hallPath, { recursive: true });
        }
      }
    } else if (wingType === 'projects') {
      const projectName = data.project || 'default';
      wingPath = path.join(this.structure.wings.projects, projectName);

      if (!fs.existsSync(wingPath)) {
        fs.mkdirSync(wingPath, { recursive: true });

        // 创建走廊
        for (const hallName of Object.values(this.structure.halls)) {
          const hallPath = path.join(wingPath, `hall-${hallName}`);
          if (!fs.existsSync(hallPath)) {
            fs.mkdirSync(hallPath, { recursive: true });
          }
        }
      }
    } else {
      const topicName = data.topic || 'general';
      wingPath = path.join(this.structure.wings.topics, topicName);

      if (!fs.existsSync(wingPath)) {
        fs.mkdirSync(wingPath, { recursive: true });

        // 创建走廊
        for (const hallName of Object.values(this.structure.halls)) {
          const hallPath = path.join(wingPath, `hall-${hallName}`);
          if (!fs.existsSync(hallPath)) {
            fs.mkdirSync(hallPath, { recursive: true });
          }
        }
      }
    }

    // 确定走廊路径
    const hallPath = path.join(wingPath, `hall-${hallType}`);

    // 创建记忆
    const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const now = new Date().toISOString();

    const memory = {
      id,
      type: hallType,
      data: data,
      aaak: this.aaak.encode(data), // AAAK压缩
      created_at: data.created_at || now,
      updated_at: now,
      access_count: 0
    };

    // 保存到文件
    const filename = `${id}.${hallType}.json`;
    const filePath = path.join(hallPath, filename);
    fs.writeFileSync(filePath, JSON.stringify(memory, null, 2));

    // 添加到向量DB
    if (this.isInitialized && this.collection && data.content) {
      try {
        await this.collection.add({
          ids: [id],
          documents: [data.content],
          metadatas: [{ type: hallType, created: now }]
        });
      } catch (e) {
        // 静默失败
      }
    }

    return memory;
  }

  /**
   * 记住信息
   */
  async remember(content, type = 'fact', importance = 0.5) {
    await this.ensureReady();

    // 映射类型到走廊
    const hallMap = {
      'fact': 'facts',
      'preference': 'preferences',
      'context': 'context'
    };

    const hallType = hallMap[type] || 'facts';
    const wingMap = {
      'fact': 'topics',
      'preference': 'user',
      'context': 'topics'
    };

    const wingType = wingMap[type] || 'topics';

    const memory = await this.storeMemory(wingType, hallType, {
      content,
      importance,
      type
    });

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
            return {
              content: doc,
              score: 1 - (results.distances[0][i] || 0)
            };
          });

          // 更新访问计数
          for (const mem of memories) {
            await this.updateAccessCount(mem.content);
          }

          return memories.slice(0, limit);
        }
      } catch (e) {
        // 降级到文本搜索
      }
    }

    // 宫殿结构搜索
    return await this.searchPalace(query, limit);
  }

  /**
   * 在宫殿中搜索
   */
  async searchPalace(query, limit = 5) {
    const results = [];
    const queryLower = query.toLowerCase();

    // 搜索所有翼楼
    for (const [wingName, wingPath] of Object.entries(this.structure.wings)) {
      if (!fs.existsSync(wingPath)) continue;

      const files = this.findMemoryFiles(wingPath);

      for (const file of files) {
        try {
          const content = fs.readFileSync(file, 'utf-8');
          const memory = JSON.parse(content);

          // 搜索AAAK编码和数据
          const aaakText = JSON.stringify(memory.aaak).toLowerCase();
          const dataText = JSON.stringify(memory.data).toLowerCase();

          if (aaakText.includes(queryLower) || dataText.includes(queryLower)) {
            results.push({
              content: memory.data.content || memory.data,
              score: this.calculateRelevance(query, memory)
            });
          }
        } catch (e) {
          // 忽略损坏的文件
        }
      }
    }

    // 按相关性排序
    results.sort((a, b) => b.score - a.score);

    return results.slice(0, limit);
  }

  /**
   * 查找记忆文件
   */
  findMemoryFiles(searchPath) {
    const files = [];

    if (!fs.existsSync(searchPath)) {
      return files;
    }

    const walk = (dir) => {
      const items = fs.readdirSync(dir);

      for (const item of items) {
        const itemPath = path.join(dir, item);
        const stat = fs.statSync(itemPath);

        if (stat.isDirectory()) {
          walk(itemPath);
        } else if (item.endsWith('.json')) {
          files.push(itemPath);
        }
      }
    };

    walk(searchPath);
    return files;
  }

  /**
   * 计算相关性
   */
  calculateRelevance(query, memory) {
    let score = 0;
    const queryLower = query.toLowerCase();

    // 检查AAAK编码（更高权重）
    const aaakText = JSON.stringify(memory.aaak).toLowerCase();
    if (aaakText.includes(queryLower)) {
      score += 2;
    }

    // 检查数据
    const dataText = JSON.stringify(memory.data).toLowerCase();
    if (dataText.includes(queryLower)) {
      score += 1;
    }

    // 检查重要性
    if (memory.data.importance) {
      score += memory.data.importance;
    }

    // 检查访问次数（热记忆）
    score += Math.min(memory.access_count || 0, 5) * 0.1;

    return score;
  }

  /**
   * 更新访问计数
   */
  async updateAccessCount(content) {
    const files = this.findMemoryFiles(this.palacePath);

    for (const file of files) {
      try {
        const memory = JSON.parse(fs.readFileSync(file, 'utf-8'));
        if (memory.data.content === content) {
          memory.access_count++;
          fs.writeFileSync(file, JSON.stringify(memory, null, 2));
          break;
        }
      } catch (e) {
        // 忽略
      }
    }
  }

  /**
   * 更新偏好
   */
  async updatePreference(key, value) {
    await this.ensureReady();

    await this.storeMemory('user', 'preferences', {
      key,
      value
    });

    return `✅ 已更新: ${key} = ${value}`;
  }

  /**
   * 获取偏好
   */
  async getPreference(key) {
    await this.ensureReady();

    const hallPath = path.join(this.structure.wings.user, 'hall-preferences');

    if (!fs.existsSync(hallPath)) {
      return null;
    }

    const files = fs.readdirSync(hallPath);

    for (const file of files) {
      try {
        const memory = JSON.parse(fs.readFileSync(path.join(hallPath, file), 'utf-8'));
        if (memory.data.key === key) {
          return memory.data.value;
        }
      } catch (e) {
        // 忽略
      }
    }

    return null;
  }

  /**
   * 获取所有偏好
   */
  async getAllPreferences() {
    await this.ensureReady();

    const hallPath = path.join(this.structure.wings.user, 'hall-preferences');
    const prefs = {};

    if (!fs.existsSync(hallPath)) {
      return prefs;
    }

    const files = fs.readdirSync(hallPath);

    for (const file of files) {
      try {
        const memory = JSON.parse(fs.readFileSync(path.join(hallPath, file), 'utf-8'));
        if (memory.data.key) {
          prefs[memory.data.key] = memory.data.value;
        }
      } catch (e) {
        // 忽略
      }
    }

    return prefs;
  }

  /**
   * 添加反思
   */
  async addReflection(content, significance = 0.5) {
    await this.ensureReady();

    await this.storeMemory('user', 'discoveries', {
      content,
      significance
    });

    return `✅ 反思已记录`;
  }

  /**
   * 获取最近反思
   */
  async getRecentReflections(limit = 5) {
    await this.ensureReady();

    const hallPath = path.join(this.structure.wings.user, 'hall-discoveries');

    if (!fs.existsSync(hallPath)) {
      return [];
    }

    const files = fs.readdirSync(hallPath);
    const reflections = [];

    for (const file of files) {
      try {
        const memory = JSON.parse(fs.readFileSync(path.join(hallPath, file), 'utf-8'));
        reflections.push({
          content: memory.data.content,
          created_at: memory.created_at,
          significance: memory.data.significance
        });
      } catch (e) {
        // 忽略
      }
    }

    return reflections
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, limit);
  }

  /**
   * 获取统计
   */
  async getStats() {
    await this.ensureReady();

    const byType = {};
    const files = this.findMemoryFiles(this.palacePath);

    for (const file of files) {
      try {
        const memory = JSON.parse(fs.readFileSync(file, 'utf-8'));
        const type = memory.type || 'unknown';
        byType[type] = (byType[type] || 0) + 1;
      } catch (e) {
        // 忽略
      }
    }

    return {
      memories: {
        total: files.length,
        byType
      },
      wings: this.countWings(),
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

    const files = this.findMemoryFiles(this.palacePath);
    let cleaned = 0;

    for (const file of files) {
      try {
        const memory = JSON.parse(fs.readFileSync(file, 'utf-8'));
        const created = new Date(memory.created_at);

        if (created < cutoffDate &&
            (memory.data.importance || 0) < minImportance &&
            (memory.access_count || 0) < 5) {
          fs.unlinkSync(file);
          cleaned++;
        }
      } catch (e) {
        // 忽略
      }
    }

    return `✅ 清理了 ${cleaned} 条旧记忆`;
  }

  /**
   * 导出数据
   */
  async export() {
    await this.ensureReady();

    return {
      palace_path: this.palacePath,
      wings: this.countWings(),
      memories: this.countMemories(),
      exported_at: new Date().toISOString()
    };
  }

  /**
   * 统计翼楼数
   */
  countWings() {
    let count = 0;

    for (const wingPath of Object.values(this.structure.wings)) {
      if (fs.existsSync(wingPath)) {
        const items = fs.readdirSync(wingPath);
        count += items.filter(item => {
          const itemPath = path.join(wingPath, item);
          return fs.statSync(itemPath).isDirectory();
        }).length;
      }
    }

    return count;
  }

  /**
   * 统计记忆数
   */
  countMemories() {
    const files = this.findMemoryFiles(this.palacePath);
    return files.length;
  }
}

/**
 * AAAK编码器 - AI友好的压缩格式
 */
class AAAKEncoder {
  constructor() {
    this.abbreviations = {
      'DEV': 'development',
      'PROD': 'production',
      'AUTH': 'authentication',
      'DB': 'database',
      'API': 'application programming interface',
      'FE': 'frontend',
      'BE': 'backend',
      'INFRA': 'infrastructure',
      'UX': 'user experience',
      'UI': 'user interface',
      'SaaS': 'software as a service',
      'REC': 'recommended',
      'PRI': 'primary',
      'SEC': 'secondary',
      'JR': 'junior',
      'SR': 'senior',
      'YR': 'year'
    };
  }

  /**
   * 编码为AAAK格式
   */
  encode(data) {
    if (typeof data === 'string') {
      return this.encodeString(data);
    } else if (typeof data === 'object') {
      return this.encodeObject(data);
    }

    return data;
  }

  /**
   * 编码字符串
   */
  encodeString(text) {
    if (!text) return text;

    let encoded = text;

    // 替换常用词
    for (const [abbr, full] of Object.entries(this.abbreviations)) {
      const regex = new RegExp(`\\b${full}\\b`, 'gi');
      encoded = encoded.replace(regex, abbr);
    }

    // 压缩空格和换行
    encoded = encoded.replace(/\s+/g, ' ');

    return encoded;
  }

  /**
   * 编码对象
   */
  encodeObject(obj) {
    if (!obj) return obj;

    const encoded = {};

    for (const [key, value] of Object.entries(obj)) {
      // 压缩键名
      const compressedKey = this.compressKey(key);
      encoded[compressedKey] = this.encode(value);
    }

    return encoded;
  }

  /**
   * 压缩键名
   */
  compressKey(key) {
    if (key.length <= 3) return key;

    // 去除元音（保留首字母）
    return key[0] + key.substring(1).replace(/[aeiou]/gi, '');
  }

  /**
   * 解码AAAK格式
   */
  decode(aaak) {
    if (typeof aaak === 'string') {
      return this.decodeString(aaak);
    } else if (typeof aaak === 'object') {
      return this.decodeObject(aaak);
    }

    return aaak;
  }

  /**
   * 解码字符串
   */
  decodeString(text) {
    if (!text) return text;

    let decoded = text;

    // 恢复常用词
    for (const [abbr, full] of Object.entries(this.abbreviations)) {
      const regex = new RegExp(`\\b${abbr}\\b`, 'gi');
      decoded = decoded.replace(regex, full);
    }

    return decoded;
  }

  /**
   * 解码对象
   */
  decodeObject(obj) {
    if (!obj) return obj;

    const decoded = {};

    for (const [key, value] of Object.entries(obj)) {
      const expandedKey = this.expandKey(key);
      decoded[expandedKey] = this.decode(value);
    }

    return decoded;
  }

  /**
   * 扩展键名
   */
  expandKey(key) {
    return key; // 暂时保持原样
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
