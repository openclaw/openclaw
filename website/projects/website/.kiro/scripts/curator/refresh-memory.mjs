#!/usr/bin/env node
/**
 * Curator Memory 刷新包裝腳本 (ESM)
 *
 * 使用步驟：
 * 1. 載入環境變數
 * 2. 執行 tsx 編譯 build-memory-v1.5.ts
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';

// 載入環境變數
try {
  const envContent = readFileSync(join(process.cwd(), '.env'), 'utf-8');
  envContent.split('\n').forEach(line => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;

    const [key, ...values] = line.split('=');
    if (key && values.length > 0) {
      const value = values.join('=').trim();
      process.env[key.trim()] = value;
    }
  });
  console.log('✅ 環境變數已載入\n');
} catch (error) {
  console.error('❌ 無法載入 .env:', error.message);
  process.exit(1);
}

// 執行 build-memory 腳本，並傳遞環境變數
const child = spawn('pnpm', ['tsx', '.kiro/scripts/curator/build-memory-v1.5.ts'], {
  stdio: 'inherit',
  env: process.env,
  shell: true
});

child.on('exit', (code) => {
  process.exit(code || 0);
});
