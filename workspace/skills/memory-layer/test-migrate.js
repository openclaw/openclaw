#!/usr/bin/env node

import { memory } from './index.js';

console.log('🔄 测试迁移...');

memory.ready.then(async () => {
  console.log('\n✅ 初始化完成');

  const stats = await memory.getStats();
  console.log('\n📊 统计:');
  console.log('翼楼:', stats.wings);
  console.log('记忆:', stats.memories);
  console.log('类型:', JSON.stringify(stats.memories.byType, null, 2));

  // 测试功能
  console.log('\n🧪 测试记住...');
  const r1 = await memory.remember('检修后的新记忆', 'fact', 0.8);
  console.log(r1);

  console.log('\n🧪 测试回忆...');
  const r2 = await memory.recall('检修', 3);
  console.log('找到', r2.length, '条相关记忆');

  console.log('\n🎉 所有功能正常！');

  process.exit(0);
}).catch(err => {
  console.error('\n❌ 错误:', err.message);
  console.error(err.stack);
  process.exit(1);
});
