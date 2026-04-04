#!/usr/bin/env tsx

/**
 * 測試：更新 Notion 頁面的圖片
 *
 * 用途：將課程 5 的 highlight1 圖片換成 SVG
 */

import { Client } from "@notionhq/client";
import * as fs from 'fs';
import * as path from 'path';

const notion = new Client({
  auth: process.env.NOTION_TOKEN,
});

const PAGE_ID = "28405e9d-e121-80ca-b731-d3861177c7e1"; // 課程 5

async function updateImage() {
  console.log("🚀 開始測試：更新 Notion 圖片");
  console.log(`📄 Page ID: ${PAGE_ID}`);
  console.log("");

  // Step 1: 讀取當前頁面資料
  console.log("📖 Step 1: 讀取當前頁面資料...");

  const page = await notion.pages.retrieve({
    page_id: PAGE_ID,
  });

  console.log("✅ 頁面資料已讀取");
  console.log("");

  // Step 2: 準備新的圖片 URL
  // 注意：Notion 只支援外部 URL，不支援直接上傳 SVG
  // 我們需要：
  // 1. 將 SVG 上傳到某個 hosting（例如 GitHub, S3, 或其他）
  // 2. 取得公開的 URL
  // 3. 更新 Notion

  console.log("⚠️  重要提示：");
  console.log("   Notion 不支援直接上傳 SVG");
  console.log("   需要先將 SVG 上傳到外部 hosting");
  console.log("");

  // 這裡示範如何更新（使用外部 URL）
  const externalImageUrl = "https://example.com/test-pricing.svg"; // 需要替換成實際 URL

  console.log("📝 Step 2: 準備更新...");
  console.log(`   新圖片 URL: ${externalImageUrl}`);
  console.log("");

  // Step 3: 更新頁面屬性
  console.log("🔄 Step 3: 更新 content_highlight1_image...");

  try {
    const response = await notion.pages.update({
      page_id: PAGE_ID,
      properties: {
        "content_highlight1_image": {
          files: [
            {
              type: "external",
              name: "test-pricing-course5.svg",
              external: {
                url: externalImageUrl
              }
            }
          ]
        }
      }
    });

    console.log("✅ 更新成功！");
    console.log("");
    console.log("📊 更新結果：");
    console.log(JSON.stringify(response, null, 2));

  } catch (error: any) {
    console.error("❌ 更新失敗：", error.message);
    console.error("");
    console.error("完整錯誤：");
    console.error(error);
  }
}

// 執行
if (require.main === module) {
  updateImage().catch(error => {
    console.error("執行失敗：", error);
    process.exit(1);
  });
}
