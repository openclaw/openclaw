import { memory, commands } from './index.js';

/**
 * 测试记忆系统
 */
async function runTests() {
  console.log('\n🧪 测试OpenClaw记忆系统\n');
  console.log('='.repeat(60));

  // 等待初始化
  console.log('⏳ 初始化中...');
  await new Promise(resolve => setTimeout(resolve, 3000));

  // 测试1: 记住信息
  console.log('\n📝 测试1: 记住信息');
  console.log('-'.repeat(60));
  console.log(await commands.remember('用户喜欢简洁的回答，不要啰嗦', 'preference'));
  console.log(await commands.remember('用户在做AI科普报告，重视数据准确性', 'fact'));
  console.log(await commands.remember('用户会亲自验证B站粉丝数，用API而不是搜索引擎', 'fact', 0.9));
  console.log(await commands.remember('用户不喜欢被要求重复解释同样的事情', 'preference', 0.8));

  // 等待向量数据库
  await new Promise(resolve => setTimeout(resolve, 2000));

  // 测试2: 回忆信息
  console.log('\n🔍 测试2: 回忆信息');
  console.log('-'.repeat(60));
  const recallResults = await commands.recall('用户喜欢什么', 3);
  console.log(recallResults);

  // 测试3: 偏好管理
  console.log('\n⚙️  测试3: 偏好管理');
  console.log('-'.repeat(60));
  console.log(await commands.preference.set('communication_style', 'concise'));
  console.log(await commands.preference.set('data_source_preference', 'api_first'));
  console.log('\n所有偏好:');
  const allPrefs = await commands.preference.all();
  console.log(JSON.stringify(allPrefs, null, 2));

  // 测试4: 反思
  console.log('\n💭 测试4: 反思');
  console.log('-'.repeat(60));
  const reflection = `
今天的对话中，我学到了几个重要点：
1. 用户非常重视数据准确性，会亲自验证
2. 用户喜欢简洁的回答风格
3. 用户不喜欢啰嗦
4. 下次应该直接用API查询，而不是引用二手数据
`;
  console.log(await commands.reflect(reflection, 0.8));

  // 测试5: 统计
  console.log('\n📊 测试5: 统计信息');
  console.log('-'.repeat(60));
  const stats = await commands.stats();
  console.log(JSON.stringify(stats, null, 2));

  // 测试6: 导出
  console.log('\n💾 测试6: 导出数据');
  console.log('-'.repeat(60));
  const exported = await commands.export();
  console.log(`导出 ${exported.memories.length} 条记忆`);
  console.log(`导出 ${exported.profile.length} 条偏好`);
  console.log(`导出 ${exported.reflections.length} 条反思`);

  console.log('\n✅ 所有测试完成！');
  console.log('='.repeat(60));
}

// 运行测试
runTests().catch(error => {
  console.error('❌ 测试失败:', error);
  process.exit(1);
});
