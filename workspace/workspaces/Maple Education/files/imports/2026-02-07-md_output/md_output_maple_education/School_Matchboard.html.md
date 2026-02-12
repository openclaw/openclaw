---
title: "School_Matchboard.html"
source_path: "School_Matchboard.html"
tags: ["产品", "Maple", "html"]
ocr: false
---

# School_Matchboard.html

简介：内容概述：<!doctype html>

## 内容

```text
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Maple Education 学校与产品速配板</title>
  <style>
    :root {
      --bg: #0b1224;
      --card: #0f172a;
      --muted: #9ca3af;
      --text: #e5e7eb;
      --accent: #38bdf8;
      --accent2: #a4c639;
      --good: #34d399;
      --warn: #fbbf24;
      --bad: #f87171;
      --border: #1f2937;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
      background: radial-gradient(circle at 20% 20%, #111827 0%, #0b1224 35%), #0b1224;
      color: var(--text);
      padding: 20px 16px 48px;
    }
    h1 { margin: 0 0 8px; font-size: 28px; }
    p.lead { margin: 0 0 14px; color: var(--muted); }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .layout {
      display: grid;
      grid-template-columns: 2fr 0.9fr;
      gap: 16px;
      align-items: start;
    }
    @media (max-width: 1024px) {
      .layout { grid-template-columns: 1fr; }
    }
    .panel {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 16px;
    }
    .controls {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
      gap: 12px;
      margin-bottom: 12px;
    }
    label { display: block; margin-bottom: 6px; font-size: 13px; color: var(--muted); }
    input, select, textarea {
      width: 100%;
      padding: 10px 12px;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: #0b1224;
      color: var(--text);
      font-size: 14px;
    }
    input:focus, select:focus, textarea:focus { outline: 1px solid var(--accent); }
    textarea { resize: vertical; min-height: 110px; }
    .cards { display: grid; gap: 12px; }
    .card {
      background: #0d162b;
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 14px;
      display: grid;
      gap: 8px;
    }
    .card h3 { margin: 0; font-size: 17px; }
    .meta { display: flex; flex-wrap: wrap; gap: 8px; }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 9px;
      border-radius: 999px;
      font-size: 12px;
      border: 1px solid var(--border);
      background: #0b1224;
      color: var(--muted);
    }
    .pill.good { color: var(--good); border-color: #1c2f2f; }
    .pill.warn { color: var(--warn); border-color: #2f241c; }
    .pill.bad { color: var(--bad); border-color: #2f1c1c; }
    .muted { color: var(--muted); font-size: 13px; }
    .tagline { color: #e5e7eb; }
    button.add {
      justify-self: start;
      background: linear-gradient(135deg, #38bdf8, #0ea5e9);
      color: #0b1224;
      border: none;
      border-radius: 10px;
      padding: 8px 12px;
      font-weight: 600;
      cursor: pointer;
    }
    button.add:hover { opacity: 0.9; }
    .sidebar-section { margin-bottom: 16px; }
    .sidebar-section h3 { margin: 0 0 8px; font-size: 16px; }
    .list { display: grid; gap: 8px; }
	    .list-item {
	      border: 1px dashed var(--border);
	      border-radius: 10px;
	      padding: 8px 10px;
	      font-size: 13px;
	      display: grid;
	      gap: 4px;
	      background: #0b1224;
	    }
	    .course-list {
	      max-height: 320px;
	      overflow: auto;
	      padding-right: 6px;
	    }
	    .course-row {
	      display: flex;
	      align-items: flex-start;
	      justify-content: space-between;
	      gap: 10px;
	    }
		    .course-row button.add { padding: 6px 10px; }
		    .course-row strong a { color: var(--accent); text-decoration: none; }
		    .course-row strong a:hover { text-decoration: underline; }
		    .course-actions {
		      display: flex;
		      align-items: center;
		      gap: 6px;
		      flex-wrap: wrap;
		      justify-content: flex-end;
		    }
		    .pill-btn {
		      display: inline-flex;
		      align-items: center;
		      justify-content: center;
		      border: 1px solid var(--border);
		      background: #0b1224;
		      color: var(--muted);
		      border-radius: 999px;
		      padding: 4px 9px;
		      font-size: 12px;
		      cursor: pointer;
		      text-decoration: none;
		    }
		    .pill-btn:hover { border-color: var(--accent); color: var(--text); text-decoration: none; }
		    .pill.sales { color: var(--accent2); border-color: #26351c; }
	    .match-panel-title {
	      display: flex;
	      justify-content: space-between;
	      align-items: baseline;
	      gap: 12px;
	      margin-bottom: 8px;
	    }
	    .match-panel-title h3 { margin: 0; font-size: 16px; }
	    .overlay {
	      position: fixed;
	      inset: 0;
	      display: none;
	      align-items: center;
	      justify-content: center;
	      padding: 16px;
	      background: rgba(0, 0, 0, 0.6);
	      z-index: 9999;
	    }
	    .overlay.open { display: flex; }
	    .modal {
	      width: min(960px, 100%);
	      max-height: 88vh;
	      overflow: auto;
	      background: var(--card);
	      border: 1px solid var(--border);
	      border-radius: 14px;
	      padding: 16px;
	    }
	    .kv-grid {
	      display: grid;
	      grid-template-columns: repeat(2, minmax(0, 1fr));
	      gap: 10px;
	      margin-top: 10px;
	    }
	    @media (max-width: 860px) {
	      .kv-grid { grid-template-columns: 1fr; }
	    }
	    .kv-item {
	      border: 1px dashed var(--border);
	      border-radius: 10px;
	      padding: 10px 12px;
	      background: #0b1224;
	    }
	    .kv-item .k { color: var(--muted); font-size: 12px; margin-bottom: 4px; }
	    .kv-item .v { color: var(--text); font-size: 14px; word-break: break-word; }
	  .downloads ul { margin: 0; padding-left: 16px; }
	  .empty { text-align: center; color: var(--muted); padding: 12px 0; }
	  small { color: var(--muted); }
	  </style>
</head>
<body>
  <h1>枫叶留学 · 学校与产品速配板 / School &amp; Program Matchboard</h1>
  <p class="lead">目标：顾问输入客户年龄 / 学历 / 预算 / 专业方向，即时筛出可选课程；一键加入客户方案并生成客户表单/合同/报价/发票。<br/>Goal: input age / education / budget / major to filter instantly; one-click add to client plan and generate client sheet / contract / quote / invoice.</p>
  <p class="muted">版本 / Version：2025-12-19 05:20（如看不到“即时匹配 / Instant Match”模块，请刷新或确认打开的是此文件）</p>
  <p class="muted" id="runtime-status">运行状态 / Status：等待初始化… / waiting for init…</p>

  <div class="layout">
    <div>
      <div class="panel">
        <div class="controls">
	          <div>
	            <label>快速操作 / Quick actions</label>
	            <button class="add" style="width:100%;" id="reset-filters">展示全部 / Clear filters</button>
	            <button class="add" style="width:100%; margin-top:8px;" id="export-course-db">导出课程库 JSON / Export JSON</button>
	            <button class="add" style="width:100%; margin-top:8px;" id="export-course-db-csv">导出课程库 CSV（NocoDB）/ Export CSV</button>
	            <button class="add" style="width:100%; margin-top:8px;" id="import-course-db-btn">导入课程库 JSON / Import JSON</button>
	            <input id="import-course-db" type="file" accept="application/json" style="display:none;" />
	            <div class="muted" style="margin-top:6px;">提示：导入后会保存在本机浏览器，下次打开自动加载。</div>
	          </div>
	          <div>
	            <label for="catalog-mode">学校/课程数据集 / Dataset</label>
		            <select id="catalog-mode">
		              <option value="curated">精选推荐（22 条，预算较全）</option>
		              <option value="kaplan_full">Kaplan 全课程（367 条）</option>
		              <option value="psb_full">PSB 全课程（85 条）</option>
		              <option value="sim_full">SIM 全课程（118 条）</option>
		              <option value="curtin_full">Curtin 全课程（51 条）</option>
		              <option value="lsbf_full">LSBF 全课程（85 条）</option>
		              <option value="combined">精选 + Kaplan 全课程</option>
		              <option value="all">全部（精选+Kaplan+PSB+SIM+Curtin+LSBF）</option>
		              <option value="nocodb_shared">NocoDB 数据库（共享视图）</option>
		              <option value="custom_db">自定义数据库（导入）</option>
		            </select>
		            <div class="muted" style="margin-top:6px;">说明：默认是“全部（全课程）”；如想只看 22 条精选可切回“精选推荐”。</div>
		            <details class="muted" id="nocodb-settings" style="margin-top:8px;">
		              <summary style="cursor:pointer;">NocoDB 设置（可选，多人维护课程库）</summary>
		              <div style="margin-top:10px;">
		                <label for="nocodb-url">NocoDB 地址</label>
		                <input id="nocodb-url" type="text" placeholder="例如 http://192.168.50.191:8090" />
		                <label for="nocodb-view" style="margin-top:10px;">共享视图链接/ID</label>
		                <input id="nocodb-view" type="text" placeholder="在 NocoDB 里把 Courses 表创建 Shared View，然后把链接粘贴到这里" />
		                <button class="add" type="button" id="nocodb-save" style="width:100%; margin-top:10px;">保存设置</button>
		                <button class="add" type="button" id="nocodb-refresh" style="width:100%; margin-top:8px;">立即刷新 NocoDB 数据</button>
		                <div class="muted" style="margin-top:8px;">提示：共享视图只读；同事在 NocoDB 表格里增删改后，点“刷新”即可同步到匹配器。</div>
		              </div>
			            </details>
			          </div>
	          <div>
	            <label for="view-mode">展示方式 / View</label>
	            <select id="view-mode">
	              <option value="cards">按课程（每条一张卡）</option>
	              <option value="group_provider">按机构聚合（每个机构一张卡 + 课程列表）</option>
	            </select>
	            <div class="muted" style="margin-top:6px;">全课程数据很多时建议用“按机构聚合”。</div>
	          </div>
	          <div>
	            <label for="provider">机构筛选 / Provider</label>
	            <select id="provider">
	              <option value="">全部机构 / All providers</option>
	            </select>
	          </div>
          <div>
            <label for="keyword">关键词（学校/课程） / Keyword (school/program)</label>
            <input id="keyword" type="text" placeholder="例如 Kaplan / UCD / Psychology / IT" autofocus />
          </div>
          <div>
            <label>数量 / Stats</label>
            <div class="muted" id="catalog-stats" style="padding-top: 10px;">—</div>
          </div>
          <div>
            <label for="age">客户年龄 / Age</label>
            <input id="age" type="number" min="0" placeholder="例如 16" />
          </div>
          <div>
            <label for="education">最高学历 / Education</label>
            <select id="education">
              <option value="">不限 / Any</option>
              <option value="middle">初中毕业 / 在读 · Middle school</option>
              <option value="high">高中 / 中专 / 职高 · High school</option>
              <option value="diploma">大专 / 高职 · Diploma</option>
              <option value="bachelor">本科 · Bachelor</option>
              <option value="master">硕士及以上 · Master+</option>
            </select>
          </div>
	          <div>
	            <label for="budget">年预算（SGD，含学费，不含生活费） / Annual budget (SGD, tuition only)</label>
	            <input id="budget" type="number" min="0" step="1000" placeholder="例如 22000" />
	          </div>
	          <div>
	            <label for="tuition-max">总学费上限（SGD，可选） / Max total tuition (SGD, optional)</label>
	            <input id="tuition-max" type="number" min="0" step="1000" placeholder="例如 40000" />
	          </div>
	          <div>
	            <label for="duration-max-months">学制上限（个月，可选） / Max duration (months, optional)</label>
	            <input id="duration-max-months" type="number" min="0" step="1" placeholder="例如 18" />
	          </div>
	          <div>
	            <label for="qs-max">QS 排名上限（可选） / Max QS rank (optional)</label>
	            <input id="qs-max" type="number" min="1" step="1" placeholder="例如 100" />
	          </div>
	          <div>
	            <label for="cscse">留服认证（可选） / CSCSE (optional)</label>
	            <select id="cscse">
	              <option value="">不限 / Any</option>
	              <option value="yes">仅显示可留服认证（疑似） / Likely CSCSE-recognized</option>
	              <option value="no">仅显示不可/未知 / No or unknown</option>
	            </select>
	          </div>
	          <div>
	            <label for="route">意向路线 / Track</label>
	            <select id="route">
	              <option value="">不限 / Any</option>
              <option value="private_university">私立本科/硕士 / Private University (UG/PG)</option>
              <option value="dual_degree">合作办学本科 / Partner / Dual degree</option>
              <option value="k12_public">K12 公立 (AEIS) / Public</option>
              <option value="k12_international">K12 国际学校 / International school</option>
              <option value="kindergarten">幼儿园 / Kindergarten</option>
              <option value="nus_highend">NUS/NTU 高端申请 / NUS/NTU premium applications</option>
            </select>
          </div>
          <div>
            <label for="major">专业/方向 / Major</label>
            <select id="major">
              <option value="">不限 / Any</option>
              <option value="business">商科 / 管理 · Business</option>
              <option value="computing">IT / 计算机 / 数据 · Computing</option>
              <option value="engineering">工程 · Engineering</option>
              <option value="hospitality">酒店 / 旅游 · Hospitality</option>
              <option value="design_arts">设计 / 艺术 / 传媒 · Design / Arts / Media</option>
              <option value="psychology">心理 · Psychology</option>
              <option value="finance_acca">会计 / ACCA · Accounting</option>
              <option value="k12_public">K12 公立 (AEIS) / Public</option>
              <option value="k12_international">K12 国际学校 / International school</option>
              <option value="kindergarten">幼儿园 / Kindergarten</option>
              <option value="highend_public">NUS/NTU 高端申请 / NUS/NTU premium applications</option>
            </select>
          </div>
        </div>
      </div>

      <div class="panel" id="quick-panel">
        <div class="match-panel-title">
          <h3>即时匹配（Top 30，可一键加入客户） / Instant Match (Top 30, add to client)</h3>
          <div class="muted" id="quick-meta">—</div>
        </div>
        <div class="list course-list" id="quick-list"></div>
        <div class="empty" id="quick-empty" style="display:none;">未匹配到课程，请输入关键词或调整筛选条件。/ No programs found. Try keywords or adjust filters.</div>
      </div>

      <div class="cards panel" id="card-list"></div>
      <div class="empty" id="empty-state" style="display:none;">未匹配到课程，请调整筛选条件。/ No programs found. Adjust filters.</div>

	      <div class="panel downloads" style="margin-top:12px;">
	        <h3 style="margin:0 0 8px;">常用合同 / 表单 / 宣传物料</h3>
	        <ul>
	          <li><a href="01_Legal_and_Contracts/Templates/Maple_Study_Abroad_Service_Contract_Complete.html" target="_blank">主合同：留学服务合同（HTML，可打印 PDF）</a></li>
	          <li><a href="01_Legal_and_Contracts/Templates/Template_11_自雇EP公司设立与EP申请服务合同.html" target="_blank">合同：自雇 EP & 公司设立服务合同（HTML，可打印 PDF）</a></li>
	          <li><a href="01_Legal_and_Contracts/Templates/Template_05_私立大学申请服务附录.md" target="_blank">附录：私立大学申请服务附录 (MD)</a></li>
	          <li><a href="01_Legal_and_Contracts/Templates/Template_06_SIM申请服务附录.md" target="_blank">附录：SIM 申请服务附录 (MD)</a></li>
	          <li><a href="01_Legal_and_Contracts/Templates/Template_08_NUS_NTU高端申请服务附录.md" target="_blank">附录：NUS/NTU 高端申请服务附录 (MD)</a></li>
	          <li><a href="01_Legal_and_Contracts/Templates/Template_09_K12公立AEIS申请服务附录.md" target="_blank">附录：K12 公立/AEIS 申请服务附录 (MD)</a></li>
          <li><a href="01_Legal_and_Contracts/Templates/Template_10_国际学校申请服务附录.md" target="_blank">附录：国际学校申请服务附录 (MD)</a></li>
          <li><a href="01_Legal_and_Contracts/Templates/Template_07_幼儿园择校服务协议.md" target="_blank">协议：幼儿园择校服务协议 (MD)</a></li>
          <li><a href="01_Legal_and_Contracts/Templates/Template_01_代理合作协议.html" target="_blank">代理合作协议（HTML，可打印 PDF）</a></li>
          <li><a href="01_Legal_and_Contracts/Templates/Template_02_学生信息收集表.html" target="_blank">学生信息收集表（HTML，可打印 PDF）</a></li>
          <li><a href="01_Legal_and_Contracts/Templates/Template_04_返佣项目清单.html" target="_blank">返佣项目清单（HTML，可打印 PDF）</a></li>
          <li><a href="05_Marketing_Media/Maple%20留学产品宣传手册.pdf" target="_blank">产品宣传手册 (PDF)</a></li>
          <li><a href="05_Marketing_Media/Decks/Deck_01_私立本科路线.html" target="_blank">Deck · 私立本科路线</a></li>
          <li><a href="05_Marketing_Media/Decks/Deck_03_低龄AEIS路线.html" target="_blank">Deck · 低龄 AEIS 路线</a></li>
          <li><a href="05_Marketing_Media/Decks/Deck_04_低龄国际学校.html" target="_blank">Deck · 国际学校路线</a></li>
          <li><a href="05_Marketing_Media/Decks/Deck_05_新加坡幼儿园.html" target="_blank">Deck · 幼儿园路线</a></li>
          <li><a href="05_Marketing_Media/Decks/Deck_06_全家移民.html" target="_blank">Deck · 全家移民 (自雇 EP)</a></li>
          <li><a href="05_Marketing_Media/Decks/Deck_07_管家服务.html" target="_blank">Deck · 管家服务</a></li>
          <li><a href="02_Operations_and_Data/pricing/2025-11-29_Maple_Education_价目表_分类版.md" target="_blank">完整价目表 (MD)</a></li>
        </ul>
      </div>
    </div>

    <div class="panel">
      <div class="sidebar-section">
        <h3>路线匹配结果 / Route results</h3>
        <div class="meta" id="route-results"></div>
        <div class="muted" id="route-results-note">提示：填写左侧客户信息后，这里会显示“可走路线”。点击路线可一键筛选学校。/ Tip: fill client info, suggested tracks will appear here. Click a track to filter.</div>
      </div>

      <div class="sidebar-section">
        <h3>一键生成合同</h3>
        <div class="controls" style="grid-template-columns: 1fr;">
	          <div>
	            <label for="contract-no">合同编号</label>
	            <div style="display:grid; grid-template-columns: 1fr auto; gap: 8px;">
	              <input id="contract-no" type="text" placeholder="MAPLE-YYYYMMDD-XXXX" />
	              <button class="add" type="button" id="regen-contract-no">重生成</button>
	            </div>
	          </div>
	          <div>
	            <label for="contract-type">合同包类型</label>
	            <select id="contract-type">
	              <option value="auto">自动（按路线）</option>
	              <option value="main">主合同（留学服务合同）</option>
	              <option value="main_private">主合同 + 私立大学申请服务附录</option>
	              <option value="main_sim">主合同 + SIM 申请服务附录</option>
	              <option value="main_highend">主合同 + NUS/NTU 高端申请服务附录</option>
	              <option value="main_k12_public">主合同 + K12 公立/AEIS 申请服务附录</option>
	              <option value="main_k12_international">主合同 + 国际学校申请服务附录</option>
	              <option value="kindergarten">幼儿园择校服务协议（单独）</option>
	            </select>
	            <div class="muted" id="contract-type-note" style="margin-top:6px;">自动：—</div>
	          </div>
	          <div>
	            <label for="consultant">留学顾问</label>
	            <input id="consultant" type="text" placeholder="顾问姓名" />
	          </div>
	          <div>
	            <label for="client-name">客户姓名</label>
	            <input id="client-name" type="text" placeholder="与证件一致" />
	          </div>
	          <div>
	            <label for="child-name">学生/孩子姓名（低龄用）</label>
	            <input id="child-name" type="text" placeholder="K12/幼儿园可填写，可留空" />
	          </div>
	          <div>
	            <label for="target-grade">申请年级/阶段（低龄用）</label>
	            <input id="target-grade" type="text" placeholder="例如 K1 / P3 / Sec 1，可留空" />
	          </div>
	          <div>
	            <label for="client-id">身份证号</label>
	            <input id="client-id" type="text" placeholder="可留空" />
	          </div>
          <div>
            <label for="client-passport">护照号</label>
            <input id="client-passport" type="text" placeholder="可留空" />
          </div>
          <div>
            <label for="client-address">联系地址</label>
            <input id="client-address" type="text" placeholder="可留空" />
          </div>
          <div>
            <label for="client-phone">联系电话</label>
            <input id="client-phone" type="text" placeholder="可留空" />
          </div>
          <div>
            <label for="client-email">邮箱</label>
            <input id="client-email" type="email" placeholder="可留空" />
          </div>

          <div>
            <label for="country-cn">国家/地区 (CN)</label>
            <input id="country-cn" type="text" value="新加坡" />
          </div>
          <div>
            <label for="country-en">Country/Region (EN)</label>
            <input id="country-en" type="text" value="Singapore" />
          </div>
          <div>
            <label for="institution-cn">院校类型 (CN)</label>
            <input id="institution-cn" type="text" placeholder="会自动根据路线填充" />
          </div>
          <div>
            <label for="institution-en">Institution Type (EN)</label>
            <input id="institution-en" type="text" placeholder="Auto-filled by route" />
          </div>
          <div>
            <label for="target-school">目标院校/项目</label>
            <input id="target-school" type="text" placeholder="可从客户方案自动带入" />
          </div>
		          <div>
		            <label for="target-major">专业</label>
		            <input id="target-major" type="text" placeholder="例如 Business / IT / K12" />
		          </div>

		          <div>
		            <label for="start-date">预计开学日期（可选）</label>
		            <input id="start-date" type="date" />
		          </div>
		          <div>
		            <label for="deadline-date">报名/申请截止日期（可选）</label>
		            <input id="deadline-date" type="date" />
		          </div>

		          <div style="grid-column: 1 / -1;">
		            <label>销售提醒清单（可选）</label>
		            <div id="sales-reminders" style="display:grid; gap: 8px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));"></div>
		            <input id="sales-reminders-selected" type="hidden" value="" />
		            <div class="muted" id="sales-reminders-note" style="margin-top:6px;"></div>
		          </div>

		          <div style="grid-column: 1 / -1;">
		            <label for="sales-notes">销售备注（可选）</label>
		            <textarea id="sales-notes" style="min-height:90px;" placeholder="例如：材料缺口/风险点/家长诉求/跟进时间等"></textarea>
		          </div>

		          <div>
		            <label for="pricing-item">收费项目（按价目表）</label>
		            <div style="display:grid; grid-template-columns: 1fr auto; gap: 8px;">
		              <select id="pricing-item"></select>
	              <button class="add" type="button" id="apply-pricing">按价目表填充</button>
	            </div>
	            <div class="muted" id="pricing-note" style="margin-top:6px;"></div>
	          </div>

	          <div style="grid-column: 1 / -1;">
	            <label>可选附加收费项目（可写入报价页）</label>
	            <div id="addon-items" style="display:grid; gap: 8px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));"></div>
	            <input id="addons-selected" type="hidden" value="" />
	            <div class="muted" id="addons-note" style="margin-top:6px;"></div>
	          </div>

	          <div style="grid-column: 1 / -1;">
	            <label for="refund-terms">退费/特别约定（可选）</label>
	            <textarea id="refund-terms" placeholder="如无特殊退费约定，可留空（按主合同条款执行）。"></textarea>
	          </div>

	          <div style="grid-column: 1 / -1;">
	            <label>合同包内容</label>
	            <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
	              <div style="display:flex; align-items:center; gap:8px;">
	                <input id="include-quote-page" type="checkbox" checked style="width:auto;" />
	                <div style="font-size: 13px; color: var(--text);">附加《报价与退费约定》页</div>
	              </div>
	            </div>
	            <div class="muted" style="margin-top:6px;">提示：该页会把“收费项目 + 附加项 + 退费政策”整理成一页，方便打印归档。</div>
	          </div>

		          <div>
		            <label for="fee-sgd">服务费总额 (SGD)</label>
		            <input id="fee-sgd" type="number" min="0" step="1" placeholder="例如 3000" />
		          </div>
	          <div>
	            <label for="fx-cny-per-sgd">汇率（1 SGD = ? CNY，可选）</label>
	            <input id="fx-cny-per-sgd" type="number" min="0" step="0.01" placeholder="例如 5.30" />
	            <div class="muted" style="margin-top:6px;">提示：仅用于把旧价目表里的 CNY 金额换算为 SGD；合同/报价/发票全部输出 SGD。</div>
	          </div>
	          <div>
	            <label for="pay-method">支付方式</label>
	            <select id="pay-method">
	              <option value="full">一次性付清 Full Payment</option>
	              <option value="installment">分期付款 Installment</option>
	            </select>
	          </div>
	          <div>
	            <label for="initial-sgd">首次付款 (SGD)</label>
	            <input id="initial-sgd" type="number" min="0" step="1" placeholder="可留空" />
	          </div>
	          <div>
	            <label for="payment-date">付款日期</label>
	            <input id="payment-date" type="date" />
	          </div>
        </div>

        <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px;">
          <button class="add" id="preview-contract" type="button" style="width:100%;">预览</button>
          <button class="add" id="download-contract" type="button" style="width:100%;">下载 HTML</button>
        </div>
        <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px;">
          <button class="add" id="preview-quote" type="button" style="width:100%;">预览报价单</button>
          <button class="add" id="download-quote" type="button" style="width:100%;">下载报价单 HTML</button>
        </div>
	        <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px;">
	          <button class="add" id="preview-invoice" type="button" style="width:100%;">预览发票</button>
	          <button class="add" id="download-invoice" type="button" style="width:100%;">下载发票 HTML</button>
	        </div>
	        <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px;">
	          <button class="add" id="preview-client-sheet" type="button" style="width:100%;">预览客户表单</button>
	          <button class="add" id="download-client-sheet" type="button" style="width:100%;">下载客户表单 HTML</button>
	        </div>
	        <small>提示：预览页可直接 Ctrl+P / 打印 → 另存为 PDF。</small>
	        <div class="muted" id="contract-status" style="margin-top: 8px;"></div>
	        <div class="muted" style="margin-top: 6px;">
	          档案库（NAS MVP）：<a href="/admin/" target="_blank" rel="noopener noreferrer">打开 /admin/</a> · <a href="/admin/cases/" target="_blank" rel="noopener noreferrer">案件库</a>
	        </div>
	        <div style="display:flex; gap:10px; margin-top: 8px;">
	          <button class="add" id="save-case" type="button" style="flex:1;">保存/更新案件</button>
	          <button class="add" id="open-case" type="button" style="flex:1;">打开案件</button>
	        </div>
	        <div class="muted" id="case-status" style="margin-top: 6px;"></div>
	      </div>

      <div class="sidebar-section">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:10px;">
          <h3 style="margin:0;">客户方案（已选课程） / Client plan (selected)</h3>
          <button class="pill-btn" id="clear-shortlist" type="button">清空 / Clear</button>
        </div>
        <div class="list" id="shortlist"></div>
        <div class="empty" id="shortlist-empty">尚未选择，点击左侧课程的“加入客户”。/ Empty. Click “Add to client”.</div>
      </div>

      <div class="sidebar-section">
        <h3>附加服务 & 下一步</h3>
        <div class="list">
          <div class="list-item">
            <strong>境外助理 (8 项)</strong> · S$599<br/>
            入境接机/报到/体检/电话卡/银行卡/购物等。
          </div>
          <div class="list-item">
            <strong>管家套餐 · 3 个月</strong> · S$699<br/>
            学业监督、生活关怀、节点提醒，可加接机 S$200。
          </div>
          <div class="list-item">
            <strong>管家套餐 · 12 个月</strong> · S$4,399<br/>
            含 8 项助理服务，续期 S$2,000/年。
          </div>
          <div class="list-item">
            <strong>自雇 EP 全案</strong> · S$6,000（FAC）<br/>
            公司注册首年 S$3,880；开户 S$2,500；尽调 S$50/次。
          </div>
          <div class="list-item">
            <strong>毕业后路径提示</strong><br/>
            - 私立本科可衔接：就业 / 自雇 EP / NUS/NTU 硕士（不保证录取）<br/>
            - K12 可衔接：学生证 PR 规划 / 国际跳板欧美。
          </div>
          <div class="list-item">
            <strong>移民 / 签证 / 延伸服务</strong><br/>
            - 全家移民：自雇 EP / 公司设立 / 银行开户 / 尽调。<br/>
            - 签证路径：学生证 PR、家属 DP/LTVP，按家庭方案设计。<br/>
            - 培训备考：AEIS/S-AEIS、DSA、语言/预科/文书辅导，按项目报价。<br/>
            - 如需最新报价/合同，请查阅项目目录或联系顾问。
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="overlay" id="detail-overlay" aria-hidden="true">
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="detail-title">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px;">
        <div style="min-width:0;">
          <h2 id="detail-title" style="margin:0 0 6px; font-size:20px; line-height:1.25;">—</h2>
          <div class="muted" id="detail-subtitle">—</div>
        </div>
        <button class="pill-btn" id="detail-close" type="button">关闭 / Close</button>
      </div>

      <div class="meta" id="detail-pills" style="margin-top:10px;"></div>

      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-top:10px;">
        <button class="add" id="detail-add" type="button">加入客户 / Add to client</button>
        <button class="pill-btn" id="detail-remove" type="button" style="display:none;">从客户方案移除 / Remove</button>
        <button class="pill-btn" id="detail-sales-dec" type="button">−</button>
        <span class="pill sales" id="detail-sales-count" title="历史成交/销售数量（本机浏览器保存）">销量 0</span>
        <button class="pill-btn" id="detail-sales-inc" type="button">+</button>
        <a class="pill-btn" id="detail-official" href="#" target="_blank" rel="noreferrer">官网 / Official</a>
      </div>

      <div class="kv-grid" id="detail-kv"></div>
    </div>
  </div>

	  <script src="matchboard.config.js"></script>
	  <script>
	    const eduRank = { none: 0, middle: 1, high: 2, diploma: 3, bachelor: 4, master: 5 };

    // BEGIN_AUTO_COURSE_PAGE_DETAILS
    const coursePageDetailsByUrl = {"last_updated": "2025-12-13T07:33:01Z", "psb": {"https://www.psb-academy.edu.sg/coventry-university/bachelor-of-arts-with-honours-in-international-hospitality-and-tourism-management": {"awardedBy": "Coventry University", "academicLevel": "Bachelor's Degree", "duration": "20 months", "intakes": "March, July and November", "fees": "S$23,282.40", "mode": "Blended (In-campus & online)"}, "https://www.psb-academy.edu.sg/coventry-university/bachelor-of-arts-with-honours-in-digital-media": {"awardedBy": "PSB Academy", "academicLevel": "Bachelor's Degree", "duration": "24 months", "intakes": "March, July and November.", "fees": "S$37,539.60", "mode": "Blended Learning (In-campus & Online)"}, "https://www.psb-academy.edu.sg/coventry-university/bachelor-of-arts-with-honours-in-media-and-communications": {"awardedBy": "Coventry University", "academicLevel": "Bachelor's Degree", "duration": "16 months", "intakes": "March, July and November.", "fees": "S$23,282.40", "mode": "Blended (In-campus and Online)"}, "https://www.psb-academy.edu.sg/coventry-university/bachelor-of-arts-with-honours-in-business-and-marketing": {"awardedBy": "Coventry University", "academicLevel": "Bachelor's Degree", "duration": "16 months", "intakes": "March, July and November", "fees": "S$23,282.4", "mode": "Blended (In-campus & online)"}, "https://www.psb-academy.edu.sg/cambridge-assessment-international-education/igcse-intensive": {"awardedBy": "Cambridge Assessment International Examinations (CAIE, United Kingdom)", "academicLevel": "IGCSE", "duration": "5 months", "intakes": "Jan, Jul", "fees": "S$4,207.40", "mode": "Blended (City Campus & Online)"}, "https://www.psb-academy.edu.sg/coventry-university/bachelor-of-arts-with-honours-in-digital-marketing": {"awardedBy": "Coventry University", "academicLevel": "Bachelor's Degree", "duration": "16 months", "intakes": "March, July and November", "fees": "S$23,282.40", "mode": "Blended (In-campus & online)"}, "https://www.psb-academy.edu.sg/coventry-university/bachelor-of-science-with-honours-in-accounting-and-finance": {"awardedBy": "Coventry University", "academicLevel": "Bachelor's Degree", "duration": "16 months", "intakes": "March,July and November", "fees": "S$23,282.40", "mode": "Blended (In-campus & online)"}, "https://www.psb-academy.edu.sg/coventry-university/bachelor-of-engineering-with-honours-in-mechanical-engineering": {"awardedBy": "Coventry University", "academicLevel": "Bachelor's Degree", "duration": "16-24 months", "intakes": "March, July and November", "fees": "S$26,683.20", "mode": "Blended (In-campus & online)"}, "https://www.psb-academy.edu.sg/coventry-university/bachelor-of-engineering-with-honours-in-electro-mechanical-engineering": {"awardedBy": "Coventry University", "academicLevel": "Bachelor's Degree", "duration": "16-24 months", "intakes": "March, July and November", "fees": "S$26,596.00", "mode": "Blended (In-campus & online)"}, "https://www.psb-academy.edu.sg/coventry-university/bachelor-of-engineering-with-honours-in-electrical-and-electronic-engineering": {"awardedBy": "Coventry University", "academicLevel": "Bachelor's Degree", "duration": "16-24 months", "intakes": "March, July and November", "fees": "S$26,683.20", "mode": "Blended (In-campus & online)"}, "https://www.psb-academy.edu.sg/coventry-university/bachelor-of-science-with-honours-in-computing-science": {"awardedBy": "Coventry University", "academicLevel": "Bachelor's Degree", "duration": "16 months", "intakes": "March, July and November", "fees": "S$26,596.00", "mode": "Blended (In-campus & Online)"}, "https://www.psb-academy.edu.sg/coventry-university/bachelor-of-science-with-honours-in-business-and-finance": {"awardedBy": "Coventry University", "academicLevel": "Bachelor's Degree", "duration": "16 months", "intakes": "March, July and November", "fees": "S$23,282.40", "mode": "Blended (In-campus & online)"}, "https://www.psb-academy.edu.sg/coventry-university/bachelor-of-science-with-honours-in-cyber-security": {"awardedBy": "Coventry University", "academicLevel": "Bachelor's Degree", "duration": "16 months", "intakes": "March, July and November", "fees": "S$26,596.00", "mode": "Blended (In-campus & Online)"}, "https://www.psb-academy.edu.sg/coventry-university/bachelor-of-science-with-honours-in-paramedic-science-top-up": {"awardedBy": "Coventry University", "academicLevel": "Bachelor's Degree", "duration": "8-12 months", "intakes": "March, July, November", "fees": "S$13,341.60", "mode": "Blended Learning (In-campus & Online)"}, "https://www.psb-academy.edu.sg/coventry-university/bachelor-of-science-with-honours-in-quantity-surveying-and-commercial-management": {"awardedBy": "Coventry University", "academicLevel": "Bachelor's Degree", "duration": "16-24 months", "intakes": "March, July and November", "fees": "S$26,683.20", "mode": "Blended (In-campus & online)"}, "https://www.psb-academy.edu.sg/coventry-university/master-of-business-administration-in-finance": {"awardedBy": "Coventry University", "academicLevel": "Master's Degree", "duration": "12-16 months", "intakes": "March, July and November.", "fees": "S$15,299.00", "mode": "Blended (In-campus & Online)"}, "https://www.psb-academy.edu.sg/coventry-university/master-of-science-in-cyber-security": {"awardedBy": "Coventry University", "academicLevel": "Master's Degree", "duration": "12-20 months", "intakes": "March, July and November", "fees": "S$15,299", "mode": "Blended Learning (City Campus & Online)"}, "https://www.psb-academy.edu.sg/coventry-university/master-of-science-in-engineering-management": {"awardedBy": "Coventry University", "academicLevel": "Master's Degree", "duration": "12-16 months", "intakes": "March, July and November", "fees": "S$15,299", "mode": "Blended (In-campus & Online)"}, "https://www.psb-academy.edu.sg/coventry-university/master-of-business-administration-in-global-business": {"awardedBy": "Coventry University", "academicLevel": "Master's Degree", "duration": "12-16 months", "intakes": "March, July and November", "fees": "S$15,299", "mode": "Blended (In-campus & Online)"}, "https://www.psb-academy.edu.sg/edinburgh-napier-university/bachelor-of-arts-business-management-top-up": {"awardedBy": "Edinburgh Napier University", "academicLevel": "Degree Course", "duration": "12 months", "intakes": "Mar, July, Nov", "fees": "S$12,923.04 - S$13,603.20", "mode": "Face-to-face (City Campus)"}, "https://www.psb-academy.edu.sg/edinburgh-napier-university/bachelor-of-science-sport-and-exercise-science-top-up": {"awardedBy": "Edinburgh Napier University", "academicLevel": "Degree Course", "duration": "16- 24 months", "intakes": "Jan, May, Sep", "fees": "S$$14,191.80 - S$28,383.60", "mode": "Face-to-face (Campuses)"}, "https://www.psb-academy.edu.sg/la-trobe-university/bachelor-of-business-marketing-international-business": {"awardedBy": "La Trobe University", "academicLevel": "Bachelor's Degree", "duration": "12-32 months", "intakes": "Jan, May & Sept", "fees": "S$22,236.00-S$29,648.00", "mode": "Blended (Campuses & Online)"}, "https://www.psb-academy.edu.sg/la-trobe-university/bachelor-of-science-applied-chemistry-and-molecular-biology": {"awardedBy": "La Trobe University", "academicLevel": "Degree Course", "duration": "Part-Time: 24-48 months", "intakes": "January, May & September", "fees": "S$26,814.00-S$53,628.00", "mode": "Blended (Campuses & Online)"}, "https://www.psb-academy.edu.sg/la-trobe-university/bachelor-of-business-management-marketing": {"awardedBy": "La Trobe University", "academicLevel": "Bachelor's Degree", "duration": "12-32 months", "intakes": "Jan, May & Sept", "fees": "S$22,236.00 - S$29,648.00", "mode": "Blended (Campus & Online)"}, "https://www.psb-academy.edu.sg/la-trobe-university/bachelor-of-business-management-international-business": {"awardedBy": "La Trobe University", "academicLevel": "Bachelor's Degree", "duration": "12-32 months", "intakes": "Jan, May & Sept", "fees": "S$22,236.00-S$29,648.00", "mode": "Blended (Campuses & Online)"}, "https://www.psb-academy.edu.sg/la-trobe-university/bachelor-of-nursing-top-up": {"awardedBy": "La Trobe University", "academicLevel": "Bachelor's Degree", "duration": "24 months", "intakes": "Feb & Aug", "fees": "S$21,895.92 - S$24,328.80", "mode": "Blended (In-campus & online)"}, "https://www.psb-academy.edu.sg/la-trobe-university/bachelor-of-science-biotechnology-and-molecular-biology": {"awardedBy": "La Trobe University", "academicLevel": "Degree Course", "intakes": "January, May & Sept", "fees": "S$26,814.00 - S$53,628.00", "mode": "Blended (Campuses & Online)"}, "https://www.psb-academy.edu.sg/la-trobe-university/bachelor-of-science-molecular-biology-and-pharmaceutical-science": {"awardedBy": "La Trobe University", "academicLevel": "Bachelor's Degree", "duration": "Part-Time: 24-48 months", "intakes": "January, May & September", "fees": "S$26,814.00 - S$53,628.00", "mode": "Blended (Campuses & Online)"}, "https://www.psb-academy.edu.sg/edith-cowan-university/bachelor-of-science-exercise-and-sports-science": {"awardedBy": "Edith Cowan University", "academicLevel": "Bachelor's Degree", "duration": "12-24 months", "intakes": "January, May, and August", "fees": "S$21,124.20-S$28,165.60", "mode": "Blended (City Campuses & Online)"}, "https://www.psb-academy.edu.sg/massey-university/bachelor-of-information-sciences-with-a-double-major-in-computer-science-and-information-technology": {"awardedBy": "Massey University", "academicLevel": "Bachelor's Degree", "duration": "Part-Time: 24-36 months", "intakes": "March & November", "fees": "S$25,113.60 - S$37,670.40", "mode": "Blended (Campuses & Online)"}, "https://www.psb-academy.edu.sg/massey-university/bachelor-of-business-in-business-analytics": {"awardedBy": "Massey University", "academicLevel": "Bachelor's Degree", "duration": "Part-Time: 36 months", "intakes": "March,July & November", "fees": "S$17,893.44-S$37,670.40", "mode": "Blended (Campuses & Online)"}, "https://www.psb-academy.edu.sg/la-trobe-university/master-of-biotechnology-and-bioinformatics": {"awardedBy": "La Trobe University", "academicLevel": "Master's Degree", "duration": "36 - 48 months", "intakes": "May & September", "fees": "S$45,230.64 - S$47,611.20", "mode": "Blended (Campuses & Online)"}, "https://www.psb-academy.edu.sg/massey-university/bachelor-of-business-in-human-resource-management-employment-relations": {"awardedBy": "Massey University", "academicLevel": "Bachelor's Degree", "duration": "Part-Time: 36 months", "intakes": "March, July & November", "fees": "S$17,893.44-S$37,670.40", "mode": "Blended (Campuses & Online)"}, "https://www.psb-academy.edu.sg/psb-academy/certificate-in-english-proficiency": {}, "https://www.psb-academy.edu.sg/psb-academy/certificate-in-engineering-foundation-e-learning": {"academicLevel": "Certificate Course", "duration": "6 months", "intakes": "Year-Round", "fees": "S$2,289.00", "mode": "Self-paced, Asynchronous E-Learning"}, "https://www.psb-academy.edu.sg/la-trobe-university/bachelor-of-biomedical-science": {"awardedBy": "La Trobe University", "academicLevel": "Bachelor's Degree", "duration": "Part-Time: 24-48 months", "intakes": "January, May & Sept", "fees": "S$26,814.00 - S$53,628.00", "mode": "Blended (Campuses & Online)"}, "https://www.psb-academy.edu.sg/psb-academy/certificate-in-infocomm-technology-e-learning": {"academicLevel": "Certificate Course", "duration": "6 months", "intakes": "Year-Round", "fees": "S$2,289.00", "mode": "Self-paced, Asynchronous E-Learning"}, "https://www.psb-academy.edu.sg/psb-academy/certificate-in-academic-english": {"academicLevel": "Certificate Course", "duration": "4 months", "intakes": "Jan, Apr, Jun, Oct", "fees": "S$4,850.50", "mode": "Blending Learning (City Campus & Online)"}, "https://www.psb-academy.edu.sg/psb-academy/certificate-in-business-management": {"academicLevel": "Certificate Course", "duration": "6 months", "intakes": "Full-Time: Jan, Feb, Apr, May, Jul, Aug, Oct, Nov Part-Time: Jan, Apr, Jul, Oct", "fees": "Full-Time: S$2,921.20 Part-Time: S$2,354.40", "mode": "Blended (City Campus & Online)"}, "https://www.psb-academy.edu.sg/psb-academy/certificate-in-business-studies-e-learning": {"academicLevel": "Certificate Course", "duration": "6 months", "intakes": "Year-Round", "fees": "S$1,831.20", "mode": "Self-paced, Asynchronous E-Learning"}, "https://www.psb-academy.edu.sg/psb-academy/certificate-in-infocomm-technology": {"academicLevel": "Certificate Course", "duration": "6 months", "intakes": "Year-Round", "fees": "S$2,289.00", "mode": "Self-paced, Asynchronous E-Learning"}, "https://www.psb-academy.edu.sg/psb-academy/certificate-in-media-and-communications": {"academicLevel": "Certificate Course", "duration": "6 months", "intakes": "Jan, Feb, Apr, May, Jul, Aug, Oct, Nov", "fees": "S$2,964.80", "mode": "Blended (City Campus & Online)"}, "https://www.psb-academy.edu.sg/psb-academy/diploma-in-business-administration": {"academicLevel": "Diploma Course", "duration": "Full-Time: 9 - 12 months Part-Time: 12 months", "intakes": "Full-Time: Jan, Feb, Mar, Apr, May, Jul, Aug, Oct, Nov Part-Time: Jan, Apr, Jul, Oct", "fees": "Full-Time: S$7,673.60 Part-Time: S$6,540.00", "mode": "Blended Learning (City Campus & Online)"}, "https://www.psb-academy.edu.sg/psb-academy/certificate-in-sport-and-exercise-sciences": {"academicLevel": "Certificate Course", "duration": "6 months", "intakes": "Jan, Apr, Jul, Oct", "fees": "S$2,964.80", "mode": "Blended (In-campus or online)"}, "https://www.psb-academy.edu.sg/psb-academy/diploma-in-mechanical-engineering-technology": {"academicLevel": "Diploma Course", "duration": "Full-Time: 9 - 12 months", "intakes": "Jan, Apr, Jul, Oct", "fees": "Full-Time: S$10,202.40", "mode": "Blended (In-campus & online)"}, "https://www.psb-academy.edu.sg/psb-academy/diploma-in-business-administration-digital-marketing": {"academicLevel": "Diploma Course", "duration": "Full-Time: 9 - 12 months Part-Time: 12 months", "intakes": "Full-Time: Jan, Feb, Mar, Apr, May, Jul, Aug, Oct, Nov Part-Time: Jan, Apr, Jul, Oct", "fees": "Full-Time: S$7,673.60 Part-Time: S$6,540.00", "mode": "Blended Learning (City Campus & Online)"}, "https://www.psb-academy.edu.sg/psb-academy/diploma-in-business-administration-accounting-and-finance": {"academicLevel": "Diploma Course", "duration": "Full-Time: 9 - 12 months Part-Time: 12 months", "intakes": "Full-Time: Jan, Feb, Mar, Apr, May, Jul, Aug, Oct, Nov Part-Time: Jan, Apr, Jul, Oct", "fees": "Full-Time: S$7,673.60 Part-Time: S$6,540.00", "mode": "Blended Learning (City Campus & Online)"}, "https://www.psb-academy.edu.sg/psb-academy/diploma-in-business-administration-human-resource-management": {"academicLevel": "Diploma Course", "duration": "12 months", "intakes": "Jan, Apr, Jul, Oct", "fees": "S$6,540.00", "mode": "Blended Learning (City Campus & Online)"}, "https://www.psb-academy.edu.sg/psb-academy/diploma-in-business-studies-digital-marketing-e-learning": {"academicLevel": "Diploma Course", "duration": "9 months", "intakes": "Year-Round", "fees": "S$4,534.40", "mode": "Self-paced, Asynchronous E-Learning"}, "https://www.psb-academy.edu.sg/psb-academy/diploma-in-business-studies-business-analytics-e-learning": {"academicLevel": "Diploma Course", "duration": "9 months", "intakes": "Year-Round", "fees": "S$4,534.40", "mode": "Self-paced, Asynchronous E-Learning"}, "https://www.psb-academy.edu.sg/psb-academy/diploma-in-business-analytics": {"academicLevel": "Diploma Course", "duration": "Full-Time: 9 - 12 months Part-Time: 12 months", "intakes": "Full-Time: Jan, Apr, Jul, Oct Part-Time: Apr, Oct", "fees": "Full-Time: S$7,673.60 Part-Time: S$6,540.00", "mode": "Blended Learning (City Campus & Online)"}, "https://www.psb-academy.edu.sg/psb-academy/diploma-in-business-studies-e-learning": {"academicLevel": "Diploma Course", "duration": "9 months", "intakes": "Year-Round", "fees": "S$4,534.40", "mode": "Self-paced, Asynchronous E-Learning"}, "https://www.psb-academy.edu.sg/psb-academy/diploma-in-cyber-security": {"academicLevel": "Diploma Course", "duration": "Full Time: 9 - 12 months", "intakes": "Jan, Apr, Jul, Oct", "fees": "Full Time: S$7,673.60 Part Time: S$7,630.00", "mode": "Blended (In-campus & online)"}, "https://www.psb-academy.edu.sg/psb-academy/diploma-in-electrical-engineering-technology": {"academicLevel": "Diploma Course", "duration": "Full-Time: 9 - 12 months", "intakes": "Jan, Apr, Jul, Oct", "fees": "Full-Time: S$10,202.40", "mode": "Blended (In-campus & online)"}, "https://www.psb-academy.edu.sg/psb-academy/diploma-in-business-studies-human-resource-management-e-learning": {"academicLevel": "Diploma Course", "duration": "9 months", "intakes": "Year-Round", "fees": "S$4,534.40", "mode": "Self-paced, Asynchronous E-Learning"}, "https://www.psb-academy.edu.sg/psb-academy/diploma-in-global-supply-chain": {"academicLevel": "Diploma Course", "duration": "Full-Time: 9 - 12 months Part-Time: 12 months", "intakes": "Jan, Apr, Jul, Oct", "fees": "Full-Time: S$7,673.60 Part-Time: S$6,540.00", "mode": "Blended Learning (City Campus & Online)"}, "https://www.psb-academy.edu.sg/psb-academy/diploma-in-graphic-design-and-media": {"academicLevel": "Diploma Course", "duration": "Full-Time: 9 - 12 months Part-Time: 12 months", "intakes": "Full-Time: Jan, Apr, Jul, Oct Part-Time: Apr, Oct", "fees": "S$7,673.60", "mode": "Blended Learning (City Campus & Online)"}, "https://www.psb-academy.edu.sg/psb-academy/diploma-in-infocomm-technology": {"academicLevel": "Diploma Course", "duration": "Full-Time: 9 - 12 months", "intakes": "Jan, Apr, Jul, Oct", "fees": "Full-Time: S$7,673.60", "mode": "Blended (In-campus & online)"}, "https://www.psb-academy.edu.sg/psb-academy/diploma-in-sport-and-exercise-sciences": {"academicLevel": "Diploma Course", "duration": "Full-Time: 9 - 12 months", "intakes": "Jan, Apr, Jul, Oct", "fees": "S$7,673.60", "mode": "Blended (In-campus & online)"}, "https://www.psb-academy.edu.sg/psb-academy/diploma-in-infocomm-technology-e-learning": {"academicLevel": "Diploma Course", "duration": "9 months", "intakes": "Year-Round", "mode": "Self-paced, Asynchronous E-Learning"}, "https://www.psb-academy.edu.sg/psb-academy/foundation-certificate-in-business": {"academicLevel": "Foundation Certificate Course", "duration": "6 months", "intakes": "Jan, May, Jul", "fees": "S$4,054.80", "mode": "Blended (City Campus & Online)"}, "https://www.psb-academy.edu.sg/psb-academy/certificate-in-engineering-foundation": {"academicLevel": "Foundation Certificate Course", "duration": "9 months", "intakes": "Jan, May, Jul, Nov", "fees": "S$4,251.00", "mode": "Blended (In-campus & online)"}, "https://www.psb-academy.edu.sg/psb-academy/diploma-in-media-and-communications": {"academicLevel": "Diploma Course", "duration": "9 - 12 months", "intakes": "Jan, Apr, Jul, Oct", "fees": "S$7,673.60", "mode": "Blended Learning (City Campus & Online)"}, "https://www.psb-academy.edu.sg/psb-academy/diploma-in-sport-and-exercise-sciences-sport-coaching": {"academicLevel": "Diploma Course", "duration": "12 months", "intakes": "Jan, Apr, Jul, Oct", "fees": "S$7,673.60", "mode": "Blended (In-campus & online)"}, "https://www.psb-academy.edu.sg/psb-academy/foundation-diploma-in-life-sciences": {"academicLevel": "Diploma Course", "duration": "Full-Time: 9 - 12 months", "intakes": "Jan, Apr, Jun, Sep", "fees": "S$10,202.40", "mode": "Blended (In-campus & online)"}, "https://www.psb-academy.edu.sg/psb-academy/diploma-in-tourism-and-hospitality-management": {"academicLevel": "Diploma Course", "duration": "Full-Time: 9 - 12 months Part-Time: 12 months", "intakes": "Jan, Apr, Jul, Oct", "fees": "Full-Time: S$7,673.60 Part-Time: S$6,540.00", "mode": "Blended Learning (City Campus & Online)"}, "https://www.psb-academy.edu.sg/the-university-of-newcastle-australia/bachelor-of-communication": {"awardedBy": "University of Newcastle, Australia", "academicLevel": "Bachelor's Degree", "duration": "12-28 months", "intakes": "January, May, and August", "fees": "S$32,307.60-S$51,012.00", "mode": "Blended (City Campus & online)"}, "https://www.psb-academy.edu.sg/psb-academy/foundation-certificate-in-engineering-and-technology": {"academicLevel": "Foundation Certificate Course", "duration": "9 months", "intakes": "Jan, May, Jul, Nov", "fees": "S$4,251.00", "mode": "Blended (In-campus & online)"}, "https://www.psb-academy.edu.sg/the-university-of-newcastle-australia/bachelor-of-business": {"awardedBy": "University of Newcastle, Australia", "academicLevel": "Bachelor's Degree", "duration": "12-28 months", "intakes": "January, May, & August", "fees": "S$25,506.00-S$51,012.00", "mode": "Blended (City Campus & online)"}, "https://www.psb-academy.edu.sg/the-university-of-newcastle-australia/bachelor-of-information-technology": {"awardedBy": "University of Newcastle, Australia", "academicLevel": "Bachelor's Degree", "duration": "16-28 months", "intakes": "January, May and August", "fees": "S$32,970.32-S$52,058.40", "mode": "Blended (City Campus & online)"}, "https://www.psb-academy.edu.sg/the-university-of-newcastle-australia/bachelor-of-commerce": {"awardedBy": "University of Newcastle, Australia", "academicLevel": "Bachelor's Degree", "duration": "12-28 months", "intakes": "January, May & August", "fees": "S$25,506.00-S$51,012.00", "mode": "Blended (City Campus & online)"}, "https://www.psb-academy.edu.sg/psb-academy/postgraduate-diploma-in-cyber-security-elearning": {"academicLevel": "Postgraduate Diploma Course", "duration": "9 months", "intakes": "Year-Round", "mode": "Self-paced, Asynchronous E-Learning"}, "https://www.psb-academy.edu.sg/the-university-of-newcastle-australia/graduate-certificate-in-business-administration": {"awardedBy": "University of Newcastle, Australia", "academicLevel": "Postgraduate", "duration": "8 months", "intakes": "August & September", "fees": "S$11,663.00", "mode": "Face-to-face (City Campus)"}, "https://www.psb-academy.edu.sg/university-of-canberra/doctor-of-business-administration": {"awardedBy": "University of Canberra", "academicLevel": "Doctorate Degree", "duration": "48 months", "intakes": "Jan, July", "fees": "S$73,520.50 - S$77,390.00", "mode": "Blended (Campuses & online)"}, "https://www.psb-academy.edu.sg/the-university-of-newcastle-australia/executive-master-of-business-administration": {"awardedBy": "University of Newcastle, Australia", "academicLevel": "Master's Degree", "duration": "12 months", "intakes": "January & August", "fees": "S$44,908.00", "mode": "Blended (Campuses & online)"}, "https://www.psb-academy.edu.sg/the-university-of-newcastle-australia/master-of-business-administration": {"awardedBy": "University of Newcastle, Australia", "academicLevel": "Master's Degree", "duration": "16 months", "intakes": "August & September", "fees": "S$34,989.00", "mode": "Blended (City Campus & online)"}, "https://www.psb-academy.edu.sg/university-of-hertfordshire/bachelor-of-arts-honours-business-management-with-logistics": {"awardedBy": "University of Hertfordshire", "academicLevel": "Degree Course", "duration": "Part-time: 36 months Full-time: 24 months", "intakes": "Jan, May, Sep", "fees": "S$11,684.80 - S$35,054.40", "mode": "Face-to-face (City Campus)"}, "https://www.psb-academy.edu.sg/university-of-hertfordshire/bachelor-of-arts-honours-business-administration-top-up-e-learning": {"awardedBy": "University of Hertfordshire", "academicLevel": "Degree Course", "duration": "12 months", "intakes": "Jan, May, Sep", "fees": "S$11,684.80", "mode": "E-learning (100% online)"}, "https://www.psb-academy.edu.sg/university-of-hertfordshire/bachelor-of-arts-honours-business-administration-top-up": {"awardedBy": "University of Hertfordshire", "academicLevel": "Degree Course", "duration": "12 months", "intakes": "Jan, May, Sep", "fees": "S$11,684.80", "mode": "Blended (City Campus & online)"}, "https://www.psb-academy.edu.sg/university-of-hertfordshire/bachelor-of-engineering-honours-in-robotics-and-artificial-intelligence": {"awardedBy": "University of Hertfordshire", "academicLevel": "Degree Course", "duration": "Part-time: 24-36 months Full-time: 16-24 months", "intakes": "Jan, May, Sep", "fees": "S$23,892.80 - S$35,839.20", "mode": "Blended (STEM Campus & online)"}, "https://www.psb-academy.edu.sg/university-of-hertfordshire/bachelor-of-science-honours-diagnostic-radiography-and-imaging": {"awardedBy": "University of Hertfordshire", "academicLevel": "Degree Course", "duration": "36 months", "intakes": "October", "fees": "S$85,020.00", "mode": "Blended (Campuses & online)"}, "https://www.psb-academy.edu.sg/university-of-hertfordshire/master-of-business-administration-e-learning": {"awardedBy": "University of Hertfordshire", "academicLevel": "Master Course", "duration": "12 months", "intakes": "Jan, May, Sep", "fees": "S$16,742.40", "mode": "E-learning (100% online)"}, "https://www.psb-academy.edu.sg/university-of-hertfordshire/master-of-science-in-data-science": {"awardedBy": "University of Hertfordshire", "academicLevel": "Master Degree", "duration": "Part-time: 16 months Full-time: 12 months", "intakes": "Jan, May, Sep", "mode": "Blended (Campuses & online)"}, "https://www.psb-academy.edu.sg/university-of-hertfordshire/master-of-business-administration-uh": {"awardedBy": "University of Hertfordshire", "academicLevel": "Master Course", "duration": "12 months", "intakes": "Jan, May, Sep", "fees": "S$16,742.40", "mode": "Blended (Campuses & online)"}, "https://www.psb-academy.edu.sg/university-of-hertfordshire/bachelor-of-science-honours-data-science": {"awardedBy": "University of Hertfordshire", "academicLevel": "Degree Course", "duration": "Part-time: 24-36 months Full-time: 16-24 months", "intakes": "Jan, May, Sep", "fees": "S$$23,892.80 - S$35,839.20", "mode": "Blended (Campuses & online)"}}, "sim": {"https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/master-of-business-administration-marketing": {"duration": "Part-time, 2 years", "applicationDates": "Now till 5 December 2025", "fees": "S$44,341.20", "intakes": "Jan 2026 intake"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/master-of-business-administration-international-business-and-strategy": {"duration": "Part-time, 2 years", "applicationDates": "Now till 5 December 2025", "fees": "S$44,341.20", "intakes": "Jan 2026 intake"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/master-of-science-international-business": {"duration": "Full-time, 1 year", "applicationDates": "Now till 6 Apr 2026 (Local & Int'l)", "fees": "S$42,575.40 to S$44,537.40", "intakes": "Oct 2026 Intake"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/master-of-science-financial-management": {"duration": "Full-time, 1 year", "applicationDates": "Now till 6 Apr 2026 (Local & Int'l)", "fees": "S$47,088.00 to S$49,638.60", "intakes": "Oct 2026 intake"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/master-of-business-administration": {"duration": "Part-time, 2 years", "applicationDates": "Now till 5 December 2025", "fees": "S$44,341.20", "intakes": "Jan 2026 intake"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/master-of-business-administration-innovation-and-business-transformation": {"duration": "Part-time, 2 years", "applicationDates": "Now till 5 December 2025", "fees": "S$44,341.20", "intakes": "Jan 2026 Intake"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/monash-university-foundation-year": {"duration": "Full-time, 1 year", "applicationDates": "12 Jul - 24 Oct 2025", "fees": "S$13,428.80 - S$14,213.60", "intakes": "Jan 2026 intake"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/msc-finance-and-investment-banking": {"duration": "Full-time, 1 year", "applicationDates": "This programme is not open for direct applications by prospective students.", "intakes": "Oct 2025 Intake"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-accounting": {"duration": "Full-time, 2 to 3 years", "applicationDates": "12 Jul - 24 Oct 2025", "fees": "S$33,484.80 to S$57,133.44"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-business": {"duration": "Full-time & Part-time, (Full-time, 1.5 - 3 years | Part-time, 2 - 3 years)", "applicationDates": "12 Jul - 24 Oct 2025", "fees": "S$25,113.60 - S$57,133.44"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-applied-science-aviation-top-up": {"duration": "Part-time, 1.5 to 2.5 years", "applicationDates": "12 Jul - 24 Oct 2025", "fees": "S$21,765.12 to S$38,088.96"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-construction-management-honours-top-up": {"duration": "Full-time & Part-time, (Full-time, 2 years | Part-time, 3 years)", "applicationDates": "12 Jul - 24 Oct 2025", "fees": "S$35,996.16 - S$39,492.48", "intakes": "Jan 2026 Intake"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-professional-communication": {"duration": "Full-time, 12 to 24 months", "applicationDates": "2 Jun - 29 Aug 2025 (Category B)", "fees": "S$24,328.80 to S$55,249.92", "intakes": "Jul 2026 Intake, Nov 2025 Intake"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-graphic-design-top-up": {"duration": "Full-time, 1 year", "applicationDates": "Mid Jan 2026 (Jul 2026 Intake)", "fees": "S$24,328.80 to S$27,624.96", "intakes": "Jul 2026 Intake"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/master-of-energy-efficient-and-sustainable-building-top-up": {"duration": "Full-time, 12 months", "applicationDates": "12 Jul - 24 Oct 2025", "fees": "S$28,841.40 - S$32,373.00", "intakes": "Jan 2026 Intake"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/diploma-in-accounting": {"duration": "Full-time, 15 months", "applicationDates": "22 August 2025 till 06 February 2026 (For International applicants) 22 August 2025 till 13 February 2026 (For Local Applicants)"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/certificate-in-pre-sessional-business-management": {"duration": "Full-time, 6 months", "applicationDates": "22 August 2025 till 06 February 2026 (For International Applicants) 22 August 2025 till 13 February 2026 (For Local Applicants)"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/certificate-in-foundation-studies": {"duration": "Full-time, 3 months", "applicationDates": "22 August 2025 till 06 February 2026 (For International applicants) 22 August 2025 till 13 February 2026 (For Local Applicants)"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/diploma-international-business": {"duration": "Full-time, 15 months", "applicationDates": "22 August 2025 till 06 February 2026 (For International applicants) 22 August 2025 till 13 February 2026 (For Local Applicants)"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/diploma-management-studies": {"duration": "Full-time, 15 months", "applicationDates": "1 June 2025 till 14 November 2025 (For international Applicants) 1 June 2025 till 14 November 2025 (Local Applicants)"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/diploma-in-information-technology-(e-learning)": {"duration": "Full-time, 1 year", "applicationDates": "02 September 2025 - 01 March 2026", "fees": "S$14,800.00 - S$16,644.30"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/diploma-in-banking-and-finance": {"duration": "Full-time, 15 months", "applicationDates": "22 August 2025 till 06 February 2026 (For International applicants) 22 August 2025 till 13 February 2026 (For Local Applicants)"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/diploma-in-management-studies-(e-learning)": {"duration": "Full-time, 15 months", "applicationDates": "02 September 2025 till 01 March 2026", "fees": "S$18,000.00 - $20,132.30"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/diploma-information-technology": {"duration": "Full-time, 1 year", "applicationDates": "22 August 2026 till 06 February 2026 (For International Applicants) 22 August 2026 till 13 February 2026 (For Local Applicants)"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/information-technology-foundation-studies": {"duration": "Full-time, 6 months", "applicationDates": "22 August 2026 till 06 February 2026 (For International Applicants) 22 August 2026 till 13 February 2026 (For Local Applicants)"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/graduate-diploma-in-business-analytics-part-time": {"duration": "Part-time, 6 Months", "applicationDates": "1 November 2025 till 19 January 2026", "fees": "S$6,627.20", "intakes": "May 2026 Intake"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/graduate-certificate-business-analytics-part-time": {"duration": "Part-time, 6 Months", "applicationDates": "1 November 2025 till 19 January 2026", "fees": "S$3,313.60", "intakes": "May 2026 intake"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/graduate-diploma-in-business-analytics-full-time": {"duration": "Full-time, 6 Months", "applicationDates": "22 August 2026 till 06 February 2026 (For International Applicants) 22 August 2026 till 13 February 2026 (For Local Applicants)"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/graduate-diploma-in-human-resource-management-part-time": {"duration": "Part-time, 6 Months", "applicationDates": "1 November 2025 till 19 January 2026", "fees": "S$6,627.20", "intakes": "May 2026 Intake"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/management-foundation-studies": {"duration": "Full-time, 6 months", "applicationDates": "22 August 2026 till 06 February 2026 (For International Applicants) 22 August 2026 till 13 February 2026 (For Local Applicants)"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/specialist-diploma-social-entrepreneurship-part-time": {"duration": "Part-time, 6 months", "applicationDates": "Now till 31 May 2025 (for July 2025 intake)", "fees": "S$17,985 (incl. GST)"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-nursing-honours": {"duration": "Part-time, 2 years", "applicationDates": "Jan 2026 (2yrs programme) : 12 Jul 2025 - 11 Jan 2026", "intakes": "Jan 2026 intake"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-arts-communication-and-economics": {"duration": "Full-time, 4 years", "applicationDates": "Now till 15 December (January (Spring) 2026 Intake)", "fees": "S$60,887.40 - S$84,496.80 (Singaporean & PR) / S$67,296.60 - S$93,391.20 (International student)"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-nursing-post-registration": {"duration": "Part-time, 1 to 2 years", "applicationDates": "Jan 2026 (2-years intake): 12 Jul 2025 to 30 Jan 2026", "fees": "S$26,596.00", "intakes": "Jan 2026 intake, Jul 2026 intake"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-arts-communication-and-international-trade": {"duration": "Full-time, 4 years", "applicationDates": "Now till 15 December (January (Spring) 2026 Intake)", "fees": "S$60,887.40 - S$84,496.80 (Singaporean & PR) / S$67,296.60 - S$93,391.20 (International student)"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-arts-communication-and-psychology": {"duration": "Full-time, 4 years", "applicationDates": "Now till 15 December (January (Spring) 2026 Intake)", "fees": "S$60,887.40 - S$84,496.80 (Singaporean & PR) / S$67,296.60 - S$93,391.20 (International student)"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-arts-communication-and-sociology": {"duration": "Full-time, 4 years", "applicationDates": "Now till 15 December (January (Spring) 2026 Intake)", "fees": "S$60,887.40 - S$84,496.80 (Singaporean & PR) / S$67,296.60 - S$93,391.20 (International student)"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-arts-communication": {"duration": "Full-time, 3 years", "applicationDates": "Now till 15 December (January (Spring) 2026 Intake)", "fees": "S$41,627.10 - S$74,556.00 (Singaporean & PR) / S$46,008.90 - S$82,404.00 (International student)"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-arts-economics-and-psychology": {"duration": "Full-time, 4 years", "applicationDates": "Now till 15 December (January (Spring) 2026 Intake)", "fees": "S$60,887.40 - S$84,496.80 (Singaporean & PR) / S$67,296.60 - S$93,391.20 (International student)"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-arts-economics-and-international-trade": {"duration": "Full-time, 4 years", "applicationDates": "Now till 15 December (January (Spring) 2026 Intake)", "fees": "S$60,887.40 - S$84,496.80 (Singaporean & PR) / S$67,296.60 - S$93,391.20 (International student)"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-arts-economics-and-sociology": {"duration": "Full-time, 4 years", "applicationDates": "Now till 15 December (January (Spring) 2026 Intake)", "fees": "S$60,887.40 - S$84,496.80 (Singaporean & PR) / S$67,296.60 - S$93,391.20 (International student)"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-arts-international-trade-and-sociology": {"duration": "Full-time, 4 years", "applicationDates": "Now till 15 December (January (Spring) 2026 Intake)", "fees": "S$60,887.40 - S$84,496.80 (Singaporean & PR) / S$67,296.60 - S$93,391.20 (International student)"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-arts-international-trade-and-psychology": {"duration": "Full-time, 4 years", "applicationDates": "Now till 15 December (January (Spring) 2026 Intake)", "fees": "S$60,887.40 - S$84,496.80 (Singaporean & PR) / S$67,296.60 - S$93,391.20 (International student)"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-arts-economics": {"duration": "Full-time, 3 years", "applicationDates": "Now till 15 December (January (Spring) 2026 Intake)", "fees": "S$41,627.10 - S$74,556.00 (Singaporean & PR) / S$46,008.90 - S$82,404.00 (International student)"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-arts-psychology-and-sociology": {"duration": "Full-time, 4 years", "applicationDates": "Now till 15 December (January (Spring) 2026 Intake)", "fees": "S$60,887.40 - S$84,496.80 (Singaporean & PR) / S$67,296.60 - S$93,391.20 (International student)"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-arts-psychology": {"duration": "Full-time, 3 years", "applicationDates": "Now till 15 December (January (Spring) 2026 Intake)", "fees": "S$41,627.10 - S$74,556.00 (Singaporean & PR) / S$46,008.90 - S$82,404.00 (International student)"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-arts-international-trade": {"duration": "Full-time, 3 years", "applicationDates": "Now till 15 December (January (Spring) 2026 Intake)", "fees": "S$41,627.10 - S$74,556.00 (Singaporean & PR) / S$46,008.90 - S$82,404.00 (International student)"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-arts-sociology": {"duration": "Full-time, 3 years", "applicationDates": "Now till 15 December (January (Spring) 2026 Intake)", "fees": "S$41,627.10 - S$74,556.00 (Singaporean & PR) / S$46,008.90 - S$82,404.00 (International student)"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-business-administration-and-geographic-information-science": {"duration": "Full-time, 4 years", "applicationDates": "Now till 15 December (January (Spring) 2026 Intake)", "fees": "S$60,887.40 - S$84,496.80 (Singaporean & PR) / S$67,296.60 - S$93,391.20 (International student)"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-business-administration": {"duration": "Full-time, 3 years", "applicationDates": "Now till 15 December (January (Spring) 2026 Intake)", "fees": "S$41,627.10 - S$74,556.00 (Singaporean & PR) / S$46,008.90 - S$82,404.00 (International student)"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-business-administration-and-bachelor-of-arts-international-trade": {"duration": "Full-time, 4 years", "applicationDates": "Now till 15 December (January (Spring) 2026 Intake)", "fees": "S$64,615.20 - S$98,786.70 (Singaporean & PR) / S$71,416.80 - S$109,185.30 (International student)"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-business-administration-and-bachelor-of-arts-communication": {"duration": "Full-time, 4 years", "applicationDates": "Now till 15 December (January (Spring) 2026 Intake)", "fees": "S$64,615.20 - S$98,786.70 (Singaporean & PR) / S$71,416.80 - S$109,185.30 (International student)"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-business-administration-and-bachelor-of-arts-economics": {"duration": "Full-time, 4 years", "applicationDates": "Now till 15 December (January (Spring) 2026 Intake)", "fees": "S$64,615.20 - S$98,786.70 (Singaporean & PR) / S$71,416.80 - S$109,185.30 (International student)"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-business-administration-bachelor-of-arts-psychology": {"duration": "Full-time, 4 years", "applicationDates": "Now till 15 December (January (Spring) 2026 Intake)", "fees": "S$64,615.20 - S$98,786.70 (Singaporean & PR) / S$71,416.80 - S$109,185.30 (International student)"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-business-administration-and-bachelor-of-arts-sociology": {"duration": "Full-time, 4 years", "applicationDates": "Now till 15 December (January (Spring) 2026 Intake)", "fees": "S$64,615.20 - S$98,786.70 (Singaporean & PR) / S$71,416.80 - S$109,185.30 (International student)"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-geographic-information-science-and-bachelor-of-arts-economics": {"duration": "Full-time, 4 years", "applicationDates": "Now till 15 December (January (Spring) 2026 Intake)", "fees": "S$64,615.20 - S$98,786.70 (Singaporean & PR) / S$71,416.80 - S$109,185.30 (International student)"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-geographic-information-science-and-bachelor-of-arts-international-trade": {"duration": "Full-time, 4 years", "applicationDates": "Now till 15 December (January (Spring) 2026 Intake)", "fees": "S$64,615.20 - S$98,786.70 (Singaporean & PR) / S$71,416.80 - S$109,185.30 (International student)"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-geographic-information-science-and-bachelor-of-arts-communication": {"duration": "Full-time, 4 years", "applicationDates": "Now till 15 December (January (Spring) 2026 Intake)", "fees": "S$64,615.20 - S$98,786.70 (Singaporean & PR) / S$71,416.80 - S$109,185.30 (International student)"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-geographic-information-science": {"duration": "Full-time, 3 years", "applicationDates": "Now till 15 December (January (Spring) 2026 Intake)", "fees": "S$41,627.10 - S$74,556.00 (Singaporean & PR) / S$46,008.90 - S$82,404.00 (International student)"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-geographic-information-science-and-bachelor-of-arts-psychology": {"duration": "Full-time, 4 years", "applicationDates": "Now till 15 December (January (Spring) 2026 Intake)", "fees": "S$64,615.20 - S$98,786.70 (Singaporean & PR) / S$71,416.80 - S$109,185.30 (International student)"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-geographic-information-science-and-bachelor-of-arts-sociology": {"duration": "Full-time, 4 years", "applicationDates": "Now till 15 December (January (Spring) 2026 Intake)", "fees": "S$64,615.20 - S$98,786.70 (Singaporean & PR) / S$71,416.80 - S$109,185.30 (International student)"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/master-of-business-administration-(fasttrack)": {"duration": "Full-time & Part-time, Flexibility to complete the master program within 1 or 2 years to fit your needs.", "applicationDates": "Not open for application yet."}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-honours-business-management-communications-top-up": {"duration": "Full-time, 2 years", "applicationDates": "Preparatory Course - Now till 31 January 2026 (Local & International Applicants) | Direct Entry: Now till 31 January 2026 (Local & International Applicants)", "fees": "S$47,447.70 to S$51,829.50", "intakes": "Jul 2026 intake"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-honours-business-management-top-up": {"duration": "Full-time & Part-time, (Full-time & Part-time, 2 years | Part-time study not open for applications)", "applicationDates": "Preparatory Course - Now till 31 January 2026 (Local & International Applicants) | Direct Entry: Now till 31 January 2026 (Local & International Applicants)", "fees": "S$41,071.20 to S$45,518.40", "intakes": "Jul 2026 intake"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-honours-accounting-and-finance-top-up": {"duration": "Full-time, 2 years", "applicationDates": "Preparatory Course - Now till 4 May 2026 (Local & International Applicants) | Direct Entry: Now till 18 May 2026 (Local & International Applicants)", "fees": "S$41,071.20 to S$45,518.40", "intakes": "Sep 2026 intake"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-honours-business-management-communications-and-year-in-industry-top-up": {"duration": "Full-time, 2 years 4 months", "applicationDates": "Preparatory Course - Now till 31 January 2026 (Local & International Applicants) | Direct Entry: Now till 31 January 2026 (Local & International Applicants)", "fees": "S$51,829.50 to S$56,614.60", "intakes": "Jul 2026 intake"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-honours-business-management-industrial-placement-top-up": {"duration": "Full-time, 2 years", "applicationDates": "Preparatory Course - Now till 31 January 2026 (Local & International Applicants) | Direct Entry: Now till 31 January 2026 (Local & International Applicants)", "fees": "S$47,578.50 to S$52,407.20", "intakes": "Jul 2026 intake"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-honours-business-and-management": {"duration": "Full-time & Part-time, (Full-time, 3 years | Part-time, 3 years)", "applicationDates": "Now till 2 Feb 2026 (Local and International applicants)", "fees": "S$26,685 to S$42,835"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-honours-in-accounting-and-finance": {"duration": "Full-time & Part-time, (Full-time, 3 years | Part-time, 3 years)", "applicationDates": "Now till 2 Feb 2026 (Local and International applicants)", "fees": "S$26,685 to S$42,835"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-honours-international-business-top-up": {"duration": "Full-time, 2 years", "applicationDates": "Preparatory Course - Now till 31 January 2026 (Local & International Applicants) | Direct Entry: Now till 31 January 2026 (Local & International Applicants)", "fees": "S$52,014.80 to S$57,050.60", "intakes": "Jul 2026 intake"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-honours-computer-science": {"duration": "Full-time, 3 years", "applicationDates": "Now till 25 Feb 2026 (local and international applicants)", "fees": "S$31,370 to S$49,460"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-honours-computer-science-machine-learning-and-artificial-intelligence": {"duration": "Full-time, 3 years", "applicationDates": "Now till 25 Feb 2026 (local and international applicants)", "fees": "S$31,360 to S$49,460"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-honours-computer-science-physical-computing-internet-of-things": {"duration": "Full-time, 3 years", "applicationDates": "Now till 25 Feb 2026 (local and international applicants)", "fees": "S$31,360 to S$49,460"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-honours-computer-science-user-experience": {"duration": "Full-time, 3 years", "applicationDates": "Now till 25 Feb 2026 (local and international applicants)", "fees": "S$31,360 to S$49,460"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-honours-data-science-and-business-analytics": {"duration": "Full-time, 3 years", "applicationDates": "Now till 2 Feb 2026 (Local and International applicants)", "fees": "S$26,685 to S$42,835"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-honours-computer-science-web-and-mobile-development": {"duration": "Full-time, 3 years", "applicationDates": "Now till 25 Feb 2026 (local and international applicants)", "fees": "S$31,360 to S$49,460"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-honours-economics-and-finance": {"duration": "Full-time, 3 years", "applicationDates": "Now till 2 Feb 2026 (Local and International applicants)", "fees": "S$26,685 to S$42,835"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-honours-computer-science-virtual-reality": {"duration": "Full-time, 3 years", "applicationDates": "Now till 25 Feb 2026 (local and international applicants)", "fees": "S$31,360 to S$49,460"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-honours-economics": {"duration": "Full-time, 3 years", "applicationDates": "Now till 2 Feb 2026 (Local and International applicants)", "fees": "S$26,685 to S$42,835"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-honours-economics-and-management": {"duration": "Full-time, 3 years", "applicationDates": "Now till 2 Feb 2026 (Local and International applicants)", "fees": "S$26,685 to S$42,835"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-honours-finance": {"duration": "Full-time & Part-time, (Full-time, 3 years | Part-time, 3 years)", "applicationDates": "Now till 2 Feb 2026 (Local and International applicants)", "fees": "S$26,685 to S$42,835"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-honours-economics-and-politics": {"duration": "Full-time, 3 years", "applicationDates": "Now till 2 Feb 2026 (Local and International applicants)", "fees": "S$26,685 to S$42,835"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-management-and-digital-innovation": {"duration": "Full-time, 3 years", "applicationDates": "Now till 2 Feb 2026 (Local and International applicants)", "fees": "S$26,685 to S$42,835"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-honours-international-relations": {"duration": "Full-time, 3 years", "applicationDates": "Now till 2 Feb 2026 (Local and International applicants)", "fees": "S$26,685 to S$42,835"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/certificate-of-higher-education-in-social-sciences": {"duration": "Full-time, 1 year", "applicationDates": "Now till 2 Feb 2026 (Local and International applicants)", "fees": "S$14,860 to S$15,990"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/graduate-certificate-in-mobile-development": {"duration": "Full-time, 6 months", "applicationDates": "Now till 25 Feb 2026 (local and international applicants)", "fees": "S$7,700 to S$8,160"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/graduate-certificate-in-machine-learning-artificial-intelligence": {"duration": "Full-time, 6 months", "applicationDates": "Now till 25 Feb 2026 (local and international applicants)", "fees": "S$7,700 to S$8,160"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/graduate-certificate-in-user-experience": {"duration": "Full-time, 6 months", "applicationDates": "Now till 25 Feb 2026 (local and international applicants)", "fees": "S$7,700 to S$8,160"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/graduate-certificate-in-web-development": {"duration": "Full-time, 6 months", "applicationDates": "Now till 25 Feb 2026 (local and international applicants)", "fees": "S$7,700 to S$8,160"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/graduate-certificate-in-physical-computing-internet-of-things": {"duration": "Full-time, 6 months", "applicationDates": "Applications closed", "fees": "S$7,700 to S$8,160"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/graduate-diploma-in-data-science": {"duration": "Full-time, 1 year", "applicationDates": "Now till 2 Feb 2026 (Local and International applicants)", "fees": "S$13,315 to S$14,145"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/graduate-diploma-in-business-analytics": {"duration": "Full-time, 1 year", "applicationDates": "Now till 2 Feb 2026 (Local and International applicants)", "fees": "S$13,315 to S$14,145"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/graduate-diploma-in-economics": {"duration": "Full-time, 1 year", "applicationDates": "Now till 2 Feb 2026 (Local and International applicants)", "fees": "S$13,315 to S$14,145"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/graduate-diploma-in-machine-learning-artificial-intelligence": {"duration": "Full-time, 1 year", "applicationDates": "Now till 25 Feb 2026 (local and international applicants)", "fees": "S$15,280 to S$16,200"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/graduate-diploma-in-management": {"duration": "Full-time & Part-time, (Full-time, 1 year | Part-time, 1 year)", "applicationDates": "Now till 2 Feb 2026 (Local and International applicants)", "fees": "S$13,315 to S$14,145"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/graduate-diploma-in-finance": {"duration": "Full-time & Part-time, (Full-time, 1 year | Part-time, 1 year)", "applicationDates": "Now till 2 Feb 2026 (Local and International applicants)", "fees": "S$13,315 to S$14,145"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/graduate-diploma-in-management-and-digital-innovation": {"duration": "Full-time, 1 year", "applicationDates": "Now till 2 Feb 2026 (Local and International applicants)", "fees": "S$13,315 to S$14,145"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/graduate-diploma-in-user-experience": {"duration": "Full-time, 1 year", "applicationDates": "Now till 25 Feb 2026 (local and international applicants)", "fees": "S$15,280 to S$16,200"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/graduate-diploma-in-virtual-reality": {"duration": "Full-time, 1 year", "applicationDates": "Now till 25 Feb 2026 (local and international applicants)", "fees": "S$15,280 to S$16,200"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/international-foundation-programme": {"duration": "Full-time, 1 year", "applicationDates": "Now till 2 Feb 2026 (Local and International applicants)", "fees": "S$19,385 to S$21,040"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/graduate-diploma-in-physical-computing-internet-of-things": {"duration": "Full-time, 1 year", "applicationDates": "Now till 25 Feb 2026 (local and international applicants)", "fees": "S$15,280 to S$16,200"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/graduate-diploma-in-web-development": {"duration": "Full-time, 1 year", "applicationDates": "Now till 25 Feb 2026 (local and international applicants)", "fees": "S$15,280 to S$16,200"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/graduate-diploma-in-mobile-development": {"duration": "Full-time, 1 year", "applicationDates": "Now till 25 Feb 2026 (local and international applicants)", "fees": "S$15,280 to S$16,200"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-arts-honours-digital-media": {"duration": "Full-time, 2 to 3 years", "applicationDates": "Preparatory Course - Now till 1 April 2026 (Local & International Applicants) | Direct Entry: Now till 1 April 2026 (Local & International Applicants)", "fees": "S$52,974.00 to S$56,244.00", "intakes": "Aug 2026 Intake"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-arts-honours-sport-and-marketing": {"duration": "Full-time, 2 to 3 years", "applicationDates": "Preparatory Course - Now till 1 April 2026 (Local & International Applicants) | Direct Entry: Now till 1 April 2026 (Local & International Applicants)", "fees": "S$52,974.00 to S$56,244.00", "intakes": "Aug 2026 Intake"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/master-of-science-in-professional-accountancy": {"duration": "Part-time, 1 year", "applicationDates": "Now till 9 Mar 2026 (Local applicants)", "fees": "S$14,260"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-computer-science-artificial-intelligence-and-big-data": {"duration": "Full-time & Part-time, (Full-time, 3 years | Part-time, 3 years)", "applicationDates": "Apr 2026 Intake: 10 Nov 2025 to 19 Jan 2026", "fees": "S$23,397.50 to S$40,809.60", "intakes": "Apr 2026 Intake"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-arts-honours-marketing": {"duration": "Full-time & Part-time, 2 to 3 years | Part-time (not open for applications)", "applicationDates": "Preparatory Course - Now till 1 April 2026 (Local & International Applicants) | Direct Entry: Now till 1 April 2026 (Local & International Applicants)", "fees": "S$52,974.00 to S$56,244.00", "intakes": "Aug 2026 Intake"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-business-information-systems": {"duration": "Full-time, 3 years", "applicationDates": "Apr 2026 Intake: 10 Nov 2025 to 19 Jan 2026", "fees": "S$23,397.50 to S$40,809.60", "intakes": "Jul 2026 Intake"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-computer-science-big-data-discontinued": {"duration": "Full-time & Part-time, (Full-time, 3 years | Part-time, 3 years)", "fees": "S$23,397.50 to S$40,809.60", "intakes": "Apr 2026 Intake"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-computer-science-game-and-mobile-development": {"duration": "Full-time, 3 years", "applicationDates": "Apr 2026 Intake: 10 Nov 2025 to 19 Jan 2026", "fees": "S$23,397.50 to S$40,809.60", "intakes": "Apr 2026 Intake, Jul 2026 Intake"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-computer-science-cyber-security": {"duration": "Full-time, 3 years", "applicationDates": "Apr 2026 Intake: 10 Nov 2025 to 19 Jan 2026", "fees": "S$23,397.50 to S$40,809.60", "intakes": "Apr 2026 Intake, Jul 2026 Intake"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-computer-science-digital-systems-security": {"duration": "Full-time & Part-time, (Full-time, 3 years | Part-time, 3 years)", "applicationDates": "Apr 2026 Intake: 10 Nov 2025 to 19 Jan 2026", "fees": "S$23,397.50 to S$40,809.60", "intakes": "Apr 2026 Intake, Jul 2026 Intake"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-information-technology": {"duration": "Part-time, 3 years", "applicationDates": "Apr 2026 Intake: 10 Nov 2025 to 19 Jan 2026", "intakes": "Apr 2026 Intake, Jul 2026 Intake"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-psychological-science": {"duration": "Full-time, 3 years", "applicationDates": "July 2026 Intake: 10 Nov 2025 to 19 Jan 2026", "fees": "S$25,793.76 to $50,698.08", "intakes": "Jan 2027 Intake"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-computer-science-double-major-digital-systems-security-and-big-data-big-data-and-cs": {"duration": "Full-time, 3 years", "fees": "S$27,886.56 to S$43,564.25", "intakes": "Apr 2026 Intake, Jul 2026 Intake"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-computer-science-double-major": {"duration": "Full-time, 3 years", "applicationDates": "Apr 2026 Intake: 10 Nov 2025 to 19 Jan 2026", "fees": "S$27,886.56 to S$43,564.25", "intakes": "Apr 2026 Intake, Jul 2026 Intake"}, "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/master-of-computing-(data-analytics)": {"duration": "Full-time & Part-time, 1 year", "applicationDates": "Apr 2026 Intake: 10 Nov 2025 to 19 Jan 2026", "fees": "S$30,520.00", "intakes": "Apr 2026 Intake, Jul 2026 Intake"}}, "curtin": {"https://www.curtin.edu.sg/courses/undergraduate/bachelor-of-commerce/": {"intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/undergraduate/bachelor-of-commerce/accounting-and-finance/": {"fees": "S$44,472", "intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/undergraduate/bachelor-of-computing-cyber-security/": {"fees": "S$44,472", "intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/english-courses/academic-english-4/": {"duration": "13 weeks", "fees": "S$4,305.50 per unit", "intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/undergraduate/communications/": {"intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/undergraduate/bachelor-of-commerce/accounting/": {"fees": "S$44,472", "intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/undergraduate/bachelor-of-information-technology/": {"fees": "S$44,472", "intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/postgraduate/master-of-advanced-practice/clinical-leadership-specialisation/": {"fees": "S$23,108", "intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/undergraduate/nursing-conversion-program-for-registered-nurses/": {"fees": "S$21,800", "intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/diploma/diploma-of-commerce/": {"fees": "S$11,772", "intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/diploma/diploma-of-arts-and-creative-industries/": {"fees": "S$11,772", "intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/diploma/": {"intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/english-courses/english-for-academic-purposes/": {"fees": "S$4,305.50 per unit", "intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/diploma/diploma-of-information-technology/": {"fees": "S$11,772", "intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/english-courses/": {"intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/phd/": {"fees": "S$76,300", "intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/undergraduate/bachelor-of-commerce/finance/": {"fees": "S$44,472", "intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/undergraduate/bachelor-of-commerce/finance-and-management/": {"fees": "S$44,472", "intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/undergraduate/bachelor-of-commerce/finance-and-marketing/": {"fees": "S$44,472", "intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/postgraduate/graduate-certificate-in-clinical-leadership/": {"fees": "S$11,554", "intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/postgraduate/graduate-certificate-in-predictive-analytics/": {"fees": "S$11,772", "intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/postgraduate/graduate-certificate-in-supply-chain-management/": {"fees": "S$13,516", "intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/postgraduate/graduate-certificate-in-wound-ostomy-continence-practice/": {"fees": "S$5,777", "intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/postgraduate/graduate-diploma-in-predictive-analytics/": {"fees": "S$23,544", "intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/postgraduate/graduate-diploma-in-wound-ostomy-and-continence-practice/": {"fees": "S$17,331", "intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/undergraduate/bachelor-of-commerce/international-business/": {"fees": "S$44,472", "intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/undergraduate/communications/journalism-and-marketing/": {"fees": "S$29,648", "intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/undergraduate/communications/journalism-and-web-media/": {"fees": "S$29,648", "intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/undergraduate/bachelor-of-commerce/logistics-and-supply-chain-management/": {"fees": "S$44,472", "intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/undergraduate/bachelor-of-commerce/logistics-and-supply-chain-management-and-marketing/": {"fees": "S$44,472", "intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/undergraduate/bachelor-of-commerce/management/": {"fees": "S$44,472", "intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/undergraduate/bachelor-of-commerce/management-and-human-resource-management/": {"fees": "S$44,472", "intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/postgraduate/graduate-certificate-in-business-fundamentals/": {"fees": "S$13,516", "intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/undergraduate/bachelor-of-commerce/management-and-marketing/": {"fees": "S$44,472", "intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/postgraduate/master-of-advanced-practice/": {"intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/undergraduate/bachelor-of-commerce/marketing/": {"fees": "S$44,472", "intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/postgraduate/master-of-artificial-intelligence/": {"fees": "S$23,544", "intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/postgraduate/master-of-computing/": {"intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/postgraduate/master-of-computing/computer-science/": {"fees": "S$47,088", "intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/postgraduate/master-of-cybersecurity/": {"fees": "S$23,544", "intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/postgraduate/master-of-computing/cyber-security/": {"fees": "S$47,088", "intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/postgraduate/master-of-international-business-2/": {"fees": "S$27,032", "intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/postgraduate/master-of-predictive-analytics-data-science-major/": {"fees": "S$47,088", "intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/postgraduate/master-of-computing/artificial-intelligence/": {"fees": "S$47,088", "intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/postgraduate/master-of-supply-chain-management-professional/": {"fees": "S$27,032", "intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/postgraduate/": {"intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/study-abroad/": {"fees": "S$2,725", "intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/undergraduate/": {"intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/undergraduate/communications/web-media-and-marketing/": {"fees": "S$29,648", "intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/postgraduate/master-of-science-health-practice/": {"fees": "S$34,008", "intakes": "See academic calendar"}, "https://www.curtin.edu.sg/courses/postgraduate/master-of-advanced-practice/wound-ostomy-and-continence-practice-specialisation/": {"fees": "S$17,331", "intakes": "See academic calendar"}}, "lsbf": {"https://www.lsbf.edu.sg/programme/asia-winter-programme-singapore-2026-ai-uni-level": {"duration": "5 Days", "intakes": "12-16 Jan 2026", "fees": "SGD $1,775"}, "https://www.lsbf.edu.sg/programme/advanced-certificate-in-healthcare-and-social-care-management": {"duration": "4 Months"}, "https://www.lsbf.edu.sg/programmes/diploma/advanced-diploma-in-hospitality-and-tourism-management": {"duration": "8 months (full-time) / 12 months (part-time)+ 6 months IA", "intakes": "January, March, May, July, September, November", "fees": "SGD $6,981.45"}, "https://www.lsbf.edu.sg/programmes/diploma/advanced-diploma-in-business-studies": {"duration": "8 months (full-time) 8 months (part-time)", "intakes": "January (full-time) January (part-time)", "fees": "SGD $6,649.00"}, "https://www.lsbf.edu.sg/programmes/diploma/advanced-diploma-in-logistics-and-supply-chain-management": {"duration": "8 months + 6 months IA* (full-time), 12 months + 6 months IA* (part-time)", "intakes": "January, March, May, July, September, November (full-time); January, April, July, October (part-time) / modular", "fees": "SGD $6,649.00"}, "https://www.lsbf.edu.sg/programmes/chinese-programme/advanced-diploma-in-business-administration-mandarin": {"duration": "9 months (part-time)", "intakes": "Start every six weeks", "fees": "SGD $6,986.90"}, "https://www.lsbf.edu.sg/programmes/chinese-programme/advanced-diploma-in-accounting-and-finance-mandarin": {"duration": "8 months (full-time), 12 months (part-time)", "intakes": "Every two months (full-time), Every three months (part-time)"}, "https://www.lsbf.edu.sg/programmes/diploma/advanced-diploma-in-accounting-and-finance": {"duration": "8 months (full-time), 12 months (part-time)", "intakes": "January, March, May, July, September, November (full-time) / January, April, July, October (part-time)", "fees": "SGD $6,649.00"}, "https://www.lsbf.edu.sg/programmes/acca/bsc-hons-in-applied-accounting": {"duration": "Maximum candidature period – 6 months", "intakes": "Before May 2026"}, "https://www.lsbf.edu.sg/programmes/undergraduate/bachelor-of-arts-honours-accounting-and-finance": {"duration": "24 months – Day Classes (International & Local Students) | Evening/Weekend Classes (Local Students)", "intakes": "January, May or September", "fees": "SGD $27,250.00"}, "https://www.lsbf.edu.sg/programmes/chinese-programme/advanced-diploma-in-hospitality-and-tourism-management-mandarin": {"duration": "8 months + 6 months IA* (full-time); 12 months + 6 months IA* (part-time)", "intakes": "Start every two months (full-time), every 1.5 months (part-time) / modular", "fees": "SGD $6,104.00"}, "https://www.lsbf.edu.sg/programmes/online-courses/bachelor-of-arts-honours-in-business-logistics-and-transport-management-top-up": {"duration": "8 months (full-time), 12 months (part-time)", "intakes": "Start in January, May or September", "fees": "SGD $15,151.00"}, "https://www.lsbf.edu.sg/programmes/chinese-programme/advanced-diploma-in-global-logistics-and-supply-chain-management-mandarin": {"duration": "9 months (part-time)", "intakes": "Start every six weeks", "fees": "SGD $5,450"}, "https://www.lsbf.edu.sg/programmes/undergraduate/bachelor-of-arts-honours-in-business-studies": {"duration": "8 months (full-time), 12 months (part-time)", "intakes": "Start in January, May or September", "fees": "SGD $15,151.00"}, "https://www.lsbf.edu.sg/programmes/undergraduate/bachelor-of-arts-hons-in-hospitality-management": {"duration": "8 months (full-time), 12 months (part-time)", "intakes": "January, May or September", "fees": "SGD $15,908.55"}, "https://www.lsbf.edu.sg/programmes/undergraduate/bachelor-of-science-honours-computer-science": {"duration": "3 years (Day or Evening Classes Available)", "intakes": "February, June or October", "fees": "SGD $15,151.00"}, "https://www.lsbf.edu.sg/programmes/executive-development/cash-management": {"duration": "2 days, 9.30am-5.00pm", "intakes": "Coming Soon! (Q2 2025)"}, "https://www.lsbf.edu.sg/programmes/executive-development/certificate-in-digital-technologies-ai-cloud-and-cybersecurity": {"duration": "3 months", "intakes": "March 2026"}, "https://www.lsbf.edu.sg/programmes/chinese-programme/certificate-in-mandarin-for-business": {"duration": "Up to 3 months per level (Full-Time) Up to 4 months per level (Part-Time)", "intakes": "Jan, March, May, July, Sept, Nov (Full-time) / Jan, April, July, Oct (Part-time)", "fees": "SGD$1,312.04"}, "https://www.lsbf.edu.sg/programmes/diploma/certificate-in-robotics-programming": {"duration": "4 months", "intakes": "February, June, October"}, "https://www.lsbf.edu.sg/programme/asia-winter-programme-singapore-2026-high-school-ai": {"duration": "5 Days", "intakes": "5-9 Jan 2026", "fees": "SGD $1,465"}, "https://www.lsbf.edu.sg/programmes/chinese-programme/diploma-in-accounting-and-finance-mandarin": {"duration": "8 months (full-time), 12 months (part-time)", "intakes": "Start every two months (full-time), every three months (part-time)"}, "https://www.lsbf.edu.sg/programmes/undergraduate/bachelor-of-arts-honours-business-management": {"duration": "24 months – Day Classes (International & Local Students) | Evening/Weekend Classes (Local Students)", "intakes": "January, May, September", "fees": "SGD $25,070.00"}, "https://www.lsbf.edu.sg/programmes/undergraduate/bachelor-of-arts-honours-in-accounting-and-finance": {"duration": "8 months (full-time), 12 months (part-time)", "intakes": "Start in January, May or September", "fees": "SGD $16,241.00"}, "https://www.lsbf.edu.sg/programmes/chinese-programme/diploma-in-applied-hospitality-skills-mandarin": {"duration": "8 months + 6 months IA* (full time)", "intakes": "Start every 5 weeks"}, "https://www.lsbf.edu.sg/programmes/diploma/diploma-in-applied-hospitality-skills": {"duration": "8 months in class (full-time) plus 6-month Industrial Attachment", "intakes": "Start every month (except in June and December) / modular", "fees": "SGD $6,409.20"}, "https://www.lsbf.edu.sg/programmes/chinese-programme/certificate-in-business-mandarin": {"duration": "6 months (full-time)", "intakes": "Starts every 2 months", "fees": "SGD $4,142.00"}, "https://www.lsbf.edu.sg/programmes/diploma/diploma-in-accounting-and-finance": {"duration": "8 months (full-time), 12 months (part-time)", "intakes": "January, March, May, July, September, November (full-time) / January, April, July, October (part-time)", "fees": "SGD $6,104.00"}, "https://www.lsbf.edu.sg/programmes/diploma/diploma-in-data-analytics": {"duration": "8 months (full-time), 12 months (part-time)", "intakes": "Start in January, March, May, July, September, November (full-time); January, April, July, October (part-time)", "fees": "SGD $6,104.00"}, "https://www.lsbf.edu.sg/programmes/chinese-programme/diploma-in-global-logistics-and-supply-chain-management-mandarin": {"duration": "9 months (part-time)", "intakes": "Start every six weeks", "fees": "SGD $5,450"}, "https://www.lsbf.edu.sg/programmes/diploma/diploma-in-information-technology": {"duration": "8 months (full-time), 12 months (part-time)", "intakes": "Every 2 months (full-time), every 3 months (part-time)", "fees": "SGD $6,104.00"}, "https://www.lsbf.edu.sg/programmes/chinese-programme/diploma-in-international-business-mandarin": {"duration": "8 months (full-time), 12 months (part-time)", "intakes": "January, March, May, July, September, November (full-time); January, April, July, October (part-time)", "fees": "SGD $6,104.00"}, "https://www.lsbf.edu.sg/programmes/diploma/diploma-in-banking-and-finance": {"duration": "8 months (full-time), 12 months (part-time)", "intakes": "Start in January, March, May, July, September, November (full-time) / January, April, July, October (part-time)", "fees": "SGD $6,104.00"}, "https://www.lsbf.edu.sg/programmes/chinese-programme/diploma-in-business-administration-mandarin": {"duration": "9 months (part-time)", "intakes": "Starts every six weeks", "fees": "SGD $6,104.00"}, "https://www.lsbf.edu.sg/programmes/diploma/diploma-in-biomedical-science": {"duration": "6 months (Full Time)/ 6 months (Part time)", "intakes": "Every two months (Feb, April, June, Aug, Oct, Dec) (full-time) and (part-time)", "fees": "SGD $6,104.00"}, "https://www.lsbf.edu.sg/programmes/diploma/diploma-in-law": {"duration": "8 months (full-time), 12 months (part-time)", "intakes": "January, March, May, July, September, November (full-time); January, April, July, October (part-time)", "fees": "SGD $6,104.00"}, "https://www.lsbf.edu.sg/programmes/diploma/diploma-in-logistics-and-supply-chain-management": {"duration": "8 months + 6 months IA* (full-time), 12 months + 6 months IA* (part-time)", "intakes": "Start in January, March, May, July, September, November (full-time); January, April, July, October (part-time)", "fees": "SGD $6,104.00"}, "https://www.lsbf.edu.sg/programmes/undergraduate/bachelor-of-science-honours-cyber-security-networks": {"duration": "3 years (full-time), 5 years (part-time)", "intakes": "February, June or October", "fees": "SGD $15,151.00"}, "https://www.lsbf.edu.sg/programmes/executive-development/finance-accounting-for-banking-finance-professionals": {"duration": "2 days, 9.30am-5.00pm", "intakes": "Coming Soon! (Q2/Q3 2025)"}, "https://www.lsbf.edu.sg/programmes/diploma/diploma-in-business-studies": {"duration": "8 months (full-time) 8 months (part-time)", "intakes": "January (full-time) January (part-time)", "fees": "SGD $6,104.00"}, "https://www.lsbf.edu.sg/programmes/chinese-programme/diploma-in-international-hospitality-management-mandarin": {"duration": "8 months (full-time) + 6-month Industrial Attachment", "intakes": "Start every two months", "fees": "SGD $8,074.07"}, "https://www.lsbf.edu.sg/programmes/diploma/diploma-in-metaverse-gaming-and-edge-computing": {"duration": "8 months (Full-Time and Part-Time)", "intakes": "Every 2 months (Feb, April, June, Aug, Oct, Dec) (Full-Time and Part-Time)", "fees": "SGD $6,104.00"}, "https://www.lsbf.edu.sg/programmes/diploma/higher-diploma-in-advanced-technology-and-ai": {"duration": "14 months (full-time/part-time)", "intakes": "February, April, June, August, October, December"}, "https://www.lsbf.edu.sg/programmes/diploma/higher-diploma-in-biomedical-science": {"duration": "12 months (Full Time)/ 12 months (Part Time)", "intakes": "Every two months (Feb, April, June, Aug, Oct, Dec) (full-time) and (part-time)", "fees": "SGD $12,818.40"}, "https://www.lsbf.edu.sg/programmes/diploma/higher-diploma-in-business-studies": {"duration": "16 months (full-time) 16 months (part-time)", "intakes": "January (full-time) January (part-time)", "fees": "SGD $12,818.40"}, "https://www.lsbf.edu.sg/programmes/diploma/foundation-diploma": {"duration": "6 months", "intakes": "Every Two Months (Full-Time; Part-Time)", "fees": "SGD $2,071.00"}, "https://www.lsbf.edu.sg/programmes/diploma/higher-diploma-in-data-science-and-analytics": {"duration": "16 months (full-time), 24 months (part-time)", "intakes": "Start in January, March, May, July, September, November (full-time); January, April, July, October (part-time)", "fees": "SGD $12,818.4"}, "https://www.lsbf.edu.sg/programmes/chinese-programme/higher-diploma-in-global-logistics-and-supply-chain-management-mandarin": {"duration": "24 months (full-time)", "intakes": "Start every six weeks", "fees": "SGD $12,312.96"}, "https://www.lsbf.edu.sg/programmes/diploma/higher-diploma-in-healthcare-and-social-care-management": {"duration": "12 months + 6 months IA* (full-time) 12 months + 6 months IA* (part-time)", "intakes": "February (full-time) February (part-time)", "fees": "SGD $12,818.40"}, "https://www.lsbf.edu.sg/programmes/chinese-programme/higher-diploma-in-international-business-mandarin": {"duration": "18 months (full-time)", "intakes": "January, March, May, July, September, November", "fees": "SGD $19,113.15"}, "https://www.lsbf.edu.sg/programmes/diploma/international-foundation-diploma-in-biomedical-science": {"duration": "6 Months (Full Time) / 6 Months (Part Time)", "intakes": "Every two months", "fees": "SGD $6,104.00"}, "https://www.lsbf.edu.sg/programmes/chinese-programme/higher-diploma-in-accounting-and-finance-mandarin": {"duration": "18 months (full-time)", "intakes": "Feb, Apr, Jun, Aug, Oct, Dec"}, "https://www.lsbf.edu.sg/programmes/diploma/higher-diploma-in-computer-science": {"duration": "14 months (full-time / part-time)", "intakes": "Every 2 months (full-time / part-time)", "fees": "SGD $12,818.40"}, "https://www.lsbf.edu.sg/programmes/postgraduate/master-of-arts-education": {"duration": "12 months (full-time)", "intakes": "January (Day Classes (International & Local Students) | Evening/Weekend Classes (Local Students))", "fees": "SGD $17,440.00"}, "https://www.lsbf.edu.sg/programmes/diploma/higher-diploma-in-cyber-security-and-networks": {"duration": "14 months (full-time/part-time)", "intakes": "February, April, June, August, October, December"}, "https://www.lsbf.edu.sg/programmes/postgraduate/master-of-arts-in-logistics-and-supply-chain-management": {"duration": "12 months (full-time), 18 months (part-time)", "intakes": "Start in January, May or September"}, "https://www.lsbf.edu.sg/programme/master-of-business-administration-in-international-business": {"duration": "12 months (full-time), 18 months (part-time)", "intakes": "January, May or September"}, "https://www.lsbf.edu.sg/programmes/diploma/higher-diploma-in-hospitality-and-tourism-management": {"duration": "14 months + 6 months IA* (Full-time only)", "intakes": "January, March, May, July, September, November / modular", "fees": "SGD $12,814.40"}, "https://www.lsbf.edu.sg/programmes/diploma/higher-diploma-in-logistics-and-supply-chain-management": {"duration": "18 months (full-time)", "intakes": "Start in January, March, May, July, September, November / modular", "fees": "SGD $12,818.40"}, "https://www.lsbf.edu.sg/programmes/executive-development/logistics-supply-chain-management": {"duration": "2 days, 9.30am-5.00pm", "intakes": "Coming Soon! (Q3 2025)"}, "https://www.lsbf.edu.sg/programme/master-of-science-financial-technology": {"duration": "Teach-Out", "intakes": "Teach-Out"}, "https://www.lsbf.edu.sg/programmes/postgraduate/ma-media-and-communication-industries": {"duration": "12 months (Full time or Part Time)", "intakes": "February, July or October"}, "https://www.lsbf.edu.sg/programmes/postgraduate/master-of-science-in-computer-science": {"duration": "12 months (Full time or Part Time)", "intakes": "February, June or October"}, "https://www.lsbf.edu.sg/programmes/postgraduate/master-of-science-in-information-security-and-digital-forensics": {"duration": "12 months (Full time or Part Time)", "intakes": "February, June or October"}, "https://www.lsbf.edu.sg/programmes/executive-development/new-manager-toolkit": {"duration": "0.5 – 1 day/module"}, "https://www.lsbf.edu.sg/programmes/postgraduate/postgraduate-diploma-in-business": {"duration": "6 months (full-time), 6 months (part-time)", "intakes": "Start in January, April, July, October"}, "https://www.lsbf.edu.sg/programmes/postgraduate/postgraduate-diploma-in-cybersecurity": {"duration": "6 months (full-time), 6 months (part-time)", "intakes": "Start in February, April, June, August, October, December"}, "https://www.lsbf.edu.sg/programme/master-of-arts-in-international-business": {"duration": "12 months (full-time), 18 months (part-time)", "intakes": "Start in January, May or September", "fees": "SGD $18,203.00"}, "https://www.lsbf.edu.sg/programmes/executive-development/practical-inventory-and-warehouse-management": {"duration": "2 days, 9.30am-5.00pm", "intakes": "Coming Soon! (Q3 2025)", "fees": "SGD $1,360"}, "https://www.lsbf.edu.sg/programmes/postgraduate/master-of-business-administration": {"duration": "12 months – Day Classes (International & Local Students) | Evening/Weekend Classes (Local Students)", "intakes": "September, January, and May", "fees": "SGD $17,440.00"}, "https://www.lsbf.edu.sg/programmes/languages/ielts": {"duration": "2 months (full-time), 11 sessions (part-time)", "intakes": "Start every month", "fees": "SGD $1,090"}, "https://www.lsbf.edu.sg/programmes/professional-qualifications/prep-scaq": {"duration": "36 hours/ module", "intakes": "April, October", "fees": "SGD $900"}, "https://www.lsbf.edu.sg/programmes/postgraduate/master-of-science-engineering-management": {"duration": "12 months (Full-time/Part-time)", "intakes": "February, July or October"}, "https://www.lsbf.edu.sg/programmes/executive-development/preventing-and-detecting-different-types-of-procurement-fraud": {"duration": "2 days, 9.30am-5.00pm", "intakes": "Coming Soon! (Q2 2025)", "fees": "SGD $1,360"}, "https://www.lsbf.edu.sg/programmes/postgraduate/master-of-science-finance-and-investment": {"duration": "12 months (full-time), 18 months (part-time)", "intakes": "Start in January, May, September"}, "https://www.lsbf.edu.sg/programmes/postgraduate/master-of-science-global-health-management": {"duration": "12 months (full-time)", "intakes": "January (Day Classes (International & Local Students) | Evening/Weekend Classes (Local Students))", "fees": "SGD $17,440.00"}, "https://www.lsbf.edu.sg/programmes/postgraduate/postgraduate-diploma-in-hospitality-and-tourism-management": {"duration": "8 months + 6 months IA* (full-time)", "intakes": "Start every two months (January, March, May, July, September, November) / modular"}, "https://www.lsbf.edu.sg/programmes/languages/preparatory-course-in-english-pce": {"duration": "2 Months/Level", "intakes": "Monthly", "fees": "SGD $2,507"}, "https://www.lsbf.edu.sg/programmes/executive-development/trade-finance-management": {"duration": "2 days, 9.30am-5.00pm", "intakes": "April 10-11, 2025", "fees": "SGD $1,360"}, "https://www.lsbf.edu.sg/programmes/languages/weekly-general-english": {"duration": "1 week, 25 hours in total.", "intakes": "According to timetable", "fees": "SGD$545.00"}}};
    // END_AUTO_COURSE_PAGE_DETAILS

    const LOGO_DATA_URL = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAcFBQYFBAcGBgYIBwcICxILCwoKCxYPEA0SGhYbGhkWGRgcICgiHB4mHhgZIzAkJiorLS4tGyIyNTEsNSgsLSz/2wBDAQcICAsJCxULCxUsHRkdLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCz/wAARCASeBJ4DASIAAhEBAxEB/8QAHAABAAIDAQEBAAAAAAAAAAAAAAYHBAUIAwEC/8QAZRAAAQMCAgQGCgsMBgYIBgIDAAECAwQFBhEHEiExE0FRYXHRFBUWIlWBkZKToQgXIzI2QlJUlLHBM1NicnN0gqKjssLSJDQ1Q1bhGDdjZLPwJSZERYPD4vE4RmZ1hNNlpONXJ//EABsBAQACAwEBAAAAAAAAAAAAAAAEBQECAwYH/8QAPREBAAIBAgEHCwMEAwACAgMAAAECAwQRIQUSExQxUaEVIjIzQVJTYXGRsYHR4TRCY/AjJMEG8RZiQ3KC/9oADAMBAAIRAxEAPwDpEACIAACIAAAAAIgAAIgAAAAAiAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA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AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB/9k=";

    const programsFallback = [
      {
        id: "kaplan-ucd-biz",
        provider: "Kaplan",
        name: "Kaplan × UCD 商科本科",
        routes: ["private_university", "dual_degree"],
        major: "business",
        qs: "合作大学约 QS 150±",
        minEdu: "middle",
        ageMin: 16,
        budgetMin: 22000,
        duration: "大专+本科 2.5–3 年（可搭配语言 2–6 个月）",
        appFee: "约 S$535（以 Kaplan 当期为准）",
        pricingNote: "对客文书费 ¥1,500；返佣 10%/6%",
        highlights: "录取友好，QS 区间稳定，适合想快拿学位再冲硕士的学生。",
        intakes: "常见 3/7/11 月开课（以当期日历为准）",
        tuition: "大专+本科总学费约 SGD 55k–65k（2.5–3 年，不含生活费）",
        process: "材料齐 2–4 周出录取；签证/IPA 2–3 周；整体 1–1.5 个月",
        official: "https://www.kaplan.com.sg/",
        multi: true,
      },
      {
        id: "kaplan-rmit-it",
        provider: "Kaplan",
        name: "Kaplan × RMIT IT/数据本科",
        routes: ["private_university", "dual_degree"],
        major: "computing",
        qs: "合作大学约 QS 150–200",
        minEdu: "middle",
        ageMin: 16,
        budgetMin: 23000,
        duration: "大专+本科 2.5–3 年（可搭配语言）",
        appFee: "约 S$535（以 Kaplan 当期为准）",
        pricingNote: "对客文书费 ¥1,500；返佣 10%/6%",
        highlights: "IT/数据方向，易录取，可与商科并行提交。",
        intakes: "常见 3/7/11 月开课（以当期日历为准）",
        tuition: "大专+本科总学费约 SGD 55k–65k（2.5–3 年，不含生活费）",
        process: "材料齐 2–4 周出录取；签证/IPA 2–3 周；整体 1–1.5 个月",
        official: "https://www.kaplan.com.sg/",
        multi: true,
      },
      {
        id: "kaplan-murdoch-psych",
        provider: "Kaplan",
        name: "Kaplan × Murdoch 心理/传媒本科",
        routes: ["private_university"],
        major: "psychology",
        qs: "合作大学约 QS 400±",
        minEdu: "middle",
        ageMin: 16,
        budgetMin: 22000,
        duration: "大专+本科 2.5–3 年",
        appFee: "约 S$535（以 Kaplan 当期为准）",
        pricingNote: "对客文书费 ¥1,500；返佣 10%/6%",
        highlights: "心理/传媒方向，录取友好，适合兴趣导向。",
        intakes: "常见 3/7/11 月开课（以当期日历为准）",
        tuition: "大专+本科总学费约 SGD 55k–65k（2.5–3 年，不含生活费）",
        process: "材料齐 2–4 周出录取；签证/IPA 2–3 周；整体 1–1.5 个月",
        official: "https://www.kaplan.com.sg/",
        multi: true,
      },
      {
        id: "psb-birmingham-biz",
        provider: "PSB",
        name: "PSB × 伯明翰商科本科",
        routes: ["private_university", "dual_degree"],
        major: "business",
        qs: "伯明翰 QS 前 100±（以当年为准）",
        minEdu: "middle",
        ageMin: 16,
        budgetMin: 23000,
        duration: "大专+本科 2.5–3 年",
        appFee: "约 S$488（以 PSB 当期为准）",
        pricingNote: "对客文书费 ¥1,500；返佣 10%/6%",
        highlights: "品牌背书强，适合想要英国名校合作学位的学生。",
        intakes: "常见 2/6/10 月开课（以当期日历为准）",
        tuition: "大专+本科总学费约 SGD 60k–70k（2.5–3 年，不含生活费）",
        process: "材料齐 2–4 周出录取；签证/IPA 2–3 周；整体 1–1.5 个月",
        official: "https://www.psb-academy.edu.sg/",
        multi: true,
      },
      {
        id: "psb-latrobe-it",
        provider: "PSB",
        name: "PSB × La Trobe IT/CS 本科",
        routes: ["private_university"],
        major: "computing",
        qs: "La Trobe QS 300±",
        minEdu: "middle",
        ageMin: 16,
        budgetMin: 23000,
        duration: "大专+本科 2.5–3 年",
        appFee: "约 S$488（以 PSB 当期为准）",
        pricingNote: "对客文书费 ¥1,500；返佣 10%/6%",
        highlights: "IT 方向，录取友好，可与商科并行提交。",
        intakes: "常见 2/6/10 月开课（以当期日历为准）",
        tuition: "大专+本科总学费约 SGD 60k–70k（2.5–3 年，不含生活费）",
        process: "材料齐 2–4 周出录取；签证/IPA 2–3 周；整体 1–1.5 个月",
        official: "https://www.psb-academy.edu.sg/",
        multi: true,
      },
      {
        id: "amity-biz",
        provider: "Amity",
        name: "Amity 商科/管理本科",
        routes: ["private_university"],
        major: "business",
        qs: "合作大学中等层级",
        minEdu: "middle",
        ageMin: 16,
        budgetMin: 18000,
        duration: "本科 2.5–3 年",
        appFee: "约 S$300（以 Amity 当期为准）",
        pricingNote: "对客文书费 ¥1,500；返佣 15%",
        highlights: "保底方案，录取容易，毕业压力较小。",
        intakes: "常见 1/5/9 月开课（以当期日历为准）",
        tuition: "本科总学费约 SGD 45k–55k（2.5–3 年，不含生活费）",
        process: "材料齐 2–3 周出录取；签证/IPA 2–3 周；整体约 1 个月",
        official: "https://www.amitysingapore.sg/",
        multi: true,
      },
      {
        id: "sim-uol-econ",
        provider: "SIM",
        name: "SIM × UOL 经济/金融本科",
        routes: ["private_university"],
        major: "business",
        qs: "合作大学 QS 前 50–100（按专业）",
        minEdu: "high",
        ageMin: 17,
        budgetMin: 26000,
        duration: "本科 3 年",
        appFee: "约 S$96 + 材料费（以 SIM 当期为准）",
        pricingNote: "返佣较低（固定额），学生端收费需抬高至单均 ≈ S$2,000",
        highlights: "品牌与学术要求高，适合自驱力强、目标名校硕士的学生。",
        intakes: "常见 4/7/10 月开课（以当期日历为准）",
        tuition: "本科总学费约 SGD 70k–80k（3 年，不含生活费）",
        process: "审核严格，录取通常 3–5 周；签证/IPA 2–3 周；整体 1.5–2 个月",
        official: "https://www.sim.edu.sg/",
        multi: false,
      },
      {
        id: "sim-rmit-it",
        provider: "SIM",
        name: "SIM × RMIT 计算机本科",
        routes: ["private_university"],
        major: "computing",
        qs: "合作大学 QS 150–200",
        minEdu: "high",
        ageMin: 17,
        budgetMin: 26000,
        duration: "本科 3 年",
        appFee: "约 S$96 + 材料费（以 SIM 当期为准）",
        pricingNote: "返佣较低（固定额），学生端收费需抬高",
        highlights: "计算机方向 + 高难度，适合成绩好且可接受压力。",
        intakes: "常见 4/7/10 月开课（以当期日历为准）",
        tuition: "本科总学费约 SGD 70k–80k（3 年，不含生活费）",
        process: "审核严格，录取通常 3–5 周；签证/IPA 2–3 周；整体 1.5–2 个月",
        official: "https://www.sim.edu.sg/",
        multi: false,
      },
      {
        id: "jcu-biz",
        provider: "JCU",
        name: "JCU 商科/IT/心理 本科/硕士",
        routes: ["private_university"],
        major: "business",
        qs: "JCU 澳大利亚公立（QS 约 400±）",
        minEdu: "high",
        ageMin: 17,
        budgetMin: 23000,
        duration: "本科 2–3 年；硕士 1–1.5 年",
        appFee: "约 S$250（以 JCU 当期为准）",
        pricingNote: "返佣 8%；文书费同私立",
        highlights: "公立背景，品牌稳，适合要澳洲/新加坡就业结合的学生。",
        intakes: "常见 3/7/11 月开课（以当期日历为准）",
        tuition: "本科 2–3 年总学费约 SGD 50k–65k；硕士 1–1.5 年约 SGD 35k–45k",
        process: "材料齐 2–4 周出录取；签证/IPA 2–3 周；整体 1–1.5 个月",
        official: "https://www.jcu.edu.sg/",
        multi: true,
      },
      {
        id: "curtin-biz",
        provider: "Curtin",
        name: "Curtin 商科/工程 本科/硕士（新加坡校区）",
        routes: ["private_university"],
        major: "engineering",
        qs: "科廷 QS 约 200±",
        minEdu: "high",
        ageMin: 17,
        budgetMin: 23000,
        duration: "本科 3 年；硕士 1–1.5 年",
        appFee: "约 S$235（以科廷当期为准）",
        pricingNote: "返佣 8%；文书费同私立",
        highlights: "澳洲公立品牌 + 新加坡学习体验。",
        intakes: "常见 2/7/11 月开课（以当期日历为准）",
        tuition: "本科总学费约 SGD 65k–75k（3 年，不含生活费）",
        process: "材料齐 2–4 周出录取；签证/IPA 2–3 周；整体 1–1.5 个月",
        official: "https://www.curtin.edu.sg/",
        multi: true,
      },
      {
        id: "mdis-olevel",
        provider: "MDIS",
        name: "MDIS O/A Level + 本科路径",
        routes: ["private_university"],
        major: "business",
        qs: "多合作大学，QS 视专业",
        minEdu: "middle",
        ageMin: 15,
        budgetMin: 18000,
        duration: "O/A Level 10–24 个月；后续大专/本科 2–3 年",
        appFee: "约 S$160（以 MDIS 当期为准）",
        pricingNote: "返佣按档位固定金额；文书费同私立",
        highlights: "需要过渡的学生可先读 O/A Level，再升学。",
        intakes: "O/A Level 滚动开班，常见 1/4/7/10 月",
        tuition: "O/A Level 每年约 SGD 15k–20k；后续大专/本科合计约 SGD 45k+",
        process: "预科录取通常 2–3 周；签证/IPA 2–3 周；整体 1–1.5 个月",
        official: "https://www.mdis.edu.sg/",
        multi: true,
      },
      {
        id: "lsbf-acca",
        provider: "LSBF",
        name: "LSBF ACCA / 商科本科",
        routes: ["private_university"],
        major: "finance_acca",
        qs: "以职业资格为主",
        minEdu: "middle",
        ageMin: 16,
        budgetMin: 18000,
        duration: "ACCA 按科目；本科 2–3 年",
        appFee: "约 S$160（以 LSBF 当期为准）",
        pricingNote: "返佣分段 12%/18%/4%；文书费同私立",
        highlights: "会计/ACCA 方向，适合明确职业路径的学生。",
        intakes: "ACCA 与本科滚动开课，常见 1/4/7/10 月",
        tuition: "ACCA 全科约 SGD 18k–25k；本科 2–3 年约 SGD 45k–55k",
        process: "录取友好，2–3 周可出；签证/IPA 2–3 周；整体约 1 个月",
        official: "https://www.lsbf.edu.sg/",
        multi: true,
      },
      {
        id: "aeis",
        provider: "公立",
        name: "新加坡公立学校 · AEIS/S-AEIS",
        routes: ["k12_public"],
        major: "k12_public",
        qs: "公立体系",
        minEdu: "middle",
        ageMin: 7,
        ageMax: 16,
        budgetMin: 12000,
        duration: "备考 2–6 个月；之后按公校学制",
        appFee: "考试费/报名费按官方；服务费 ¥12,000；陪读签证 ¥13,000",
        pricingNote: "无返佣；服务费为主；需强调考试不确定性",
        highlights: "学生证阶段可规划 PR；需准备 Plan B（国际/新二）。",
        intakes: "考试窗口：S-AEIS 2–3 月，AEIS 9–10 月；录取后次年 1/3 月入学",
        tuition: "公校学费约 SGD 6k–10k/年（PR/国际生差异），培训费按课程",
        process: "备考 2–6 个月 → 考试放榜 → 学校分配；签证 2–4 周",
        official: "https://www.moe.gov.sg/admissions/aeis",
        multi: false,
      },
      {
        id: "intl-top",
        provider: "国际学校",
        name: "国际学校顶级梯队（UWC/SAS/TTS）",
        routes: ["k12_international"],
        major: "k12_international",
        qs: "国际顶级",
        minEdu: "middle",
        ageMin: 3,
        ageMax: 18,
        budgetMin: 40000,
        duration: "幼儿园~高中，IB/A-Level",
        appFee: "学校申请费按校方（通常 S$400–800）",
        pricingNote: "Case by case；返佣无；服务费需单报",
        highlights: "高预算高要求，目标世界 Top 大学或本地公立为备选。",
        intakes: "主要 8 月开学，部分 1 月插班；候补位常见",
        tuition: "学费约 SGD 40k–55k/年；报名/注册费另计",
        process: "面试+测评；排位可能 2–8 周；签证/DP 按家庭情况",
        official: "https://www.uwcsea.edu.sg/",
        multi: false,
      },
      {
        id: "intl-mid",
        provider: "国际学校",
        name: "国际学校第二梯队（CIS/AIS/SAIS）",
        routes: ["k12_international"],
        major: "k12_international",
        qs: "国际主流",
        minEdu: "middle",
        ageMin: 3,
        ageMax: 18,
        budgetMin: 30000,
        duration: "幼儿园~高中",
        appFee: "申请费按校方（约 S$400–800）",
        pricingNote: "对客服务费 ≈ S$2,000；返佣 S$800–1,000",
        highlights: "录取与预算相对友好，可作跳板欧美/澳洲。",
        intakes: "主要 8 月开学，1 月/4 月插班位有限",
        tuition: "学费约 SGD 30k–40k/年；报名/注册费另计",
        process: "材料+面试 2–4 周；热门年级需排队；签证/DP 视家庭身份",
        official: "https://www.cis.edu.sg/",
        multi: true,
      },
      {
        id: "intl-entry",
        provider: "国际学校",
        name: "国际学校入门梯队（GIIS/Chatsworth）",
        routes: ["k12_international"],
        major: "k12_international",
        qs: "区域性",
        minEdu: "middle",
        ageMin: 3,
        ageMax: 18,
        budgetMin: 20000,
        duration: "幼儿园~高中",
        appFee: "申请费按校方（约 S$300–600）",
        pricingNote: "少量文书费；返佣 S$530–1,340 按学段",
        highlights: "预算较低，录取友好，性价比路线。",
        intakes: "8 月为主，1 月/4 月插班较多，位置相对充足",
        tuition: "学费约 SGD 20k–28k/年；报名/注册费另计",
        process: "材料+面试 1–3 周；部分年级可快速插班；签证/DP 视家庭身份",
        official: "https://singapore.globalindianschool.org/",
        multi: true,
      },
      {
        id: "kindergarten",
        provider: "幼儿园",
        name: "新加坡私立幼儿园",
        routes: ["kindergarten"],
        major: "kindergarten",
        qs: "",
        minEdu: "middle",
        ageMin: 2,
        ageMax: 6,
        budgetMin: 12000,
        duration: "按学期/学年",
        appFee: "申请费按园所；服务费固定 SGD 2,000",
        pricingNote: "无返佣；固定择校服务费 SGD 2,000",
        highlights: "早期落地，衔接公立/国际路线。",
        intakes: "按学期滚动，常见 1/4/7/10 月插班",
        tuition: "学费约 SGD 12k–20k/年（视园所与托管时长）",
        process: "园所录取通常 1–2 周；陪读/DP 2–4 周；整体约 1 个月",
        official: "https://www.ecda.gov.sg/Parents/Pages/default.aspx",
        multi: true,
      },
      {
        id: "nus-ntu",
        provider: "公立",
        name: "NUS / NTU / SMU 公立本科/硕士直申",
        routes: ["nus_highend"],
        major: "highend_public",
        qs: "顶尖公立",
        minEdu: "high",
        ageMin: 17,
        budgetMin: 25000,
        duration: "本科 3–4 年；硕士 1–2 年",
        appFee: "按院校官方（通常 S$20–50）",
        pricingNote: "本科/授课硕士 ¥15,000（失败退 ¥10,000）；研博 ¥30,000（失败退 ¥15,000）",
        highlights: "竞争激烈，不保证录取；内部参考：高考一本线 +50 分。",
        intakes: "主开学 8 月，部分硕士/博士 1 月次开学",
        tuition: "本科学费约 SGD 25k–35k/年；硕士 25k–45k/年（依专业/GST）",
        process: "申请窗口约 10–12 月/次年初；录取放榜需 2–4 个月；学生准证 2–4 周",
        official: "https://www.nus.edu.sg/",
        multi: true,
      },
    ];

    const embeddedCatalog = {"last_updated": "2025-12-12", "notes": "Structured school/program catalog with numeric fields for age/education/tuition. Sources: official sites cached under 99_System_and_Tools/cache/* and hand snapshots for NUS/SMU.", "items": [{"id": "kaplan-ucd-biz", "name": "Kaplan × UCD 商科本科", "provider": "Kaplan", "level": "private_university", "routes": ["private_university", "dual_degree"], "majors": ["business"], "qs_band": "QS ~150± (partner)", "intake_months": [3, 7, 11], "duration_text": "大专+本科 2.5–3 年", "tuition_sgd_min": 55000, "tuition_sgd_max": 65000, "budget_sgd_min": 22000, "application_fee_text": "约 S$535", "process_text": "录取 2–4 周；IPA 2–3 周；整体 1–1.5 个月", "age_min": 16, "age_max": null, "min_edu_rank": 1, "min_edu_label": "初中及以上", "gpa_min": null, "english_req": null, "sources": {"official": "https://www.kaplan.com.sg/", "snapshot": "cache/www.kaplan.com.sg/"}}, {"id": "kaplan-rmit-it", "name": "Kaplan × RMIT IT/数据本科", "provider": "Kaplan", "level": "private_university", "routes": ["private_university", "dual_degree"], "majors": ["computing"], "qs_band": "QS ~150–200 (partner)", "intake_months": [3, 7, 11], "duration_text": "大专+本科 2.5–3 年", "tuition_sgd_min": 55000, "tuition_sgd_max": 65000, "budget_sgd_min": 23000, "application_fee_text": "约 S$535", "process_text": "录取 2–4 周；IPA 2–3 周；整体 1–1.5 个月", "age_min": 16, "age_max": null, "min_edu_rank": 1, "min_edu_label": "初中及以上", "gpa_min": null, "english_req": null, "sources": {"official": "https://www.kaplan.com.sg/", "snapshot": "cache/www.kaplan.com.sg/"}}, {"id": "kaplan-murdoch-psych", "name": "Kaplan × Murdoch 心理/传媒本科", "provider": "Kaplan", "level": "private_university", "routes": ["private_university"], "majors": ["psychology", "design_arts"], "qs_band": "QS ~400± (partner)", "intake_months": [3, 7, 11], "duration_text": "大专+本科 2.5–3 年", "tuition_sgd_min": 55000, "tuition_sgd_max": 65000, "budget_sgd_min": 22000, "application_fee_text": "约 S$535", "process_text": "录取 2–4 周；IPA 2–3 周；整体 1–1.5 个月", "age_min": 16, "age_max": null, "min_edu_rank": 1, "min_edu_label": "初中及以上", "gpa_min": null, "english_req": null, "sources": {"official": "https://www.kaplan.com.sg/", "snapshot": "cache/www.kaplan.com.sg/"}}, {"id": "psb-birmingham-biz", "name": "PSB × 伯明翰商科本科", "provider": "PSB", "level": "private_university", "routes": ["private_university", "dual_degree"], "majors": ["business"], "qs_band": "QS 前 100± (partner)", "intake_months": [2, 6, 10], "duration_text": "大专+本科 2.5–3 年", "tuition_sgd_min": 60000, "tuition_sgd_max": 70000, "budget_sgd_min": 23000, "application_fee_text": "约 S$488", "process_text": "录取 2–4 周；IPA 2–3 周；整体 1–1.5 个月", "age_min": 16, "age_max": null, "min_edu_rank": 1, "min_edu_label": "初中及以上", "gpa_min": null, "english_req": null, "sources": {"official": "https://www.psb-academy.edu.sg/", "snapshot": "cache/www.psb-academy.edu.sg/"}}, {"id": "psb-latrobe-it", "name": "PSB × La Trobe IT/CS 本科", "provider": "PSB", "level": "private_university", "routes": ["private_university"], "majors": ["computing"], "qs_band": "QS ~300± (partner)", "intake_months": [2, 6, 10], "duration_text": "大专+本科 2.5–3 年", "tuition_sgd_min": 60000, "tuition_sgd_max": 70000, "budget_sgd_min": 23000, "application_fee_text": "约 S$488", "process_text": "录取 2–4 周；IPA 2–3 周；整体 1–1.5 个月", "age_min": 16, "age_max": null, "min_edu_rank": 1, "min_edu_label": "初中及以上", "gpa_min": null, "english_req": null, "sources": {"official": "https://www.psb-academy.edu.sg/", "snapshot": "cache/www.psb-academy.edu.sg/"}}, {"id": "amity-biz", "name": "Amity 商科/管理本科", "provider": "Amity", "level": "private_university", "routes": ["private_university"], "majors": ["business"], "qs_band": "合作大学中等层级", "intake_months": [1, 5, 9], "duration_text": "本科 2.5–3 年", "tuition_sgd_min": 45000, "tuition_sgd_max": 55000, "budget_sgd_min": 18000, "application_fee_text": "约 S$300", "process_text": "录取 2–3 周；IPA 2–3 周；整体约 1 个月", "age_min": 16, "age_max": null, "min_edu_rank": 1, "min_edu_label": "初中及以上", "gpa_min": null, "english_req": null, "sources": {"official": "https://www.amitysingapore.sg/", "snapshot": "cache/www.amitysingapore.sg/"}}, {"id": "sim-uol-econ", "name": "SIM × UOL 经济/金融本科", "provider": "SIM", "level": "private_university", "routes": ["private_university"], "majors": ["business"], "qs_band": "QS 前 50–100 (partner)", "intake_months": [4, 7, 10], "duration_text": "本科 3 年", "tuition_sgd_min": 70000, "tuition_sgd_max": 80000, "budget_sgd_min": 26000, "application_fee_text": "约 S$96 + 材料费", "process_text": "录取 3–5 周；IPA 2–3 周；整体 1.5–2 个月", "age_min": 17, "age_max": null, "min_edu_rank": 2, "min_edu_label": "高中及以上", "gpa_min": null, "english_req": null, "sources": {"official": "https://www.sim.edu.sg/", "snapshot": "cache/www.sim.edu.sg/"}}, {"id": "sim-rmit-it", "name": "SIM × RMIT 计算机本科", "provider": "SIM", "level": "private_university", "routes": ["private_university"], "majors": ["computing"], "qs_band": "QS 150–200 (partner)", "intake_months": [4, 7, 10], "duration_text": "本科 3 年", "tuition_sgd_min": 70000, "tuition_sgd_max": 80000, "budget_sgd_min": 26000, "application_fee_text": "约 S$96 + 材料费", "process_text": "录取 3–5 周；IPA 2–3 周；整体 1.5–2 个月", "age_min": 17, "age_max": null, "min_edu_rank": 2, "min_edu_label": "高中及以上", "gpa_min": null, "english_req": null, "sources": {"official": "https://www.sim.edu.sg/", "snapshot": "cache/www.sim.edu.sg/"}}, {"id": "jcu-biz", "name": "JCU 商科/IT/心理 本科/硕士", "provider": "JCU", "level": "private_university", "routes": ["private_university"], "majors": ["business", "computing", "psychology"], "qs_band": "QS ~400± (澳洲公立)", "intake_months": [3, 7, 11], "duration_text": "本科 2–3 年；硕士 1–1.5 年", "tuition_sgd_min": 35000, "tuition_sgd_max": 65000, "budget_sgd_min": 23000, "application_fee_text": "约 S$250", "process_text": "录取 2–4 周；IPA 2–3 周；整体 1–1.5 个月", "age_min": 17, "age_max": null, "min_edu_rank": 2, "min_edu_label": "高中及以上", "gpa_min": null, "english_req": null, "sources": {"official": "https://www.jcu.edu.sg/", "snapshot": "cache/www.jcu.edu.sg/ (403 授权可能需手动)"}}, {"id": "curtin-biz", "name": "Curtin 商科/工程 本科/硕士（新加坡校区）", "provider": "Curtin", "level": "private_university", "routes": ["private_university"], "majors": ["business", "engineering"], "qs_band": "QS ~200±", "intake_months": [2, 7, 11], "duration_text": "本科 3 年；硕士 1–1.5 年", "tuition_sgd_min": 65000, "tuition_sgd_max": 75000, "budget_sgd_min": 23000, "application_fee_text": "约 S$235", "process_text": "录取 2–4 周；IPA 2–3 周；整体 1–1.5 个月", "age_min": 17, "age_max": null, "min_edu_rank": 2, "min_edu_label": "高中及以上", "gpa_min": null, "english_req": null, "sources": {"official": "https://www.curtin.edu.sg/", "snapshot": "cache/www.curtin.edu.sg/"}}, {"id": "mdis-olevel", "name": "MDIS O/A Level + 本科路径", "provider": "MDIS", "level": "private_university", "routes": ["private_university"], "majors": ["business"], "qs_band": "多合作大学，QS 视专业", "intake_months": [1, 4, 7, 10], "duration_text": "O/A Level 10–24 个月；后续大专/本科 2–3 年", "tuition_sgd_min": 15000, "tuition_sgd_max": 45000, "budget_sgd_min": 18000, "application_fee_text": "约 S$160", "process_text": "预科录取 2–3 周；IPA 2–3 周；整体 1–1.5 个月", "age_min": 15, "age_max": null, "min_edu_rank": 1, "min_edu_label": "初中及以上", "gpa_min": null, "english_req": null, "sources": {"official": "https://www.mdis.edu.sg/", "snapshot": "cache/www.mdis.edu.sg/"}}, {"id": "lsbf-acca", "name": "LSBF ACCA / 商科本科", "provider": "LSBF", "level": "private_university", "routes": ["private_university"], "majors": ["finance_acca", "business"], "qs_band": "职业资格导向", "intake_months": [1, 4, 7, 10], "duration_text": "ACCA 按科；本科 2–3 年", "tuition_sgd_min": 18000, "tuition_sgd_max": 55000, "budget_sgd_min": 18000, "application_fee_text": "约 S$160", "process_text": "录取 2–3 周；IPA 2–3 周；整体约 1 个月", "age_min": 16, "age_max": null, "min_edu_rank": 1, "min_edu_label": "初中及以上", "gpa_min": null, "english_req": null, "sources": {"official": "https://www.lsbf.edu.sg/", "snapshot": "cache/www.lsbf.edu.sg/"}}, {"id": "aeis", "name": "新加坡公立学校 · AEIS/S-AEIS", "provider": "MOE 公立", "level": "k12_public", "routes": ["k12_public"], "majors": ["k12_public"], "qs_band": "公立体系", "intake_months": [2, 3, 9, 10], "duration_text": "备考 2–6 个月；之后按公校学制", "tuition_sgd_min": 6000, "tuition_sgd_max": 10000, "budget_sgd_min": 12000, "application_fee_text": "考试/报名费按官方；服务费 ¥12,000；陪读 ¥13,000", "process_text": "备考→考试→分配学校；学生签证 2–4 周", "age_min": 7, "age_max": 16, "min_edu_rank": 1, "min_edu_label": "初中及以下可报考（按年级）", "gpa_min": null, "english_req": null, "sources": {"official": "https://www.moe.gov.sg/admissions/aeis", "snapshot": "cache/www.moe.gov.sg/"}}, {"id": "intl-top", "name": "国际学校顶级梯队（UWC/SAS/TTS）", "provider": "国际学校", "level": "k12_international", "routes": ["k12_international"], "majors": ["k12_international"], "qs_band": "国际顶级", "intake_months": [1, 8], "duration_text": "幼儿园~高中，IB/A-Level", "tuition_sgd_min": 40000, "tuition_sgd_max": 55000, "budget_sgd_min": 40000, "application_fee_text": "申请费常见 S$400–800", "process_text": "材料+面试；排位 2–8 周；签证/DP 视家庭身份", "age_min": 3, "age_max": 18, "min_edu_rank": 1, "min_edu_label": "按年级测试/面试", "gpa_min": null, "english_req": null, "sources": {"official": "https://www.uwcsea.edu.sg/", "snapshot": "cache/www.uwcsea.edu.sg/"}}, {"id": "intl-mid", "name": "国际学校第二梯队（CIS/AIS/SAIS）", "provider": "国际学校", "level": "k12_international", "routes": ["k12_international"], "majors": ["k12_international"], "qs_band": "国际主流", "intake_months": [1, 4, 8], "duration_text": "幼儿园~高中", "tuition_sgd_min": 30000, "tuition_sgd_max": 40000, "budget_sgd_min": 30000, "application_fee_text": "申请费常见 S$400–800", "process_text": "材料+面试 2–4 周；热门年级排队；签证/DP 视家庭", "age_min": 3, "age_max": 18, "min_edu_rank": 1, "min_edu_label": "按年级测试/面试", "gpa_min": null, "english_req": null, "sources": {"official": "https://www.cis.edu.sg/", "snapshot": "cache/www.cis.edu.sg/"}}, {"id": "maplebear", "name": "MapleBear 幼儿园/早教", "provider": "MapleBear", "level": "kindergarten", "routes": ["kindergarten"], "majors": ["kindergarten"], "qs_band": null, "intake_months": [], "duration_text": "按学期/学年", "tuition_sgd_min": null, "tuition_sgd_max": null, "budget_sgd_min": null, "application_fee_text": "待补充", "process_text": "材料审核 1–2 周；陪读/DP 2–4 周（如需）", "age_min": 2, "age_max": 6, "min_edu_rank": 0, "min_edu_label": "无学历要求", "gpa_min": null, "english_req": null, "sources": {"official": "https://www.maplebear.sg/", "snapshot": "cache/www.maplebear.sg/"}}, {"id": "etonhouse", "name": "EtonHouse 国际学校/幼儿园", "provider": "EtonHouse", "level": "kindergarten", "routes": ["kindergarten", "k12_international"], "majors": ["kindergarten"], "qs_band": null, "intake_months": [], "duration_text": "按年级/学期", "tuition_sgd_min": null, "tuition_sgd_max": null, "budget_sgd_min": null, "application_fee_text": "待补充", "process_text": "材料+面试；陪读/DP 2–4 周（如需）", "age_min": 2, "age_max": 18, "min_edu_rank": 0, "min_edu_label": "无学历要求", "gpa_min": null, "english_req": null, "sources": {"official": "https://www.etonhouse.edu.sg/", "snapshot": "cache/www.etonhouse.edu.sg/"}}, {"id": "mindchamps", "name": "MindChamps 幼儿园/早教", "provider": "MindChamps", "level": "kindergarten", "routes": ["kindergarten"], "majors": ["kindergarten"], "qs_band": null, "intake_months": [], "duration_text": "按学期/学年", "tuition_sgd_min": null, "tuition_sgd_max": null, "budget_sgd_min": null, "application_fee_text": "待补充", "process_text": "材料审核 1–2 周；陪读/DP 2–4 周（如需）", "age_min": 2, "age_max": 6, "min_edu_rank": 0, "min_edu_label": "无学历要求", "gpa_min": null, "english_req": null, "sources": {"official": "https://www.mindchamps.org/", "snapshot": "cache/www.mindchamps.org/"}}, {"id": "pats-schoolhouse", "name": "Pat's Schoolhouse 幼儿园", "provider": "Pat's Schoolhouse", "level": "kindergarten", "routes": ["kindergarten"], "majors": ["kindergarten"], "qs_band": null, "intake_months": [], "duration_text": "按学期/学年", "tuition_sgd_min": null, "tuition_sgd_max": null, "budget_sgd_min": null, "application_fee_text": "待补充", "process_text": "材料审核 1–2 周；陪读/DP 2–4 周（如需）", "age_min": 2, "age_max": 6, "min_edu_rank": 0, "min_edu_label": "无学历要求", "gpa_min": null, "english_req": null, "sources": {"official": "https://patschoolhouse.com/", "snapshot": "cache/patschoolhouse.com/"}}, {"id": "odyssey", "name": "Odyssey The Global Preschool", "provider": "Odyssey", "level": "kindergarten", "routes": ["kindergarten"], "majors": ["kindergarten"], "qs_band": null, "intake_months": [], "duration_text": "按学期/学年", "tuition_sgd_min": null, "tuition_sgd_max": null, "budget_sgd_min": null, "application_fee_text": "待补充", "process_text": "材料审核 1–2 周；陪读/DP 2–4 周（如需）", "age_min": 2, "age_max": 6, "min_edu_rank": 0, "min_edu_label": "无学历要求", "gpa_min": null, "english_req": null, "sources": {"official": "https://theodyssey.sg/", "snapshot": "cache/theodyssey.sg/"}}, {"id": "kinderland", "name": "Kinderland 幼儿园/学前", "provider": "Kinderland", "level": "kindergarten", "routes": ["kindergarten"], "majors": ["kindergarten"], "qs_band": null, "intake_months": [], "duration_text": "按学期/学年", "tuition_sgd_min": null, "tuition_sgd_max": null, "budget_sgd_min": null, "application_fee_text": "待补充", "process_text": "材料审核 1–2 周；陪读/DP 2–4 周（如需）", "age_min": 2, "age_max": 6, "min_edu_rank": 0, "min_edu_label": "无学历要求", "gpa_min": null, "english_req": null, "sources": {"official": "https://www.kinderland.com.sg/", "snapshot": "cache/www.kinderland.com.sg/"}}, {"id": "nus-ntu", "name": "NUS / NTU / SMU 公立本科/硕士直申", "provider": "公立", "level": "public_university", "routes": ["nus_highend"], "majors": ["highend_public"], "qs_band": "顶尖公立", "intake_months": [1, 8], "duration_text": "本科 3–4 年；硕士 1–2 年", "tuition_sgd_min": 25000, "tuition_sgd_max": 45000, "budget_sgd_min": 25000, "application_fee_text": "官方常见 S$20–50", "process_text": "申请窗口 10–12 月/次年初；放榜 2–4 个月；学生准证 2–4 周", "age_min": 17, "age_max": null, "min_edu_rank": 2, "min_edu_label": "高中及以上", "gpa_min": null, "english_req": null, "sources": {"official": "https://www.nus.edu.sg/", "snapshot": "cache/www.nus.edu.sg/ (手动快照)"}}]};

    // Kaplan 全课程（来源：Kaplan programme-directory PDF，2025-06；用于“课程库”展示与匹配参考）
    const kaplanProgrammePdfJun2025 = [["ASTON UNIVERSITY","MASTER OF SCIENCE DIGITAL MARKETING AND STRATEGY"],["ASTON UNIVERSITY","MASTER OF SCIENCE ENGINEERING BUSINESS MANAGEMENT"],["ASTON UNIVERSITY","MASTER OF SCIENCE STRATEGIC BUSINESS ANALYTICS"],["ASTON UNIVERSITY","MASTER OF SCIENCE STRATEGIC FINANCIAL MANAGEMENT"],["ASTON UNIVERSITY","MASTER OF SCIENCE STRATEGIC SUPPLY CHAIN MANAGEMENT"],["ASTON UNIVERSITY","DOCTOR OF BUSINESS ADMINISTRATION (PART-TIME ONLY)"],["BIRMINGHAM CITY UNIVERSITY","BACHELOR OF ARTS (HONOURS) BUSINESS ADMINISTRATION (TOP-UP) (PART-TIME ONLY)"],["BIRMINGHAM CITY UNIVERSITY","BACHELOR OF ARTS (HONOURS) IN INTERNATIONAL BUSINESS (TOP-UP) (PART-TIME ONLY)"],["BIRMINGHAM CITY UNIVERSITY","BACHELOR OF ARTS (HONOURS) INTERNATIONAL MARKETING (TOP-UP) (PART-TIME ONLY)"],["BIRMINGHAM CITY UNIVERSITY","BACHELOR OF LAWS (HONOURS) (TOP-UP) (PART-TIME ONLY)"],["BIRMINGHAM CITY UNIVERSITY","MASTER OF LAWS IN INTERNATIONAL BUSINESS LAW (PART-TIME ONLY)"],["BIRMINGHAM CITY UNIVERSITY","BACHELOR OF ARTS WITH HONOURS DIGITAL MARKETING (TOP-UP) (PART-TIME ONLY)"],["BIRMINGHAM CITY UNIVERSITY","BACHELOR OF SCIENCE WITH HONOURS COMPUTER SCIENCE (GLOBAL) (TOP-UP) (PART-TIME ONLY)"],["BIRMINGHAM CITY UNIVERSITY","BACHELOR OF SCIENCE WITH HONOURS COMPUTER SCIENCE WITH ARTIFICIAL INTELLIGENCE (GLOBAL) (TOP-UP) (PART-TIME ONLY)"],["BIRMINGHAM CITY UNIVERSITY","BACHELOR OF SCIENCE WITH HONOURS CYBER SECURITY (GLOBAL) (TOP-UP) (PART-TIME ONLY)"],["BIRMINGHAM CITY UNIVERSITY","BACHELOR OF SCIENCE WITH HONOURS DIGITAL FORENSICS (GLOBAL) (TOP-UP) (PART-TIME ONLY)"],["BIRMINGHAM CITY UNIVERSITY","BACHELOR OF SCIENCE WITH HONOURS CONSTRUCTION MANAGEMENT (TOP-UP) (PART-TIME ONLY)"],["UNIVERSITY OF ESSEX","BACHELOR OF SCIENCE (HONOURS) IN ACCOUNTING AND FINANCE (TOP-UP) (TEACH-OUT BY NOV 2025)"],["UNIVERSITY OF ESSEX","BACHELOR OF SCIENCE (HONOURS) IN BANKING AND FINANCE (TOP-UP) (TEACH-OUT BY NOV 2025)"],["UNIVERSITY OF ESSEX","BACHELOR OF SCIENCE (HONOURS) IN PSYCHOLOGY (TOP-UP) (TEACH-OUT BY NOV 2025)"],["UNIVERSITY OF ESSEX","BACHELOR OF SCIENCE (HONOURS) IN SPORTS AND EXERCISE SCIENCE (TOP-UP) (TEACH-OUT BY NOV 2025)"],["UNIVERSITY OF ESSEX","BACHELOR OF SCIENCE (HONOURS) IN COMPUTER SCIENCE (TOP-UP) (TEACH-OUT BY NOV 2025)"],["MONASH UNIVERSITY","BACHELOR OF EDUCATION IN EARLY CHILDHOOD (TOP-UP) (PART-TIME ONLY)"],["MONASH UNIVERSITY","MASTER OF COUNSELLING (PART-TIME ONLY)"],["MONASH UNIVERSITY","GRADUATE CERTIFICATE OF COUNSELLING (PART-TIME ONLY)"],["MONASH UNIVERSITY","GRADUATE CERTIFICATE OF COUNSELLING (E-LEARNING) (PART-TIME ONLY)"],["MURDOCH UNIVERSITY","BACHELOR OF ARTS IN PSYCHOLOGY (TEACH-OUT BY MAY 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF ARTS IN PSYCHOLOGY AND MANAGEMENT (TEACH-OUT BY MAY 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF ARTS IN PSYCHOLOGY AND MARKETING (TEACH-OUT BY MAY 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF ARTS IN PSYCHOLOGY AND HUMAN RESOURCES MANAGEMENT (TEACH-OUT BY MAY 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF ARTS IN PSYCHOLOGY AND WEB COMMUNICATION (TEACH-OUT BY MAY 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF ARTS IN PSYCHOLOGY AND CRIMINOLOGY (TEACH-OUT BY MAY 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF ARTS IN PSYCHOLOGY AND GLOBAL MEDIA AND COMMUNICATION (TEACH-OUT BY MAY 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN ACCOUNTING"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN ACCOUNTING AND BANKING"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN ACCOUNTING AND FINANCE"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN ACCOUNTING AND MANAGEMENT"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN ACCOUNTING AND MARKETING"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN ACCOUNTING AND BUSINESS LAW"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN ACCOUNTING AND CRIMINOLOGY"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN ACCOUNTING AND HUMAN RESOURCES MANAGEMENT"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN ACCOUNTING AND INTERNATIONAL BUSINESS"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN BANKING"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN BANKING AND MANAGEMENT"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN BANKING AND MARKETING"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN BANKING AND BUSINESS LAW"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN BANKING AND CRIMINOLOGY"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN BANKING AND INTERNATIONAL BUSINESS"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN BANKING AND HUMAN RESOURCES MANAGEMENT"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN BANKING AND BUSINESS INFORMATION SYSTEMS (TEACH-OUT BY MAY 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN BANKING AND CYBER SECURITY AND FORENSICS (TEACH-OUT BY MAY 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN FINANCE"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN FINANCE AND MANAGEMENT"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN FINANCE AND MARKETING"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN FINANCE AND BUSINESS LAW"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN FINANCE AND BUSINESS INFORMATION SYSTEMS (TEACH-OUT BY MAY 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN FINANCE AND CYBER SECURITY AND FORENSICS (TEACH-OUT BY MAY 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN FINANCE AND CRIMINOLOGY"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN BUSINESS LAW"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN BUSINESS LAW AND CRIMINOLOGY"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN BUSINESS LAW AND POLITICS AND INTERNATIONAL STUDIES (TEACH-OUT BY MAY 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN BUSINESS LAW AND TOURISM AND EVENTS"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN INTERNATIONAL BUSINESS"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN INTERNATIONAL BUSINESS AND BUSINESS LAW"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN INTERNATIONAL BUSINESS AND CYBER SECURITY AND FORENSICS"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN INTERNATIONAL BUSINESS AND FINANCE"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN INTERNATIONAL BUSINESS AND HOSPITALITY AND TOURISM MANAGEMENT"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN INTERNATIONAL BUSINESS AND HUMAN RESOURCES MANAGEMENT"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN INTERNATIONAL BUSINESS AND MANAGEMENT"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN INTERNATIONAL BUSINESS AND MARKETING"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN INTERNATIONAL BUSINESS AND POLITICS AND INTERNATIONAL STUDIES (TEACH-OUT BY MAY 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN INTERNATIONAL BUSINESS AND TOURISM AND EVENTS"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN INTERNATIONAL BUSINESS AND WEB COMMUNICATION"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN HUMAN RESOURCES MANAGEMENT"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN HUMAN RESOURCES MANAGEMENT AND BUSINESS LAW"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN HUMAN RESOURCES MANAGEMENT AND CRIMINOLOGY"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN HUMAN RESOURCES MANAGEMENT AND FINANCE"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN HUMAN RESOURCES MANAGEMENT AND MANAGEMENT"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN HUMAN RESOURCES MANAGEMENT AND MARKETING"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN HUMAN RESOURCES MANAGEMENT AND STRATEGIC COMMUNICATION"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN HUMAN RESOURCES MANAGEMENT AND TOURISM AND EVENTS"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN HOSPITALITY AND TOURISM MANAGEMENT"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN HOSPITALITY AND TOURISM MANAGEMENT AND MANAGEMENT"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN HOSPITALITY AND TOURISM MANAGEMENT AND MARKETING"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN HOSPITALITY AND TOURISM MANAGEMENT AND HUMAN RESOURCES MANAGEMENT"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN HOSPITALITY AND TOURISM MANAGEMENT AND BUSINESS LAW"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN HOSPITALITY AND TOURISM MANAGEMENT AND WEB COMMUNICATION"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN HOSPITALITY AND TOURISM MANAGEMENT AND TOURISM AND EVENTS"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN HOSPITALITY AND TOURISM MANAGEMENT AND STRATEGIC COMMUNICATION"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN HOSPITALITY AND TOURISM MANAGEMENT AND DIGITAL COMMUNICATION"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN MANAGEMENT"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN MANAGEMENT AND BUSINESS LAW"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN MANAGEMENT AND CRIMINOLOGY"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN MANAGEMENT AND GLOBAL MEDIA AND COMMUNICATION"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN MANAGEMENT AND INTERNATIONAL BUSINESS"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN MANAGEMENT AND MARKETING"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN MANAGEMENT AND STRATEGIC COMMUNICATION"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN MANAGEMENT AND TOURISM AND EVENTS"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN MANAGEMENT AND POLITICS AND INTERNATIONAL STUDIES (TEACH-OUT BY MAY 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN MARKETING"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN MARKETING AND BUSINESS LAW"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN MARKETING AND GLOBAL MEDIA AND COMMUNICATION"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN MARKETING AND INTERNATIONAL BUSINESS"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN MARKETING AND JOURNALISM (TEACH-OUT BY JAN 2026)"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN MARKETING AND STRATEGIC COMMUNICATION"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN MARKETING AND TOURISM AND EVENTS"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN MARKETING AND WEB COMMUNICATION"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN MANAGEMENT AND COMMUNICATION AND MEDIA STUDIES"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN MARKETING AND COMMUNICATION AND MEDIA STUDIES"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN MARKETING AND DIGITAL COMMUNICATION"],["MURDOCH UNIVERSITY","BACHELOR OF COMMUNICATION IN COMMUNICATION AND MEDIA STUDIES"],["MURDOCH UNIVERSITY","BACHELOR OF COMMUNICATION IN COMMUNICATION AND MEDIA STUDIES AND MARKETING"],["MURDOCH UNIVERSITY","BACHELOR OF COMMUNICATION IN COMMUNICATION AND MEDIA STUDIES AND STRATEGIC COMMUNICATION"],["MURDOCH UNIVERSITY","BACHELOR OF COMMUNICATION IN COMMUNICATION AND MEDIA STUDIES AND TOURISM AND EVENTS"],["MURDOCH UNIVERSITY","BACHELOR OF COMMUNICATION IN COMMUNICATION AND MEDIA STUDIES AND DIGITAL COMMUNICATION"],["MURDOCH UNIVERSITY","BACHELOR OF COMMUNICATION IN DIGITAL COMMUNICATION"],["MURDOCH UNIVERSITY","BACHELOR OF COMMUNICATION IN DIGITAL COMMUNICATION AND MARKETING"],["MURDOCH UNIVERSITY","BACHELOR OF COMMUNICATION IN DIGITAL COMMUNICATION AND MANAGEMENT"],["MURDOCH UNIVERSITY","BACHELOR OF COMMUNICATION IN DIGITAL COMMUNICATION AND STRATEGIC COMMUNICATION"],["MURDOCH UNIVERSITY","BACHELOR OF COMMUNICATION IN DIGITAL COMMUNICATION AND TOURISM AND EVENTS"],["MURDOCH UNIVERSITY","BACHELOR OF COMMUNICATION IN GLOBAL MEDIA AND COMMUNICATION"],["MURDOCH UNIVERSITY","BACHELOR OF COMMUNICATION IN GLOBAL MEDIA AND COMMUNICATION AND JOURNALISM (TEACH-OUT BY JAN 2026)"],["MURDOCH UNIVERSITY","BACHELOR OF COMMUNICATION IN GLOBAL MEDIA AND COMMUNICATION AND MARKETING"],["MURDOCH UNIVERSITY","BACHELOR OF COMMUNICATION IN GLOBAL MEDIA AND COMMUNICATION AND GLOBAL POLITICS AND POLICY (TEACH-OUT BY MAY 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF COMMUNICATION IN GLOBAL MEDIA AND COMMUNICATION AND POLITICS AND INTERNATIONAL STUDIES (TEACH-OUT BY MAY 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF COMMUNICATION IN GLOBAL MEDIA AND COMMUNICATION AND STRATEGIC COMMUNICATION"],["MURDOCH UNIVERSITY","BACHELOR OF COMMUNICATION IN GLOBAL MEDIA AND COMMUNICATION AND TOURISM AND EVENTS"],["MURDOCH UNIVERSITY","BACHELOR OF COMMUNICATION IN GLOBAL MEDIA AND COMMUNICATION AND WEB COMMUNICATION"],["MURDOCH UNIVERSITY","BACHELOR OF COMMUNICATION IN JOURNALISM (TEACH-OUT BY JAN 2026)"],["MURDOCH UNIVERSITY","BACHELOR OF COMMUNICATION IN JOURNALISM AND CRIMINOLOGY (TEACH-OUT BY JAN 2026)"],["MURDOCH UNIVERSITY","BACHELOR OF COMMUNICATION IN JOURNALISM AND GLOBAL MEDIA AND COMMUNICATION (TEACH-OUT BY JAN 2026)"],["MURDOCH UNIVERSITY","BACHELOR OF COMMUNICATION IN JOURNALISM AND MANAGEMENT (TEACH-OUT BY JAN 2026)"],["MURDOCH UNIVERSITY","BACHELOR OF COMMUNICATION IN JOURNALISM AND STRATEGIC COMMUNICATION (TEACH-OUT BY JAN 2026)"],["MURDOCH UNIVERSITY","BACHELOR OF COMMUNICATION IN JOURNALISM AND MARKETING (TEACH-OUT BY JAN 2026)"],["MURDOCH UNIVERSITY","BACHELOR OF COMMUNICATION IN JOURNALISM AND WEB COMMUNICATION (TEACH-OUT BY JAN 2026)"],["MURDOCH UNIVERSITY","BACHELOR OF COMMUNICATION IN STRATEGIC COMMUNICATION"],["MURDOCH UNIVERSITY","BACHELOR OF COMMUNICATION IN STRATEGIC COMMUNICATION AND GLOBAL POLITICS AND POLICY (TEACH-OUT BY MAY 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF COMMUNICATION IN STRATEGIC COMMUNICATION AND INTERNATIONAL BUSINESS (TEACH-OUT BY JAN 2026)"],["MURDOCH UNIVERSITY","BACHELOR OF COMMUNICATION IN STRATEGIC COMMUNICATION AND JOURNALISM (TEACH-OUT BY JAN 2026)"],["MURDOCH UNIVERSITY","BACHELOR OF COMMUNICATION IN STRATEGIC COMMUNICATION AND MANAGEMENT"],["MURDOCH UNIVERSITY","BACHELOR OF COMMUNICATION IN STRATEGIC COMMUNICATION AND MARKETING"],["MURDOCH UNIVERSITY","BACHELOR OF COMMUNICATION IN STRATEGIC COMMUNICATION AND TOURISM AND EVENTS"],["MURDOCH UNIVERSITY","BACHELOR OF COMMUNICATION IN WEB COMMUNICATION"],["MURDOCH UNIVERSITY","BACHELOR OF COMMUNICATION IN WEB COMMUNICATION AND GLOBAL MEDIA AND COMMUNICATION"],["MURDOCH UNIVERSITY","BACHELOR OF COMMUNICATION IN WEB COMMUNICATION AND MANAGEMENT"],["MURDOCH UNIVERSITY","BACHELOR OF COMMUNICATION IN WEB COMMUNICATION AND MARKETING"],["MURDOCH UNIVERSITY","BACHELOR OF COMMUNICATION IN WEB COMMUNICATION AND STRATEGIC COMMUNICATION"],["MURDOCH UNIVERSITY","BACHELOR OF COMMUNICATION IN WEB COMMUNICATION AND TOURISM AND EVENTS"],["MURDOCH UNIVERSITY","BACHELOR OF CRIMINOLOGY IN CRIMINAL BEHAVIOUR"],["MURDOCH UNIVERSITY","BACHELOR OF DATA ANALYTICS IN BUSINESS INTELLIGENCE"],["MURDOCH UNIVERSITY","BACHELOR OF DATA ANALYTICS IN BUSINESS INTELLIGENCE AND BUSINESS INFORMATION SYSTEMS"],["MURDOCH UNIVERSITY","BACHELOR OF DATA ANALYTICS IN BUSINESS INTELLIGENCE AND COMPUTER SCIENCE"],["MURDOCH UNIVERSITY","BACHELOR OF INFORMATION TECHNOLOGY IN ARTIFICIAL INTELLIGENCE AND AUTONOMOUS SYSTEMS"],["MURDOCH UNIVERSITY","BACHELOR OF INFORMATION TECHNOLOGY IN ARTIFICIAL INTELLIGENCE AND AUTONOMOUS SYSTEMS AND BUSINESS INFORMATION SYSTEMS"],["MURDOCH UNIVERSITY","BACHELOR OF INFORMATION TECHNOLOGY IN ARTIFICIAL INTELLIGENCE AND AUTONOMOUS SYSTEMS AND COMPUTER SCIENCE"],["MURDOCH UNIVERSITY","BACHELOR OF INFORMATION TECHNOLOGY IN ARTIFICIAL INTELLIGENCE AND AUTONOMOUS SYSTEMS AND CYBER SECURITY AND FORENSICS"],["MURDOCH UNIVERSITY","BACHELOR OF INFORMATION TECHNOLOGY IN ARTIFICIAL INTELLIGENCE AND AUTONOMOUS SYSTEMS AND MOBILE AND WEB APPLICATION DEVELOPMENT (TEACH-OUT BY JAN 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF INFORMATION TECHNOLOGY IN ARTIFICIAL INTELLIGENCE AND AUTONOMOUS SYSTEMS AND GAMES SOFTWARE DESIGN AND PRODUCTION (TEACH-OUT BY MAY 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF INFORMATION TECHNOLOGY IN CYBER SECURITY AND FORENSICS"],["MURDOCH UNIVERSITY","BACHELOR OF INFORMATION TECHNOLOGY IN CYBER SECURITY AND FORENSICS AND BUSINESS INFORMATION SYSTEMS"],["MURDOCH UNIVERSITY","BACHELOR OF INFORMATION TECHNOLOGY IN CYBER SECURITY AND FORENSICS AND COMPUTER SCIENCE"],["MURDOCH UNIVERSITY","BACHELOR OF INFORMATION TECHNOLOGY IN CYBER SECURITY AND FORENSICS AND CRIMINOLOGY"],["MURDOCH UNIVERSITY","BACHELOR OF INFORMATION TECHNOLOGY IN CYBER SECURITY AND FORENSICS AND FINANCE"],["MURDOCH UNIVERSITY","BACHELOR OF INFORMATION TECHNOLOGY IN CYBER SECURITY AND FORENSICS AND MANAGEMENT"],["MURDOCH UNIVERSITY","BACHELOR OF INFORMATION TECHNOLOGY IN CYBER SECURITY AND FORENSICS AND WEB COMMUNICATION"],["MURDOCH UNIVERSITY","BACHELOR OF INFORMATION TECHNOLOGY IN BUSINESS INFORMATION SYSTEMS"],["MURDOCH UNIVERSITY","BACHELOR OF INFORMATION TECHNOLOGY IN BUSINESS INFORMATION SYSTEMS AND BANKING"],["MURDOCH UNIVERSITY","BACHELOR OF INFORMATION TECHNOLOGY IN BUSINESS INFORMATION SYSTEMS AND COMPUTER SCIENCE"],["MURDOCH UNIVERSITY","BACHELOR OF INFORMATION TECHNOLOGY IN BUSINESS INFORMATION SYSTEMS AND FINANCE"],["MURDOCH UNIVERSITY","BACHELOR OF INFORMATION TECHNOLOGY IN BUSINESS INFORMATION SYSTEMS AND MANAGEMENT"],["MURDOCH UNIVERSITY","BACHELOR OF INFORMATION TECHNOLOGY IN BUSINESS INFORMATION SYSTEMS AND WEB COMMUNICATION"],["MURDOCH UNIVERSITY","BACHELOR OF INFORMATION TECHNOLOGY IN COMPUTER SCIENCE"],["MURDOCH UNIVERSITY","BACHELOR OF INFORMATION TECHNOLOGY IN COMPUTER SCIENCE AND BUSINESS INFORMATION SYSTEMS"],["MURDOCH UNIVERSITY","BACHELOR OF INFORMATION TECHNOLOGY IN COMPUTER SCIENCE AND MANAGEMENT"],["MURDOCH UNIVERSITY","BACHELOR OF INFORMATION TECHNOLOGY IN COMPUTER SCIENCE AND WEB COMMUNICATION"],["MURDOCH UNIVERSITY","BACHELOR OF INFORMATION TECHNOLOGY IN MOBILE AND WEB APPLICATION DEVELOPMENT (TEACH-OUT BY JAN 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF INFORMATION TECHNOLOGY IN MOBILE AND WEB APPLICATION DEVELOPMENT AND BUSINESS INFORMATION SYSTEMS (TEACH-OUT BY JAN 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF INFORMATION TECHNOLOGY IN MOBILE AND WEB APPLICATION DEVELOPMENT AND COMPUTER SCIENCE (TEACH-OUT BY JAN 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF INFORMATION TECHNOLOGY IN MOBILE AND WEB APPLICATION DEVELOPMENT AND CYBER SECURITY AND FORENSICS (TEACH-OUT BY JAN 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF INFORMATION TECHNOLOGY IN MOBILE AND WEB APPLICATION DEVELOPMENT AND MARKETING (TEACH-OUT BY JAN 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF INFORMATION TECHNOLOGY IN MOBILE AND WEB APPLICATION DEVELOPMENT AND WEB COMMUNICATION (TEACH-OUT BY JAN 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF INFORMATION TECHNOLOGY IN GAMES SOFTWARE DESIGN AND PRODUCTION (TEACH-OUT BY MAY 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF INFORMATION TECHNOLOGY IN GAMES SOFTWARE DESIGN AND PRODUCTION AND COMPUTER SCIENCE (TEACH-OUT BY MAY 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF INFORMATION TECHNOLOGY IN GAMES SOFTWARE DESIGN AND PRODUCTION AND CYBER SECURITY AND FORENSICS (TEACH-OUT BY MAY 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF INFORMATION TECHNOLOGY IN GAMES SOFTWARE DESIGN AND PRODUCTION AND MOBILE AND WEB APPLICATION DEVELOPMENT (TEACH-OUT BY JAN 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF INFORMATION TECHNOLOGY IN GAMES DESIGN AND DEVELOPMENT"],["MURDOCH UNIVERSITY","BACHELOR OF INFORMATION TECHNOLOGY IN GAMES DESIGN AND DEVELOPMENT AND COMPUTER SCIENCE"],["MURDOCH UNIVERSITY","BACHELOR OF INFORMATION TECHNOLOGY IN GAMES DESIGN AND DEVELOPMENT AND CYBER SECURITY AND FORENSICS"],["MURDOCH UNIVERSITY","BACHELOR OF INFORMATION TECHNOLOGY IN ARTIFICIAL INTELLIGENCE AND AUTONOMOUS SYSTEMS AND GAMES DESIGN AND DEVELOPMENT"],["MURDOCH UNIVERSITY","BACHELOR OF PSYCHOLOGY IN PSYCHOLOGICAL SCIENCE"],["MURDOCH UNIVERSITY","BACHELOR OF PSYCHOLOGY IN PSYCHOLOGICAL SCIENCE AND GLOBAL MEDIA AND COMMUNICATION"],["MURDOCH UNIVERSITY","BACHELOR OF PSYCHOLOGY IN PSYCHOLOGICAL SCIENCE AND HUMAN RESOURCES MANAGEMENT"],["MURDOCH UNIVERSITY","BACHELOR OF PSYCHOLOGY IN PSYCHOLOGICAL SCIENCE AND MANAGEMENT"],["MURDOCH UNIVERSITY","BACHELOR OF PSYCHOLOGY IN PSYCHOLOGICAL SCIENCE AND CRIMINOLOGY"],["MURDOCH UNIVERSITY","BACHELOR OF PSYCHOLOGY IN PSYCHOLOGICAL SCIENCE AND MARKETING"],["MURDOCH UNIVERSITY","BACHELOR OF PSYCHOLOGY IN PSYCHOLOGICAL SCIENCE AND WEB COMMUNICATION"],["MURDOCH UNIVERSITY","BACHELOR OF PSYCHOLOGY IN PSYCHOLOGICAL SCIENCE AND COMMUNICATION AND MEDIA STUDIES"],["MURDOCH UNIVERSITY","BACHELOR OF PSYCHOLOGY IN PSYCHOLOGICAL SCIENCE AND DIGITAL COMMUNICATION"],["MURDOCH UNIVERSITY","GRADUATE CERTIFICATE IN BUSINESS ADMINISTRATION"],["MURDOCH UNIVERSITY","GRADUATE CERTIFICATE IN HUMAN RESOURCES MANAGEMENT"],["MURDOCH UNIVERSITY","GRADUATE DIPLOMA IN PSYCHOLOGY (ADVANCED)"],["MURDOCH UNIVERSITY","MASTER OF BUSINESS ADMINISTRATION - MASTER OF HUMAN RESOURCES MANAGEMENT"],["MURDOCH UNIVERSITY","MASTER OF SCIENCE IN INFORMATION TECHNOLOGY (ARTIFICIAL INTELLIGENCE AND DATA SCIENCE)"],["MURDOCH UNIVERSITY","MASTER OF SCIENCE IN INFORMATION TECHNOLOGY (INFORMATION TECHNOLOGY MANAGEMENT)"],["MURDOCH UNIVERSITY","MASTER OF BUSINESS ADMINISTRATION - MASTER OF INFORMATION TECHNOLOGY (ARTIFICIAL INTELLIGENCE AND DATA SCIENCE)"],["MURDOCH UNIVERSITY","GRADUATE CERTIFICATE IN COMMUNICATION"],["MURDOCH UNIVERSITY","MASTER OF COMMUNICATION"],["MURDOCH UNIVERSITY","MASTER OF BUSINESS ADMINISTRATION - MASTER OF COMMUNICATION"],["MURDOCH UNIVERSITY","MASTER OF BUSINESS ADMINISTRATION (MURDOCH UNIVERSITY) (FULL-TIME ONLY)"],["MURDOCH UNIVERSITY","MASTER OF BUSINESS ADMINISTRATION (MURDOCH UNIVERSITY) (PART-TIME ONLY)"],["MURDOCH UNIVERSITY","MASTER OF PROFESSIONAL ACCOUNTING (PART-TIME ONLY)"],["MURDOCH UNIVERSITY","MASTER OF BUSINESS ADMINISTRATION (E-LEARNING) (MURDOCH UNIVERSITY)"],["MURDOCH UNIVERSITY","GRADUATE CERTIFICATE IN BUSINESS ADMINISTRATION (E-LEARNING)"],["MURDOCH UNIVERSITY","GRADUATE CERTIFICATE IN EDUCATION INCLUSIVE AND SPECIAL NEEDS EDUCATION (PART-TIME ONLY)"],["MURDOCH UNIVERSITY","GRADUATE CERTIFICATE IN EDUCATION INTERNATIONAL EDUCATION (PART-TIME ONLY)"],["MURDOCH UNIVERSITY","GRADUATE CERTIFICATE IN EDUCATION E-LEARNING (PART-TIME ONLY)"],["MURDOCH UNIVERSITY","MASTER OF EDUCATION INCLUSIVE AND SPECIAL NEEDS EDUCATION (PART-TIME ONLY)"],["MURDOCH UNIVERSITY","MASTER OF EDUCATION E-LEARNING (PART-TIME ONLY)"],["MURDOCH UNIVERSITY","MASTER OF EDUCATION INTERNATIONAL EDUCATION (PART-TIME ONLY)"],["MURDOCH UNIVERSITY","GRADUATE CERTIFICATE IN INFORMATION TECHNOLOGY"],["UNIVERSITY COLLEGE DUBLIN","BACHELOR OF BUSINESS STUDIES (HONOURS) (MANAGEMENT) (TOP-UP)"],["UNIVERSITY COLLEGE DUBLIN","BACHELOR OF BUSINESS STUDIES (HONOURS) (FINANCE) (TOP-UP)"],["UNIVERSITY COLLEGE DUBLIN","BACHELOR OF BUSINESS STUDIES (HONOURS) (HUMAN RESOURCE MANAGEMENT) (TOP-UP)"],["UNIVERSITY COLLEGE DUBLIN","BACHELOR OF BUSINESS STUDIES (HONOURS) (LOGISTICS AND SUPPLY CHAIN MANAGEMENT) (TOP-UP)"],["UNIVERSITY COLLEGE DUBLIN","BACHELOR OF BUSINESS STUDIES (HONOURS) (MARKETING) (TOP-UP)"],["UNIVERSITY COLLEGE DUBLIN","BACHELOR OF BUSINESS STUDIES (HONOURS) (PROJECT MANAGEMENT) (TOP-UP)"],["UNIVERSITY COLLEGE DUBLIN","BACHELOR OF BUSINESS STUDIES (HONOURS) (DIGITAL BUSINESS) (TOP-UP)"],["UNIVERSITY COLLEGE DUBLIN","BACHELOR OF BUSINESS STUDIES (HONOURS) (BUSINESS ANALYTICS) (TOP-UP)"],["UNIVERSITY COLLEGE DUBLIN","BACHELOR OF BUSINESS STUDIES (HONOURS) (FINTECH) (TOP-UP)"],["UNIVERSITY COLLEGE DUBLIN","MASTER OF SCIENCE (MANAGEMENT)"],["UNIVERSITY COLLEGE DUBLIN","MASTER OF SCIENCE (GLOBAL FINANCE)"],["NORTHUMBRIA UNIVERSITY","BACHELOR OF ARTS (HONOURS) IN BUSINESS MANAGEMENT (TOP-UP) (TEACH-OUT BY JAN 2026) (PART-TIME ONLY)"],["NORTHUMBRIA UNIVERSITY","BACHELOR OF ARTS (HONOURS) IN BUSINESS WITH TOURISM MANAGEMENT (TOP-UP) (TEACH-OUT BY JAN 2026) (PART-TIME ONLY)"],["NORTHUMBRIA UNIVERSITY","BACHELOR OF ARTS (HONOURS) BUSINESS WITH INTERNATIONAL MANAGEMENT (TOP-UP) (TEACH-OUT BY JAN 2026)"],["NORTHUMBRIA UNIVERSITY","BACHELOR OF ARTS (HONOURS) IN BUSINESS WITH MARKETING MANAGEMENT (TOP-UP) (TEACH-OUT BY JAN 2026) (PART-TIME ONLY)"],["NORTHUMBRIA UNIVERSITY","BACHELOR OF ARTS (HONOURS) IN BUSINESS WITH LOGISTICS AND SUPPLY CHAIN MANAGEMENT (TOP-UP) (TEACH-OUT BY JAN 2026) (PART-TIME ONLY)"],["NORTHUMBRIA UNIVERSITY","BACHELOR OF ARTS (HONOURS) MASS COMMUNICATION WITH PUBLIC RELATIONS (TOP-UP)"],["NORTHUMBRIA UNIVERSITY","BACHELOR OF ARTS (HONOURS) IN BUSINESS WITH HUMAN RESOURCE MANAGEMENT (TOP-UP) (TEACH-OUT BY JAN 2026) (PART-TIME ONLY)"],["NORTHUMBRIA UNIVERSITY","BACHELOR OF ARTS (HONOURS) BUSINESS (TOP-UP) (TEACH-OUT BY JAN 2026) (PART-TIME ONLY)"],["NORTHUMBRIA UNIVERSITY","BACHELOR OF SCIENCE (HONOURS) IN PSYCHOLOGY (CLINICAL PSYCHOLOGY) (TOP-UP)"],["NORTHUMBRIA UNIVERSITY","BACHELOR OF ARTS (HONOURS) IN GUIDANCE AND COUNSELLING (TOP-UP) (PART-TIME ONLY)"],["NORTHUMBRIA UNIVERSITY","MASTER OF BUSINESS ADMINISTRATION (NORTHUMBRIA UNIVERSITY)"],["NORTHUMBRIA UNIVERSITY","BACHELOR OF ARTS (HONOURS) IN CHILDHOOD AND EARLY YEARS STUDIES (TOP-UP) (PART-TIME ONLY)"],["NORTHUMBRIA UNIVERSITY","BACHELOR OF SCIENCE NURSING (TOP-UP) (PART-TIME ONLY)"],["NORTHUMBRIA UNIVERSITY","BACHELOR OF SCIENCE (HONOURS) GLOBAL BUSINESS MANAGEMENT"],["NORTHUMBRIA UNIVERSITY","BACHELOR OF SCIENCE (HONOURS) GLOBAL BUSINESS MANAGEMENT (HUMAN RESOURCES)"],["NORTHUMBRIA UNIVERSITY","BACHELOR OF SCIENCE (HONOURS) GLOBAL BUSINESS MANAGEMENT (LOGISTICS AND SUPPLY CHAIN)"],["NORTHUMBRIA UNIVERSITY","BACHELOR OF SCIENCE (HONOURS) INTERNATIONAL TOURISM, HOSPITALITY AND EVENTS"],["NORTHUMBRIA UNIVERSITY","MASTER OF PUBLIC HEALTH (PART-TIME ONLY)"],["ROYAL HOLLOWAY, UNIVERSITY OF LONDON","BACHELOR OF SCIENCE (HONOURS) IN BUSINESS AND MANAGEMENT (TOP-UP) (TEACH-OUT BY JULY 2026 ) (PART-TIME ONLY)"],["ROYAL HOLLOWAY, UNIVERSITY OF LONDON","BACHELOR OF SCIENCE (HONOURS) IN MANAGEMENT WITH MARKETING (TOP-UP) (TEACH-OUT BY JULY 2026) (PART-TIME ONLY)"],["ROYAL HOLLOWAY, UNIVERSITY OF LONDON","BACHELOR OF SCIENCE (HONOURS) IN MANAGEMENT WITH INTERNATIONAL BUSINESS (TOP-UP) (TEACH-OUT BY JULY 2026) (PART-TIME ONLY)"],["ROYAL HOLLOWAY, UNIVERSITY OF LONDON","BACHELOR OF SCIENCE (HONOURS) IN BUSINESS AND MANAGEMENT (TOP-UP) (TEACH-OUT BY DEC 2025) (FULL-TIME ONLY)"],["ROYAL HOLLOWAY, UNIVERSITY OF LONDON","BACHELOR OF SCIENCE (HONOURS) IN MANAGEMENT WITH MARKETING (TOP-UP) (TEACH-OUT BY DEC 2025) (FULL-TIME ONLY)"],["ROYAL HOLLOWAY, UNIVERSITY OF LONDON","BACHELOR OF SCIENCE (HONOURS) IN MANAGEMENT WITH INTERNATIONAL BUSINESS (TOP-UP) (TEACH-OUT BY DEC 2025) (FULL-TIME ONLY)"],["RMIT UNIVERSITY","BACHELOR OF ENGINEERING (MECHANICAL ENGINEERING) (HONOURS) (TOP-UP) (TEACH-OUT BY AUG 2026) (PART-TIME ONLY)"],["UNIVERSITY OF PORTSMOUTH","BACHELOR OF ARTS (HONOURS) IN ACCOUNTANCY AND FINANCIAL MANAGEMENT (TOP-UP)"],["UNIVERSITY OF PORTSMOUTH","BACHELOR OF SCIENCE (HONOURS) SOFTWARE ENGINEERING (TOP-UP)"],["UNIVERSITY OF PORTSMOUTH","BACHELOR OF SCIENCE (HONOURS) CYBER SECURITY AND FORENSIC COMPUTING (TOP-UP)"],["UNIVERSITY OF PORTSMOUTH","BACHELOR OF SCIENCE (HONOURS) DATA SCIENCE AND ANALYTICS (TOP-UP)"],["UNIVERSITY OF PORTSMOUTH","BACHELOR OF SCIENCE (HONOURS) COMPUTER SCIENCE (TOP-UP)"],["UNIVERSITY OF PORTSMOUTH","MASTER OF SCIENCE ARTIFICIAL INTELLIGENCE AND MACHINE LEARNING"],["UNIVERSITY OF PORTSMOUTH","MASTER OF SCIENCE CYBER SECURITY AND FORENSIC INFORMATION TECHNOLOGY"],["UNIVERSITY OF PORTSMOUTH","MASTER OF SCIENCE DATA ANALYTICS"],["UNIVERSITY OF PORTSMOUTH","BACHELOR OF SCIENCE WITH HONOURS IN PSYCHOLOGY (TOP-UP)"],["UNIVERSITY OF PORTSMOUTH","MASTER OF SCIENCE IN PSYCHOLOGY"],["MURDOCH UNIVERSITY","BACHELOR OF ARTS IN COMMUNICATION AND MEDIA STUDIES (TEACH-OUT BY JAN 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF ARTS IN COMMUNICATION AND MEDIA STUDIES AND MARKETING (TEACH-OUT BY JAN 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF ARTS IN COMMUNICATION AND MEDIA STUDIES AND PUBLIC RELATIONS (TEACH-OUT BY JAN 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF ARTS IN JOURNALISM (TEACH-OUT BY JAN 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF ARTS IN PSYCHOLOGY AND COMMUNICATION AND MEDIA STUDIES (TEACH-OUT BY JAN 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF ARTS IN PUBLIC RELATIONS AND MARKETING (TEACH-OUT BY JAN 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF ARTS IN PUBLIC RELATIONS AND INTERNATIONAL BUSINESS (TEACH-OUT BY JAN 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF ARTS IN TOURISM AND EVENTS (TEACH-OUT BY JAN 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF ARTS IN TOURISM AND EVENTS AND BUSINESS LAW (TEACH-OUT BY JAN 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF ARTS IN TOURISM AND EVENTS AND HOSPITALITY AND TOURISM MANAGEMENT (TEACH-OUT BY JAN 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF ARTS IN TOURISM AND EVENTS AND MARKETING (TEACH-OUT BY JAN 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF ARTS IN TOURISM AND EVENTS AND MANAGEMENT (TEACH-OUT BY JAN 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF ARTS IN WEB COMMUNICATION AND PUBLIC RELATIONS (TEACH-OUT BY JAN 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN MANAGEMENT AND PUBLIC RELATIONS (TEACH-OUT BY JAN 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF BUSINESS IN MARKETING AND PUBLIC RELATIONS (TEACH-OUT BY JAN 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF SCIENCE IN BUSINESS INFORMATION SYSTEMS (TEACH-OUT BY JAN 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF SCIENCE IN BUSINESS INFORMATION SYSTEMS AND COMPUTER SCIENCE (TEACH-OUT BY JAN 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF SCIENCE IN BUSINESS INFORMATION SYSTEMS AND WEB COMMUNICATION (TEACH-OUT BY JAN 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF SCIENCE IN BUSINESS INFORMATION SYSTEMS AND FINANCE (TEACH-OUT BY JAN 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF SCIENCE IN COMPUTER SCIENCE (TEACH-OUT BY JAN 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF SCIENCE IN COMPUTER SCIENCE AND WEB COMMUNICATION (TEACH-OUT BY JAN 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF SCIENCE IN CYBER FORENSICS AND INFORMATION SECURITY (TEACH-OUT BY JAN 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF SCIENCE IN CYBER FORENSICS AND INFORMATION SECURITY AND BUSINESS INFORMATION SYSTEMS (TEACH-OUT BY JAN 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF SCIENCE IN CYBER FORENSICS AND INFORMATION SECURITY AND COMPUTER SCIENCE (TEACH-OUT BY JAN 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF SCIENCE IN CYBER SECURITY AND FORENSICS (TEACH-OUT BY JAN 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF SCIENCE IN CYBER SECURITY AND FORENSICS AND BANKING (TEACH-OUT BY JAN 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF SCIENCE IN CYBER SECURITY AND FORENSICS AND BUSINESS INFORMATION SYSTEMS (TEACH-OUT BY JAN 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF SCIENCE IN CYBER SECURITY AND FORENSICS AND COMPUTER SCIENCE (TEACH-OUT BY JAN 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF SCIENCE IN CYBER SECURITY AND FORENSICS AND CRIMINOLOGY (TEACH-OUT BY JAN 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF SCIENCE IN CYBER SECURITY AND FORENSICS AND FINANCE (TEACH-OUT BY JAN 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF SCIENCE IN CYBER SECURITY AND FORENSICS AND MANAGEMENT (TEACH-OUT BY JAN 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF SCIENCE IN CYBER SECURITY AND FORENSICS AND WEB COMMUNICATION (TEACH-OUT BY JAN 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF SCIENCE IN GAMES SOFTWARE DESIGN AND PRODUCTION (TEACH-OUT BY JAN 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF SCIENCE IN GAMES SOFTWARE DESIGN AND PRODUCTION AND COMPUTER SCIENCE (TEACH-OUT BY JAN 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF SCIENCE IN MOBILE AND WEB APPLICATION DEVELOPMENT (TEACH-OUT BY JAN 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF SCIENCE IN MOBILE AND WEB APPLICATION DEVELOPMENT AND COMPUTER SCIENCE (TEACH-OUT BY JAN 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF SCIENCE IN MOBILE AND WEB APPLICATION DEVELOPMENT AND BUSINESS INFORMATION SYSTEMS (TEACH-OUT BY JAN 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF SCIENCE IN MOBILE AND WEB APPLICATION DEVELOPMENT AND CYBER SECURITY AND FORENSICS (TEACH-OUT BY JAN 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF COMMERCE IN ACCOUNTING AND BUSINESS LAW (TEACH-OUT BY MAY 2027)"],["MURDOCH UNIVERSITY","BACHELOR OF COMMERCE IN FINANCE (TEACH-OUT BY JAN 2026)"],["MURDOCH UNIVERSITY","CERTIFICATE IN FOUNDATION STUDIES (FULL-TIME ONLY)"],["MURDOCH UNIVERSITY","DIPLOMA IN PROFESSIONAL BUSINESS ENGLISH (FULL-TIME ONLY)"],["MURDOCH UNIVERSITY","DIPLOMA IN SPORTS AND EXERCISE SCIENCE (PART-TIME ONLY)"],["MURDOCH UNIVERSITY","DIPLOMA IN BUSINESS MANAGEMENT"],["MURDOCH UNIVERSITY","PRINCIPLES OF ACCOUNTING"],["MURDOCH UNIVERSITY","DIPLOMA IN PSYCHOLOGY"],["MURDOCH UNIVERSITY","DIPLOMA IN INFORMATION TECHNOLOGY"],["MURDOCH UNIVERSITY","FOUNDATION DIPLOMA"],["MURDOCH UNIVERSITY","DIPLOMA IN BUSINESS MANAGEMENT (FINANCE AND BANKING)"],["MURDOCH UNIVERSITY","DIPLOMA IN BUSINESS MANAGEMENT (HOSPITALITY AND TOURISM)"],["MURDOCH UNIVERSITY","DIPLOMA IN BUSINESS MANAGEMENT (HUMAN RESOURCE) (TEACH-OUT BY DEC 2025)"],["MURDOCH UNIVERSITY","DIPLOMA IN BUSINESS MANAGEMENT (LOGISTICS AND SUPPLY CHAIN)"],["MURDOCH UNIVERSITY","DIPLOMA IN BUSINESS MANAGEMENT (MARKETING) (TEACH-OUT BY DEC 2025)"],["MURDOCH UNIVERSITY","DIPLOMA IN BUSINESS MANAGEMENT (GENERAL STUDIES)"],["MURDOCH UNIVERSITY","DIPLOMA IN COMPUTER FORENSICS"],["MURDOCH UNIVERSITY","DIPLOMA IN COUNSELLING"],["MURDOCH UNIVERSITY","DIPLOMA IN HEALTH SERVICES MANAGEMENT (PART-TIME ONLY)"],["MURDOCH UNIVERSITY","DIPLOMA IN LEGAL STUDIES"],["MURDOCH UNIVERSITY","WILLS AND ESTATES"],["MURDOCH UNIVERSITY","ADVANCED DIPLOMA IN MANAGEMENT (PART-TIME ONLY)"],["MURDOCH UNIVERSITY","PREPARATORY COURSE FOR CAMBRIDGE INTERNATIONAL GENERAL CERTIFICATE OF SECONDARY EDUCATION (IGCSE) EXAMINATION"],["MURDOCH UNIVERSITY","FOUNDATION DIPLOMA IN COMPUTING AND IT"],["MURDOCH UNIVERSITY","FOUNDATION DIPLOMA IN SPORT AND EXERCISE SCIENCE (PART-TIME ONLY)"],["MURDOCH UNIVERSITY","FOUNDATION DIPLOMA (E-LEARNING)"],["MURDOCH UNIVERSITY","DIPLOMA IN BUSINESS MANAGEMENT (GENERAL STUDIES) (E-LEARNING)"],["MURDOCH UNIVERSITY","DIPLOMA IN BUSINESS ANALYTICS"],["MURDOCH UNIVERSITY","DIPLOMA IN FINTECH"],["MURDOCH UNIVERSITY","DIPLOMA IN CRIMINOLOGY"],["MURDOCH UNIVERSITY","CERTIFICATE IN ENGLISH LEVEL 1 (E-LEARNING) (FULL-TIME ONLY)"],["MURDOCH UNIVERSITY","CERTIFICATE IN ENGLISH LEVEL 2 (E-LEARNING) (FULL-TIME ONLY)"],["MURDOCH UNIVERSITY","CERTIFICATE IN ENGLISH LEVEL 3 (E-LEARNING) (FULL-TIME ONLY)"],["MURDOCH UNIVERSITY","CERTIFICATE IN ENGLISH LEVEL 4 (E-LEARNING) (FULL-TIME ONLY)"],["MURDOCH UNIVERSITY","CERTIFICATE IN ENGLISH LEVEL 5 (E-LEARNING) (FULL-TIME ONLY)"],["MURDOCH UNIVERSITY","DIPLOMA IN ACCOUNTING AND FINANCE"],["MURDOCH UNIVERSITY","DIPLOMA IN HUMAN RESOURCES AND MANAGEMENT"],["MURDOCH UNIVERSITY","DIPLOMA IN MARKETING AND MANAGEMENT"],["MURDOCH UNIVERSITY","DIPLOMA IN FINANCE AND BANKING"],["MURDOCH UNIVERSITY","DIPLOMA IN HOSPITALITY AND TOURISM MANAGEMENT"],["MURDOCH UNIVERSITY","DIPLOMA IN LOGISTICS AND SUPPLY CHAIN MANAGEMENT"],["MURDOCH UNIVERSITY","DIPLOMA IN PSYCHOLOGY AND CRIMINOLOGY"],["MURDOCH UNIVERSITY","DIPLOMA IN BUSINESS MANAGEMENT (E-LEARNING)"],["MURDOCH UNIVERSITY","DIPLOMA IN HOSPITALITY AND TOURISM MANAGEMENT (E-LEARNING)"],["MURDOCH UNIVERSITY","DIPLOMA IN HUMAN RESOURCES AND MANAGEMENT (E-LEARNING)"],["MURDOCH UNIVERSITY","DIPLOMA IN LOGISTICS AND SUPPLY CHAIN MANAGEMENT (E-LEARNING)"],["MURDOCH UNIVERSITY","DIPLOMA IN MARKETING AND MANAGEMENT (E-LEARNING)"],["MURDOCH UNIVERSITY","DIPLOMA IN FINANCE AND BUSINESS ANALYTICS"],["MURDOCH UNIVERSITY","DIPLOMA IN MEDIA COMMUNICATION AND DIGITAL MARKETING"],["MURDOCH UNIVERSITY","DIPLOMA IN PSYCHOLOGY AND COUNSELLING"],["MURDOCH UNIVERSITY","PREPARATORY COURSE FOR THE ASSOCIATION OF CHARTERED CERTIFIED ACCOUNTANTS (ACCA) EXAMINATION"],["MURDOCH UNIVERSITY","PREPARATORY COURSE FOR THE ASSOCIATION OF CHARTERED CERTIFIED ACCOUNTANTS (ACCA) EXAMINATION - CERTIFIED ACCOUNTING TECHNICIAN"],["MURDOCH UNIVERSITY","PREPARATORY COURSE FOR CHARTERED FINANCIAL ANALYST EXAMINATION"],["MURDOCH UNIVERSITY","PREPARATORY COURSE FOR THE ASSOCIATION OF CHARTERED CERTIFIED ACCOUNTANTS (ACCA) DIPLOMA IN FINANCIAL AND MANAGEMENT ACCOUNTING (RQF LEVEL 2)"],["MURDOCH UNIVERSITY","PREPARATORY COURSE FOR THE ASSOCIATION OF CHARTERED CERTIFIED ACCOUNTANTS (ACCA) DIPLOMA IN FINANCIAL AND MANAGEMENT ACCOUNTING (RQF LEVEL 3)"],["MURDOCH UNIVERSITY","PREPARATORY COURSE FOR THE ASSOCIATION OF CHARTERED CERTIFIED ACCOUNTANTS (ACCA) DIPLOMA IN ACCOUNTING AND BUSINESS (RQF LEVEL 4)"],["MURDOCH UNIVERSITY","PREPARATORY COURSE FOR SINGAPORE CA QUALIFICATION"],["MURDOCH UNIVERSITY","CFA L1 PREPARATORY PROGRAM BY KAPLAN (IBF-STS ACCREDITED)"],["MURDOCH UNIVERSITY","CFA L2 PREPARATORY PROGRAM BY KAPLAN (IBF-STS ACCREDITED)"],["MURDOCH UNIVERSITY","CFA L3 PREPARATORY PROGRAM BY KAPLAN (IBF-STS ACCREDITED)"],["MURDOCH UNIVERSITY","CFA L1 PREPARATORY PROGRAM BY KAPLAN (IBF-STS ACCREDITED) (E-LEARNING)"],["MURDOCH UNIVERSITY","CFA L2 PREPARATORY PROGRAM BY KAPLAN (IBF-STS ACCREDITED) (E-LEARNING)"],["MURDOCH UNIVERSITY","CFA L3 PREPARATORY PROGRAM BY KAPLAN (IBF-STS ACCREDITED) (E-LEARNING)"]];

    // PSB 全课程（来源：psb-academy.edu.sg sitemap，离线内置）
    const psbProgrammeSitemap = [["Cambridge Assessment International Education","Preparatory Course for Cambridge International General Certificate of Secondary Education (IGCSE) Examination (Intensive)","https://www.psb-academy.edu.sg/cambridge-assessment-international-education/igcse-intensive"],["Coventry University","Bachelor of Arts with Honours in Business and Marketing","https://www.psb-academy.edu.sg/coventry-university/bachelor-of-arts-with-honours-in-business-and-marketing"],["Coventry University","Bachelor of Arts with Honours in Digital Marketing","https://www.psb-academy.edu.sg/coventry-university/bachelor-of-arts-with-honours-in-digital-marketing"],["Coventry University","Bachelor of Arts with Honours in Digital Media","https://www.psb-academy.edu.sg/coventry-university/bachelor-of-arts-with-honours-in-digital-media"],["Coventry University","Bachelor of Arts with Honours in International Hospitality and Tourism Management","https://www.psb-academy.edu.sg/coventry-university/bachelor-of-arts-with-honours-in-international-hospitality-and-tourism-management"],["Coventry University","Bachelor of Arts with Honours in Media and Communications","https://www.psb-academy.edu.sg/coventry-university/bachelor-of-arts-with-honours-in-media-and-communications"],["Coventry University","Bachelor of Engineering with Honours in Electrical and Electronic Engineering","https://www.psb-academy.edu.sg/coventry-university/bachelor-of-engineering-with-honours-in-electrical-and-electronic-engineering"],["Coventry University","Bachelor of Engineering with Honours in Electro-Mechanical Engineering","https://www.psb-academy.edu.sg/coventry-university/bachelor-of-engineering-with-honours-in-electro-mechanical-engineering"],["Coventry University","Bachelor of Engineering with Honours in Mechanical Engineering","https://www.psb-academy.edu.sg/coventry-university/bachelor-of-engineering-with-honours-in-mechanical-engineering"],["Coventry University","Bachelor of Science with Honours in Accounting and Finance","https://www.psb-academy.edu.sg/coventry-university/bachelor-of-science-with-honours-in-accounting-and-finance"],["Coventry University","Bachelor of Science with Honours in Business and Finance","https://www.psb-academy.edu.sg/coventry-university/bachelor-of-science-with-honours-in-business-and-finance"],["Coventry University","Bachelor of Science with Honours in Computing Science","https://www.psb-academy.edu.sg/coventry-university/bachelor-of-science-with-honours-in-computing-science"],["Coventry University","Bachelor of Science with Honours in Cyber Security","https://www.psb-academy.edu.sg/coventry-university/bachelor-of-science-with-honours-in-cyber-security"],["Coventry University","Bachelor of Science with Honours in Paramedic Science (Top-Up)","https://www.psb-academy.edu.sg/coventry-university/bachelor-of-science-with-honours-in-paramedic-science-top-up"],["Coventry University","Bachelor of Science with Honours in Quantity Surveying and Commercial Management","https://www.psb-academy.edu.sg/coventry-university/bachelor-of-science-with-honours-in-quantity-surveying-and-commercial-management"],["Coventry University","Master of Business Administration in Finance","https://www.psb-academy.edu.sg/coventry-university/master-of-business-administration-in-finance"],["Coventry University","Master of Business Administration in Global Business","https://www.psb-academy.edu.sg/coventry-university/master-of-business-administration-in-global-business"],["Coventry University","Master of Science in Cyber Security","https://www.psb-academy.edu.sg/coventry-university/master-of-science-in-cyber-security"],["Coventry University","Master of Science in Engineering Management","https://www.psb-academy.edu.sg/coventry-university/master-of-science-in-engineering-management"],["Edinburgh Napier University","Bachelor of Arts Business Management (Top-up)","https://www.psb-academy.edu.sg/edinburgh-napier-university/bachelor-of-arts-business-management-top-up"],["Edinburgh Napier University","Bachelor of Science Sport and Exercise Science (Top-up)","https://www.psb-academy.edu.sg/edinburgh-napier-university/bachelor-of-science-sport-and-exercise-science-top-up"],["Edith Cowan University","Bachelor of Science (Exercise and Sports Science)","https://www.psb-academy.edu.sg/edith-cowan-university/bachelor-of-science-exercise-and-sports-science"],["La Trobe University","Bachelor of Biomedical Science","https://www.psb-academy.edu.sg/la-trobe-university/bachelor-of-biomedical-science"],["La Trobe University","Bachelor of Business (Management and International Business)","https://www.psb-academy.edu.sg/la-trobe-university/bachelor-of-business-management-international-business"],["La Trobe University","Bachelor of Business (Management and Marketing)","https://www.psb-academy.edu.sg/la-trobe-university/bachelor-of-business-management-marketing"],["La Trobe University","Bachelor of Business (Marketing and International Business)","https://www.psb-academy.edu.sg/la-trobe-university/bachelor-of-business-marketing-international-business"],["La Trobe University","Bachelor of Nursing (Top-up)","https://www.psb-academy.edu.sg/la-trobe-university/bachelor-of-nursing-top-up"],["La Trobe University","Bachelor of Science (Applied Chemistry and Molecular Biology)","https://www.psb-academy.edu.sg/la-trobe-university/bachelor-of-science-applied-chemistry-and-molecular-biology"],["La Trobe University","Bachelor of Science (Biotechnology and Molecular Biology)","https://www.psb-academy.edu.sg/la-trobe-university/bachelor-of-science-biotechnology-and-molecular-biology"],["La Trobe University","Bachelor of Science (Molecular Biology and Pharmaceutical Science)","https://www.psb-academy.edu.sg/la-trobe-university/bachelor-of-science-molecular-biology-and-pharmaceutical-science"],["La Trobe University","Master of Biotechnology and Bioinformatics","https://www.psb-academy.edu.sg/la-trobe-university/master-of-biotechnology-and-bioinformatics"],["Massey University","Bachelor of Business in Business Analytics","https://www.psb-academy.edu.sg/massey-university/bachelor-of-business-in-business-analytics"],["Massey University","Bachelor of Business in Human Resource Management and Employment Relations","https://www.psb-academy.edu.sg/massey-university/bachelor-of-business-in-human-resource-management-employment-relations"],["Massey University","Bachelor of Information Sciences with a double major in Computer Science and Information Technology","https://www.psb-academy.edu.sg/massey-university/bachelor-of-information-sciences-with-a-double-major-in-computer-science-and-information-technology"],["PSB Academy","Certificate In English Proficiency","https://www.psb-academy.edu.sg/psb-academy/certificate-in-english-proficiency"],["PSB Academy","Certificate in Academic English","https://www.psb-academy.edu.sg/psb-academy/certificate-in-academic-english"],["PSB Academy","Certificate in Business Management","https://www.psb-academy.edu.sg/psb-academy/certificate-in-business-management"],["PSB Academy","Certificate in Business Studies (E-Learning)","https://www.psb-academy.edu.sg/psb-academy/certificate-in-business-studies-e-learning"],["PSB Academy","Certificate in Engineering Foundation (E-Learning)","https://www.psb-academy.edu.sg/psb-academy/certificate-in-engineering-foundation-e-learning"],["PSB Academy","Certificate in InfoComm Technology (E-Learning)","https://www.psb-academy.edu.sg/psb-academy/certificate-in-infocomm-technology"],["PSB Academy","Certificate in InfoComm Technology (E-Learning)","https://www.psb-academy.edu.sg/psb-academy/certificate-in-infocomm-technology-e-learning"],["PSB Academy","Certificate in Media and Communications","https://www.psb-academy.edu.sg/psb-academy/certificate-in-media-and-communications"],["PSB Academy","Certificate in Sport and Exercise Sciences","https://www.psb-academy.edu.sg/psb-academy/certificate-in-sport-and-exercise-sciences"],["PSB Academy","Diploma In Mechanical Engineering Technology","https://www.psb-academy.edu.sg/psb-academy/diploma-in-mechanical-engineering-technology"],["PSB Academy","Diploma in Business Administration","https://www.psb-academy.edu.sg/psb-academy/diploma-in-business-administration"],["PSB Academy","Diploma in Business Administration (Accounting and Finance)","https://www.psb-academy.edu.sg/psb-academy/diploma-in-business-administration-accounting-and-finance"],["PSB Academy","Diploma in Business Administration (Digital Marketing)","https://www.psb-academy.edu.sg/psb-academy/diploma-in-business-administration-digital-marketing"],["PSB Academy","Diploma in Business Administration (Human Resource Management)","https://www.psb-academy.edu.sg/psb-academy/diploma-in-business-administration-human-resource-management"],["PSB Academy","Diploma in Business Analytics","https://www.psb-academy.edu.sg/psb-academy/diploma-in-business-analytics"],["PSB Academy","Diploma in Business Studies (Business Analytics) (E-Learning)","https://www.psb-academy.edu.sg/psb-academy/diploma-in-business-studies-business-analytics-e-learning"],["PSB Academy","Diploma in Business Studies (Digital Marketing) (E-Learning)","https://www.psb-academy.edu.sg/psb-academy/diploma-in-business-studies-digital-marketing-e-learning"],["PSB Academy","Diploma in Business Studies (E-Learning)","https://www.psb-academy.edu.sg/psb-academy/diploma-in-business-studies-e-learning"],["PSB Academy","Diploma in Business Studies (Human Resource Management) (E-Learning)","https://www.psb-academy.edu.sg/psb-academy/diploma-in-business-studies-human-resource-management-e-learning"],["PSB Academy","Diploma in Cyber Security","https://www.psb-academy.edu.sg/psb-academy/diploma-in-cyber-security"],["PSB Academy","Diploma in Electrical Engineering Technology","https://www.psb-academy.edu.sg/psb-academy/diploma-in-electrical-engineering-technology"],["PSB Academy","Diploma in Global Supply Chain Management","https://www.psb-academy.edu.sg/psb-academy/diploma-in-global-supply-chain"],["PSB Academy","Diploma in Graphic Design and Media","https://www.psb-academy.edu.sg/psb-academy/diploma-in-graphic-design-and-media"],["PSB Academy","Diploma in InfoComm Technology","https://www.psb-academy.edu.sg/psb-academy/diploma-in-infocomm-technology"],["PSB Academy","Diploma in InfoComm Technology (E-Learning)","https://www.psb-academy.edu.sg/psb-academy/diploma-in-infocomm-technology-e-learning"],["PSB Academy","Diploma in Media and Communications","https://www.psb-academy.edu.sg/psb-academy/diploma-in-media-and-communications"],["PSB Academy","Diploma in Sport and Exercise Sciences","https://www.psb-academy.edu.sg/psb-academy/diploma-in-sport-and-exercise-sciences"],["PSB Academy","Diploma in Sport and Exercise Sciences (Sport Coaching)","https://www.psb-academy.edu.sg/psb-academy/diploma-in-sport-and-exercise-sciences-sport-coaching"],["PSB Academy","Diploma in Tourism and Hospitality Management","https://www.psb-academy.edu.sg/psb-academy/diploma-in-tourism-and-hospitality-management"],["PSB Academy","Foundation Certificate in Business","https://www.psb-academy.edu.sg/psb-academy/foundation-certificate-in-business"],["PSB Academy","Foundation Certificate in Engineering and Technology","https://www.psb-academy.edu.sg/psb-academy/certificate-in-engineering-foundation"],["PSB Academy","Foundation Certificate in Engineering and Technology","https://www.psb-academy.edu.sg/psb-academy/foundation-certificate-in-engineering-and-technology"],["PSB Academy","Foundation Diploma in Life Sciences","https://www.psb-academy.edu.sg/psb-academy/foundation-diploma-in-life-sciences"],["PSB Academy","Postgraduate Diploma in Cyber Security (E-Learning)","https://www.psb-academy.edu.sg/psb-academy/postgraduate-diploma-in-cyber-security-elearning"],["The University of Newcastle, Australia","Bachelor of Business","https://www.psb-academy.edu.sg/the-university-of-newcastle-australia/bachelor-of-business"],["The University of Newcastle, Australia","Bachelor of Commerce","https://www.psb-academy.edu.sg/the-university-of-newcastle-australia/bachelor-of-commerce"],["The University of Newcastle, Australia","Bachelor of Communication","https://www.psb-academy.edu.sg/the-university-of-newcastle-australia/bachelor-of-communication"],["The University of Newcastle, Australia","Bachelor of Information Technology","https://www.psb-academy.edu.sg/the-university-of-newcastle-australia/bachelor-of-information-technology"],["The University of Newcastle, Australia","Executive Master of Business Administration","https://www.psb-academy.edu.sg/the-university-of-newcastle-australia/executive-master-of-business-administration"],["The University of Newcastle, Australia","Graduate Certificate in Business Administration","https://www.psb-academy.edu.sg/the-university-of-newcastle-australia/graduate-certificate-in-business-administration"],["The University of Newcastle, Australia","Master of Business Administration","https://www.psb-academy.edu.sg/the-university-of-newcastle-australia/master-of-business-administration"],["University of Canberra","Doctor of Business Administration","https://www.psb-academy.edu.sg/university-of-canberra/doctor-of-business-administration"],["University of Hertfordshire","Bachelor of Arts (Honours) Business Administration (Top-Up)","https://www.psb-academy.edu.sg/university-of-hertfordshire/bachelor-of-arts-honours-business-administration-top-up"],["University of Hertfordshire","Bachelor of Arts (Honours) Business Administration (Top-Up) (E-Learning)","https://www.psb-academy.edu.sg/university-of-hertfordshire/bachelor-of-arts-honours-business-administration-top-up-e-learning"],["University of Hertfordshire","Bachelor of Arts (Honours) Business Management with Logistics","https://www.psb-academy.edu.sg/university-of-hertfordshire/bachelor-of-arts-honours-business-management-with-logistics"],["University of Hertfordshire","Bachelor of Engineering Honours in Robotics and Artificial Intelligence","https://www.psb-academy.edu.sg/university-of-hertfordshire/bachelor-of-engineering-honours-in-robotics-and-artificial-intelligence"],["University of Hertfordshire","Bachelor of Science (Honours) Data Science","https://www.psb-academy.edu.sg/university-of-hertfordshire/bachelor-of-science-honours-data-science"],["University of Hertfordshire","Bachelor of Science (Honours) Diagnostic Radiography and Imaging","https://www.psb-academy.edu.sg/university-of-hertfordshire/bachelor-of-science-honours-diagnostic-radiography-and-imaging"],["University of Hertfordshire","Master of Business Administration","https://www.psb-academy.edu.sg/university-of-hertfordshire/master-of-business-administration-uh"],["University of Hertfordshire","Master of Business Administration (E-Learning)","https://www.psb-academy.edu.sg/university-of-hertfordshire/master-of-business-administration-e-learning"],["University of Hertfordshire","Master of Science in Data Science","https://www.psb-academy.edu.sg/university-of-hertfordshire/master-of-science-in-data-science"]];

    // SIM 全课程（来源：sim.edu.sg programme-listing，离线内置）
    const simProgrammeSitemap = [["Birmingham Business School, University of Birmingham, UK","Master of Business Administration","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/master-of-business-administration"],["Birmingham Business School, University of Birmingham, UK","Master of Business Administration (Innovation and Business Transformation)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/master-of-business-administration-innovation-and-business-transformation"],["Birmingham Business School, University of Birmingham, UK","Master of Business Administration (International Business and Strategy)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/master-of-business-administration-international-business-and-strategy"],["Birmingham Business School, University of Birmingham, UK","Master of Business Administration (Marketing)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/master-of-business-administration-marketing"],["Birmingham Business School, University of Birmingham, UK","Master of Science Financial Management","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/master-of-science-financial-management"],["Birmingham Business School, University of Birmingham, UK","Master of Science International Business","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/master-of-science-international-business"],["Grenoble Ecole de Management, France","MSc Finance and Investment Banking (Top-up)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/msc-finance-and-investment-banking"],["Monash College, Australia","Monash University Foundation Year","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/monash-university-foundation-year"],["RMIT University, Australia","Bachelor of Accounting","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-accounting"],["RMIT University, Australia","Bachelor of Applied Science (Aviation) (Top-up)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-applied-science-aviation-top-up"],["RMIT University, Australia","Bachelor of Business","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-business"],["RMIT University, Australia","Bachelor of Construction Management (Honours) (Top-up)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-construction-management-honours-top-up"],["RMIT University, Australia","Bachelor of Graphic Design (Top-up)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-graphic-design-top-up"],["RMIT University, Australia","Bachelor of Professional Communication","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-professional-communication"],["RMIT University, Australia","Master of Energy Efficient and Sustainable Building (Top-up)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/master-of-energy-efficient-and-sustainable-building-top-up"],["Singapore Institute of Management, Singapore","Certificate in Foundation Studies","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/certificate-in-foundation-studies"],["Singapore Institute of Management, Singapore","Certificate in Pre-Sessional Business Management","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/certificate-in-pre-sessional-business-management"],["Singapore Institute of Management, Singapore","Diploma in Accounting","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/diploma-in-accounting"],["Singapore Institute of Management, Singapore","Diploma in Banking and Finance","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/diploma-in-banking-and-finance"],["Singapore Institute of Management, Singapore","Diploma in Information Technology","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/diploma-information-technology"],["Singapore Institute of Management, Singapore","Diploma in Information Technology (E-Learning)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/diploma-in-information-technology-(e-learning)"],["Singapore Institute of Management, Singapore","Diploma in International Business","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/diploma-international-business"],["Singapore Institute of Management, Singapore","Diploma in Management Studies","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/diploma-management-studies"],["Singapore Institute of Management, Singapore","Diploma in Management Studies (E-Learning)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/diploma-in-management-studies-(e-learning)"],["Singapore Institute of Management, Singapore","Graduate Certificate in Business Analytics (Part-Time)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/graduate-certificate-business-analytics-part-time"],["Singapore Institute of Management, Singapore","Graduate Diploma in Business Analytics (Full-Time)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/graduate-diploma-in-business-analytics-full-time"],["Singapore Institute of Management, Singapore","Graduate Diploma in Business Analytics (Part-Time)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/graduate-diploma-in-business-analytics-part-time"],["Singapore Institute of Management, Singapore","Graduate Diploma in Human Resource Management (Part-Time)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/graduate-diploma-in-human-resource-management-part-time"],["Singapore Institute of Management, Singapore","Information Technology Foundation Studies","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/information-technology-foundation-studies"],["Singapore Institute of Management, Singapore","Management Foundation Studies","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/management-foundation-studies"],["Singapore Institute of Management, Singapore","Specialist Diploma in Social Entrepreneurship","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/specialist-diploma-social-entrepreneurship-part-time"],["The University of Sydney, Australia","Bachelor of Nursing (Honours)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-nursing-honours"],["The University of Sydney, Australia","Bachelor of Nursing (Post-Registration)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-nursing-post-registration"],["University at Buffalo, The State University of New York, US","Bachelor of Arts (Communication and Economics)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-arts-communication-and-economics"],["University at Buffalo, The State University of New York, US","Bachelor of Arts (Communication and International Trade)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-arts-communication-and-international-trade"],["University at Buffalo, The State University of New York, US","Bachelor of Arts (Communication and Psychology)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-arts-communication-and-psychology"],["University at Buffalo, The State University of New York, US","Bachelor of Arts (Communication and Sociology)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-arts-communication-and-sociology"],["University at Buffalo, The State University of New York, US","Bachelor of Arts (Communication)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-arts-communication"],["University at Buffalo, The State University of New York, US","Bachelor of Arts (Economics and International Trade)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-arts-economics-and-international-trade"],["University at Buffalo, The State University of New York, US","Bachelor of Arts (Economics and Psychology)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-arts-economics-and-psychology"],["University at Buffalo, The State University of New York, US","Bachelor of Arts (Economics and Sociology)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-arts-economics-and-sociology"],["University at Buffalo, The State University of New York, US","Bachelor of Arts (Economics)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-arts-economics"],["University at Buffalo, The State University of New York, US","Bachelor of Arts (International Trade and Psychology)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-arts-international-trade-and-psychology"],["University at Buffalo, The State University of New York, US","Bachelor of Arts (International Trade and Sociology)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-arts-international-trade-and-sociology"],["University at Buffalo, The State University of New York, US","Bachelor of Arts (International Trade)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-arts-international-trade"],["University at Buffalo, The State University of New York, US","Bachelor of Arts (Psychology and Sociology)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-arts-psychology-and-sociology"],["University at Buffalo, The State University of New York, US","Bachelor of Arts (Psychology)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-arts-psychology"],["University at Buffalo, The State University of New York, US","Bachelor of Arts (Sociology)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-arts-sociology"],["University at Buffalo, The State University of New York, US","Bachelor of Science (Business Administration and Geographic Information Science)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-business-administration-and-geographic-information-science"],["University at Buffalo, The State University of New York, US","Bachelor of Science (Business Administration)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-business-administration"],["University at Buffalo, The State University of New York, US","Bachelor of Science (Business Administration) and Bachelor of Arts (Communication)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-business-administration-and-bachelor-of-arts-communication"],["University at Buffalo, The State University of New York, US","Bachelor of Science (Business Administration) and Bachelor of Arts (Economics)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-business-administration-and-bachelor-of-arts-economics"],["University at Buffalo, The State University of New York, US","Bachelor of Science (Business Administration) and Bachelor of Arts (International Trade)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-business-administration-and-bachelor-of-arts-international-trade"],["University at Buffalo, The State University of New York, US","Bachelor of Science (Business Administration) and Bachelor of Arts (Psychology)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-business-administration-bachelor-of-arts-psychology"],["University at Buffalo, The State University of New York, US","Bachelor of Science (Business Administration) and Bachelor of Arts (Sociology)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-business-administration-and-bachelor-of-arts-sociology"],["University at Buffalo, The State University of New York, US","Bachelor of Science (Geographic Information Science)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-geographic-information-science"],["University at Buffalo, The State University of New York, US","Bachelor of Science (Geographic Information Science) and Bachelor of Arts (Communication)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-geographic-information-science-and-bachelor-of-arts-communication"],["University at Buffalo, The State University of New York, US","Bachelor of Science (Geographic Information Science) and Bachelor of Arts (Economics)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-geographic-information-science-and-bachelor-of-arts-economics"],["University at Buffalo, The State University of New York, US","Bachelor of Science (Geographic Information Science) and Bachelor of Arts (International Trade)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-geographic-information-science-and-bachelor-of-arts-international-trade"],["University at Buffalo, The State University of New York, US","Bachelor of Science (Geographic Information Science) and Bachelor of Arts (Psychology)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-geographic-information-science-and-bachelor-of-arts-psychology"],["University at Buffalo, The State University of New York, US","Bachelor of Science (Geographic Information Science) and Bachelor of Arts (Sociology)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-geographic-information-science-and-bachelor-of-arts-sociology"],["University of Alberta, Canada","Master of Business Administration (FastTrack)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/master-of-business-administration-(fasttrack)"],["University of Birmingham, UK","Bachelor of Science (Honours) Accounting and Finance (Top-up)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-honours-accounting-and-finance-top-up"],["University of Birmingham, UK","Bachelor of Science (Honours) Business Management (Top-up)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-honours-business-management-top-up"],["University of Birmingham, UK","Bachelor of Science (Honours) Business Management with Communications (Top-up)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-honours-business-management-communications-top-up"],["University of Birmingham, UK","Bachelor of Science (Honours) Business Management with Communications and Year in Industry (Top-up)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-honours-business-management-communications-and-year-in-industry-top-up"],["University of Birmingham, UK","Bachelor of Science (Honours) Business Management with Industrial Placement (Top-up)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-honours-business-management-industrial-placement-top-up"],["University of Birmingham, UK","Bachelor of Science (Honours) International Business (Top-up)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-honours-international-business-top-up"],["University of London, UK","Bachelor of Science (Honours) in Accounting and Finance","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-honours-in-accounting-and-finance"],["University of London, UK","Bachelor of Science (Honours) in Business and Management","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-honours-business-and-management"],["University of London, UK","Bachelor of Science (Honours) in Computer Science","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-honours-computer-science"],["University of London, UK","Bachelor of Science (Honours) in Computer Science (Machine Learning and Artificial Intelligence)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-honours-computer-science-machine-learning-and-artificial-intelligence"],["University of London, UK","Bachelor of Science (Honours) in Computer Science (Physical Computing and the Internet of Things)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-honours-computer-science-physical-computing-internet-of-things"],["University of London, UK","Bachelor of Science (Honours) in Computer Science (User Experience)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-honours-computer-science-user-experience"],["University of London, UK","Bachelor of Science (Honours) in Computer Science (Virtual Reality)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-honours-computer-science-virtual-reality"],["University of London, UK","Bachelor of Science (Honours) in Computer Science (Web and Mobile Development)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-honours-computer-science-web-and-mobile-development"],["University of London, UK","Bachelor of Science (Honours) in Data Science and Business Analytics","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-honours-data-science-and-business-analytics"],["University of London, UK","Bachelor of Science (Honours) in Economics","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-honours-economics"],["University of London, UK","Bachelor of Science (Honours) in Economics and Finance","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-honours-economics-and-finance"],["University of London, UK","Bachelor of Science (Honours) in Economics and Management","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-honours-economics-and-management"],["University of London, UK","Bachelor of Science (Honours) in Economics and Politics","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-honours-economics-and-politics"],["University of London, UK","Bachelor of Science (Honours) in Finance","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-honours-finance"],["University of London, UK","Bachelor of Science (Honours) in International Relations","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-honours-international-relations"],["University of London, UK","Bachelor of Science (Honours) in Management and Digital Innovation","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-science-management-and-digital-innovation"],["University of London, UK","Certificate of Higher Education in Social Sciences","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/certificate-of-higher-education-in-social-sciences"],["University of London, UK","Graduate Certificate in Machine Learning and Artificial Intelligence","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/graduate-certificate-in-machine-learning-artificial-intelligence"],["University of London, UK","Graduate Certificate in Mobile Development","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/graduate-certificate-in-mobile-development"],["University of London, UK","Graduate Certificate in Physical Computing and the Internet of Things","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/graduate-certificate-in-physical-computing-internet-of-things"],["University of London, UK","Graduate Certificate in User Experience","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/graduate-certificate-in-user-experience"],["University of London, UK","Graduate Certificate in Web Development","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/graduate-certificate-in-web-development"],["University of London, UK","Graduate Diploma in Business Analytics","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/graduate-diploma-in-business-analytics"],["University of London, UK","Graduate Diploma in Data Science","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/graduate-diploma-in-data-science"],["University of London, UK","Graduate Diploma in Economics","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/graduate-diploma-in-economics"],["University of London, UK","Graduate Diploma in Finance","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/graduate-diploma-in-finance"],["University of London, UK","Graduate Diploma in Machine Learning and Artificial Intelligence","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/graduate-diploma-in-machine-learning-artificial-intelligence"],["University of London, UK","Graduate Diploma in Management","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/graduate-diploma-in-management"],["University of London, UK","Graduate Diploma in Management and Digital Innovation","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/graduate-diploma-in-management-and-digital-innovation"],["University of London, UK","Graduate Diploma in Mobile Development","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/graduate-diploma-in-mobile-development"],["University of London, UK","Graduate Diploma in Physical Computing and the Internet of Things","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/graduate-diploma-in-physical-computing-internet-of-things"],["University of London, UK","Graduate Diploma in User Experience","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/graduate-diploma-in-user-experience"],["University of London, UK","Graduate Diploma in Virtual Reality","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/graduate-diploma-in-virtual-reality"],["University of London, UK","Graduate Diploma in Web Development","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/graduate-diploma-in-web-development"],["University of London, UK","International Foundation Programme","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/international-foundation-programme"],["University of London, UK","Master of Science in Professional Accountancy","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/master-of-science-in-professional-accountancy"],["University of Stirling, UK","Bachelor of Arts (Honours) Digital Media","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-arts-honours-digital-media"],["University of Stirling, UK","Bachelor of Arts (Honours) Marketing","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-arts-honours-marketing"],["University of Stirling, UK","Bachelor of Arts (Honours) Sport and Marketing","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-arts-honours-sport-and-marketing"],["University of Wollongong","Bachelor of Computer Science (Artificial Intelligence and Big Data)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-computer-science-artificial-intelligence-and-big-data"],["University of Wollongong, Australia","Bachelor of Business Information Systems","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-business-information-systems"],["University of Wollongong, Australia","Bachelor of Computer Science (Big Data) - Discontinued","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-computer-science-big-data-discontinued"],["University of Wollongong, Australia","Bachelor of Computer Science (Cyber Security)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-computer-science-cyber-security"],["University of Wollongong, Australia","Bachelor of Computer Science (Digital Systems Security)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-computer-science-digital-systems-security"],["University of Wollongong, Australia","Bachelor of Computer Science (Game and Mobile Development)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-computer-science-game-and-mobile-development"],["University of Wollongong, Australia","Bachelor of Information Technology","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-information-technology"],["University of Wollongong, Australia","Bachelor of Psychological Science","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-psychological-science"],["University of Wollongong, Australia","Double Major : Bachelor of Computer Science (Artificial Intelligence and Big Data and Cyber Security) / (Digital Systems Security and Artifi","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-computer-science-double-major"],["University of Wollongong, Australia","Double Major : Bachelor of Computer Science (Digital Systems Security and Big Data) / (Big Data and Cyber Security) - Discontinued","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/bachelor-of-computer-science-double-major-digital-systems-security-and-big-data-big-data-and-cs"],["University of Wollongong, Australia","Master of Computing (Data Analytics) (Top-up)","https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing/master-of-computing-(data-analytics)"]];

    // Curtin 全课程（来源：curtin.edu.sg sitemap，离线内置）
    const curtinProgrammeSitemap = [["Curtin University","Academic English 4","https://www.curtin.edu.sg/courses/english-courses/academic-english-4/"],["Curtin University","Accounting","https://www.curtin.edu.sg/courses/undergraduate/bachelor-of-commerce/accounting/"],["Curtin University","Accounting and Finance","https://www.curtin.edu.sg/courses/undergraduate/bachelor-of-commerce/accounting-and-finance/"],["Curtin University","Bachelor of Commerce","https://www.curtin.edu.sg/courses/undergraduate/bachelor-of-commerce/"],["Curtin University","Bachelor of Communications (Top-Up)","https://www.curtin.edu.sg/courses/undergraduate/communications/"],["Curtin University","Bachelor of Computing (Cyber Security)","https://www.curtin.edu.sg/courses/undergraduate/bachelor-of-computing-cyber-security/"],["Curtin University","Bachelor of Information Technology","https://www.curtin.edu.sg/courses/undergraduate/bachelor-of-information-technology/"],["Curtin University","Bachelor of Science (Nursing) Conversion Program for Registered Nurses (Top-up)","https://www.curtin.edu.sg/courses/undergraduate/nursing-conversion-program-for-registered-nurses/"],["Curtin University","Clinical Leadership Specialisation","https://www.curtin.edu.sg/courses/postgraduate/master-of-advanced-practice/clinical-leadership-specialisation/"],["Curtin University","Diploma","https://www.curtin.edu.sg/courses/diploma/"],["Curtin University","Diploma of Arts and Creative Industries","https://www.curtin.edu.sg/courses/diploma/diploma-of-arts-and-creative-industries/"],["Curtin University","Diploma of Commerce","https://www.curtin.edu.sg/courses/diploma/diploma-of-commerce/"],["Curtin University","Diploma of English for Academic Purposes","https://www.curtin.edu.sg/courses/english-courses/english-for-academic-purposes/"],["Curtin University","Diploma of Information Technology","https://www.curtin.edu.sg/courses/diploma/diploma-of-information-technology/"],["Curtin University","Doctor of Philosophy (PhD)","https://www.curtin.edu.sg/courses/phd/"],["Curtin University","English language courses","https://www.curtin.edu.sg/courses/english-courses/"],["Curtin University","Finance","https://www.curtin.edu.sg/courses/undergraduate/bachelor-of-commerce/finance/"],["Curtin University","Finance and Management","https://www.curtin.edu.sg/courses/undergraduate/bachelor-of-commerce/finance-and-management/"],["Curtin University","Finance and Marketing","https://www.curtin.edu.sg/courses/undergraduate/bachelor-of-commerce/finance-and-marketing/"],["Curtin University","Graduate Certificate in Business Fundamentals","https://www.curtin.edu.sg/courses/postgraduate/graduate-certificate-in-business-fundamentals/"],["Curtin University","Graduate Certificate in Clinical Leadership","https://www.curtin.edu.sg/courses/postgraduate/graduate-certificate-in-clinical-leadership/"],["Curtin University","Graduate Certificate in Predictive Analytics","https://www.curtin.edu.sg/courses/postgraduate/graduate-certificate-in-predictive-analytics/"],["Curtin University","Graduate Certificate in Supply Chain Management","https://www.curtin.edu.sg/courses/postgraduate/graduate-certificate-in-supply-chain-management/"],["Curtin University","Graduate Certificate in Wound, Ostomy and Continence Practice","https://www.curtin.edu.sg/courses/postgraduate/graduate-certificate-in-wound-ostomy-continence-practice/"],["Curtin University","Graduate Diploma in Predictive Analytics","https://www.curtin.edu.sg/courses/postgraduate/graduate-diploma-in-predictive-analytics/"],["Curtin University","Graduate Diploma in Wound, Ostomy and Continence Practice (Teach-out)","https://www.curtin.edu.sg/courses/postgraduate/graduate-diploma-in-wound-ostomy-and-continence-practice/"],["Curtin University","International Business","https://www.curtin.edu.sg/courses/undergraduate/bachelor-of-commerce/international-business/"],["Curtin University","Journalism and Marketing Communication Specialisation","https://www.curtin.edu.sg/courses/undergraduate/communications/journalism-and-marketing/"],["Curtin University","Journalism and Web Media Specialisation","https://www.curtin.edu.sg/courses/undergraduate/communications/journalism-and-web-media/"],["Curtin University","Logistics and Supply Chain Management","https://www.curtin.edu.sg/courses/undergraduate/bachelor-of-commerce/logistics-and-supply-chain-management/"],["Curtin University","Logistics and Supply Chain Management and Marketing","https://www.curtin.edu.sg/courses/undergraduate/bachelor-of-commerce/logistics-and-supply-chain-management-and-marketing/"],["Curtin University","Management","https://www.curtin.edu.sg/courses/undergraduate/bachelor-of-commerce/management/"],["Curtin University","Management and Human Resource Management","https://www.curtin.edu.sg/courses/undergraduate/bachelor-of-commerce/management-and-human-resource-management/"],["Curtin University","Management and Marketing","https://www.curtin.edu.sg/courses/undergraduate/bachelor-of-commerce/management-and-marketing/"],["Curtin University","Marketing","https://www.curtin.edu.sg/courses/undergraduate/bachelor-of-commerce/marketing/"],["Curtin University","Master of Advanced Practice","https://www.curtin.edu.sg/courses/postgraduate/master-of-advanced-practice/"],["Curtin University","Master of Artificial Intelligence","https://www.curtin.edu.sg/courses/postgraduate/master-of-artificial-intelligence/"],["Curtin University","Master of Computing","https://www.curtin.edu.sg/courses/postgraduate/master-of-computing/"],["Curtin University","Master of Computing – Artificial Intelligence major","https://www.curtin.edu.sg/courses/postgraduate/master-of-computing/artificial-intelligence/"],["Curtin University","Master of Computing – Computer Science major","https://www.curtin.edu.sg/courses/postgraduate/master-of-computing/computer-science/"],["Curtin University","Master of Computing – Cyber Security major","https://www.curtin.edu.sg/courses/postgraduate/master-of-computing/cyber-security/"],["Curtin University","Master of Cyber Security","https://www.curtin.edu.sg/courses/postgraduate/master-of-cybersecurity/"],["Curtin University","Master of International Business","https://www.curtin.edu.sg/courses/postgraduate/master-of-international-business-2/"],["Curtin University","Master of Predictive Analytics – Data Science major","https://www.curtin.edu.sg/courses/postgraduate/master-of-predictive-analytics-data-science-major/"],["Curtin University","Master of Science (Health Practice) Clinical Leadership Major (Teach-out)","https://www.curtin.edu.sg/courses/postgraduate/master-of-science-health-practice/"],["Curtin University","Master of Supply Chain Management (Professional)","https://www.curtin.edu.sg/courses/postgraduate/master-of-supply-chain-management-professional/"],["Curtin University","Postgraduate courses","https://www.curtin.edu.sg/courses/postgraduate/"],["Curtin University","Study Abroad","https://www.curtin.edu.sg/courses/study-abroad/"],["Curtin University","Undergraduate courses","https://www.curtin.edu.sg/courses/undergraduate/"],["Curtin University","Web Media and Marketing Communication Specialisation","https://www.curtin.edu.sg/courses/undergraduate/communications/web-media-and-marketing/"],["Curtin University","Wound, Ostomy and Continence Nursing Practice Specialisation","https://www.curtin.edu.sg/courses/postgraduate/master-of-advanced-practice/wound-ostomy-and-continence-practice-specialisation/"]];

    // LSBF 全课程（来源：lsbf.edu.sg sitemap，离线内置）
    const lsbfProgrammeSitemap = [["LSBF","ASIA WINTER PROGRAMME – SINGAPORE (2026)","https://www.lsbf.edu.sg/programme/asia-winter-programme-singapore-2026-ai-uni-level"],["LSBF","Advanced Certificate in Healthcare and Social Care Management","https://www.lsbf.edu.sg/programme/advanced-certificate-in-healthcare-and-social-care-management"],["LSBF","Advanced Diploma in Accounting and Finance","https://www.lsbf.edu.sg/programmes/diploma/advanced-diploma-in-accounting-and-finance"],["LSBF","Advanced Diploma in Accounting and Finance (Mandarin)","https://www.lsbf.edu.sg/programmes/chinese-programme/advanced-diploma-in-accounting-and-finance-mandarin"],["LSBF","Advanced Diploma in Business Administration (Mandarin)","https://www.lsbf.edu.sg/programmes/chinese-programme/advanced-diploma-in-business-administration-mandarin"],["LSBF","Advanced Diploma in Business Studies","https://www.lsbf.edu.sg/programmes/diploma/advanced-diploma-in-business-studies"],["LSBF","Advanced Diploma in Global Logistics and Supply Chain Management (Mandarin)","https://www.lsbf.edu.sg/programmes/chinese-programme/advanced-diploma-in-global-logistics-and-supply-chain-management-mandarin"],["LSBF","Advanced Diploma in Hospitality and Tourism Management","https://www.lsbf.edu.sg/programmes/diploma/advanced-diploma-in-hospitality-and-tourism-management"],["LSBF","Advanced Diploma in Hospitality and Tourism Management (Mandarin)","https://www.lsbf.edu.sg/programmes/chinese-programme/advanced-diploma-in-hospitality-and-tourism-management-mandarin"],["LSBF","Advanced Diploma in Logistics and Supply Chain Management","https://www.lsbf.edu.sg/programmes/diploma/advanced-diploma-in-logistics-and-supply-chain-management"],["LSBF","Asia Summer School Programme – Singapore & Malaysia (2025)","https://www.lsbf.edu.sg/programmes/languages/lsbf-asia-summer-school"],["LSBF","Asia Winter Programme – Singapore (2026)","https://www.lsbf.edu.sg/programme/asia-winter-programme-singapore-2026-high-school-ai"],["LSBF","BSc (Hons) in Applied Accounting","https://www.lsbf.edu.sg/programmes/acca/bsc-hons-in-applied-accounting"],["LSBF","Bachelor of Arts (Honours) Accounting and Finance","https://www.lsbf.edu.sg/programmes/undergraduate/bachelor-of-arts-honours-accounting-and-finance"],["LSBF","Bachelor of Arts (Honours) Business Management","https://www.lsbf.edu.sg/programmes/undergraduate/bachelor-of-arts-honours-business-management"],["LSBF","Bachelor of Arts (Honours) in Accounting and Finance (Top-up)","https://www.lsbf.edu.sg/programmes/undergraduate/bachelor-of-arts-honours-in-accounting-and-finance"],["LSBF","Bachelor of Arts (Honours) in Business Logistics and Transport Management (Top-Up)","https://www.lsbf.edu.sg/programmes/online-courses/bachelor-of-arts-honours-in-business-logistics-and-transport-management-top-up"],["LSBF","Bachelor of Arts (Honours) in Business Studies (Top-up)","https://www.lsbf.edu.sg/programmes/undergraduate/bachelor-of-arts-honours-in-business-studies"],["LSBF","Bachelor of Arts (Honours) in Hospitality Management (Top-up)","https://www.lsbf.edu.sg/programmes/undergraduate/bachelor-of-arts-hons-in-hospitality-management"],["LSBF","Bachelor of Science (Honours) Computer Science","https://www.lsbf.edu.sg/programmes/undergraduate/bachelor-of-science-honours-computer-science"],["LSBF","Bachelor of Science (Honours) Cyber Security Networks","https://www.lsbf.edu.sg/programmes/undergraduate/bachelor-of-science-honours-cyber-security-networks"],["LSBF","Cash Management","https://www.lsbf.edu.sg/programmes/executive-development/cash-management"],["LSBF","Certificate in Business (Mandarin)","https://www.lsbf.edu.sg/programmes/chinese-programme/certificate-in-business-mandarin"],["LSBF","Certificate in Digital Technologies: AI, Cloud and Cybersecurity","https://www.lsbf.edu.sg/programmes/executive-development/certificate-in-digital-technologies-ai-cloud-and-cybersecurity"],["LSBF","Certificate in Mandarin for Business (CMB)","https://www.lsbf.edu.sg/programmes/chinese-programme/certificate-in-mandarin-for-business"],["LSBF","Certificate in Robotics Programming","https://www.lsbf.edu.sg/programmes/diploma/certificate-in-robotics-programming"],["LSBF","Diploma in Accounting and Finance","https://www.lsbf.edu.sg/programmes/diploma/diploma-in-accounting-and-finance"],["LSBF","Diploma in Accounting and Finance (Mandarin)","https://www.lsbf.edu.sg/programmes/chinese-programme/diploma-in-accounting-and-finance-mandarin"],["LSBF","Diploma in Applied Hospitality Skills","https://www.lsbf.edu.sg/programmes/diploma/diploma-in-applied-hospitality-skills"],["LSBF","Diploma in Applied Hospitality Skills (Mandarin)","https://www.lsbf.edu.sg/programmes/chinese-programme/diploma-in-applied-hospitality-skills-mandarin"],["LSBF","Diploma in Banking and Finance","https://www.lsbf.edu.sg/programmes/diploma/diploma-in-banking-and-finance"],["LSBF","Diploma in Biomedical Science","https://www.lsbf.edu.sg/programmes/diploma/diploma-in-biomedical-science"],["LSBF","Diploma in Business Administration (Mandarin)","https://www.lsbf.edu.sg/programmes/chinese-programme/diploma-in-business-administration-mandarin"],["LSBF","Diploma in Business Studies","https://www.lsbf.edu.sg/programmes/diploma/diploma-in-business-studies"],["LSBF","Diploma in Data Analytics","https://www.lsbf.edu.sg/programmes/diploma/diploma-in-data-analytics"],["LSBF","Diploma in Global Logistics and Supply Chain Management (Mandarin)","https://www.lsbf.edu.sg/programmes/chinese-programme/diploma-in-global-logistics-and-supply-chain-management-mandarin"],["LSBF","Diploma in Information Technology","https://www.lsbf.edu.sg/programmes/diploma/diploma-in-information-technology"],["LSBF","Diploma in International Business (Mandarin)","https://www.lsbf.edu.sg/programmes/chinese-programme/diploma-in-international-business-mandarin"],["LSBF","Diploma in International Hospitality Management","https://www.lsbf.edu.sg/programmes/diploma/diploma-in-international-hospitality-management"],["LSBF","Diploma in International Hospitality Management (Mandarin)","https://www.lsbf.edu.sg/programmes/chinese-programme/diploma-in-international-hospitality-management-mandarin"],["LSBF","Diploma in Law","https://www.lsbf.edu.sg/programmes/diploma/diploma-in-law"],["LSBF","Diploma in Logistics and Supply Chain Management","https://www.lsbf.edu.sg/programmes/diploma/diploma-in-logistics-and-supply-chain-management"],["LSBF","Diploma in Metaverse Gaming and Edge Computing","https://www.lsbf.edu.sg/programmes/diploma/diploma-in-metaverse-gaming-and-edge-computing"],["LSBF","Enterprise Risk Management (in collaboration with Deloitte)","https://www.lsbf.edu.sg/programmes/executive-development/enterprise-risk-management"],["LSBF","Finance & Accounting for Banking & Finance Professionals","https://www.lsbf.edu.sg/programmes/executive-development/finance-accounting-for-banking-finance-professionals"],["LSBF","Foundation Diploma","https://www.lsbf.edu.sg/programmes/diploma/foundation-diploma"],["LSBF","Higher Diploma in Accounting and Finance","https://www.lsbf.edu.sg/programmes/diploma/higher-diploma-in-accounting-and-finance"],["LSBF","Higher Diploma in Accounting and Finance (Mandarin)","https://www.lsbf.edu.sg/programmes/chinese-programme/higher-diploma-in-accounting-and-finance-mandarin"],["LSBF","Higher Diploma in Advanced Technology and AI","https://www.lsbf.edu.sg/programmes/diploma/higher-diploma-in-advanced-technology-and-ai"],["LSBF","Higher Diploma in Biomedical Science","https://www.lsbf.edu.sg/programmes/diploma/higher-diploma-in-biomedical-science"],["LSBF","Higher Diploma in Business Studies","https://www.lsbf.edu.sg/programmes/diploma/higher-diploma-in-business-studies"],["LSBF","Higher Diploma in Computer Science","https://www.lsbf.edu.sg/programmes/diploma/higher-diploma-in-computer-science"],["LSBF","Higher Diploma in Cyber Security and Networks","https://www.lsbf.edu.sg/programmes/diploma/higher-diploma-in-cyber-security-and-networks"],["LSBF","Higher Diploma in Data Science and Analytics","https://www.lsbf.edu.sg/programmes/diploma/higher-diploma-in-data-science-and-analytics"],["LSBF","Higher Diploma in Global Logistics and Supply Chain Management (Mandarin)","https://www.lsbf.edu.sg/programmes/chinese-programme/higher-diploma-in-global-logistics-and-supply-chain-management-mandarin"],["LSBF","Higher Diploma in Healthcare and Social Care Management","https://www.lsbf.edu.sg/programmes/diploma/higher-diploma-in-healthcare-and-social-care-management"],["LSBF","Higher Diploma in Hospitality and Tourism Management","https://www.lsbf.edu.sg/programmes/diploma/higher-diploma-in-hospitality-and-tourism-management"],["LSBF","Higher Diploma in International Business (Mandarin)","https://www.lsbf.edu.sg/programmes/chinese-programme/higher-diploma-in-international-business-mandarin"],["LSBF","Higher Diploma in Logistics and Supply Chain Management","https://www.lsbf.edu.sg/programmes/diploma/higher-diploma-in-logistics-and-supply-chain-management"],["LSBF","International Foundation Diploma in Biomedical Science","https://www.lsbf.edu.sg/programmes/diploma/international-foundation-diploma-in-biomedical-science"],["LSBF","Logistics & Supply Chain Management","https://www.lsbf.edu.sg/programmes/executive-development/logistics-supply-chain-management"],["LSBF","MA Media and Communication Industries","https://www.lsbf.edu.sg/programmes/postgraduate/ma-media-and-communication-industries"],["LSBF","Master of Arts Education","https://www.lsbf.edu.sg/programmes/postgraduate/master-of-arts-education"],["LSBF","Master of Arts International Business","https://www.lsbf.edu.sg/programme/master-of-arts-in-international-business"],["LSBF","Master of Arts in Logistics and Supply Chain Management","https://www.lsbf.edu.sg/programmes/postgraduate/master-of-arts-in-logistics-and-supply-chain-management"],["LSBF","Master of Business Administration (MBA) in International Business","https://www.lsbf.edu.sg/programme/master-of-business-administration-in-international-business"],["LSBF","Master of Business Administration – Global","https://www.lsbf.edu.sg/programmes/postgraduate/master-of-business-administration"],["LSBF","Master of Science Engineering Management","https://www.lsbf.edu.sg/programmes/postgraduate/master-of-science-engineering-management"],["LSBF","Master of Science Finance and Investment","https://www.lsbf.edu.sg/programmes/postgraduate/master-of-science-finance-and-investment"],["LSBF","Master of Science Financial Technology","https://www.lsbf.edu.sg/programme/master-of-science-financial-technology"],["LSBF","Master of Science Global Health Management","https://www.lsbf.edu.sg/programmes/postgraduate/master-of-science-global-health-management"],["LSBF","Master of Science in Computer Science","https://www.lsbf.edu.sg/programmes/postgraduate/master-of-science-in-computer-science"],["LSBF","Master of Science in Information Security and Digital Forensics","https://www.lsbf.edu.sg/programmes/postgraduate/master-of-science-in-information-security-and-digital-forensics"],["LSBF","New Manager Toolkit Programme","https://www.lsbf.edu.sg/programmes/executive-development/new-manager-toolkit"],["LSBF","Postgraduate Diploma in Business","https://www.lsbf.edu.sg/programmes/postgraduate/postgraduate-diploma-in-business"],["LSBF","Postgraduate Diploma in Cybersecurity","https://www.lsbf.edu.sg/programmes/postgraduate/postgraduate-diploma-in-cybersecurity"],["LSBF","Postgraduate Diploma in Hospitality and Tourism Management","https://www.lsbf.edu.sg/programmes/postgraduate/postgraduate-diploma-in-hospitality-and-tourism-management"],["LSBF","Practical Inventory and Warehouse Management","https://www.lsbf.edu.sg/programmes/executive-development/practical-inventory-and-warehouse-management"],["LSBF","Preparatory Course for ACCA","https://www.lsbf.edu.sg/programmes/acca/preparatory-course-for-acca"],["LSBF","Preparatory Course for International English Language Testing System (IELTS)","https://www.lsbf.edu.sg/programmes/languages/ielts"],["LSBF","Preparatory Course for Singapore CA Qualification","https://www.lsbf.edu.sg/programmes/professional-qualifications/prep-scaq"],["LSBF","Preparatory Course in English (PCE)","https://www.lsbf.edu.sg/programmes/languages/preparatory-course-in-english-pce"],["LSBF","Preventing and Detecting Different Types of Procurement Fraud","https://www.lsbf.edu.sg/programmes/executive-development/preventing-and-detecting-different-types-of-procurement-fraud"],["LSBF","Trade Finance Management","https://www.lsbf.edu.sg/programmes/executive-development/trade-finance-management"],["LSBF","Weekly General English","https://www.lsbf.edu.sg/programmes/languages/weekly-general-english"]];

    const cardList = document.getElementById("card-list");
    const emptyState = document.getElementById("empty-state");
    const quickListEl = document.getElementById("quick-list");
    const quickEmptyEl = document.getElementById("quick-empty");
    const quickMetaEl = document.getElementById("quick-meta");
    const runtimeStatusEl = document.getElementById("runtime-status");
    const shortlistEl = document.getElementById("shortlist");
    const shortlistEmpty = document.getElementById("shortlist-empty");
    const detailOverlayEl = document.getElementById("detail-overlay");
    const detailTitleEl = document.getElementById("detail-title");
    const detailSubtitleEl = document.getElementById("detail-subtitle");
    const detailPillsEl = document.getElementById("detail-pills");
    const detailKvEl = document.getElementById("detail-kv");
    const detailCloseBtn = document.getElementById("detail-close");
    const detailAddBtn = document.getElementById("detail-add");
    const detailRemoveBtn = document.getElementById("detail-remove");
    const detailSalesDecBtn = document.getElementById("detail-sales-dec");
    const detailSalesIncBtn = document.getElementById("detail-sales-inc");
    const detailSalesCountEl = document.getElementById("detail-sales-count");
    const detailOfficialEl = document.getElementById("detail-official");
    const routeResultsEl = document.getElementById("route-results");
    const routeResultsNoteEl = document.getElementById("route-results-note");
    const shortlist = new Map();
    let currentPrograms = [];
    let currentProgramsById = new Map();
    let lastRouteStats = null;
    let detailOpenProgramId = null;
    let detailModalBound = false;
    let detailPrevBodyOverflow = "";

    const rank = (v) => eduRank[v] || 0;

    function formatErr(err) {
      if (!err) return "未知错误";
      if (typeof err === "string") return err;
      if (err && err.message) return String(err.message);
      try { return JSON.stringify(err); } catch { return String(err); }
    }

    function setRuntimeStatus(msg) {
      if (!runtimeStatusEl) return;
      runtimeStatusEl.textContent = String(msg || "").trim() || "运行状态 / Status：—";
    }

    try {
      setRuntimeStatus("运行状态 / Status：脚本已加载，正在初始化… / script loaded, initializing…");
      window.addEventListener("error", (e) => {
        const msg = e && e.message ? e.message : "未知错误";
        setRuntimeStatus(`运行状态 / Status：错误 / error（${msg}）`);
      });
      window.addEventListener("unhandledrejection", (e) => {
        setRuntimeStatus(`运行状态 / Status：错误 / error（${formatErr(e && e.reason)}）`);
      });
    } catch {
      // ignore
    }

    const salesCountStorageKey = "maple_matchboard_sales_counts_v1";
    let salesCountById = loadSalesCounts();

    function loadSalesCounts() {
      try {
        const raw = localStorage.getItem(salesCountStorageKey);
        if (!raw) return new Map();
        const parsed = JSON.parse(raw);
        const obj = (parsed && typeof parsed === "object" && parsed.counts && typeof parsed.counts === "object")
          ? parsed.counts
          : (parsed && typeof parsed === "object" ? parsed : {});
        const map = new Map();
        Object.entries(obj).forEach(([id, val]) => {
          const num = Number(val);
          if (!id) return;
          if (!Number.isFinite(num) || num <= 0) return;
          map.set(String(id), Math.floor(num));
        });
        return map;
      } catch {
        return new Map();
      }
    }

    function persistSalesCounts() {
      try {
        const counts = Object.fromEntries(salesCountById.entries());
        localStorage.setItem(salesCountStorageKey, JSON.stringify({
          schema_version: 1,
          updated_at: new Date().toISOString(),
          counts,
        }));
      } catch {
        // ignore
      }
    }

    function getSalesCount(programId) {
      const id = String(programId || "").trim();
      if (!id) return 0;
      const n = salesCountById.get(id);
      return Number.isFinite(n) && n > 0 ? n : 0;
    }

    function bumpSalesCount(programId, delta) {
      const id = String(programId || "").trim();
      if (!id) return;
      const cur = getSalesCount(id);
      const next = Math.max(0, Math.floor(cur + Number(delta || 0)));
      if (next === cur) return;
      if (next === 0) salesCountById.delete(id);
      else salesCountById.set(id, next);
      persistSalesCounts();
    }

    function programOfficialUrl(p) {
      if (!p || typeof p !== "object") return "";
      const url = String(p.official || (p.sources && p.sources.official) || "").trim();
      return url;
    }

    function formatSgdAmount(value) {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) return "";
      return `S$${Math.round(n).toLocaleString()}`;
    }

    function programTuitionRangeLabel(p) {
      const min = (p && Number.isFinite(p.tuitionSgdMin) && p.tuitionSgdMin > 0) ? p.tuitionSgdMin : null;
      const max = (p && Number.isFinite(p.tuitionSgdMax) && p.tuitionSgdMax > 0) ? p.tuitionSgdMax : null;
      if (min != null && max != null) {
        if (Math.round(min) === Math.round(max)) return formatSgdAmount(max);
        return `${formatSgdAmount(min)}–${formatSgdAmount(max)}`;
      }
      if (max != null) return `≤ ${formatSgdAmount(max)}`;
      if (min != null) return `≥ ${formatSgdAmount(min)}`;
      return "";
    }

    function programDurationMonthsLabel(p) {
      const min = (p && Number.isFinite(p.durationMonthsMin) && p.durationMonthsMin > 0) ? p.durationMonthsMin : null;
      const max = (p && Number.isFinite(p.durationMonthsMax) && p.durationMonthsMax > 0) ? p.durationMonthsMax : null;
      if (min != null && max != null) {
        if (Math.round(min) === Math.round(max)) return `${Math.round(max)} mo`;
        return `${Math.round(min)}–${Math.round(max)} mo`;
      }
      if (max != null) return `≤ ${Math.round(max)} mo`;
      if (min != null) return `≥ ${Math.round(min)} mo`;
      return "";
    }

    function isProgramDetailsOpen() {
      return !!(detailOverlayEl && detailOverlayEl.classList.contains("open"));
    }

    function closeProgramDetails() {
      if (!detailOverlayEl) return;
      detailOpenProgramId = null;
      detailOverlayEl.classList.remove("open");
      detailOverlayEl.setAttribute("aria-hidden", "true");
      try { document.body.style.overflow = detailPrevBodyOverflow || ""; } catch {}
    }

    function openProgramDetails(programId) {
      if (!detailOverlayEl || !detailTitleEl || !detailKvEl) return;
      const id = String(programId || "").trim();
      if (!id) return;
      const p = currentProgramsById.get(id) || shortlist.get(id);
      if (!p) return;

      detailOpenProgramId = id;
      const officialUrl = programOfficialUrl(p);
      const sales = getSalesCount(id);

      detailTitleEl.textContent = String(p.name || "—");

      if (detailSubtitleEl) {
        const parts = [];
        if (p.provider) parts.push(String(p.provider));
        if (p.partner) parts.push(String(p.partner));
        const levelLabel = awardLevelLabel(p.awardLevel) || p.awardLevel;
        if (levelLabel) parts.push(String(levelLabel));
        detailSubtitleEl.textContent = parts.join(" · ") || "—";
      }

      if (detailSalesCountEl) detailSalesCountEl.textContent = `${bi("销量", "Sales")} ${sales}`;

      const inShortlist = shortlist.has(id);
      if (detailAddBtn) detailAddBtn.style.display = inShortlist ? "none" : "";
      if (detailRemoveBtn) detailRemoveBtn.style.display = inShortlist ? "" : "none";

      if (detailOfficialEl) {
        if (officialUrl) {
          detailOfficialEl.href = officialUrl;
          detailOfficialEl.style.display = "";
        } else {
          detailOfficialEl.removeAttribute("href");
          detailOfficialEl.style.display = "none";
        }
      }

      if (detailPillsEl) {
        const pills = [];
        const pushPill = (text, extraClass, title) => {
          const t = String(text || "").trim();
          if (!t) return;
          pills.push(`<span class="pill${extraClass ? " " + extraClass : ""}"${title ? ` title="${escapeHtml(String(title))}"` : ""}>${escapeHtml(t)}</span>`);
        };

        if (p.provider) pushPill(p.provider);
        if (p.partner) pushPill(p.partner);
        const levelLabel = awardLevelLabel(p.awardLevel) || p.awardLevel;
        if (levelLabel) pushPill(levelLabel);
        if (p.cscseStatus) pushPill(`${bi("留服", "CSCSE")}：${bi(cscseLabel(p.cscseStatus), cscseLabelEn(p.cscseStatus))}`, cscsePillClass(p.cscseStatus));

        const routes = Array.isArray(p.routes) ? p.routes : [];
        routes.forEach((r) => pushPill(bi(routeLabel(r), routeLabelEn(r))));

        const majors = (Array.isArray(p.majors) && p.majors.length) ? p.majors : (p.major ? [p.major] : []);
        majors.slice(0, 6).forEach((m) => pushPill(bi(majorLabel(m), majorLabelEn(m))));

        if (Number.isFinite(p.qsRank) && p.qsRank > 0) pushPill(`QS ${Math.round(p.qsRank)}`);
        else if (p.qs) pushPill(p.qs);

        if (Number.isFinite(p.durationMonthsMax) && p.durationMonthsMax > 0) pushPill(`≤${Math.round(p.durationMonthsMax)}mo`);
        if (Number.isFinite(p.tuitionSgdMax) && p.tuitionSgdMax > 0) pushPill(`Fees≤S$${Math.round(p.tuitionSgdMax).toLocaleString()}`);

        detailPillsEl.innerHTML = pills.join("");
      }

      const routes = Array.isArray(p.routes) ? p.routes : [];
      const majors = (Array.isArray(p.majors) && p.majors.length) ? p.majors : (p.major ? [p.major] : []);

      const minEduKey = String(p.minEdu || "").trim() || ((Number.isFinite(p.minEduRank) && p.minEduRank > 0) ? eduKeyFromRank(p.minEduRank) : "");
      const eduText = minEduKey ? bi(eduLabel(minEduKey), eduLabelEn(minEduKey)) : "—";

      const ageReq = [];
      if (p.ageMin != null && Number.isFinite(Number(p.ageMin))) ageReq.push(`≥ ${Math.round(Number(p.ageMin))}`);
      if (p.ageMax != null && Number.isFinite(Number(p.ageMax))) ageReq.push(`≤ ${Math.round(Number(p.ageMax))}`);
      const ageText = ageReq.length ? ageReq.join(" · ") : "—";

      const budgetText = (p.budgetMin != null && Number.isFinite(Number(p.budgetMin)) && Number(p.budgetMin) > 0)
        ? `≥ SGD ${Math.round(Number(p.budgetMin)).toLocaleString()}/yr`
        : "";
      const tuitionRange = programTuitionRangeLabel(p);
      const tuitionText = tuitionRange || String(p.tuition || p.tuitionEstimate || "").trim() || "—";
      const durationText = String(p.duration || p.duration_text || "").trim();
      const durationMonthsText = programDurationMonthsLabel(p);
      const intakesText = String(p.intakes || p.intake_text || "").trim();
      const processText = String(p.process || p.process_text || "").trim();
      const pricingText = convertRefundTextToSgd(String(p.pricingNote || p.tuitionEstimate || ""), readFxCnyPerSgd()) || "—";
      const highlightText = String(p.highlights || "").trim();
      const tagText = (Array.isArray(p.tags) && p.tags.length) ? p.tags.slice(0, 40).join(" · ") : "";

      const kvs = [
        { k: bi("路线", "Track"), v: routes.length ? routes.map((r) => bi(routeLabel(r), routeLabelEn(r))).join(" · ") : "—" },
        { k: bi("专业/方向", "Major"), v: majors.length ? majors.map((m) => bi(majorLabel(m), majorLabelEn(m))).join(" · ") : "—" },
        { k: bi("最低学历", "Minimum education"), v: eduText },
        { k: bi("年龄要求", "Age"), v: ageText },
        { k: bi("年预算", "Annual budget"), v: budgetText || "—" },
        { k: bi("总学费", "Tuition"), v: tuitionText },
        { k: bi("学制", "Duration"), v: durationText || "—" },
        ...(durationMonthsText ? [{ k: bi("学制（月）", "Duration (months)"), v: durationMonthsText }] : []),
        { k: bi("开课/入学", "Intakes"), v: intakesText || "—" },
        { k: bi("申请费", "Application fee"), v: convertRefundTextToSgd(p.appFee || "待确认", readFxCnyPerSgd()) },
        { k: bi("流程", "Process"), v: processText || "—" },
        { k: bi("价格/返佣摘要", "Pricing / Notes"), v: pricingText },
        { k: bi("亮点", "Highlights"), v: highlightText || "—" },
        ...(p.cscseStatus ? [{ k: bi("留服认证", "CSCSE"), v: bi(cscseLabel(p.cscseStatus), cscseLabelEn(p.cscseStatus)) }] : []),
        ...((p.qs || (Number.isFinite(p.qsRank) && p.qsRank > 0)) ? [{ k: bi("QS 排名", "QS"), v: String(p.qs || `QS ${Math.round(p.qsRank)}`) }] : []),
        ...(tagText ? [{ k: bi("标签", "Tags"), v: tagText }] : []),
        ...(officialUrl ? [{ k: bi("官网链接", "Official link"), vHtml: `<a href="${escapeHtml(officialUrl)}" target="_blank" rel="noreferrer">${escapeHtml(officialUrl)}</a>` }] : []),
      ];

      detailKvEl.innerHTML = kvs.map(({ k, v, vHtml }) => `
        <div class="kv-item">
          <div class="k">${escapeHtml(String(k || ""))}</div>
          <div class="v">${vHtml != null ? vHtml : escapeHtml(String(v || "—"))}</div>
        </div>
      `).join("");

      try {
        if (!isProgramDetailsOpen()) {
          detailPrevBodyOverflow = document.body.style.overflow;
          document.body.style.overflow = "hidden";
        }
      } catch {}
      detailOverlayEl.classList.add("open");
      detailOverlayEl.setAttribute("aria-hidden", "false");
      if (detailCloseBtn) detailCloseBtn.focus({ preventScroll: true });
    }

    function bindProgramDetailsModalOnce() {
      if (detailModalBound) return;
      detailModalBound = true;

      if (detailCloseBtn) detailCloseBtn.addEventListener("click", closeProgramDetails);
      if (detailOverlayEl) {
        detailOverlayEl.addEventListener("click", (e) => {
          if (e.target === detailOverlayEl) closeProgramDetails();
        });
      }
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && isProgramDetailsOpen()) closeProgramDetails();
      });

      if (detailAddBtn) {
        detailAddBtn.addEventListener("click", () => {
          const id = detailOpenProgramId;
          if (!id) return;
          const picked = currentProgramsById.get(id) || shortlist.get(id);
          if (picked) addToShortlist(picked);
          render(currentPrograms);
          openProgramDetails(id);
        });
      }

      if (detailRemoveBtn) {
        detailRemoveBtn.addEventListener("click", () => {
          const id = detailOpenProgramId;
          if (!id) return;
          removeFromShortlist(id);
          render(currentPrograms);
          openProgramDetails(id);
        });
      }

      if (detailSalesIncBtn) {
        detailSalesIncBtn.addEventListener("click", () => {
          const id = detailOpenProgramId;
          if (!id) return;
          bumpSalesCount(id, 1);
          render(currentPrograms);
          openProgramDetails(id);
        });
      }

      if (detailSalesDecBtn) {
        detailSalesDecBtn.addEventListener("click", () => {
          const id = detailOpenProgramId;
          if (!id) return;
          bumpSalesCount(id, -1);
          render(currentPrograms);
          openProgramDetails(id);
        });
      }
    }

    const SALES_REMINDER_ITEMS = [
      { id: "passport", label: "护照/身份证", note: "扫描件/有效期确认" },
      { id: "education", label: "学历材料", note: "成绩单/毕业证/在读证明" },
      { id: "english", label: "语言成绩", note: "IELTS/TOEFL/同等证明" },
      { id: "cv_ps", label: "文书材料", note: "简历/CV/PS/推荐信（如需）" },
      { id: "finance", label: "资金与付款", note: "预算确认/押金/付款节点" },
      { id: "deadline", label: "时间节点", note: "开学日期/申请截止日期" },
      { id: "medical", label: "体检与入境", note: "体检/疫苗/IPA/签证节点" },
      { id: "others", label: "其他提醒", note: "按客户情况补充" },
    ];

    function renderQuickMatches(programs, filters) {
      if (!quickListEl || !quickEmptyEl) return;
      const list = Array.isArray(programs) ? programs : [];
      const total = list.length;
      const limit = 30;

      const sorted = list.slice().sort((a, b) => {
        const sa = getSalesCount(a && a.id);
        const sb = getSalesCount(b && b.id);
        if (sb !== sa) return sb - sa;
        const ap = String((a && a.provider) ? a.provider : "");
        const bp = String((b && b.provider) ? b.provider : "");
        if (ap !== bp) return ap.localeCompare(bp, "zh-Hans-CN");
        return String((a && a.name) ? a.name : "").localeCompare(String((b && b.name) ? b.name : ""), "en");
      });

      const shown = sorted.slice(0, limit);
      if (quickMetaEl) {
        const providerHint = (filters && filters.provider) ? ` · ${bi("机构", "Provider")}: ${filters.provider}` : "";
        const kwHint = (filters && filters.keyword) ? ` · ${bi("关键词", "Keyword")}: ${filters.keyword}` : "";
        quickMetaEl.textContent = total ? `${bi("显示", "Showing")} ${shown.length}/${total}（${bi("按销量排序", "sorted by sales")}）${providerHint}${kwHint}` : "—";
      }

      if (shown.length === 0) {
        quickListEl.innerHTML = "";
        quickEmptyEl.style.display = "block";
        return;
      }

      quickEmptyEl.style.display = "none";
      quickListEl.innerHTML = shown.map((p) => {
        const id = String(p.id || "");
        const sales = getSalesCount(id);
        const name = p.official
          ? `<a href="${p.official}" target="_blank" rel="noreferrer">${escapeHtml(p.name)}</a>`
          : escapeHtml(p.name);
        const parts = [];
        if (p.provider) parts.push(escapeHtml(p.provider));
        if (p.partner) parts.push(escapeHtml(p.partner));
        const levelLabel = awardLevelLabel(p.awardLevel) || p.awardLevel;
        if (levelLabel) parts.push(escapeHtml(levelLabel));
        if (p.duration) parts.push(escapeHtml(p.duration));
        const fee = programFeeBrief(p);
        if (fee) parts.push(escapeHtml(String(fee)));
        return `
          <div class="list-item course-row">
            <div>
              <strong>${name}</strong><br/>
              <span class="muted">${parts.filter(Boolean).join(" · ") || bi("详见官网", "See official site")}</span>
            </div>
            <div class="course-actions">
              <button class="pill-btn" data-sales-action="dec" data-id="${escapeHtml(id)}" type="button">−</button>
              <span class="pill sales" title="历史成交/销售数量（本机浏览器保存） / Sales count (saved in this browser)">${bi("销量", "Sales")} ${sales}</span>
              <button class="pill-btn" data-sales-action="inc" data-id="${escapeHtml(id)}" type="button">+</button>
              <button class="pill-btn show-details" data-id="${escapeHtml(id)}" type="button">详情 / Details</button>
              <button class="add add-course" data-id="${escapeHtml(id)}" type="button">${bi("加入客户", "Add to client")}</button>
            </div>
          </div>
        `;
      }).join("");
    }

	    function matches(p, filters) {
	      if (filters.age) {
	        if (p.ageMin && filters.age < p.ageMin) return false;
	        if (p.ageMax && filters.age > p.ageMax) return false;
	      }
			      if (filters.education) {
			        const need = rank(filters.education);
			        const have = p.minEduRank || rank(p.minEdu);
			        if (need < have) return false;
			      }
	      if (filters.provider) {
	        if (!p.provider || p.provider !== filters.provider) return false;
	      }
	      if (filters.keyword) {
	        const tokens = keywordTokens(filters.keyword);
	        if (tokens.length) {
	          const hay = String(p.searchText || buildSearchHaystack(p));
	          const ok = tokens.every((t) => hay.includes(t));
	          if (!ok) return false;
	        }
	      }
			      if (filters.budget && p.budgetMin && filters.budget < p.budgetMin) return false;
			      if (filters.tuitionMax != null) {
			        const fee = (Number.isFinite(p.tuitionSgdMax) && p.tuitionSgdMax > 0)
			          ? p.tuitionSgdMax
			          : ((Number.isFinite(p.tuitionSgdMin) && p.tuitionSgdMin > 0) ? p.tuitionSgdMin : null);
			        if (!fee) return false;
			        if (fee > filters.tuitionMax) return false;
			      }
			      if (filters.durationMaxMonths != null) {
			        const dur = (Number.isFinite(p.durationMonthsMax) && p.durationMonthsMax > 0) ? p.durationMonthsMax : null;
			        if (!dur) return false;
			        if (dur > filters.durationMaxMonths) return false;
			      }
			      if (filters.qsMax != null) {
			        const q = (Number.isFinite(p.qsRank) && p.qsRank > 0) ? p.qsRank : null;
			        if (!q) return false;
			        if (q > filters.qsMax) return false;
			      }
			      if (filters.cscse) {
			        const status = String(p.cscseStatus || "").trim().toLowerCase();
			        if (filters.cscse === "yes") {
			          if (status !== "yes") return false;
			        } else if (filters.cscse === "no") {
			          if (status === "yes") return false;
			        }
			      }
			      if (filters.route) {
			        const routes = Array.isArray(p.routes) ? p.routes : [];
			        if (!routes.includes(filters.route)) return false;
			      }
			      if (filters.major) {
			        const needle = filters.major;
			        const majors = Array.isArray(p.majors) && p.majors.length ? p.majors : (p.major ? [p.major] : []);
			        if (!majors.includes(needle)) return false;
			      }
				      return true;
				    }

			    function groupProgramsByProvider(programs) {
			      const map = new Map();
			      (programs || []).forEach((p) => {
			        const provider = String((p && p.provider) ? p.provider : "").trim() || "未知机构";
			        const g = map.get(provider) || { provider, programs: [] };
			        g.programs.push(p);
			        map.set(provider, g);
			      });
			      return Array.from(map.values()).sort((a, b) => {
			        const diff = (b.programs.length || 0) - (a.programs.length || 0);
			        if (diff) return diff;
			        return String(a.provider).localeCompare(String(b.provider), "zh-Hans-CN");
			      });
			    }

			    function programFeeBrief(p) {
			      if (!p) return "";
			      if (Number.isFinite(p.tuitionSgdMax) && p.tuitionSgdMax > 0) return `Fees≤S$${Math.round(p.tuitionSgdMax).toLocaleString()}`;
			      if (Number.isFinite(p.tuitionSgdMin) && p.tuitionSgdMin > 0) return `Fees≥S$${Math.round(p.tuitionSgdMin).toLocaleString()}`;
			      return String(p.tuition || p.tuitionEstimate || "").trim();
			    }

			    function renderGroupedByProvider(programs) {
			      const list = Array.isArray(programs) ? programs : [];
			      const byId = new Map(list.map((p) => [p.id, p]));
			      const groups = groupProgramsByProvider(list);

			      groups.forEach((g) => {
			        const groupPrograms = (g.programs || []).slice().sort((a, b) => {
			          const sa = getSalesCount(a && a.id);
			          const sb = getSalesCount(b && b.id);
			          if (sb !== sa) return sb - sa;
			          return String(a.name || "").localeCompare(String(b.name || ""), "en");
			        });
			        const routes = uniqueStrings(groupPrograms.flatMap((p) => Array.isArray(p.routes) ? p.routes : []).filter(Boolean));
			        const majors = uniqueStrings(groupPrograms.flatMap((p) => {
			          const ms = Array.isArray(p.majors) && p.majors.length ? p.majors : (p.major ? [p.major] : []);
			          return ms || [];
			        }).filter(Boolean));

			        let strictEduRank = 0;
			        let strictAgeMin = null;
			        let budgetMinLo = null;
			        let budgetMinHi = null;
			        const feeNums = [];
			        const durNums = [];
			        let anyProcess = "";
			        let anyAppFee = "";

			        groupPrograms.forEach((p) => {
			          const er = (Number.isFinite(p.minEduRank) && p.minEduRank >= 0) ? p.minEduRank : rank(p.minEdu);
			          if (Number.isFinite(er)) strictEduRank = Math.max(strictEduRank, er);
			          if (p.ageMin != null && Number.isFinite(Number(p.ageMin))) strictAgeMin = strictAgeMin == null ? Number(p.ageMin) : Math.max(strictAgeMin, Number(p.ageMin));
			          if (p.budgetMin != null && Number.isFinite(Number(p.budgetMin)) && Number(p.budgetMin) > 0) {
			            const b = Number(p.budgetMin);
			            budgetMinLo = budgetMinLo == null ? b : Math.min(budgetMinLo, b);
			            budgetMinHi = budgetMinHi == null ? b : Math.max(budgetMinHi, b);
			          }
			          if (Number.isFinite(p.tuitionSgdMin) && p.tuitionSgdMin > 0) feeNums.push(p.tuitionSgdMin);
			          if (Number.isFinite(p.tuitionSgdMax) && p.tuitionSgdMax > 0) feeNums.push(p.tuitionSgdMax);
			          if (Number.isFinite(p.durationMonthsMin) && p.durationMonthsMin > 0) durNums.push(p.durationMonthsMin);
			          if (Number.isFinite(p.durationMonthsMax) && p.durationMonthsMax > 0) durNums.push(p.durationMonthsMax);
			          if (!anyProcess) anyProcess = normalizeText(p.process || p.process_text || "");
			          if (!anyAppFee) anyAppFee = normalizeText(p.appFee || "");
			        });

			        const strictEduKey = strictEduRank > 0 ? eduKeyFromRank(strictEduRank) : "";
			        const feeSummary = feeNums.length ? `${Math.round(Math.min(...feeNums)).toLocaleString()}–${Math.round(Math.max(...feeNums)).toLocaleString()}` : "";
			        const durSummary = durNums.length ? `${Math.round(Math.min(...durNums))}–${Math.round(Math.max(...durNums))}mo` : "";
			        const budgetSummary = (budgetMinLo != null)
			          ? (Math.round(budgetMinLo) === Math.round(budgetMinHi)
			            ? `≥ SGD ${Math.round(budgetMinLo).toLocaleString()}/年`
			            : `≥ SGD ${Math.round(budgetMinLo).toLocaleString()}–${Math.round(budgetMinHi).toLocaleString()}/年`)
			          : "";

			        const majorsLabel = majors.length ? majors.slice(0, 8).map((m) => bi(majorLabel(m), majorLabelEn(m))).join(" · ") : "";

			        const rowsHtml = groupPrograms.map((p) => {
			          const sales = getSalesCount(p.id);
			          const name = p.official
			            ? `<a href="${p.official}" target="_blank" rel="noreferrer">${p.name}</a>`
			            : p.name;
			          const parts = [];
			          if (p.partner) parts.push(p.partner);
			          const levelLabel = awardLevelLabel(p.awardLevel) || p.awardLevel;
			          if (levelLabel) parts.push(levelLabel);
			          if (p.duration) parts.push(p.duration);
			          const fee = programFeeBrief(p);
			          if (fee) parts.push(fee);
			          return `
			            <div class="list-item course-row">
			              <div>
			                <strong>${name}</strong><br/>
			                <span class="muted">${parts.filter(Boolean).join(" · ") || bi("详见官网", "See official site")}</span>
			              </div>
			              <div class="course-actions">
			                <button class="pill-btn" data-sales-action="dec" data-id="${p.id}" type="button">−</button>
			                <span class="pill sales" title="历史成交/销售数量（本机浏览器保存） / Sales count (saved in this browser)">${bi("销量", "Sales")} ${sales}</span>
			                <button class="pill-btn" data-sales-action="inc" data-id="${p.id}" type="button">+</button>
			                <button class="pill-btn show-details" data-id="${p.id}" type="button">详情 / Details</button>
			                <button class="add add-course" data-id="${p.id}" type="button">${bi("加入客户", "Add to client")}</button>
			              </div>
			            </div>
			          `;
			        }).join("");

			        const card = document.createElement("div");
			        card.className = "card";
			        card.innerHTML = `
			          <h3>${g.provider}（${groupPrograms.length} ${bi("课程", "Programs")}）</h3>
			          <div class="meta">
			            <span class="pill">${g.provider}</span>
			            <span class="pill good">${bi("课程", "Programs")} ${groupPrograms.length}</span>
			            ${strictAgeMin != null ? `<span class="pill">${bi("年龄≥", "Age ≥")} ${Math.round(strictAgeMin)}</span>` : ""}
			            ${strictEduKey ? `<span class="pill">${bi("学历≥", "Education ≥")} ${bi(eduLabel(strictEduKey), eduLabelEn(strictEduKey))}</span>` : ""}
			            ${budgetSummary ? `<span class="pill">${budgetSummary}</span>` : ""}
			            ${feeSummary ? `<span class="pill">Fees S$${feeSummary}</span>` : ""}
			            ${durSummary ? `<span class="pill">${bi("学制", "Duration")} ${durSummary}</span>` : ""}
			            ${routes.map((r) => `<span class="pill">${bi(routeLabel(r), routeLabelEn(r))}</span>`).join("")}
			          </div>
			          ${majorsLabel ? `<div class="muted">${bi("方向", "Majors")}: ${majorsLabel}</div>` : ""}
			          ${(anyProcess || anyAppFee) ? `<div class="muted">${bi("通用", "Common")}: ${[anyProcess ? `${bi("流程", "Process")} ${anyProcess}` : "", anyAppFee ? `${bi("申请费", "App fee")} ${convertRefundTextToSgd(anyAppFee, readFxCnyPerSgd())}` : ""].filter(Boolean).join(" · ")}</div>` : ""}
			          <div class="list course-list">${rowsHtml}</div>
			        `;
			        card.addEventListener("click", (e) => {
			          const btn = e.target && e.target.closest ? e.target.closest("button") : null;
			          if (!btn) return;
			          const id = btn.getAttribute("data-id");
			          if (!id) return;
			          const salesAction = btn.getAttribute("data-sales-action");
			          if (salesAction === "inc") {
			            bumpSalesCount(id, 1);
			            render(currentPrograms);
			            return;
			          }
			          if (salesAction === "dec") {
			            bumpSalesCount(id, -1);
			            render(currentPrograms);
			            return;
			          }
			          if (btn.classList.contains("show-details")) {
			            openProgramDetails(id);
			            return;
			          }
			          if (btn.classList.contains("add-course")) {
			            const picked = byId.get(id);
			            if (picked) addToShortlist(picked);
			          }
			        });
			        cardList.appendChild(card);
			      });
			    }

			    function render(programs) {
			      const age = parseInt(document.getElementById("age").value, 10);
			      const education = document.getElementById("education").value;
			      const budget = parseInt(document.getElementById("budget").value, 10);
		      const tuitionMax = parseInt(document.getElementById("tuition-max").value, 10);
		      const durationMaxMonths = parseFloat(document.getElementById("duration-max-months").value);
		      const qsMax = parseInt(document.getElementById("qs-max").value, 10);
		      const cscse = document.getElementById("cscse").value;
	      const route = document.getElementById("route").value;
	      const major = document.getElementById("major").value;
	      const provider = document.getElementById("provider").value;
	      const keyword = document.getElementById("keyword").value;
		      const filters = {
		        age: isNaN(age) ? null : age,
		        education,
		        budget: isNaN(budget) ? null : budget,
		        tuitionMax: !isNaN(tuitionMax) && tuitionMax > 0 ? tuitionMax : null,
		        durationMaxMonths: Number.isFinite(durationMaxMonths) && durationMaxMonths > 0 ? durationMaxMonths : null,
		        qsMax: !isNaN(qsMax) && qsMax > 0 ? qsMax : null,
		        cscse,
		        route,
		        major,
		        provider,
		        keyword,
		      };

      renderRouteResults(programs, filters);
      syncContractDefaultsFromContext(filters);

      const filtered = programs.filter((p) => matches(p, filters));
      const filteredSorted = filtered.slice().sort((a, b) => {
        const sa = getSalesCount(a && a.id);
        const sb = getSalesCount(b && b.id);
        if (sb !== sa) return sb - sa;
        const ap = String((a && a.provider) ? a.provider : "");
        const bp = String((b && b.provider) ? b.provider : "");
        if (ap !== bp) return ap.localeCompare(bp, "zh-Hans-CN");
        return String((a && a.name) ? a.name : "").localeCompare(String((b && b.name) ? b.name : ""), "en");
      });
	      updateCatalogStats(programs.length, filtered.length);
	      renderQuickMatches(filteredSorted, filters);
		      cardList.innerHTML = "";
		      if (filtered.length === 0) {
		        if (!programs.length) {
		          if (currentCatalogMode === "nocodb_shared") {
		            if (nocodbLoading) emptyState.textContent = "正在从 NocoDB 加载课程数据… / Loading from NocoDB…";
		            else if (nocodbLastError) emptyState.textContent = `NocoDB 加载失败 / Failed: ${nocodbLastError}`;
		            else emptyState.textContent = "NocoDB 共享视图暂无课程记录。/ No records in NocoDB shared view.";
		          } else if (currentCatalogMode === "custom_db") {
		            emptyState.textContent = "自定义数据库暂无课程记录：请点击上方“导入课程库 JSON”，或切换数据集到“全部/精选”。/ No records in custom DB: import JSON or switch dataset to All/Curated.";
		          } else {
		            emptyState.textContent = "当前数据集暂无课程记录：请切换上方“学校/课程数据集”（建议选“全部”）。/ No records in current dataset: switch dataset (recommend All).";
		          }
		        } else {
		          emptyState.textContent = "未匹配到课程，请调整筛选条件。/ No matches. Adjust filters.";
		        }
		        emptyState.style.display = "block";
		        return;
			      }
		      emptyState.style.display = "none";

		      if (currentViewMode === "group_provider") {
		        renderGroupedByProvider(filteredSorted);
		        return;
		      }

	      filteredSorted.forEach((p) => {
	        const card = document.createElement("div");
	        card.className = "card";
	        card.innerHTML = `
	          <h3>${p.name}</h3>
	          <div class="meta">
	            <span class="pill">${p.provider}</span>
		            ${p.partner ? `<span class="pill">${p.partner}</span>` : ""}
		            ${p.awardLevel ? `<span class="pill">${awardLevelLabel(p.awardLevel) || p.awardLevel}</span>` : ""}
		            ${(Number.isFinite(p.durationMonthsMax) && p.durationMonthsMax > 0) ? `<span class="pill">≤${Math.round(p.durationMonthsMax)}mo</span>` : ""}
		            ${(Number.isFinite(p.tuitionSgdMax) && p.tuitionSgdMax > 0) ? `<span class="pill">Fees≤S$${Math.round(p.tuitionSgdMax).toLocaleString()}</span>` : ""}
		            ${p.cscseStatus ? `<span class="pill ${cscsePillClass(p.cscseStatus)}">${bi("留服", "CSCSE")}: ${bi(cscseLabel(p.cscseStatus), cscseLabelEn(p.cscseStatus))}</span>` : ""}
		            ${p.routes.map(r => `<span class="pill">${bi(routeLabel(r), routeLabelEn(r))}</span>`).join("")}
		            ${p.qs ? `<span class="pill">${p.qs}</span>` : ""}
		            ${p.multi ? `<span class="pill good">${bi("可加入客户方案", "Eligible")}</span>` : ""}
		          </div>
	          ${(p.tags && p.tags.length) ? `<div class="muted">${bi("标签（可搜索）", "Tags (searchable)")}：${p.tags.slice(0, 8).join(" · ")}</div>` : ""}
	          <div class="tagline">${p.highlights}</div>
	          <div class="muted">${bi("专业方向", "Major")}: ${bi(majorLabel(p.major), majorLabelEn(p.major))} · ${bi("学制", "Duration")}: ${p.duration}</div>
	          <div class="muted">${bi("入读要求", "Requirements")}: ${bi(eduLabel(p.minEdu), eduLabelEn(p.minEdu))}${p.ageMin ? ` · ${bi("年龄≥", "Age ≥")} ${p.ageMin}` : ""}${p.ageMax ? ` · ${bi("年龄≤", "Age ≤")} ${p.ageMax}` : ""}</div>
		          <div class="muted">${bi("预算参考", "Budget")}: ${p.budgetMin ? `≥ SGD ${p.budgetMin.toLocaleString()}/yr` : bi("待补充", "TBC")} · ${bi("申请费", "App fee")}: ${convertRefundTextToSgd(p.appFee || bi("待确认", "TBC"), readFxCnyPerSgd())}</div>
		          <div class="muted">${bi("价格/返佣摘要", "Pricing / notes")}: ${convertRefundTextToSgd(p.pricingNote || p.tuitionEstimate || bi("待补充", "TBC"), readFxCnyPerSgd())}</div>
	          <div class="muted">${bi("开课节奏", "Intakes")}: ${p.intakes || p.intake_text || bi("待补充", "TBC")}</div>
	          <div class="muted">${bi("学费估算", "Tuition")}: ${p.tuition || p.tuitionEstimate || bi("待补充", "TBC")} · ${bi("流程", "Process")}: ${p.process || p.process_text || bi("待补充", "TBC")}</div>
	          ${p.official ? `<div class="muted">${bi("官网", "Official")}: <a href="${p.official}" target="_blank" rel="noreferrer">${p.official}</a></div>` : (p.sources && p.sources.official ? `<div class="muted">${bi("官网", "Official")}: <a href="${p.sources.official}" target="_blank" rel="noreferrer">${p.sources.official}</a></div>` : `<div class='muted'>${bi("官网链接", "Official link")}: ${bi("待补充", "TBC")}</div>`)}
          <div class="course-actions">
            <button class="add add-course" data-id="${p.id}" type="button">${bi("加入客户", "Add to client")}</button>
            <button class="pill-btn show-details" data-id="${p.id}" type="button">详情 / Details</button>
          </div>
	          <small>提示：具体学费/开课时间以校方当期为准；如需更新，请同步 programs.yaml / 价目表后修改此板。</small>
	        `;
        card.addEventListener("click", (e) => {
          const btn = e.target && e.target.closest ? e.target.closest("button") : null;
          if (!btn) return;
          const id = btn.getAttribute("data-id");
          if (!id) return;
          if (btn.classList.contains("show-details")) {
            openProgramDetails(id);
            return;
          }
          if (btn.classList.contains("add-course")) {
            addToShortlist(p);
          }
        });
        cardList.appendChild(card);
      });
    }

    function routeLabel(route) {
      return {
        private_university: "私立本科/硕士",
        dual_degree: "合作办学",
        k12_public: "K12 公立 (AEIS)",
        k12_international: "K12 国际学校",
        kindergarten: "幼儿园",
        nus_highend: "NUS/NTU 高端申请",
      }[route] || route;
    }

    function bi(cn, en) {
      const c = String(cn || "").trim();
      const e = String(en || "").trim();
      if (c && e && c !== e) return `${c} / ${e}`;
      return c || e || "—";
    }

    function routeLabelEn(route) {
      return {
        private_university: "Private University (UG/PG)",
        dual_degree: "Partner / Dual Degree",
        k12_public: "K12 Public (AEIS)",
        k12_international: "K12 International School",
        kindergarten: "Kindergarten",
        nus_highend: "Public University (NUS/NTU/SMU)",
      }[route] || route;
    }

    function majorLabel(val) {
      if (!val) return "待确认";
      return {
        business: "商科/管理",
        computing: "IT/计算机/数据",
        engineering: "工程",
        hospitality: "酒店/旅游",
        design_arts: "设计/艺术/传媒",
        psychology: "心理",
        finance_acca: "会计/ACCA",
        k12_public: "K12 公立",
        k12_international: "K12 国际学校",
        kindergarten: "幼儿园",
        highend_public: "公立高端申请",
      }[val] || val;
    }

    function majorLabelEn(val) {
      if (!val) return "TBC";
      return {
        business: "Business / Management",
        computing: "Computing / IT / Data",
        engineering: "Engineering",
        hospitality: "Hospitality / Tourism",
        design_arts: "Design / Arts / Media",
        psychology: "Psychology",
        finance_acca: "Accounting / ACCA",
        k12_public: "K12 Public",
        k12_international: "K12 International School",
        kindergarten: "Kindergarten",
        highend_public: "Public University (High-end)",
      }[val] || val;
    }

    function eduLabel(val) {
      if (!val) return "待确认";
      return {
        none: "无学历要求",
        middle: "初中及以上",
        high: "高中及以上",
        diploma: "大专及以上",
        bachelor: "本科及以上",
        master: "硕士及以上",
      }[val] || val;
    }

    function eduLabelEn(val) {
      if (!val) return "TBC";
      return {
        none: "No requirement",
        middle: "Middle school+",
        high: "High school+",
        diploma: "Diploma+",
        bachelor: "Bachelor+",
        master: "Master+",
      }[val] || val;
    }

    function cscseLabelEn(status) {
      return { yes: "Likely yes", no: "No/Non-degree", unknown: "Unknown" }[String(status || "").toLowerCase()] || "Unknown";
    }

    function addToShortlist(p) {
      shortlist.set(p.id, p);
      renderShortlist();
    }

    function removeFromShortlist(id) {
      shortlist.delete(id);
      renderShortlist();
    }

    function renderShortlist() {
      shortlistEl.innerHTML = "";
      if (shortlist.size === 0) {
        shortlistEmpty.style.display = "block";
        syncContractDefaultsFromContext(getFilters());
        return;
      }
      shortlistEmpty.style.display = "none";
	      shortlist.forEach((p) => {
	        const item = document.createElement("div");
	        item.className = "list-item";
	        item.innerHTML = `
	          <strong>${p.name}</strong><br/>
	          ${bi(majorLabel(p.major), majorLabelEn(p.major))} · ${bi(routeLabel(p.routes[0]), routeLabelEn(p.routes[0]))}<br/>
	          ${bi("预算", "Budget")} ≥ SGD ${p.budgetMin ? p.budgetMin.toLocaleString() : bi("待补充", "TBC")}/yr · ${bi("申请费", "App fee")} ${convertRefundTextToSgd(p.appFee || bi("待确认", "TBC"), readFxCnyPerSgd())}<br/>
	          <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:6px;">
	            <a href="#" class="show-details" data-id="${p.id}">详情 / Details</a>
	            <a href="#" class="remove" data-id="${p.id}" style="color:${'var(--bad)'};">移除 / Remove</a>
	          </div>
	        `;
        const detailLink = item.querySelector("a.show-details");
        if (detailLink) detailLink.addEventListener("click", (e) => { e.preventDefault(); openProgramDetails(p.id); });
        const removeLink = item.querySelector("a.remove");
        if (removeLink) removeLink.addEventListener("click", (e) => { e.preventDefault(); removeFromShortlist(p.id); });
        shortlistEl.appendChild(item);
      });
      syncContractDefaultsFromContext(getFilters());
    }

		    function init(programs) {
		      currentPrograms = programs;
		      currentProgramsById = new Map((Array.isArray(programs) ? programs : []).map((p) => [p.id, p]));
		      bindProgramDetailsModalOnce();
		      let savedViewMode = null;
		      try { savedViewMode = localStorage.getItem(viewModeStorageKey); } catch {}
		      currentViewMode = normalizeViewMode(savedViewMode || defaultViewModeForPrograms(currentPrograms));
		      const viewModeEl = document.getElementById("view-mode");
		      if (viewModeEl) viewModeEl.value = currentViewMode;

		      let renderTimer = null;
		      const rerender = () => {
		        if (renderTimer) clearTimeout(renderTimer);
		        renderTimer = setTimeout(() => {
		          renderTimer = null;
		          render(currentPrograms);
		        }, 80);
		      };
		      document.getElementById("age").addEventListener("input", rerender);
		      document.getElementById("education").addEventListener("change", rerender);
		      document.getElementById("budget").addEventListener("input", rerender);
	      document.getElementById("tuition-max").addEventListener("input", rerender);
	      document.getElementById("duration-max-months").addEventListener("input", rerender);
	      document.getElementById("qs-max").addEventListener("input", rerender);
	      document.getElementById("cscse").addEventListener("change", rerender);
	      document.getElementById("route").addEventListener("change", rerender);
	      document.getElementById("major").addEventListener("change", rerender);
		      document.getElementById("provider").addEventListener("change", rerender);
		      document.getElementById("keyword").addEventListener("input", rerender);
	      document.getElementById("catalog-mode").addEventListener("change", (e) => {
	        setCatalogMode(e.target.value);
	      });
		      if (viewModeEl) {
		        viewModeEl.addEventListener("change", (e) => setViewMode(e.target.value));
		      }
	      document.getElementById("reset-filters").addEventListener("click", () => {
	        document.getElementById("age").value = "";
	        document.getElementById("education").value = "";
	        document.getElementById("budget").value = "";
	        document.getElementById("tuition-max").value = "";
	        document.getElementById("duration-max-months").value = "";
	        document.getElementById("qs-max").value = "";
	        document.getElementById("cscse").value = "";
	        document.getElementById("route").value = "";
	        document.getElementById("major").value = "";
	        document.getElementById("provider").value = "";
	        document.getElementById("keyword").value = "";
	        render(currentPrograms);
	      });

		      const clearShortlistBtn = document.getElementById("clear-shortlist");
		      if (clearShortlistBtn) {
		        clearShortlistBtn.addEventListener("click", () => {
		          shortlist.clear();
		          renderShortlist();
		        });
		      }

		      if (quickListEl) {
		        quickListEl.addEventListener("click", (e) => {
		          const btn = e.target && e.target.closest ? e.target.closest("button") : null;
		          if (!btn) return;
		          const id = btn.getAttribute("data-id");
		          if (!id) return;
		          const salesAction = btn.getAttribute("data-sales-action");
		          if (salesAction === "inc") {
		            bumpSalesCount(id, 1);
		            render(currentPrograms);
		            return;
		          }
		          if (salesAction === "dec") {
		            bumpSalesCount(id, -1);
		            render(currentPrograms);
		            return;
		          }
		          if (btn.classList.contains("show-details")) {
		            openProgramDetails(id);
		            return;
		          }
		          if (btn.classList.contains("add-course")) {
		            const picked = currentProgramsById.get(id);
		            if (picked) addToShortlist(picked);
		          }
		        });
		      }

		      const exportBtn = document.getElementById("export-course-db");
		      if (exportBtn) {
		        exportBtn.addEventListener("click", () => {
		          const all = programsForCatalogMode("all");
		          const payload = {
		            schema_version: 1,
		            exported_at: new Date().toISOString(),
		            items: normalizeProgramList(all),
		          };
		          downloadText("courses_db.json", JSON.stringify(payload, null, 2), "application/json;charset=utf-8");
		        });
		      }

		      const exportCsvBtn = document.getElementById("export-course-db-csv");
		      if (exportCsvBtn) {
		        exportCsvBtn.addEventListener("click", () => {
		          const all = programsForCatalogMode("all");
		          const csv = programsToCsv(all);
		          downloadText("courses_db.csv", csv, "text/csv;charset=utf-8");
		        });
		      }

		      const importBtn = document.getElementById("import-course-db-btn");
		      const importInput = document.getElementById("import-course-db");
		      if (importBtn && importInput) {
		        importBtn.addEventListener("click", () => importInput.click());
		        importInput.addEventListener("change", async () => {
	          const file = (importInput.files || [])[0];
	          importInput.value = "";
	          if (!file) return;
	          try {
	            const text = await file.text();
	            const parsed = JSON.parse(text);
	            const items = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.items) ? parsed.items : []);
	            const normalized = normalizeProgramList(items);
	            if (!normalized.length) throw new Error("导入失败：文件里没有可用的课程记录（需要至少包含 id/name）。");
	            catalogCustomPrograms = decoratePrograms(normalized);
	            persistCustomPrograms(catalogCustomPrograms);
	            setCatalogMode("custom_db");
	            alert(`已导入 ${catalogCustomPrograms.length} 条课程记录。`);
	          } catch (err) {
	            alert(err && err.message ? err.message : String(err));
	          }
		        });
		      }

		      try {
		        initNocoDbPanel();
		      } catch (err) {
		        console.error("initNocoDbPanel failed", err);
		        setRuntimeStatus(`运行状态 / Status：初始化失败 / init failed（NocoDB 面板 / panel：${formatErr(err)}）`);
		      }

		      try {
		        initContractPanel();
		      } catch (err) {
		        console.error("initContractPanel failed", err);
		        setRuntimeStatus(`运行状态 / Status：初始化失败 / init failed（合同/表单 / forms：${formatErr(err)}）`);
		      }

		      refreshProviderOptions(currentPrograms);
		      try {
		        render(currentPrograms);
		      } catch (err) {
		        console.error("render failed", err);
		        setRuntimeStatus(`运行状态 / Status：渲染失败 / render failed（${formatErr(err)}）`);
		      }
		      if (currentCatalogMode === "nocodb_shared") setCatalogMode("nocodb_shared");
		    }

		    function parseItems(data) {
		      const eduKeyFromRank = (r) => ({ 1: "middle", 2: "high", 3: "diploma", 4: "bachelor", 5: "master" }[Number(r)] || "");
		      return (data.items || []).map((p) => ({
		        id: p.id,
		        name: p.name,
		        provider: p.provider,
		        routes: p.routes || [],
		        major: Array.isArray(p.majors) ? p.majors[0] : p.major,
		        majors: p.majors,
			        qs: p.qs_band || "",
			        partner: p.partner || "",
			        awardLevel: p.award_level || "",
			        minEduRank: Number(p.min_edu_rank || 0),
			        minEdu: p.min_edu_label || p.min_edu || eduKeyFromRank(p.min_edu_rank) || "",
			        ageMin: p.age_min,
			        ageMax: p.age_max,
		        budgetMin: p.budget_sgd_min,
		        duration: p.duration_text,
		        appFee: p.application_fee_text,
		        tuitionSgdMin: p.tuition_sgd_min ?? null,
		        tuitionSgdMax: p.tuition_sgd_max ?? null,
		        pricingNote: p.tuition_sgd_min ? `约 SGD ${p.tuition_sgd_min}${p.tuition_sgd_max ? " - " + p.tuition_sgd_max : ""}` : p.tuition_estimate_sgd_text || "",
		        tuitionEstimate: p.tuition_sgd_min ? `SGD ${p.tuition_sgd_min}${p.tuition_sgd_max ? " - " + p.tuition_sgd_max : ""}` : (p.tuition_estimate_sgd_text || null),
		        process: p.process_text,
		        intakeMonths: Array.isArray(p.intake_months) ? p.intake_months : [],
		        intakes: p.intake_months && p.intake_months.length ? p.intake_months.join(", ") : null,
		        intake_text: p.intakes_text || "",
		        official: p.sources && p.sources.official ? p.sources.official : null,
		        highlights: p.highlights || p.qs_band || "详见官网",
		        multi: true
		      }));
		    }

		    const catalogModeStorageKey = "maple_matchboard_catalog_mode_v1";
		    const customCatalogStorageKey = "maple_matchboard_custom_course_db_v1";
		    const nocodbBaseUrlStorageKey = "maple_matchboard_nocodb_base_url_v1";
		    const nocodbSharedViewStorageKey = "maple_matchboard_nocodb_shared_view_v1";
		    const viewModeStorageKey = "maple_matchboard_view_mode_v1";
		    let nocodbLoadedKey = "";
		    let nocodbLastError = "";
		    let nocodbLastLoadedAt = null;
		    let nocodbLoading = false;
		    let currentViewMode = "cards";
		    let catalogCuratedPrograms = [];
		    let catalogKaplanPrograms = [];
		    let catalogPsbPrograms = [];
		    let catalogSimPrograms = [];
		    let catalogCurtinPrograms = [];
		    let catalogLsbfPrograms = [];
		    let catalogNocoDbPrograms = [];
		    let catalogCustomPrograms = [];
		    let currentCatalogMode = "all";

		    function normalizeCatalogMode(mode) {
		      const m = String(mode || "").trim();
		      if (m === "curated" || m === "kaplan_full" || m === "psb_full" || m === "sim_full" || m === "curtin_full" || m === "lsbf_full" || m === "combined" || m === "all" || m === "nocodb_shared" || m === "custom_db") return m;
		      return "all";
		    }

		    function normalizeViewMode(mode) {
		      const m = String(mode || "").trim();
		      if (m === "cards" || m === "group_provider") return m;
		      return "cards";
		    }

		    function defaultViewModeForPrograms(programs) {
		      const total = Array.isArray(programs) ? programs.length : 0;
		      if (total >= 120) return "group_provider";
		      return "cards";
		    }

		    function setViewMode(mode) {
		      currentViewMode = normalizeViewMode(mode);
		      try { localStorage.setItem(viewModeStorageKey, currentViewMode); } catch {}

		      const el = document.getElementById("view-mode");
		      if (el && el.value !== currentViewMode) el.value = currentViewMode;
		      render(currentPrograms);
		    }

		    function normalizeProgramRecord(input) {
		      if (!input || typeof input !== "object") return null;
		      const p = { ...input };
		      p.id = String(p.id || "").trim();
		      p.name = String(p.name || p.title || "").trim();
		      if (!p.id || !p.name) return null;

	      p.provider = String(p.provider || "").trim();
	      p.partner = String(p.partner || "").trim();
	      p.awardLevel = String(p.awardLevel || "").trim();
	      p.qs = String(p.qs || "").trim();
	      p.duration = String(p.duration || "").trim();
	      p.appFee = String(p.appFee || "").trim();
	      p.pricingNote = String(p.pricingNote || "").trim();
	      p.tuitionEstimate = p.tuitionEstimate == null ? null : String(p.tuitionEstimate || "").trim();
	      p.process = String(p.process || "").trim();
	      p.intakes = p.intakes == null ? null : String(p.intakes || "").trim();
	      p.intake_text = String(p.intake_text || "").trim();
	      p.official = p.official == null ? null : String(p.official || "").trim();
	      p.highlights = String(p.highlights || "").trim();

		      const splitMulti = (v) => String(v || "").split(/[\n,，、;；|]+/).map((t) => String(t || "").trim()).filter(Boolean);
		      if (!Array.isArray(p.routes)) p.routes = (typeof p.routes === "string" ? splitMulti(p.routes) : []);
		      p.routes = (p.routes || []).map((v) => String(v || "").trim()).filter(Boolean);
		      if (!Array.isArray(p.majors)) p.majors = (typeof p.majors === "string" ? splitMulti(p.majors) : (p.majors ? [String(p.majors)] : []));
		      p.majors = (p.majors || []).map((v) => String(v || "").trim()).filter(Boolean);
		      p.major = String(p.major || (Array.isArray(p.majors) ? p.majors[0] : "") || "").trim();

	      p.ageMin = p.ageMin == null ? null : Number(p.ageMin);
	      p.ageMax = p.ageMax == null ? null : Number(p.ageMax);
	      p.budgetMin = p.budgetMin == null ? null : Number(p.budgetMin);
	      p.minEduRank = p.minEduRank == null ? null : Number(p.minEduRank);
	      p.minEdu = String(p.minEdu || "").trim();
		      p.tuitionSgdMin = p.tuitionSgdMin == null ? null : Number(p.tuitionSgdMin);
		      p.tuitionSgdMax = p.tuitionSgdMax == null ? null : Number(p.tuitionSgdMax);
		      p.qsRank = p.qsRank == null ? null : Number(p.qsRank);
		      p.durationMonthsMin = p.durationMonthsMin == null ? null : Number(p.durationMonthsMin);
		      p.durationMonthsMax = p.durationMonthsMax == null ? null : Number(p.durationMonthsMax);
		      p.cscseStatus = String(p.cscseStatus || p.cscse || "").trim();
		      p.intakeMonths = Array.isArray(p.intakeMonths) ? p.intakeMonths : [];
		      p.multi = Boolean(p.multi);

	      delete p.searchText;
	      delete p.tags;
	      return p;
	    }

		    function normalizeProgramList(items) {
		      if (!Array.isArray(items)) return [];
		      const out = [];
		      const seen = new Set();
		      items.forEach((it) => {
	        const p = normalizeProgramRecord(it);
	        if (!p) return;
	        const key = p.id.toLowerCase();
	        if (seen.has(key)) return;
	        seen.add(key);
	        out.push(p);
		      });
		      return out;
		    }

		    function csvEscape(value) {
		      const raw = value == null ? "" : String(value);
		      const needsQuote = /[",\n\r]/.test(raw);
		      const escaped = raw.replace(/"/g, '""');
		      return needsQuote ? `"${escaped}"` : escaped;
		    }

		    function programsToCsv(programs) {
		      const headers = [
		        "id", "name", "provider", "partner",
		        "awardLevel", "routes", "majors", "major",
		        "qs", "qsRank",
		        "minEdu", "minEduRank",
		        "ageMin", "ageMax",
		        "budgetMin",
		        "duration", "durationMonthsMin", "durationMonthsMax",
		        "tuitionSgdMin", "tuitionSgdMax",
		        "tuitionEstimate", "pricingNote",
		        "intakes", "intake_text",
		        "cscseStatus",
		        "official",
		        "highlights", "appFee", "process",
		      ];

		      const list = normalizeProgramList(programs || []);
		      const lines = [headers.join(",")];
		      list.forEach((p) => {
		        const row = headers.map((h) => {
		          let v = p[h];
		          if (h === "routes" || h === "majors" || h === "intakeMonths") v = Array.isArray(v) ? v.join(",") : (v == null ? "" : String(v));
		          return csvEscape(v);
		        });
		        lines.push(row.join(","));
		      });
		      return "\ufeff" + lines.join("\n");
		    }

	    function loadCustomProgramsFromStorage() {
	      try {
	        const raw = localStorage.getItem(customCatalogStorageKey);
	        if (!raw) return [];
	        const parsed = JSON.parse(raw);
	        const items = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.items) ? parsed.items : []);
	        return normalizeProgramList(items);
	      } catch {
	        return [];
	      }
	    }

		    function persistCustomPrograms(programs) {
		      try {
		        localStorage.setItem(customCatalogStorageKey, JSON.stringify({
		          schema_version: 1,
		          saved_at: new Date().toISOString(),
		          items: normalizeProgramList(programs),
		        }));
		      } catch {
		        // ignore
		      }
		    }

		    function defaultNocoDbBaseUrl() {
		      const proto = (location && location.protocol) ? location.protocol : "http:";
		      const host = (location && location.hostname) ? location.hostname : "127.0.0.1";
		      return `${proto}//${host}:8090`;
		    }

		    function normalizeBaseUrl(url) {
		      const raw = String(url || "").trim();
		      if (!raw) return "";
		      return raw.replace(/\/+$/, "");
		    }

		    function readNocoDbSettings() {
		      const cfg = (typeof window !== "undefined" && window.MAPLE_MATCHBOARD_CONFIG && typeof window.MAPLE_MATCHBOARD_CONFIG === "object")
		        ? window.MAPLE_MATCHBOARD_CONFIG
		        : {};
		      const cfgNoco = (cfg && cfg.nocodb && typeof cfg.nocodb === "object") ? cfg.nocodb : {};

		      let baseUrl = normalizeBaseUrl(cfgNoco.baseUrl || "") || defaultNocoDbBaseUrl();
		      let sharedView = String(cfgNoco.sharedView || cfgNoco.sharedViewId || "").trim();

		      try {
		        const savedUrl = localStorage.getItem(nocodbBaseUrlStorageKey);
		        const savedView = localStorage.getItem(nocodbSharedViewStorageKey);
		        if (savedUrl) baseUrl = normalizeBaseUrl(savedUrl) || baseUrl;
		        if (savedView) sharedView = String(savedView || "").trim() || sharedView;
		      } catch {
		        // ignore
		      }

		      return { baseUrl, sharedView };
		    }

		    function persistNocoDbSettings(baseUrl, sharedView) {
		      try {
		        localStorage.setItem(nocodbBaseUrlStorageKey, normalizeBaseUrl(baseUrl) || "");
		        localStorage.setItem(nocodbSharedViewStorageKey, String(sharedView || "").trim());
		      } catch {
		        // ignore
		      }
		    }

		    function extractNocoDbSharedViewId(input) {
		      const raw = String(input || "").trim();
		      if (!raw) return "";
		      const byApi = raw.match(/shared-view\/([A-Za-z0-9_-]+)/);
		      if (byApi) return byApi[1];
		      const byView = raw.match(/\/view\/([A-Za-z0-9_-]+)/);
		      if (byView) return byView[1];
		      const simple = raw.match(/^([A-Za-z0-9_-]{10,})$/);
		      if (simple) return simple[1];
		      return raw;
		    }

		    function splitMultiValue(value) {
		      if (value == null) return [];
		      if (Array.isArray(value)) return value.flatMap(splitMultiValue);
		      return String(value || "").split(/[\n,，、;；|]+/).map((t) => String(t || "").trim()).filter(Boolean);
		    }

		    const ROUTE_KEYS = new Set(["private_university", "dual_degree", "k12_public", "k12_international", "kindergarten", "nus_highend"]);
		    function normalizeRouteKey(value) {
		      const raw = String(value || "").trim();
		      if (!raw) return "";
		      const s = raw.toLowerCase();
		      if (ROUTE_KEYS.has(s)) return s;
		      if (s.includes("私立") || s.includes("private")) return "private_university";
		      if (s.includes("双学位") || s.includes("合作") || s.includes("dual")) return "dual_degree";
		      if (s.includes("aeis") || (s.includes("k12") && s.includes("公立")) || s.includes("公立")) return "k12_public";
		      if (s.includes("国际") || s.includes("international")) return "k12_international";
		      if (s.includes("幼儿") || s.includes("kindergarten")) return "kindergarten";
		      if (s.includes("nus") || s.includes("ntu") || s.includes("高端") || s.includes("highend")) return "nus_highend";
		      return "";
		    }

		    const MAJOR_KEYS = new Set(["business", "computing", "engineering", "hospitality", "design_arts", "psychology", "finance_acca", "k12_public", "k12_international", "kindergarten", "highend_public"]);
		    function normalizeMajorKey(value) {
		      const raw = String(value || "").trim();
		      if (!raw) return "";
		      const s = raw.toLowerCase();
		      if (MAJOR_KEYS.has(s)) return s;
		      if (s.includes("商") || s.includes("管理") || s.includes("business") || s.includes("management") || s.includes("marketing")) return "business";
		      if (s.includes("计算机") || s.includes("电脑") || s.includes("it") || s.includes("data") || s.includes("cyber") || s.includes("comput")) return "computing";
		      if (s.includes("工程") || s.includes("engineering") || s.includes("mechanical") || s.includes("electrical") || s.includes("civil")) return "engineering";
		      if (s.includes("酒店") || s.includes("旅游") || s.includes("hospitality") || s.includes("tourism")) return "hospitality";
		      if (s.includes("设计") || s.includes("艺术") || s.includes("传媒") || s.includes("media") || s.includes("design") || s.includes("creative")) return "design_arts";
		      if (s.includes("心理") || s.includes("psych")) return "psychology";
		      if (s.includes("会计") || s.includes("acca") || s.includes("account")) return "finance_acca";
		      if (s.includes("aeis") || s.includes("k12") && s.includes("公立")) return "k12_public";
		      if (s.includes("国际") && s.includes("k12")) return "k12_international";
		      if (s.includes("幼儿")) return "kindergarten";
		      if (s.includes("nus") || s.includes("ntu") || s.includes("高端")) return "highend_public";
		      return "";
		    }

		    function normalizeAwardLevelKeyFromAny(value, fallbackText) {
		      const raw = String(value || "").trim();
		      if (!raw) return inferAwardLevelKey(fallbackText || "");
		      const s = raw.toLowerCase();
		      const known = new Set(["doctoral", "master", "bachelor", "pg_diploma", "diploma", "foundation", "certificate", "short_course"]);
		      if (known.has(s)) return s;
		      return inferAwardLevelKey(raw) || inferAwardLevelKey(fallbackText || "") || "";
		    }

		    function nocoRowToProgram(row) {
		      if (!row || typeof row !== "object") return null;
		      const name = normalizeText(row.name || row.Name || row.title || row.Title || "");
		      if (!name) return null;

		      const provider = normalizeText(row.provider || row.Provider || row.school || row.School || row.institution || row.Institution || "");
		      const partner = normalizeText(row.partner || row.Partner || row.awardedBy || row.AwardedBy || row.awarded_by || "");
		      const official = normalizeText(row.official || row.Official || row.url || row.URL || row.link || row.Link || "");
		      const idRaw = normalizeText(row.id || row.ID || row.Id || row.program_id || row.ProgramId || row.programId || "");

		      const seed = `${provider}||${partner}||${name}||${official}||${idRaw}`;
		      const id = idRaw ? String(idRaw) : `db-${slugIdPart(provider || "catalog")}-${slugIdPart(name)}-${hash32(seed)}`;

		      const routes = uniqueStrings(splitMultiValue(row.routes || row.route || row.路线).map(normalizeRouteKey).filter(Boolean));
		      const majors = uniqueStrings(splitMultiValue(row.majors || row.major || row.专业).map(normalizeMajorKey).filter(Boolean));
		      const major = majors[0] || normalizeMajorKey(row.major) || "";

		      const awardLevel = normalizeAwardLevelKeyFromAny(row.awardLevel || row.award_level || row.level || row.Level, `${name} ${partner}`);
		      const qs = normalizeText(row.qs || row.qs_band || row.qsBand || row["QS"] || "");

		      const num = (v) => {
		        const n = Number(String(v == null ? "" : v).replace(/,/g, "").trim());
		        return Number.isFinite(n) ? n : null;
		      };

		      return normalizeProgramRecord({
		        id,
		        name,
		        provider,
		        partner,
		        awardLevel,
		        routes,
		        major,
		        majors,
		        qs,
		        qsRank: num(row.qsRank || row.qs_rank || row.qs_rank_num || row["QS Rank"]),
		        minEdu: normalizeText(row.minEdu || row.min_edu || row.minEduLabel || row.min_edu_label || ""),
		        minEduRank: num(row.minEduRank || row.min_edu_rank || row.min_edu_rank_num),
		        ageMin: num(row.ageMin || row.age_min),
		        ageMax: num(row.ageMax || row.age_max),
		        budgetMin: num(row.budgetMin || row.budget_min),
		        duration: normalizeText(row.duration || row.duration_text || ""),
		        durationMonthsMin: num(row.durationMonthsMin || row.duration_months_min),
		        durationMonthsMax: num(row.durationMonthsMax || row.duration_months_max),
		        tuition: normalizeText(row.tuition || ""),
		        tuitionEstimate: row.tuitionEstimate == null ? null : normalizeText(row.tuitionEstimate),
		        pricingNote: normalizeText(row.pricingNote || row.pricing_note || ""),
		        tuitionSgdMin: num(row.tuitionSgdMin || row.tuition_sgd_min),
		        tuitionSgdMax: num(row.tuitionSgdMax || row.tuition_sgd_max),
		        intakes: row.intakes == null ? null : normalizeText(row.intakes),
		        intake_text: normalizeText(row.intake_text || row.intakeText || ""),
		        cscseStatus: normalizeText(row.cscseStatus || row.cscse || ""),
		        official: official || null,
		        highlights: normalizeText(row.highlights || ""),
		        appFee: normalizeText(row.appFee || row.app_fee || ""),
		        process: normalizeText(row.process || ""),
		        multi: true,
		      });
		    }

		    async function fetchNocoDbSharedViewRows(baseUrl, sharedViewId) {
		      const base = normalizeBaseUrl(baseUrl);
		      const viewId = extractNocoDbSharedViewId(sharedViewId);
		      if (!base) throw new Error("NocoDB 地址为空");
		      if (!viewId) throw new Error("未填写共享视图链接/ID");

		      const limit = 200;
		      const rows = [];
		      let offset = 0;
		      for (let i = 0; i < 200; i++) {
		        const url = `${base}/api/v2/public/shared-view/${encodeURIComponent(viewId)}/rows?limit=${limit}&offset=${offset}`;
		        const res = await fetch(url, { headers: { "Accept": "application/json" } });
		        if (!res.ok) {
		          const text = await res.text().catch(() => "");
		          throw new Error(`NocoDB 请求失败：HTTP ${res.status} ${text ? "- " + text : ""}`.trim());
		        }
		        const data = await res.json();
		        const chunk = Array.isArray(data && data.list) ? data.list
		          : (Array.isArray(data && data.rows) ? data.rows
		            : (Array.isArray(data && data.data) ? data.data
		              : (Array.isArray(data) ? data : [])));
		        if (!chunk.length) break;
		        rows.push(...chunk);

		        const pageInfo = (data && data.pageInfo) ? data.pageInfo : null;
		        if (pageInfo && (pageInfo.isLastPage || pageInfo.totalRows <= rows.length)) break;
		        if (chunk.length < limit) break;
		        offset += chunk.length;
		      }
		      return rows;
		    }

		    async function ensureNocoDbPrograms(force) {
		      const { baseUrl, sharedView } = readNocoDbSettings();
		      const base = normalizeBaseUrl(baseUrl);
		      const viewId = extractNocoDbSharedViewId(sharedView);
		      const key = `${base}||${viewId}`;

		      if (!force && nocodbLoadedKey === key && catalogNocoDbPrograms.length) return true;
		      if (nocodbLoading) return false;
		      nocodbLoading = true;
		      nocodbLastError = "";

		      try {
		        const rows = await fetchNocoDbSharedViewRows(base, viewId);
		        const mapped = rows.map(nocoRowToProgram).filter(Boolean);
		        const normalized = normalizeProgramList(mapped);
		        catalogNocoDbPrograms = decoratePrograms(normalized);
		        nocodbLoadedKey = key;
		        nocodbLastLoadedAt = new Date().toISOString();
		        return true;
		      } catch (err) {
		        nocodbLastError = err && err.message ? err.message : String(err);
		        return false;
		      } finally {
		        nocodbLoading = false;
		      }
		    }

		    function initNocoDbPanel() {
		      const urlEl = document.getElementById("nocodb-url");
		      const viewEl = document.getElementById("nocodb-view");
		      const saveBtn = document.getElementById("nocodb-save");
		      const refreshBtn = document.getElementById("nocodb-refresh");
		      if (!urlEl || !viewEl || !saveBtn || !refreshBtn) return;

		      const { baseUrl, sharedView } = readNocoDbSettings();
		      urlEl.value = baseUrl || defaultNocoDbBaseUrl();
		      viewEl.value = sharedView || "";

		      saveBtn.addEventListener("click", () => {
		        persistNocoDbSettings(urlEl.value, viewEl.value);
		        alert("已保存 NocoDB 设置。");
		      });

		      refreshBtn.addEventListener("click", async () => {
		        persistNocoDbSettings(urlEl.value, viewEl.value);
		        const ok = await ensureNocoDbPrograms(true);
		        if (!ok) alert(nocodbLastError || "NocoDB 刷新失败");
		        if (currentCatalogMode === "nocodb_shared") setCatalogMode("nocodb_shared");
		      });
		    }

    function refreshProviderOptions(programs) {
      const providerEl = document.getElementById("provider");
      if (!providerEl) return;

      const current = providerEl.value;
      const providers = Array.from(new Set((programs || []).map((p) => p.provider).filter(Boolean)))
        .sort((a, b) => String(a).localeCompare(String(b), "zh-Hans-CN"));

      providerEl.innerHTML = "";
      const any = document.createElement("option");
      any.value = "";
      any.textContent = "全部机构 / All providers";
      providerEl.appendChild(any);

      providers.forEach((p) => {
        const opt = document.createElement("option");
        opt.value = p;
        opt.textContent = p;
        providerEl.appendChild(opt);
      });

      providerEl.value = providers.includes(current) ? current : "";
    }

	    function updateCatalogStats(total, matched) {
	      const statsEl = document.getElementById("catalog-stats");
	      if (!statsEl) return;
		      const label = {
		        curated: "精选推荐",
		        kaplan_full: "Kaplan 全课程",
		        psb_full: "PSB 全课程",
		        sim_full: "SIM 全课程",
		        curtin_full: "Curtin 全课程",
		        lsbf_full: "LSBF 全课程",
		        combined: "精选 + Kaplan",
		        all: "全部（精选+Kaplan+PSB+SIM+Curtin+LSBF）",
		        nocodb_shared: "NocoDB 数据库（共享视图）",
		        custom_db: "自定义数据库（导入）",
		      }[currentCatalogMode] || currentCatalogMode;
      const hasFull =
        (catalogKaplanPrograms && catalogKaplanPrograms.length) ||
        (catalogPsbPrograms && catalogPsbPrograms.length) ||
        (catalogSimPrograms && catalogSimPrograms.length) ||
        (catalogCurtinPrograms && catalogCurtinPrograms.length) ||
        (catalogLsbfPrograms && catalogLsbfPrograms.length);
	      const hint = currentCatalogMode === "curated" && hasFull
	        ? ` · ${bi("提示：上方可切到“全课程/全部”查看更多", "Tip: switch to Full/All above to see more")}`
	        : "";
	      let extra = "";
	      if (currentCatalogMode === "nocodb_shared") {
	        if (nocodbLoading) extra = " · NocoDB：加载中… / loading…";
	        else if (nocodbLastError) extra = ` · NocoDB：加载失败 / failed (${nocodbLastError})`;
	        else if (nocodbLastLoadedAt) extra = ` · NocoDB：已同步 / synced ${String(nocodbLastLoadedAt).replace("T", " ").replace("Z", "")}`;
	      }
	      statsEl.textContent = `${bi("数据集", "Dataset")}: ${label}（${total}） · ${bi("当前匹配", "Matches")}: ${matched}${hint}${extra}`;
	      setRuntimeStatus(`运行状态 / Status：已加载 / loaded ${total} 条课程 / programs，当前匹配 / matches ${matched}（${label}）`);
	    }

		    function programsForCatalogMode(mode) {
		      const m = normalizeCatalogMode(mode);
		      if (m === "kaplan_full") return catalogKaplanPrograms;
		      if (m === "psb_full") return catalogPsbPrograms;
		      if (m === "sim_full") return catalogSimPrograms;
		      if (m === "curtin_full") return catalogCurtinPrograms;
		      if (m === "lsbf_full") return catalogLsbfPrograms;
		      if (m === "nocodb_shared") return catalogNocoDbPrograms;
		      if (m === "custom_db") return catalogCustomPrograms;
		      if (m === "combined") return catalogCuratedPrograms.concat(catalogKaplanPrograms);
		      if (m === "all") return catalogCuratedPrograms.concat(catalogKaplanPrograms, catalogPsbPrograms, catalogSimPrograms, catalogCurtinPrograms, catalogLsbfPrograms);
		      return catalogCuratedPrograms;
		    }

    async function setCatalogMode(mode) {
      currentCatalogMode = normalizeCatalogMode(mode);
      try { localStorage.setItem(catalogModeStorageKey, currentCatalogMode); } catch {}

      const modeEl = document.getElementById("catalog-mode");
      if (modeEl && modeEl.value !== currentCatalogMode) modeEl.value = currentCatalogMode;

      if (currentCatalogMode === "nocodb_shared") {
        const statsEl = document.getElementById("catalog-stats");
        if (statsEl) statsEl.textContent = "正在从 NocoDB 加载课程数据…";
        await ensureNocoDbPrograms(false);
        if (nocodbLastError && !catalogNocoDbPrograms.length) {
          if (statsEl) statsEl.textContent = `NocoDB 加载失败：${nocodbLastError}`;
        }
      }

      currentPrograms = programsForCatalogMode(currentCatalogMode);
      currentProgramsById = new Map((Array.isArray(currentPrograms) ? currentPrograms : []).map((p) => [p.id, p]));
      refreshProviderOptions(currentPrograms);
      render(currentPrograms);
    }

    function hash32(input) {
      const str = String(input || "");
      let h = 2166136261;
      for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return (h >>> 0).toString(36);
    }

    function slugIdPart(input) {
      return String(input || "")
        .toLowerCase()
        .replace(/&/g, "and")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 50) || "item";
    }

    function eduKeyFromRank(rank) {
      return ({ 1: "middle", 2: "high", 3: "diploma", 4: "bachelor", 5: "master" }[Number(rank)] || "middle");
    }

    function guessKaplanMinEduRank(titleUpper) {
      const t = String(titleUpper || "").toUpperCase();
      if (/(DOCTOR|PHD|DBA)/.test(t)) return 5;
      if (/(MASTER)/.test(t)) return 4;
      if (/(GRADUATE CERTIFICATE|GRADUATE DIPLOMA|POSTGRADUATE)/.test(t)) return 4;
      if (/(BACHELOR)/.test(t)) return /TOP-UP/.test(t) ? 3 : 2;
      if (/(ADVANCED DIPLOMA)/.test(t)) return 2;
      if (/(DIPLOMA|FOUNDATION|CERTIFICATE|PREPARATORY|CFA|ACCA)/.test(t)) return 1;
      return 1;
    }

    function guessKaplanBudgetMin(titleUpper) {
      const t = String(titleUpper || "").toUpperCase();
      if (/(DOCTOR|PHD|DBA|MASTER|GRADUATE)/.test(t)) return 25000;
      if (/(BACHELOR)/.test(t)) return 22000;
      if (/(FOUNDATION|DIPLOMA|CERTIFICATE|PREPARATORY|CFA|ACCA)/.test(t)) return 15000;
      return null;
    }

	    function guessKaplanMajors(titleUpper) {
	      const t = String(titleUpper || "").toUpperCase();
	      const majors = [];
	      const add = (m) => { if (m && !majors.includes(m)) majors.push(m); };

      if (/(ACCOUNTING|ACCA)/.test(t)) { add("finance_acca"); add("business"); }
      if (/(FINANCE|BANK|ECONOM|BUSINESS|MANAGEMENT|MARKETING|COMMERCE|ENTREPRENEUR|SUPPLY CHAIN|LOGISTICS|HUMAN RESOURCE|PROJECT MANAGEMENT|CONSULTANCY)/.test(t)) add("business");
      if (/(COMPUTER|COMPUTING|INFORMATION TECHNOLOGY|\\bIT\\b|CYBER|DATA|ANALYTICS|ARTIFICIAL INTELLIGENCE|\\bAI\\b|SOFTWARE|DIGITAL FORENSICS|FORENSICS|FINTECH|INFORMATION SYSTEMS)/.test(t)) add("computing");
      if (/(ENGINEERING|CONSTRUCTION|MECHANICAL|ELECTRICAL|CIVIL|AEROSPACE|MANUFACTURING)/.test(t)) add("engineering");
      if (/(HOSPITALITY|TOURISM|HOTEL)/.test(t)) add("hospitality");
      if (/(DESIGN|MEDIA|COMMUNICATION|DIGITAL MARKETING|FILM|ART|CREATIVE|JOURNALISM)/.test(t)) add("design_arts");
      if (/(PSYCHOLOGY|COUNSELL|COUNSEL|CRIMINOLOGY|MENTAL|THERAP)/.test(t)) add("psychology");
      if (/(LAW|LEGAL)/.test(t)) add("business");

	      return majors;
	    }

	    const SEARCH_STOPWORDS = new Set(["on", "the", "a", "an", "of", "to", "in", "and", "for", "with"]);

	    function normalizeText(input) {
	      return String(input || "")
	        .replace(/\s+/g, " ")
	        .trim();
	    }

		    function keywordTokens(keyword) {
		      return String(keyword || "")
		        .toLowerCase()
		        .split(/[\s,，、;；]+/)
		        .map((t) => t.trim())
		        .filter((t) => t && !SEARCH_STOPWORDS.has(t));
		    }

	    function acronymFromText(text) {
	      const raw = String(text || "").replace(/[^A-Za-z0-9 ]+/g, " ");
	      const words = raw.split(/\s+/).filter(Boolean);
	      if (words.length < 2) return "";
	      const stop = new Set(["OF", "THE", "AND", "IN", "AT", "FOR", "TO", "A", "AN"]);
	      const letters = words
	        .filter((w) => !stop.has(w.toUpperCase()))
	        .map((w) => w[0].toUpperCase());
	      const ac = letters.join("");
	      if (ac.length < 2 || ac.length > 6) return "";
	      return ac;
	    }

	    function inferPartnerFromName(name) {
	      const raw = normalizeText(name);
	      if (!raw.includes("×")) return "";
	      const parts = raw.split("×").map((s) => normalizeText(s)).filter(Boolean);
	      if (parts.length < 2) return "";
	      const right = parts[1];
	      const token = right.split(/[\s·|/]/).filter(Boolean)[0] || "";
	      return normalizeText(token);
	    }

	    function inferAwardLevelKey(text) {
	      const t = String(text || "").toLowerCase();
	      if (/(phd|doctor|doctoral|dba)\b/.test(t) || /博士/.test(t)) return "doctoral";
	      if (/(master|msc|mba|meng|ma)\b/.test(t) || /硕士/.test(t)) return "master";
	      if (/(bachelor|bsc|ba|llb|honou?rs?)\b/.test(t) || /本科/.test(t)) return "bachelor";
	      if (/(postgraduate|graduate)\s+(diploma|certificate)\b/.test(t) || /研究生文凭/.test(t)) return "pg_diploma";
	      if (/(advanced\s+diploma|diploma)\b/.test(t) || /(大专|文凭)/.test(t)) return "diploma";
	      if (/(foundation|preparatory)\b/.test(t) || /预科/.test(t)) return "foundation";
	      if (/(certificate)\b/.test(t) || /证书/.test(t)) return "certificate";
	      if (/(course|programme|program|workshop|bootcamp|short)\b/.test(t)) return "short_course";
	      return "";
	    }

	    function awardLevelLabel(key) {
	      return {
	        doctoral: "Doctoral/博士",
	        master: "Master/硕士",
	        bachelor: "Bachelor/本科",
	        pg_diploma: "PG Diploma/研究生文凭",
	        diploma: "Diploma/大专文凭",
	        foundation: "Foundation/预科",
	        certificate: "Certificate/证书",
	        short_course: "Short Course/短课",
	      }[key] || "";
	    }

		    function isDegreeLevel(key) {
		      return key === "bachelor" || key === "master" || key === "doctoral";
		    }

		    function cscseLabel(status) {
		      return { yes: "可（疑似）", no: "不可/非学位", unknown: "未知" }[String(status || "").toLowerCase()] || "未知";
		    }

		    function cscsePillClass(status) {
		      return { yes: "good", no: "bad", unknown: "warn" }[String(status || "").toLowerCase()] || "";
		    }

		    function extractMonthNumsFromText(text) {
	      const out = new Set();
	      const s = String(text || "");

	      const cn = s.match(/(1[0-2]|[1-9])\s*月/g);
	      if (cn) {
	        cn.forEach((m) => {
	          const num = Number(String(m).replace(/\D+/g, ""));
	          if (num >= 1 && num <= 12) out.add(num);
	        });
	      }

	      const enMap = {
	        jan: 1, january: 1,
	        feb: 2, february: 2,
	        mar: 3, march: 3,
	        apr: 4, april: 4,
	        may: 5,
	        jun: 6, june: 6,
	        jul: 7, july: 7,
	        aug: 8, august: 8,
	        sep: 9, sept: 9, september: 9,
	        oct: 10, october: 10,
	        nov: 11, november: 11,
	        dec: 12, december: 12,
	      };
	      const en = s.toLowerCase().match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/g);
	      if (en) {
	        en.forEach((m) => {
	          const key = String(m).toLowerCase();
	          const num = enMap[key] || enMap[key.slice(0, 3)];
	          if (num) out.add(num);
	        });
	      }

	      const rawNums = s.match(/(^|[^\d])(1[0-2]|[1-9])([^\d]|$)/g);
	      if (rawNums && s.includes(",")) {
	        rawNums.forEach((chunk) => {
	          const m = chunk.match(/(1[0-2]|[1-9])/);
	          if (!m) return;
	          const num = Number(m[1]);
	          if (num >= 1 && num <= 12) out.add(num);
	        });
	      }

	      return Array.from(out.values()).sort((a, b) => a - b);
	    }

	    function monthAbbrEn(num) {
	      return { 1: "jan", 2: "feb", 3: "mar", 4: "apr", 5: "may", 6: "jun", 7: "jul", 8: "aug", 9: "sep", 10: "oct", 11: "nov", 12: "dec" }[Number(num)] || "";
	    }

	    function uniqueStrings(values) {
	      const seen = new Set();
	      const out = [];
	      (values || []).forEach((v) => {
	        const s = String(v || "").trim();
	        if (!s) return;
	        const key = s.toLowerCase();
	        if (seen.has(key)) return;
	        seen.add(key);
	        out.push(s);
	      });
	      return out;
	    }

		    function buildProgramTags(p) {
		      const tags = [];
		      const add = (v) => { const s = normalizeText(v); if (s) tags.push(s); };

	      const provider = normalizeText(p.provider);
	      if (provider) { add(provider); add(provider.toLowerCase()); }

	      const partner = normalizeText(p.partner);
	      if (partner) {
	        add(partner);
	        add(partner.toLowerCase());
	        const ac = acronymFromText(partner);
	        if (ac) { add(ac); add(ac.toLowerCase()); }
	      }

	      const level = normalizeText(p.awardLevel) || inferAwardLevelKey(`${p.name || ""} ${p.partner || ""}`);
	      if (level) {
	        add(level);
	        const label = awardLevelLabel(level);
	        if (label) add(label);
	        if (isDegreeLevel(level)) add("degree");
	      }

	      const routes = Array.isArray(p.routes) ? p.routes : [];
	      routes.forEach((r) => { add(r); add(routeLabel(r)); });

	      const majors = Array.isArray(p.majors) && p.majors.length ? p.majors : (p.major ? [p.major] : []);
	      majors.forEach((m) => { add(m); add(majorLabel(m)); });

		      const durationText = normalizeText(p.duration);
		      if (durationText) {
		        const years = durationText.match(/(\d+(?:\.\d+)?)\s*(?:years?|年)/gi);
		        if (years) years.forEach((y) => add(String(y).toLowerCase().replace(/\s+/g, " ")));
		        const months = durationText.match(/(\d+(?:\.\d+)?)\s*(?:months?|mths?|mth|月)/gi);
		        if (months) months.forEach((m) => add(String(m).toLowerCase().replace(/\s+/g, " ")));
		      }

		      if (Number.isFinite(p.durationMonthsMax) && p.durationMonthsMax > 0) {
		        add("duration");
		        add(`${p.durationMonthsMax} months`);
		        add(`${p.durationMonthsMax}mo`);
		      }

		      const intakeText = normalizeText(p.intakes || p.intake_text);
		      const months = extractMonthNumsFromText(intakeText);
	      months.forEach((m) => {
	        const abbr = monthAbbrEn(m);
	        if (abbr) {
	          add(abbr);
	          add(`${abbr} intake`);
	          add(`starting ${abbr}`);
	          add(`starting on ${abbr}`);
	        }
	        add(`${m}月`);
	      });
	      if (months.length) {
	        add("starting");
	        add("intake");
	      }

		      const feeText = normalizeText(p.tuition || p.tuitionEstimate || p.pricingNote);
		      if (feeText) {
		        add("school");
		        add("fee");
		        add("school fee");
		        add("tuition");
		        add("fees");
		        add(feeText);
		        add(feeText.replace(/,/g, ""));
		      }

		      if (Number.isFinite(p.tuitionSgdMax) && p.tuitionSgdMax > 0) {
		        add("sgd");
		        add(`s$${Math.round(p.tuitionSgdMax)}`);
		        add(`s$${Math.round(p.tuitionSgdMax).toLocaleString()}`);
		      }

		      if (Number.isFinite(p.qsRank) && p.qsRank > 0) {
		        add("qs");
		        add(`qs ${Math.round(p.qsRank)}`);
		      }

		      const cscse = String(p.cscseStatus || "").trim().toLowerCase();
		      if (cscse) add(`cscse ${cscse}`);

		      return uniqueStrings(tags);
		    }

		    function parseSgdAmounts(text) {
		      const s = String(text || "");
		      const out = [];
		      const re = /(?:S\$\$?|SGD\s*\$?|SGD\$|SG\$)\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)/gi;
		      let m;
		      while ((m = re.exec(s)) !== null) {
		        const n = Number(String(m[1]).replace(/,/g, ""));
		        if (!Number.isFinite(n) || n <= 0) continue;
		        out.push(n);
		      }
		      return out;
		    }

		    function inferTuitionSgdRange(p) {
		      const min = Number(p && p.tuitionSgdMin);
		      const max = Number(p && p.tuitionSgdMax);
		      const hasMin = Number.isFinite(min) && min > 0;
		      const hasMax = Number.isFinite(max) && max > 0;
		      if (hasMin || hasMax) {
		        const lo = hasMin ? min : max;
		        const hi = hasMax ? max : min;
		        return { min: Math.round(lo), max: Math.round(hi) };
		      }
		      const combined = [p && p.tuitionEstimate, p && p.pricingNote, p && p.tuition].filter(Boolean).join(" ");
		      const amounts = parseSgdAmounts(combined);
		      if (!amounts.length) return null;
		      return {
		        min: Math.round(Math.min(...amounts)),
		        max: Math.round(Math.max(...amounts)),
		      };
		    }

		    function parseDurationMonthsRange(text) {
		      const raw = String(text || "").trim();
		      if (!raw) return null;
		      const s = raw
		        .toLowerCase()
		        .replace(/[–—]/g, "-")
		        .replace(/年/g, " year ")
		        .replace(/月/g, " month ")
		        .replace(/周/g, " week ")
		        .replace(/[天日]/g, " day ")
		        .replace(/\s+/g, " ");

		      const ranges = [];
		      const add = (a, b, unit) => {
		        const toNum = (v) => Number(String(v || "").replace(/,/g, ""));
		        const n1 = toNum(a);
		        const n2 = toNum(b);
		        if (!Number.isFinite(n1) || n1 <= 0 || !Number.isFinite(n2) || n2 <= 0) return;
		        const u = String(unit || "").toLowerCase();
		        const convert = (n) => {
		          if (u.startsWith("year")) return n * 12;
		          if (u.startsWith("month")) return n;
		          if (u.startsWith("week")) return n / 4.345;
		          if (u.startsWith("day")) return n / 30.417;
		          return null;
		        };
		        const m1 = convert(n1);
		        const m2 = convert(n2);
		        if (!Number.isFinite(m1) || !Number.isFinite(m2)) return;
		        ranges.push([Math.min(m1, m2), Math.max(m1, m2)]);
		      };

		      const rangeRe = /(\d+(?:\.\d+)?)\s*(?:-|to|~)\s*(\d+(?:\.\d+)?)\s*(years?|months?|weeks?|days?)/g;
		      let m;
		      while ((m = rangeRe.exec(s)) !== null) add(m[1], m[2], m[3]);

		      const singleRe = /(\d+(?:\.\d+)?)\s*(years?|months?|weeks?|days?)/g;
		      while ((m = singleRe.exec(s)) !== null) add(m[1], m[1], m[2]);

		      if (!ranges.length) return null;
		      const mins = ranges.map((r) => r[0]);
		      const maxs = ranges.map((r) => r[1]);
		      return {
		        min: Math.min(...mins),
		        max: Math.max(...maxs),
		      };
		    }

		    function parseQsRankFromText(text) {
		      const s = String(text || "").trim();
		      if (!s) return null;
		      const nums = s.match(/\b\d{1,4}\b/g);
		      if (!nums) return null;
		      const values = nums
		        .map((n) => Number(n))
		        .filter((n) => Number.isFinite(n) && n > 0 && n <= 5000);
		      if (!values.length) return null;
		      return Math.min(...values);
		    }

		    function normalizeCscseStatus(value) {
		      if (value == null) return "";
		      if (typeof value === "boolean") return value ? "yes" : "no";
		      const s = String(value || "").trim().toLowerCase();
		      if (!s) return "";
		      if (s === "yes" || s === "y" || s === "true" || s === "1") return "yes";
		      if (s === "no" || s === "n" || s === "false" || s === "0") return "no";
		      if (s === "unknown" || s === "?" || s === "n/a" || s === "na") return "unknown";
		      if (s.includes("不可") || s.includes("不认可") || s.includes("不支持")) return "no";
		      if (s.includes("未知") || s.includes("不确定")) return "unknown";
		      if (s.includes("可") && (s.includes("认证") || s.includes("留服") || s.includes("cscse"))) return "yes";
		      return "";
		    }

		    function partnerLooksLikeUniversity(partner) {
		      const p = String(partner || "").toLowerCase();
		      if (!p) return false;
		      return /(university|college|polytechnic|institute|school)/.test(p);
		    }

		    function inferCscseStatus(p) {
		      const explicit = normalizeCscseStatus(p && p.cscseStatus);
		      if (explicit) return explicit;
		      const level = normalizeText(p && p.awardLevel) || inferAwardLevelKey(`${p && p.name ? p.name : ""} ${p && p.partner ? p.partner : ""}`);
		      if (isDegreeLevel(level)) {
		        return partnerLooksLikeUniversity(p && p.partner) ? "yes" : "unknown";
		      }
		      if (level === "diploma" || level === "pg_diploma" || level === "foundation" || level === "certificate" || level === "short_course") {
		        return "no";
		      }
		      return "unknown";
		    }

		    function buildSearchHaystack(p) {
		      const parts = [];
		      const add = (v) => {
		        const s = normalizeText(v);
	        if (!s) return;
	        parts.push(s);
	        const noComma = s.replace(/,/g, "");
	        if (noComma !== s) parts.push(noComma);
	      };

	      add(p.name);
	      add(p.provider);
	      add(p.partner);
	      add(p.awardLevel);
	      add(awardLevelLabel(p.awardLevel));
	      add(p.qs);
	      add(p.duration);
	      add(p.intakes);
	      add(p.intake_text);
	      add(p.tuition);
		      add(p.tuitionEstimate);
		      add(p.pricingNote);
		      add(Number.isFinite(p.tuitionSgdMax) && p.tuitionSgdMax > 0 ? `S$${Math.round(p.tuitionSgdMax)}` : "");
		      add(Number.isFinite(p.durationMonthsMax) && p.durationMonthsMax > 0 ? `${Math.round(p.durationMonthsMax)} months` : "");
		      add(Number.isFinite(p.qsRank) && p.qsRank > 0 ? `QS ${Math.round(p.qsRank)}` : "");
		      add(p.cscseStatus ? `CSCSE ${p.cscseStatus}` : "");
		      add(p.appFee);
		      add(p.highlights);
		      add(p.official);
	      add(p.major);
	      add(majorLabel(p.major));
	      (Array.isArray(p.majors) ? p.majors : []).forEach(add);
	      (Array.isArray(p.routes) ? p.routes : []).forEach((r) => { add(r); add(routeLabel(r)); });
	      (Array.isArray(p.tags) ? p.tags : []).forEach(add);

	      return parts.join(" ").toLowerCase();
	    }

		    function decoratePrograms(programs) {
		      (programs || []).forEach((p) => {
		        if (!p || typeof p !== "object") return;
		        if (!p.partner) {
		          const inferred = inferPartnerFromName(p.name);
		          if (inferred) p.partner = inferred;
		        }
		        if (!p.awardLevel) {
		          const inferred = inferAwardLevelKey(`${p.name || ""} ${p.partner || ""}`);
		          if (inferred) p.awardLevel = inferred;
		        }
		        const tuitionRange = inferTuitionSgdRange(p);
		        if (tuitionRange) {
		          if (!(Number.isFinite(p.tuitionSgdMin) && p.tuitionSgdMin > 0)) p.tuitionSgdMin = tuitionRange.min;
		          if (!(Number.isFinite(p.tuitionSgdMax) && p.tuitionSgdMax > 0)) p.tuitionSgdMax = tuitionRange.max;
		        }
		        const durationRange = parseDurationMonthsRange(p.duration);
		        if (durationRange) {
		          p.durationMonthsMin = durationRange.min;
		          p.durationMonthsMax = durationRange.max;
		        } else {
		          p.durationMonthsMin = p.durationMonthsMin == null ? null : p.durationMonthsMin;
		          p.durationMonthsMax = p.durationMonthsMax == null ? null : p.durationMonthsMax;
		        }
		        if (!(Number.isFinite(p.qsRank) && p.qsRank > 0)) {
		          p.qsRank = parseQsRankFromText(p.qs);
		        }
		        p.cscseStatus = inferCscseStatus(p);
		        p.tags = buildProgramTags(p);
		        p.searchText = buildSearchHaystack(p);
		      });
		      return programs || [];
		    }

    const kaplanInstitutionDisplay = {
      "ASTON UNIVERSITY": "Aston University",
      "BIRMINGHAM CITY UNIVERSITY": "Birmingham City University",
      "MONASH UNIVERSITY": "Monash University",
      "MURDOCH UNIVERSITY": "Murdoch University",
      "NORTHUMBRIA UNIVERSITY": "Northumbria University",
      "RMIT UNIVERSITY": "RMIT University",
      "ROYAL HOLLOWAY, UNIVERSITY OF LONDON": "Royal Holloway, University of London",
      "UNIVERSITY COLLEGE DUBLIN": "University College Dublin",
      "UNIVERSITY OF ESSEX": "University of Essex",
      "UNIVERSITY OF PORTSMOUTH": "University of Portsmouth",
    };

	    function buildKaplanPrograms(rawPairs) {
	      const official = "https://www.kaplan.com.sg/programme-directory";
	      const process = "录取 2–4 周；IPA 2–3 周；整体 1–1.5 个月";
	      const appFee = "约 S$535";

	      return (rawPairs || []).map(([inst, title]) => {
	        const institution = kaplanInstitutionDisplay[inst] || String(inst || "");
	        const titleUpper = String(title || "").trim();
	        const majors = guessKaplanMajors(titleUpper);
	        const minEduRank = guessKaplanMinEduRank(titleUpper);
	        const minEdu = eduKeyFromRank(minEduRank);
	        const budgetMin = guessKaplanBudgetMin(titleUpper);
	        const awardLevel = inferAwardLevelKey(titleUpper);
	        const isDegree = isDegreeLevel(awardLevel);
	        const seed = `${inst}||${title}`;

	        return {
	          id: `kaplan-${slugIdPart(inst)}-${slugIdPart(titleUpper)}-${hash32(seed)}`,
	          name: titleUpper,
	          provider: "Kaplan",
	          partner: institution || "",
	          awardLevel: awardLevel || "",
	          routes: isDegree ? ["private_university", "dual_degree"] : ["private_university"],
	          major: majors[0] || "",
	          majors,
	          qs: "",
	          minEdu,
	          minEduRank,
	          ageMin: 16,
	          ageMax: null,
	          budgetMin,
          duration: "详见官网",
          appFee,
          pricingNote: "学费以 Kaplan 官方当期为准（Programme Directory PDF）",
          tuitionEstimate: "详见官网",
          process,
	          intakes: null,
	          intake_text: "详见官网",
	          official,
	          highlights: institution ? `${institution} · 官方课程清单` : "Kaplan 官方课程清单",
	          multi: true,
	        };
	      });
	    }

	    function buildPsbPrograms(rawItems) {
	      const process = "录取 2–4 周；IPA 2–3 周；整体 1–1.5 个月";
	      const appFee = "按官网当期为准";

	      return (rawItems || []).map(([inst, title, url]) => {
	        const institution = String(inst || "").trim();
	        const titleText = String(title || "").trim();
	        const majors = guessKaplanMajors(titleText);
	        const minEduRank = guessKaplanMinEduRank(titleText);
	        const minEdu = eduKeyFromRank(minEduRank);
	        const budgetMin = guessKaplanBudgetMin(titleText);
	        const awardLevel = inferAwardLevelKey(titleText);
	        const isPartner = institution && institution.toLowerCase() !== "psb academy";
	        const page = (coursePageDetailsByUrl && coursePageDetailsByUrl.psb && url && coursePageDetailsByUrl.psb[url]) ? coursePageDetailsByUrl.psb[url] : null;
	        const pageAwardedBy = normalizeText(page && page.awardedBy ? page.awardedBy : institution);
	        const pageLevel = normalizeText(page && page.academicLevel ? page.academicLevel : "");
	        const pageMode = normalizeText(page && page.mode ? page.mode : "");
	        const pageDuration = normalizeText(page && page.duration ? page.duration : "");
	        const pageIntakes = normalizeText(page && page.intakes ? page.intakes : "");
	        const pageFees = normalizeText(page && page.fees ? page.fees : "");
	        const seed = `${institution}||${titleText}||${url}`;
	        const highlightsExtra = [pageLevel ? `Level: ${pageLevel}` : "", pageMode ? `Mode: ${pageMode}` : ""].filter(Boolean).join(" · ");

	        return {
	          id: `psb-${slugIdPart(institution)}-${slugIdPart(titleText)}-${hash32(seed)}`,
	          name: titleText,
	          provider: "PSB",
	          partner: pageAwardedBy || institution || "",
	          awardLevel: awardLevel || "",
	          routes: isPartner ? ["private_university", "dual_degree"] : ["private_university"],
	          major: majors[0] || "",
	          majors,
	          qs: "",
	          minEdu,
	          minEduRank,
	          ageMin: 16,
	          ageMax: null,
	          budgetMin,
	          duration: pageDuration || "详见官网",
	          appFee,
	          pricingNote: pageFees ? `Estimated Course Fees: ${pageFees}` : "学费以 PSB 官方当期为准（课程页）",
	          tuitionEstimate: pageFees || "详见官网",
	          process,
	          intakes: pageIntakes || null,
	          intake_text: pageIntakes || "详见官网",
	          official: url || "https://www.psb-academy.edu.sg/courses",
	          highlights: `${pageAwardedBy || institution || "PSB"}${highlightsExtra ? " · " + highlightsExtra : ""} · PSB 官方课程`,
	          multi: true,
	        };
	      });
	    }

	    function buildSimPrograms(rawItems) {
	      const process = "录取 3–5 周；IPA 2–3 周；整体约 1.5 个月";
	      const appFee = "按官网当期为准";

	      return (rawItems || []).map(([partner, title, url]) => {
	        const partnerText = String(partner || "").trim();
	        const titleText = String(title || "").trim();
	        const majors = guessKaplanMajors(titleText);
	        const minEduRank = guessKaplanMinEduRank(titleText);
	        const minEdu = eduKeyFromRank(minEduRank);
	        const budgetMin = guessKaplanBudgetMin(titleText);
	        const awardLevel = inferAwardLevelKey(titleText);
	        const isSimInternal = partnerText.toLowerCase().includes("singapore institute of management");
	        const isPartner = partnerText && !isSimInternal;
	        const page = (coursePageDetailsByUrl && coursePageDetailsByUrl.sim && url && coursePageDetailsByUrl.sim[url]) ? coursePageDetailsByUrl.sim[url] : null;
	        const pageDuration = normalizeText(page && page.duration ? page.duration : "");
	        const pageIntakes = normalizeText(page && page.intakes ? page.intakes : "");
	        const pageFees = normalizeText(page && page.fees ? page.fees : "");
	        const pageApp = normalizeText(page && page.applicationDates ? page.applicationDates : "");
	        const seed = `${partnerText}||${titleText}||${url}`;
	        const highlightsExtra = [pageApp ? `Apply: ${pageApp}` : ""].filter(Boolean).join(" · ");

	        return {
	          id: `sim-${slugIdPart(partnerText)}-${slugIdPart(titleText)}-${hash32(seed)}`,
	          name: titleText,
	          provider: "SIM",
	          partner: partnerText || "",
	          awardLevel: awardLevel || "",
	          routes: isPartner ? ["private_university", "dual_degree"] : ["private_university"],
	          major: majors[0] || "",
	          majors,
	          qs: "",
	          minEdu,
	          minEduRank,
	          ageMin: 16,
	          ageMax: null,
	          budgetMin,
	          duration: pageDuration || "详见官网",
	          appFee,
	          pricingNote: pageFees ? `Estimated Fees: ${pageFees}` : "学费以 SIM 官方当期为准（课程页）",
	          tuitionEstimate: pageFees || "详见官网",
	          process,
	          intakes: pageIntakes || null,
	          intake_text: pageIntakes || "详见官网",
	          official: url || "https://www.sim.edu.sg/degrees-diplomas/programmes/programme-listing",
	          highlights: `${partnerText || "SIM"}${highlightsExtra ? " · " + highlightsExtra : ""} · SIM 官方课程`,
	          multi: true,
	        };
	      });
	    }

	    function buildCurtinPrograms(rawItems) {
	      const process = "录取/签证周期以官网当期为准";
	      const appFee = "按官网当期为准";

	      return (rawItems || []).map(([inst, title, url]) => {
	        const institution = String(inst || "Curtin University").trim();
	        const titleText = String(title || "").trim();
	        const majors = guessKaplanMajors(titleText);
	        const minEduRank = guessKaplanMinEduRank(titleText);
	        const minEdu = eduKeyFromRank(minEduRank);
	        const budgetMin = guessKaplanBudgetMin(titleText);
	        const awardLevel = inferAwardLevelKey(titleText);
	        const page = (coursePageDetailsByUrl && coursePageDetailsByUrl.curtin && url && coursePageDetailsByUrl.curtin[url]) ? coursePageDetailsByUrl.curtin[url] : null;
	        const pageDuration = normalizeText(page && page.duration ? page.duration : "");
	        const pageIntakes = normalizeText(page && page.intakes ? page.intakes : "");
	        const pageFees = normalizeText(page && page.fees ? page.fees : "");
	        const seed = `${institution}||${titleText}||${url}`;

	        return {
	          id: `curtin-${slugIdPart(titleText)}-${hash32(seed)}`,
	          name: titleText,
	          provider: "Curtin",
	          partner: institution || "",
	          awardLevel: awardLevel || "",
	          routes: ["private_university"],
	          major: majors[0] || "",
	          majors,
	          qs: "",
	          minEdu,
	          minEduRank,
	          ageMin: 16,
	          ageMax: null,
	          budgetMin,
	          duration: pageDuration || "详见官网",
	          appFee,
	          pricingNote: pageFees ? `Tuition: ${pageFees}` : "学费以 Curtin 官方当期为准（课程页）",
	          tuitionEstimate: pageFees || "详见官网",
	          process,
	          intakes: pageIntakes || null,
	          intake_text: pageIntakes || "详见官网",
	          official: url || "https://www.curtin.edu.sg/courses/",
	          highlights: institution ? `${institution} · Curtin 官方课程` : "Curtin 官方课程",
	          multi: true,
	        };
	      });
	    }

	    function buildLsbfPrograms(rawItems) {
	      const process = "录取/签证周期以官网当期为准";
	      const appFee = "按官网当期为准";

	      return (rawItems || []).map(([inst, title, url]) => {
	        const institution = String(inst || "LSBF").trim();
	        const titleText = String(title || "").trim();
	        const majors = guessKaplanMajors(titleText);
	        const minEduRank = guessKaplanMinEduRank(titleText);
	        const minEdu = eduKeyFromRank(minEduRank);
	        const budgetMin = guessKaplanBudgetMin(titleText);
	        const awardLevel = inferAwardLevelKey(titleText);
	        const page = (coursePageDetailsByUrl && coursePageDetailsByUrl.lsbf && url && coursePageDetailsByUrl.lsbf[url]) ? coursePageDetailsByUrl.lsbf[url] : null;
	        const pageDuration = normalizeText(page && page.duration ? page.duration : "");
	        const pageIntakes = normalizeText(page && page.intakes ? page.intakes : "");
	        const pageFees = normalizeText(page && page.fees ? page.fees : "");
	        const seed = `${institution}||${titleText}||${url}`;

	        return {
	          id: `lsbf-${slugIdPart(titleText)}-${hash32(seed)}`,
	          name: titleText,
	          provider: "LSBF",
	          partner: institution || "",
	          awardLevel: awardLevel || "",
	          routes: ["private_university"],
	          major: majors[0] || "",
	          majors,
	          qs: "",
	          minEdu,
	          minEduRank,
	          ageMin: 16,
	          ageMax: null,
	          budgetMin,
	          duration: pageDuration || "详见官网",
	          appFee,
	          pricingNote: pageFees ? `Fees: ${pageFees}` : "学费以 LSBF 官方当期为准（课程页）",
	          tuitionEstimate: pageFees || "详见官网",
	          process,
	          intakes: pageIntakes || null,
	          intake_text: pageIntakes || "详见官网",
	          official: url || "https://www.lsbf.edu.sg/programmes/",
	          highlights: institution ? `${institution} · LSBF 官方课程` : "LSBF 官方课程",
	          multi: true,
	        };
	      });
	    }

	    // 离线模式：优先使用内嵌 catalog，不依赖 fetch
	    (function bootstrap() {
	      catalogCuratedPrograms = decoratePrograms(embeddedCatalog ? parseItems(embeddedCatalog) : []);
	      catalogKaplanPrograms = decoratePrograms(buildKaplanPrograms(kaplanProgrammePdfJun2025 || []));
	      catalogPsbPrograms = decoratePrograms(buildPsbPrograms(psbProgrammeSitemap || []));
	      catalogSimPrograms = decoratePrograms(buildSimPrograms(simProgrammeSitemap || []));
	      catalogCurtinPrograms = decoratePrograms(buildCurtinPrograms(curtinProgrammeSitemap || []));
	      catalogLsbfPrograms = decoratePrograms(buildLsbfPrograms(lsbfProgrammeSitemap || []));
	      catalogCustomPrograms = decoratePrograms(loadCustomProgramsFromStorage());

      let saved = null;
      try { saved = localStorage.getItem(catalogModeStorageKey); } catch {}
		      currentCatalogMode = normalizeCatalogMode(saved || "all");

      const modeEl = document.getElementById("catalog-mode");
      const protocolOk = /^https?:$/.test(String(location && location.protocol));
      if (currentCatalogMode === "nocodb_shared") {
        const { sharedView } = readNocoDbSettings();
        if (!protocolOk || !String(sharedView || "").trim()) {
          currentCatalogMode = "all";
          try { localStorage.setItem(catalogModeStorageKey, currentCatalogMode); } catch {}
        }
      }
      if (currentCatalogMode === "custom_db" && !(catalogCustomPrograms && catalogCustomPrograms.length)) {
        currentCatalogMode = "all";
        try { localStorage.setItem(catalogModeStorageKey, currentCatalogMode); } catch {}
      }
      if (modeEl) modeEl.value = currentCatalogMode;

		      const initial = programsForCatalogMode(currentCatalogMode);
		      if (initial.length || currentCatalogMode === "nocodb_shared") {
		        init(initial);
		        return;
		      }
      if (catalogCuratedPrograms.length) {
        currentCatalogMode = "curated";
        if (modeEl) modeEl.value = currentCatalogMode;
        init(catalogCuratedPrograms);
        return;
      }
      if (catalogKaplanPrograms.length) {
        currentCatalogMode = "kaplan_full";
        if (modeEl) modeEl.value = currentCatalogMode;
        init(catalogKaplanPrograms);
        return;
      }
      if (catalogPsbPrograms.length) {
        currentCatalogMode = "psb_full";
        if (modeEl) modeEl.value = currentCatalogMode;
        init(catalogPsbPrograms);
        return;
      }
      if (catalogSimPrograms.length) {
        currentCatalogMode = "sim_full";
        if (modeEl) modeEl.value = currentCatalogMode;
        init(catalogSimPrograms);
        return;
      }
      if (catalogCurtinPrograms.length) {
        currentCatalogMode = "curtin_full";
        if (modeEl) modeEl.value = currentCatalogMode;
        init(catalogCurtinPrograms);
        return;
      }
      if (catalogLsbfPrograms.length) {
        currentCatalogMode = "lsbf_full";
        if (modeEl) modeEl.value = currentCatalogMode;
        init(catalogLsbfPrograms);
        return;
      }
      init(programsFallback);
    })();

		    function getFilters() {
		      const age = parseInt(document.getElementById("age").value, 10);
		      const budget = parseInt(document.getElementById("budget").value, 10);
		      const tuitionMax = parseInt(document.getElementById("tuition-max").value, 10);
		      const durationMaxMonths = parseFloat(document.getElementById("duration-max-months").value);
		      const qsMax = parseInt(document.getElementById("qs-max").value, 10);
		      return {
		        age: isNaN(age) ? null : age,
		        education: document.getElementById("education").value,
		        budget: isNaN(budget) ? null : budget,
		        tuitionMax: !isNaN(tuitionMax) && tuitionMax > 0 ? tuitionMax : null,
		        durationMaxMonths: Number.isFinite(durationMaxMonths) && durationMaxMonths > 0 ? durationMaxMonths : null,
		        qsMax: !isNaN(qsMax) && qsMax > 0 ? qsMax : null,
		        cscse: document.getElementById("cscse").value,
		        route: document.getElementById("route").value,
		        major: document.getElementById("major").value,
		        provider: document.getElementById("provider").value,
	        keyword: document.getElementById("keyword").value,
	      };
	    }

    function computeRouteStats(programs, filters) {
      const baseFilters = { ...filters, route: "" };
      const candidates = programs.filter((p) => matches(p, baseFilters));
      const stats = new Map();
      candidates.forEach((p) => {
        (p.routes || []).forEach((r) => {
          const item = stats.get(r) || { route: r, count: 0 };
          item.count += 1;
          stats.set(r, item);
        });
      });
      const routes = Array.from(stats.values()).sort((a, b) => b.count - a.count);
      return { routes, candidatesCount: candidates.length };
    }

    function renderRouteResults(programs, filters) {
      if (!routeResultsEl || !routeResultsNoteEl) return;

      const { routes, candidatesCount } = computeRouteStats(programs, filters);
      lastRouteStats = routes;
      routeResultsEl.innerHTML = "";

	      if (!filters.age && !filters.education && !filters.budget && !filters.tuitionMax && !filters.durationMaxMonths && !filters.qsMax && !filters.cscse && !filters.major && !filters.provider && !filters.keyword) {
	        routeResultsNoteEl.textContent = "提示：先填年龄/学历/预算/方向，再看可走路线。/ Tip: fill age/education/budget/major first.";
	        return;
	      }

      if (routes.length === 0) {
        routeResultsNoteEl.textContent = "当前条件下未找到可走路线，请调整条件（尤其是预算/学历）。/ No available tracks. Adjust budget/education.";
        return;
      }

      const noteParts = [];
      if (candidatesCount) noteParts.push(`${bi("匹配到", "Matches")} ${candidatesCount} ${bi("个可选项目", "programs")}`);
      if (filters.route) noteParts.push(`${bi("当前已选择路线", "Selected track")}: ${bi(routeLabel(filters.route), routeLabelEn(filters.route))}`);
      routeResultsNoteEl.textContent = noteParts.length ? noteParts.join(" · ") : bi("已计算可走路线。", "Tracks computed.");

      const clear = document.createElement("span");
      clear.className = "pill";
      clear.style.cursor = "pointer";
      clear.textContent = bi("清除路线筛选", "Clear track filter");
      clear.addEventListener("click", () => {
        document.getElementById("route").value = "";
        render(currentPrograms);
      });
      routeResultsEl.appendChild(clear);

      routes.forEach((r) => {
        const pill = document.createElement("span");
        pill.className = "pill good";
        pill.style.cursor = "pointer";
        pill.textContent = `${bi(routeLabel(r.route), routeLabelEn(r.route))} (${r.count})`;
        pill.addEventListener("click", () => {
          document.getElementById("route").value = r.route;
          render(currentPrograms);
        });
        routeResultsEl.appendChild(pill);
      });
    }

    function routeInstitutionDefaults(route) {
      return {
        private_university: { cn: "私立大学", en: "Private University" },
        dual_degree: { cn: "合作办学", en: "Partner University" },
        k12_public: { cn: "K12 公立 (AEIS)", en: "K12 Public (AEIS)" },
        k12_international: { cn: "K12 国际学校", en: "K12 International School" },
        kindergarten: { cn: "幼儿园", en: "Kindergarten" },
        nus_highend: { cn: "公立大学", en: "Public University" },
      }[route] || { cn: "", en: "" };
    }

    function defaultTargetFromShortlist() {
      const items = Array.from(shortlist.values());
      if (items.length === 0) return "";
      const names = items.slice(0, 3).map((p) => p.name);
      const suffix = items.length > 3 ? ` 等${items.length}个` : "";
      return names.join(" / ") + suffix;
    }

    function suggestedMajorFromContext(filters) {
      if (filters.major) return majorLabel(filters.major);
      const first = Array.from(shortlist.values())[0];
      if (first && first.major) return majorLabel(first.major);
      return "";
    }

    function suggestedRouteFromContext(filters) {
      if (filters.route) return filters.route;
      if (lastRouteStats && lastRouteStats.length) return lastRouteStats[0].route;
      return "";
    }

	    function syncContractDefaultsFromContext(filters) {
	      const contractNoEl = document.getElementById("contract-no");
	      const paymentDateEl = document.getElementById("payment-date");
	      const institutionCnEl = document.getElementById("institution-cn");
	      const institutionEnEl = document.getElementById("institution-en");
	      const targetSchoolEl = document.getElementById("target-school");
	      const targetMajorEl = document.getElementById("target-major");

      if (!contractNoEl.value) contractNoEl.value = generateContractNo();
      if (paymentDateEl && !paymentDateEl.value) paymentDateEl.valueAsDate = new Date();

      const suggestedRoute = suggestedRouteFromContext(filters);
      const institutionDefaults = routeInstitutionDefaults(suggestedRoute);
      if (institutionCnEl && !institutionCnEl.value) institutionCnEl.value = institutionDefaults.cn;
      if (institutionEnEl && !institutionEnEl.value) institutionEnEl.value = institutionDefaults.en;

      const suggestedTarget = defaultTargetFromShortlist();
      if (targetSchoolEl && !targetSchoolEl.value && suggestedTarget) targetSchoolEl.value = suggestedTarget;

	      const suggestedMajor = suggestedMajorFromContext(filters);
	      if (targetMajorEl && !targetMajorEl.value && suggestedMajor) targetMajorEl.value = suggestedMajor;

		      renderContractTypeNote(filters);
		      updateContractUiVisibility(filters);
		      renderPricingControls(filters);
		      renderAddonControls(filters);
		      updatePricingSummary(filters);
		      autoApplyPricingIfBlank(filters);
		    }

			    function initContractPanel() {
			      const contractStatusEl = document.getElementById("contract-status");
			      const contractTypeEl = document.getElementById("contract-type");
			      const pricingItemEl = document.getElementById("pricing-item");
			      const applyPricingEl = document.getElementById("apply-pricing");
			      const consultantEl = document.getElementById("consultant");
			      const contractNoEl = document.getElementById("contract-no");
			      const regenEl = document.getElementById("regen-contract-no");
			      const previewBtn = document.getElementById("preview-contract");
			      const downloadBtn = document.getElementById("download-contract");
			      const quotePreviewBtn = document.getElementById("preview-quote");
			      const quoteDownloadBtn = document.getElementById("download-quote");
			      const invoicePreviewBtn = document.getElementById("preview-invoice");
			      const invoiceDownloadBtn = document.getElementById("download-invoice");
			      const clientSheetPreviewBtn = document.getElementById("preview-client-sheet");
			      const clientSheetDownloadBtn = document.getElementById("download-client-sheet");
			      const saveCaseBtn = document.getElementById("save-case");
			      const openCaseBtn = document.getElementById("open-case");
			      const caseStatusEl = document.getElementById("case-status");

		      const storageKey = "maple_matchboard_contract_form_v1";
	      const restore = () => {
	        try {
	          const raw = localStorage.getItem(storageKey);
	          if (!raw) return;
	          const data = JSON.parse(raw);
	          Object.entries(data).forEach(([id, val]) => {
	            const el = document.getElementById(id);
	            if (!el) return;
	            if (el.type === "checkbox") {
	              el.checked = String(val) === "1" || String(val).toLowerCase() === "true";
	              return;
	            }
	            if (typeof val === "string" && !el.value) el.value = val;
	          });
	        } catch {
	          // ignore
	        }
	      };
			      const persist = () => {
			        try {
			          const ids = [
			            "contract-type",
			            "pricing-item",
			            "addons-selected",
			            "refund-terms",
			            "include-quote-page",
			            "consultant", "country-cn", "country-en", "institution-cn", "institution-en",
			            "fee-sgd", "pay-method", "initial-sgd", "fx-cny-per-sgd", "target-grade",
			          ];
		          const data = {};
		          ids.forEach((id) => {
		            const el = document.getElementById(id);
	            if (!el) return;
	            if (el.type === "checkbox") {
	              data[id] = el.checked ? "1" : "0";
	              return;
	            }
	            if (el.value) data[id] = el.value;
	          });
	          localStorage.setItem(storageKey, JSON.stringify(data));
	        } catch {
	          // ignore
	        }
		      };

	      restore();
	      initFxCnyPerSgdInput();
	      syncContractDefaultsFromContext(getFilters());

		      const salesRemindersWrapEl = document.getElementById("sales-reminders");
		      const salesRemindersSelectedEl = document.getElementById("sales-reminders-selected");
		      const salesRemindersNoteEl = document.getElementById("sales-reminders-note");

		      function syncSalesRemindersSelectedValue() {
		        if (!salesRemindersWrapEl || !salesRemindersSelectedEl) return;
		        const checked = Array.from(salesRemindersWrapEl.querySelectorAll("input[type='checkbox'][data-id]:checked"))
		          .map((el) => String(el.getAttribute("data-id") || "").trim())
		          .filter(Boolean);
		        salesRemindersSelectedEl.value = checked.join(", ");
		        if (salesRemindersNoteEl) salesRemindersNoteEl.textContent = checked.length ? `已勾选 ${checked.length} 项` : "未勾选（可留空）";
		      }

		      function renderSalesRemindersControls() {
		        if (!salesRemindersWrapEl || !salesRemindersSelectedEl) return;
		        const selected = new Set(splitMultiValue(salesRemindersSelectedEl.value));
		        salesRemindersWrapEl.innerHTML = SALES_REMINDER_ITEMS.map((item) => {
		          const checked = selected.has(item.id) ? "checked" : "";
		          const note = item.note ? `<span class="muted">${escapeHtml(item.note)}</span>` : "";
		          return `
		            <label class="list-item" style="display:flex; gap:10px; align-items:flex-start; cursor:pointer;">
		              <input type="checkbox" data-id="${escapeHtml(item.id)}" ${checked} style="width:auto; margin-top:2px;" />
		              <div>
		                <strong>${escapeHtml(item.label)}</strong><br/>
		                ${note}
		              </div>
		            </label>
		          `;
		        }).join("");
		      }

		      renderSalesRemindersControls();
		      syncSalesRemindersSelectedValue();
		      if (salesRemindersWrapEl) {
		        salesRemindersWrapEl.addEventListener("change", () => {
		          syncSalesRemindersSelectedValue();
		        });
		      }

			      [
			        "contract-type",
			        "pricing-item",
			        "refund-terms",
			        "include-quote-page",
			        "consultant", "client-name", "client-id", "client-passport", "client-address", "client-phone", "client-email",
			        "child-name",
			        "target-grade",
			        "country-cn", "country-en", "institution-cn", "institution-en", "target-school", "target-major",
			        "fee-sgd", "pay-method", "initial-sgd", "fx-cny-per-sgd", "payment-date", "contract-no",
			      ].forEach((id) => {
		        const el = document.getElementById(id);
		        if (!el) return;
	        el.addEventListener("input", persist);
	        el.addEventListener("change", persist);
	      });

		      const addonItemsEl = document.getElementById("addon-items");
		      if (addonItemsEl) {
		        addonItemsEl.addEventListener("change", () => {
		          syncAddonsSelectedValue();
		          updatePricingSummary(getFilters());
		          persist();
		        });
		      }

		      const fxEl = document.getElementById("fx-cny-per-sgd");
		      if (fxEl) {
			        const onFxChange = () => {
			          persistFxCnyPerSgd();
			          renderPricingControls(getFilters());
			          renderAddonControls(getFilters());
			          updatePricingSummary(getFilters());
			          autoApplyPricingIfBlank(getFilters());
			          if (Array.isArray(currentPrograms) && currentPrograms.length) render(currentPrograms);
			          persist();
			        };
		        fxEl.addEventListener("input", onFxChange);
		        fxEl.addEventListener("change", onFxChange);
		      }

		      document.getElementById("route").addEventListener("change", () => {
		        const r = document.getElementById("route").value;
		        const defaults = routeInstitutionDefaults(r);
		        const cnEl = document.getElementById("institution-cn");
		        const enEl = document.getElementById("institution-en");
	        if (cnEl) cnEl.value = defaults.cn;
		        if (enEl) enEl.value = defaults.en;
		        renderContractTypeNote(getFilters());
		        updateContractUiVisibility(getFilters());
		        renderPricingControls(getFilters());
		        renderAddonControls(getFilters());
		        updatePricingSummary(getFilters());
		        autoApplyPricingIfBlank(getFilters());
		        persist();
		      });

		      if (contractTypeEl) {
		        contractTypeEl.addEventListener("change", () => {
		          renderContractTypeNote(getFilters());
		          updateContractUiVisibility(getFilters());
		          renderPricingControls(getFilters());
		          renderAddonControls(getFilters());
		          updatePricingSummary(getFilters());
		          autoApplyPricingIfBlank(getFilters());
		          persist();
		        });
		      }

		      if (pricingItemEl) {
		        pricingItemEl.addEventListener("change", () => {
		          renderPricingControls(getFilters());
		          updatePricingSummary(getFilters());
		          autoApplyPricingIfBlank(getFilters());
		          persist();
		        });
		      }
		      if (applyPricingEl) {
		        applyPricingEl.addEventListener("click", () => {
		          applySelectedPricing(getFilters(), { force: true });
		          updatePricingSummary(getFilters());
		          persist();
		        });
		      }

	      regenEl.addEventListener("click", () => {
	        contractNoEl.value = generateContractNo();
	        persist();
	        renderCaseUi();
	      });

				      function setStatus(msg) {
				        if (!contractStatusEl) return;
				        contractStatusEl.textContent = msg;
				      }

				      const caseIndexStorageKey = "maple_matchboard_case_index_v1";
				      function readCaseIndex() {
				        try {
				          const raw = localStorage.getItem(caseIndexStorageKey);
				          if (!raw) return {};
				          const parsed = JSON.parse(raw);
				          return parsed && typeof parsed === "object" ? parsed : {};
				        } catch {
				          return {};
				        }
				      }
				      function writeCaseIndex(index) {
				        try {
				          localStorage.setItem(caseIndexStorageKey, JSON.stringify(index || {}));
				        } catch {}
				      }
				      function currentContractNo() {
				        const el = document.getElementById("contract-no");
				        return el ? String(el.value || "").trim() : "";
				      }
				      function currentCaseId() {
				        const contractNo = currentContractNo();
				        if (!contractNo) return "";
				        const idx = readCaseIndex();
				        return String(idx[contractNo] || "").trim();
				      }
				      function setCurrentCaseId(caseId) {
				        const contractNo = currentContractNo();
				        if (!contractNo || !caseId) return;
				        const idx = readCaseIndex();
				        idx[contractNo] = String(caseId).trim();
				        writeCaseIndex(idx);
				      }
				      function renderCaseUi(extraMsg) {
				        if (!caseStatusEl) return;
				        const id = currentCaseId();
				        if (openCaseBtn) openCaseBtn.disabled = !id;
				        const base = id ? `当前案件：${id}` : "当前案件：未保存";
				        caseStatusEl.textContent = extraMsg ? `${base} · ${extraMsg}` : base;
				      }

				      function readApiBaseUrl() {
				        const cfg = (typeof window !== "undefined" && window.MAPLE_MATCHBOARD_CONFIG && typeof window.MAPLE_MATCHBOARD_CONFIG === "object")
				          ? window.MAPLE_MATCHBOARD_CONFIG
			          : {};
			        const api = (cfg && cfg.api && typeof cfg.api === "object") ? cfg.api : {};
			        const raw = (api && typeof api.baseUrl === "string") ? api.baseUrl : "";
			        const base = normalizeBaseUrl(raw);
			        return base || "";
			      }

				      function buildArchiveMeta(kind) {
				        const filters = getFilters();
			        const val = (id) => {
			          const el = document.getElementById(id);
			          return el ? String(el.value || "").trim() : "";
			        };
			        const shortlistItems = Array.from(shortlist.values()).slice(0, 12).map((p) => ({
			          id: p.id || "",
			          name: p.name || "",
			          provider: p.provider || "",
			          partner: p.partner || "",
			          official: p.official || "",
			        }));

				        return {
				          kind,
				          generatedAt: new Date().toISOString(),
				          filters,
				          contractNo: val("contract-no"),
				          contractType: resolveContractType(filters),
				          route: suggestedRouteFromContext(filters),
				          consultant: val("consultant"),
			          client: {
			            name: val("client-name"),
			            phone: val("client-phone"),
			            email: val("client-email"),
			            idNumber: val("client-id"),
			            passportNumber: val("client-passport"),
			            address: val("client-address"),
			          },
			          target: {
			            countryCn: val("country-cn"),
			            countryEn: val("country-en"),
			            institutionCn: val("institution-cn"),
			            institutionEn: val("institution-en"),
			            targetSchool: val("target-school"),
			            targetMajor: val("target-major"),
			          },
			          sales: {
			            startDate: val("start-date"),
			            deadlineDate: val("deadline-date"),
			            remindersSelected: splitMultiValue(val("sales-reminders-selected")).slice(0, 50),
			            notes: val("sales-notes"),
			          },
				          shortlist: shortlistItems,
				        };
				      }

				      function buildCasePayload() {
				        const meta = buildArchiveMeta("case");
				        const getVal = (id) => {
				          const el = document.getElementById(id);
				          return el ? String(el.value || "").trim() : "";
				        };
				        return {
				          service_type: "study",
				          status: "consultation",
				          consultant: meta.consultant || "",
				          client_name: (meta.client || {}).name || "",
				          client_phone: (meta.client || {}).phone || "",
				          client_email: (meta.client || {}).email || "",
				          client_wechat: "",
				          contract_no: meta.contractNo || "",
				          inputs: {
				            filters: meta.filters || {},
				            target: meta.target || {},
				            refund_terms: getVal("refund-terms"),
				            pricing_item: getVal("pricing-item"),
				            fee_sgd: getVal("fee-sgd"),
				            sales: {
				              start_date: getVal("start-date"),
				              deadline_date: getVal("deadline-date"),
				              reminders_selected: getVal("sales-reminders-selected"),
				              notes: getVal("sales-notes"),
				            },
				          },
				          match: {
				            route: meta.route || "",
				            contract_type: meta.contractType || "",
				            shortlist: meta.shortlist || [],
				          },
				          notes: "",
				        };
				      }

				      function hasMeaningfulCaseInfo() {
				        const v = (id) => {
				          const el = document.getElementById(id);
				          return el ? String(el.value || "").trim() : "";
				        };
				        return !!(v("client-name") || v("client-phone") || v("client-email") || v("consultant"));
				      }

				      async function saveOrUpdateCase() {
				        try {
				          if (!/^https?:$/.test(String(location && location.protocol))) return "";
				          if (typeof fetch !== "function") return "";
				          if (!hasMeaningfulCaseInfo()) return "";
				          const baseUrl = readApiBaseUrl();
				          const payload = buildCasePayload();

				          let id = currentCaseId();
				          if (id) {
				            const res = await fetch(`${baseUrl}/api/cases/${encodeURIComponent(id)}`, {
				              method: "PATCH",
				              headers: { "Content-Type": "application/json" },
				              body: JSON.stringify(payload),
				            });
				            if (res.ok) return id;
				          }

				          const res = await fetch(`${baseUrl}/api/cases`, {
				            method: "POST",
				            headers: { "Content-Type": "application/json" },
				            body: JSON.stringify(payload),
				          });
				          if (!res.ok) return "";
				          const data = await res.json().catch(() => null);
				          id = data && data.id ? String(data.id) : "";
				          if (id) setCurrentCaseId(id);
				          return id;
				        } catch {
				          return "";
				        }
				      }

				      async function ensureCaseId() {
				        const id = currentCaseId();
				        if (id) return id;
				        return await saveOrUpdateCase();
				      }

				      async function tryArchiveGeneratedDoc(kind, filename, html, caseId) {
				        try {
				          if (!/^https?:$/.test(String(location && location.protocol))) return false;
				          if (typeof fetch !== "function") return false;
				          const baseUrl = readApiBaseUrl();
				          const url = `${baseUrl}/api/documents`;
				          const body = { kind, filename, html, meta: buildArchiveMeta(kind) };
				          if (caseId) body.case_id = caseId;
				          const res = await fetch(url, {
				            method: "POST",
				            headers: { "Content-Type": "application/json" },
				            body: JSON.stringify(body),
				          });
				          return res.ok;
				        } catch {
				          return false;
				        }
				      }

				      if (saveCaseBtn) {
				        saveCaseBtn.addEventListener("click", async () => {
				          renderCaseUi("保存中…");
				          const id = await saveOrUpdateCase();
				          renderCaseUi(id ? "已保存" : "保存失败（请检查 NAS MVP 是否已部署）");
				        });
				      }

				      if (openCaseBtn) {
				        openCaseBtn.addEventListener("click", () => {
				          const id = currentCaseId();
				          if (!id) {
				            renderCaseUi("尚未保存案件");
				            return;
				          }
				          window.open(`/admin/cases/${encodeURIComponent(id)}/`, "_blank");
				        });
				      }

				      if (contractNoEl) {
				        contractNoEl.addEventListener("input", () => renderCaseUi());
				        contractNoEl.addEventListener("change", () => renderCaseUi());
				      }

				      async function doGenerate(mode) {
				        try {
				          setStatus("正在生成…");
				          const isQuote = mode === "quote_preview" || mode === "quote_download";
				          const isInvoice = mode === "invoice_preview" || mode === "invoice_download";
			          const pkg = isQuote ? buildQuotationPackage() : (isInvoice ? buildInvoicePackage() : buildContractPackage());
			          const html = pkg.html;
			          const filename = pkg.filename;
			          if (mode === "preview" || mode === "quote_preview" || mode === "invoice_preview") {
			            const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
			            window.open(url, "_blank");
			            setTimeout(() => URL.revokeObjectURL(url), 60_000);
			            setStatus(pkg.note ? `已打开预览页（${pkg.note}）` : "已打开预览页（如被拦截，请允许弹窗）。");
			            return;
				          }
				          downloadText(filename, html);
				          const kind = isQuote ? "quote" : (isInvoice ? "invoice" : "contract");
				          const caseId = await ensureCaseId();
				          const archived = await tryArchiveGeneratedDoc(kind, filename, html, caseId);
				          const extra = archived ? (caseId ? " · 已归档并关联案件" : " · 已归档到档案库") : "";
				          setStatus((pkg.note ? `已下载：${filename}（${pkg.note}）` : `已下载：${filename}`) + extra);
				        } catch (err) {
				          setStatus(`生成失败：${err && err.message ? err.message : String(err)}`);
				        }
				      }

				      function doGenerateClientSheet(mode) {
				        try {
				          setStatus("正在生成客户表单…");
				          const pkg = buildClientSheetPackage();
				          const html = pkg.html;
				          const filename = pkg.filename;
				          if (mode === "preview") {
				            const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
				            window.open(url, "_blank");
				            setTimeout(() => URL.revokeObjectURL(url), 60_000);
				            setStatus("已打开客户表单预览页（如被拦截，请允许弹窗）。");
				            return;
				          }
				          downloadText(filename, html);
				          setStatus(`已下载客户表单：${filename}`);
				        } catch (err) {
				          setStatus(`客户表单生成失败：${err && err.message ? err.message : String(err)}`);
				        }
				      }

	      previewBtn.addEventListener("click", () => doGenerate("preview"));
	      downloadBtn.addEventListener("click", () => doGenerate("download"));
	      if (quotePreviewBtn) quotePreviewBtn.addEventListener("click", () => doGenerate("quote_preview"));
	      if (quoteDownloadBtn) quoteDownloadBtn.addEventListener("click", () => doGenerate("quote_download"));
	      if (invoicePreviewBtn) invoicePreviewBtn.addEventListener("click", () => doGenerate("invoice_preview"));
	      if (invoiceDownloadBtn) invoiceDownloadBtn.addEventListener("click", () => doGenerate("invoice_download"));
	      if (clientSheetPreviewBtn) clientSheetPreviewBtn.addEventListener("click", () => doGenerateClientSheet("preview"));
	      if (clientSheetDownloadBtn) clientSheetDownloadBtn.addEventListener("click", () => doGenerateClientSheet("download"));

	      renderCaseUi();
	      if (!consultantEl.value) setStatus("提示：填写顾问/客户信息后，可直接生成合同。");
	    }

    function generateContractNo() {
      const d = new Date();
      const yyyy = String(d.getFullYear());
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      const rand = String(Math.floor(Math.random() * 9000) + 1000);
      return `MAPLE-${yyyy}${mm}${dd}-${rand}`;
    }

	    function downloadText(filename, text, mimeType = "text/html;charset=utf-8") {
	      const blob = new Blob([text], { type: mimeType });
	      const url = URL.createObjectURL(blob);
	      const a = document.createElement("a");
	      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }

    function sanitizeFilenamePart(input) {
      return String(input || "")
        .trim()
        .replace(/[<>:"/\\|?*]+/g, "_")
        .replace(/\s+/g, " ")
        .slice(0, 60) || "客户";
    }

		    function buildContractFilename() {
		      const name = sanitizeFilenamePart(document.getElementById("client-name").value);
		      const contractNo = sanitizeFilenamePart(document.getElementById("contract-no").value);
		      const type = resolveContractType(getFilters());
		      const suffix = sanitizeFilenamePart(contractTypeLabel(type));
		      return `${name}_${contractNo}_${suffix}.html`;
		    }

		    function buildClientSheetFilename() {
		      const name = sanitizeFilenamePart(document.getElementById("client-name").value);
		      const contractNo = sanitizeFilenamePart(document.getElementById("contract-no").value);
		      return `${name}_${contractNo}_客户表单.html`;
		    }

		    function buildClientSheetPackage() {
		      const filters = getFilters();
		      const val = (id) => {
		        const el = document.getElementById(id);
		        return el ? String(el.value || "").trim() : "";
		      };
		      const now = new Date();
		      const createdAt = now.toISOString().replace("T", " ").replace("Z", "");

		      const consultant = val("consultant");
		      const contractNo = val("contract-no");
		      const clientName = val("client-name");
		      const phone = val("client-phone");
		      const email = val("client-email");
		      const budget = (filters && Number.isFinite(Number(filters.budget)) && Number(filters.budget) > 0)
		        ? `SGD ${Math.round(Number(filters.budget)).toLocaleString()}/年`
		        : "";
		      const startDate = val("start-date");
		      const deadlineDate = val("deadline-date");
		      const salesNotes = val("sales-notes");

		      const targetSchool = val("target-school");
		      const targetMajor = val("target-major");
		      const route = filters && filters.route ? routeLabel(filters.route) : "";
		      const provider = filters && filters.provider ? String(filters.provider) : "";
		      const keyword = filters && filters.keyword ? String(filters.keyword) : "";

		      const remindersSelected = new Set(splitMultiValue(val("sales-reminders-selected")));
		      const remindersHtml = SALES_REMINDER_ITEMS.map((item) => {
		        const checked = remindersSelected.has(item.id) ? "[x]" : "[ ]";
		        const label = escapeHtml(item.label);
		        const note = item.note ? ` <span class="muted">(${escapeHtml(item.note)})</span>` : "";
		        return `<li>${checked} ${label}${note}</li>`;
		      }).join("");

		      const picked = Array.from(shortlist.values());
		      const coursesHtml = picked.length
		        ? `<ol>${picked.map((p) => {
		          const line = [
		            escapeHtml(p.name || ""),
		            p.provider ? escapeHtml(p.provider) : "",
		            p.partner ? escapeHtml(p.partner) : "",
		          ].filter(Boolean).join(" · ");
		          return `<li>${line}</li>`;
		        }).join("")}</ol>`
		        : `<div class="muted">—</div>`;

		      const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(clientName || "客户")} · 客户表单</title>
  <style>
    :root { --muted: #6b7280; --border: #e5e7eb; --bg: #ffffff; --card: #ffffff; --text: #111827; --soft: #f9fafb; }
    body { margin: 24px; font-family: "Segoe UI", "Microsoft YaHei", sans-serif; background: var(--bg); color: var(--text); }
    h1 { margin: 0 0 6px; font-size: 22px; }
    h2 { margin: 0 0 8px; font-size: 16px; }
    .muted { color: var(--muted); font-size: 12px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 12px; }
    .card { border: 1px solid var(--border); border-radius: 12px; padding: 12px; background: var(--card); }
    table { width: 100%; border-collapse: collapse; }
    td { padding: 6px 0; vertical-align: top; }
    td.key { color: var(--muted); width: 140px; padding-right: 10px; }
    ul, ol { margin: 8px 0 0 18px; padding: 0; }
    .pre { white-space: pre-wrap; background: var(--soft); border: 1px solid var(--border); border-radius: 10px; padding: 10px; }
    @media (max-width: 860px) { .grid { grid-template-columns: 1fr; } td.key { width: 110px; } }
  </style>
</head>
<body>
  <h1>${escapeHtml(clientName || "客户")} · 客户表单</h1>
  <div class="muted">生成时间：${escapeHtml(createdAt)}${consultant ? ` · 顾问：${escapeHtml(consultant)}` : ""}${contractNo ? ` · 合同号：${escapeHtml(contractNo)}` : ""}</div>

  <div class="grid">
    <div class="card">
      <h2>客户信息</h2>
      <table>
        <tr><td class="key">电话</td><td>${escapeHtml(phone) || "—"}</td></tr>
        <tr><td class="key">邮箱</td><td>${escapeHtml(email) || "—"}</td></tr>
        <tr><td class="key">年预算</td><td>${escapeHtml(budget) || "—"}</td></tr>
        <tr><td class="key">预计开学</td><td>${escapeHtml(startDate) || "—"}</td></tr>
        <tr><td class="key">截止日期</td><td>${escapeHtml(deadlineDate) || "—"}</td></tr>
      </table>
    </div>

    <div class="card">
      <h2>目标与筛选</h2>
      <table>
        <tr><td class="key">目标项目</td><td>${escapeHtml(targetSchool) || "—"}</td></tr>
        <tr><td class="key">专业</td><td>${escapeHtml(targetMajor) || "—"}</td></tr>
        <tr><td class="key">路线</td><td>${escapeHtml(route) || "—"}</td></tr>
        <tr><td class="key">机构</td><td>${escapeHtml(provider) || "—"}</td></tr>
        <tr><td class="key">关键词</td><td>${escapeHtml(keyword) || "—"}</td></tr>
      </table>
    </div>
  </div>

  <div class="grid">
    <div class="card">
      <h2>已选课程</h2>
      ${coursesHtml}
    </div>
    <div class="card">
      <h2>提醒清单</h2>
      <ul>${remindersHtml}</ul>
    </div>
  </div>

  <div class="card" style="margin-top:12px;">
    <h2>备注</h2>
    <div class="pre">${escapeHtml(salesNotes) || "—"}</div>
  </div>
</body>
</html>`;

		      return { html, filename: buildClientSheetFilename(), note: "客户表单" };
		    }

    function escapeHtml(input) {
      return String(input || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function findTableAfterSection(doc, titleIncludes) {
      const titleEl = Array.from(doc.querySelectorAll(".section-title")).find((el) => el.textContent.includes(titleIncludes));
      if (!titleEl) return null;
      let el = titleEl;
      while (el) {
        el = el.nextElementSibling;
        if (!el) break;
        const table = el.querySelector("table");
        if (table) return table;
      }
      return null;
    }

    function setTableValue(table, labelIncludes, value) {
      const v = String(value || "").trim();
      if (!v) return;
      const rows = Array.from(table.querySelectorAll("tr"));
      for (const row of rows) {
        const tds = row.querySelectorAll("td");
        if (tds.length < 2) continue;
        const label = tds[0].textContent.replace(/\s+/g, " ").trim();
        if (!label.includes(labelIncludes)) continue;
        tds[1].textContent = v;
        return;
      }
    }

    function setStrongTrailingText(doc, strongIncludes, value) {
      const v = String(value || "").trim();
      if (!v) return;
      const strong = Array.from(doc.querySelectorAll("strong")).find((el) => el.textContent.includes(strongIncludes));
      if (!strong) return;
      let node = strong.nextSibling;
      while (node && node.nodeType !== Node.TEXT_NODE) node = node.nextSibling;
      if (node) node.nodeValue = ` ${v} `;
    }

    function formatAmount(raw) {
      const v = String(raw || "").trim().replace(/,/g, "");
      return v || "__________";
    }

    function formatPaymentDate(raw) {
      const v = String(raw || "").trim();
      if (!v) return "____ 年 __ 月 __ 日 / ___/___/______";
      const [yyyy, mm, dd] = v.split("-");
      if (!yyyy || !mm || !dd) return "____ 年 __ 月 __ 日 / ___/___/______";
      return `${yyyy} 年 ${mm} 月 ${dd} 日 / ${dd}/${mm}/${yyyy}`;
    }

    function getStudentContractTemplateHtml() {
      const el = document.getElementById("student-contract-template");
      if (!el) throw new Error("缺少合同模板（student-contract-template）");
      const html = el.textContent || "";
      if (!html.trim()) throw new Error("合同模板为空");
      return html.trim();
    }

    function buildFilledContractHtml() {
      const templateHtml = getStudentContractTemplateHtml();
      const parser = new DOMParser();
      const doc = parser.parseFromString(templateHtml, "text/html");

      // Step 4 会注入 LOGO_DATA_URL
      const logoDataUrl = typeof LOGO_DATA_URL === "string" ? LOGO_DATA_URL : null;
      if (logoDataUrl) {
        doc.querySelectorAll("img").forEach((img) => {
          img.setAttribute("src", logoDataUrl);
        });
      }

      const contractNo = document.getElementById("contract-no").value.trim();
      const consultant = document.getElementById("consultant").value.trim();
      const clientName = document.getElementById("client-name").value.trim();
      const idNumber = document.getElementById("client-id").value.trim();
      const passportNumber = document.getElementById("client-passport").value.trim();
      const address = document.getElementById("client-address").value.trim();
      const phone = document.getElementById("client-phone").value.trim();
      const email = document.getElementById("client-email").value.trim();
      const countryCn = document.getElementById("country-cn").value.trim();
      const countryEn = document.getElementById("country-en").value.trim();
	      const institutionCn = document.getElementById("institution-cn").value.trim();
	      const institutionEn = document.getElementById("institution-en").value.trim();
	      const targetSchool = document.getElementById("target-school").value.trim();
	      const targetMajor = document.getElementById("target-major").value.trim();
	      const feeSgd = formatAmount(document.getElementById("fee-sgd").value);
	      const payMethod = document.getElementById("pay-method").value;
	      const initSgd = formatAmount(document.getElementById("initial-sgd").value);
	      const paymentDate = formatPaymentDate(document.getElementById("payment-date").value);

      setStrongTrailingText(doc, "Contract No.", contractNo);
      setStrongTrailingText(doc, "Study Consultant", consultant);

      const applicantTable = findTableAfterSection(doc, "Contracting Parties");
      if (applicantTable) {
        setTableValue(applicantTable, "姓名 Name", clientName);
        setTableValue(applicantTable, "身份证号 ID Number", idNumber);
        setTableValue(applicantTable, "护照号 Passport Number", passportNumber);
        setTableValue(applicantTable, "联系地址 Contact Address", address);
        setTableValue(applicantTable, "联系电话 Contact Phone", phone);
        setTableValue(applicantTable, "电子邮箱 Email", email);
      }

      const cnArticle2 = Array.from(doc.querySelectorAll("div.cn")).find((el) =>
        el.textContent.includes("(国家/地区)") && el.textContent.includes("合同类型为") && el.textContent.includes("目标院校为")
      );
      if (cnArticle2) {
        cnArticle2.innerHTML = cnArticle2.innerHTML
          .replace(/申请赴\s*__________\s*\(国家\/地区\)/, `申请赴 ${escapeHtml(countryCn)} (国家/地区)`)
          .replace(/合同类型为\s*__________\s*\(院校类型\)/, `合同类型为 ${escapeHtml(institutionCn)} (院校类型)`)
          .replace(/目标院校为\s*__________/, `目标院校为 ${escapeHtml(targetSchool || "__________")}`)
          .replace(/专业为\s*__________/, `专业为 ${escapeHtml(targetMajor || "__________")}`);
      }

      const enArticle2 = Array.from(doc.querySelectorAll("div.en")).find((el) =>
        el.textContent.includes("(Country/Region)") && el.textContent.includes("contract type") && el.textContent.includes("target institution")
      );
      if (enArticle2) {
        enArticle2.innerHTML = enArticle2.innerHTML
          .replace(/apply for study in\s*__________\s*\(Country\/Region\)/, `apply for study in ${escapeHtml(countryEn)} (Country/Region)`)
          .replace(/contract type is\s*__________\s*\(Institution Type\)/, `contract type is ${escapeHtml(institutionEn)} (Institution Type)`)
          .replace(/target institution is\s*__________/, `target institution is ${escapeHtml(targetSchool || "__________")}`)
          .replace(/major is\s*__________/, `major is ${escapeHtml(targetMajor || "__________")}`);
      }

	      const feeTable = findTableAfterSection(doc, "Payment and Refund Regulations");
	      if (feeTable) {
	        const rows = feeTable.querySelectorAll("tr");
	        if (rows[0] && rows[0].children[1]) rows[0].children[1].innerHTML = `<strong>SGD $${escapeHtml(feeSgd)}</strong>`;
	        if (rows[1] && rows[1].children[1]) rows[1].children[1].textContent = payMethod === "installment"
	          ? "☐ 一次性付清 Full Payment ☑ 分期付款 Installment"
	          : "☑ 一次性付清 Full Payment ☐ 分期付款 Installment";
	        if (rows[2] && rows[2].children[1]) rows[2].children[1].textContent = `SGD $${initSgd}`;
	        if (rows[3] && rows[3].children[1]) rows[3].children[1].textContent = paymentDate;
	      }

	      return "<!doctype html>\n" + doc.documentElement.outerHTML;
	    }

	    function replaceAllText(haystack, needle, replacement) {
	      return String(haystack || "").split(String(needle)).join(String(replacement));
	    }

	    function replaceFirstText(haystack, needle, replacement) {
	      const str = String(haystack || "");
	      const n = String(needle);
	      const idx = str.indexOf(n);
	      if (idx === -1) return str;
	      return str.slice(0, idx) + String(replacement) + str.slice(idx + n.length);
	    }

	    function contractTypeLabel(type) {
	      return {
	        auto: "自动（按路线）",
	        main: "主合同",
	        main_private: "主合同 + 私立大学附录",
	        main_sim: "主合同 + SIM 附录",
	        main_highend: "主合同 + 高端附录",
	        main_k12_public: "主合同 + K12 公立/AEIS 附录",
	        main_k12_international: "主合同 + 国际学校附录",
	        kindergarten: "幼儿园协议",
	      }[type] || type;
	    }

	    function shortlistHasProvider(needle) {
	      const n = String(needle || "").toLowerCase();
	      return Array.from(shortlist.values()).some((p) => {
	        const provider = (p.provider || "").toLowerCase();
	        const id = (p.id || "").toLowerCase();
	        const name = (p.name || "").toLowerCase();
	        return provider.includes(n) || id.includes(n) || name.includes(n);
	      });
	    }

	    function resolveAutoContractType(filters) {
	      const suggestedRoute = suggestedRouteFromContext(filters);
	      if (suggestedRoute === "kindergarten") return "kindergarten";
	      if (suggestedRoute === "k12_public") return "main_k12_public";
	      if (suggestedRoute === "k12_international") return "main_k12_international";
	      if (suggestedRoute === "nus_highend") return "main_highend";
	      if (suggestedRoute === "private_university" || suggestedRoute === "dual_degree") {
	        return shortlistHasProvider("sim") ? "main_sim" : "main_private";
	      }
	      return "main";
	    }

	    function resolveContractType(filters) {
	      const select = document.getElementById("contract-type");
	      const val = select ? select.value : "auto";
	      if (val && val !== "auto") return val;
	      return resolveAutoContractType(filters);
	    }

	    function renderContractTypeNote(filters) {
	      const noteEl = document.getElementById("contract-type-note");
	      if (!noteEl) return;
	      const selectVal = (document.getElementById("contract-type") || {}).value || "auto";
	      const resolved = resolveContractType(filters);
	      if (selectVal !== "auto") {
	        noteEl.textContent = `当前：${contractTypeLabel(resolved)}`;
	        return;
	      }
	      const route = suggestedRouteFromContext(filters);
	      const reason = route ? `路线：${routeLabel(route)}` : "路线未选";
	      const simHint = (route === "private_university" || route === "dual_degree") ? (shortlistHasProvider("sim") ? "（检测到 SIM）" : "") : "";
	      noteEl.textContent = `自动：${contractTypeLabel(resolved)} · ${reason}${simHint}`;
	    }

			    function updateContractUiVisibility(filters) {
			      const resolved = resolveContractType(filters);
		      const childInput = document.getElementById("child-name");
		      const gradeInput = document.getElementById("target-grade");
		      const includeQuoteEl = document.getElementById("include-quote-page");
		      const refundEl = document.getElementById("refund-terms");
		      const isLowAge = resolved === "kindergarten" || resolved === "main_k12_public" || resolved === "main_k12_international";
		      const isK12 = resolved === "main_k12_public" || resolved === "main_k12_international";
		      const isKindergarten = resolved === "kindergarten";
		      if (childInput) {
		        const wrapper = childInput.closest("div");
		        if (wrapper) wrapper.style.display = isLowAge ? "block" : "none";
		      }
		      if (gradeInput) {
		        const wrapper = gradeInput.closest("div");
		        if (wrapper) wrapper.style.display = isK12 ? "block" : "none";
		      }
		      if (includeQuoteEl) {
		        includeQuoteEl.disabled = isKindergarten;
		        if (isKindergarten) includeQuoteEl.checked = false;
		      }
			      if (refundEl) {
			        refundEl.disabled = isKindergarten;
			        const wrapper = refundEl.closest("div");
			        if (wrapper) wrapper.style.opacity = isKindergarten ? "0.6" : "1";
			      }
			    }

			    // Currency policy: Output documents in SGD only.
			    // Any legacy CNY amounts in the pricing rules can be converted to SGD by a configurable FX rate.
			    const FX_STORAGE_KEY = "maple_fx_cny_per_sgd_v1";
			    const FX_DEFAULT_CNY_PER_SGD = 5.3;

			    function parsePositiveNumber(raw) {
			      const n = Number(String(raw || "").trim());
			      return Number.isFinite(n) && n > 0 ? n : null;
			    }

			    function readFxCnyPerSgd() {
			      const input = document.getElementById("fx-cny-per-sgd");
			      const fromInput = input ? parsePositiveNumber(input.value) : null;
			      if (fromInput) return fromInput;
			      const fromStorage = parsePositiveNumber(localStorage.getItem(FX_STORAGE_KEY));
			      if (fromStorage) return fromStorage;
			      return FX_DEFAULT_CNY_PER_SGD;
			    }

			    function initFxCnyPerSgdInput() {
			      const input = document.getElementById("fx-cny-per-sgd");
			      if (!input) return;
			      if (String(input.value || "").trim()) return;
			      const fx = readFxCnyPerSgd();
			      input.value = String(fx);
			    }

			    function persistFxCnyPerSgd() {
			      try {
			        localStorage.setItem(FX_STORAGE_KEY, String(readFxCnyPerSgd()));
			      } catch {
			        // ignore
			      }
			    }

			    function cnyToSgdAmount(cny, fx) {
			      const n = parsePositiveNumber(cny);
			      const f = parsePositiveNumber(fx);
			      if (!n || !f) return null;
			      return Math.round(n / f);
			    }

			    function convertRefundTextToSgd(text, fx) {
			      const raw = String(text || "").trim();
			      if (!raw) return "";
			      const f = parsePositiveNumber(fx);
			      if (!f) return raw;
			      const convert = (num) => {
			        const n = Number(String(num || "").replace(/,/g, ""));
			        if (!Number.isFinite(n) || n <= 0) return String(num || "");
			        const sgd = Math.round(n / f);
			        return `S$${sgd.toLocaleString()}`;
			      };
			      let out = raw;
			      out = out.replace(/CNY\s*¥\s*([\d,]+)/g, (_, num) => convert(num));
			      out = out.replace(/¥\s*([\d,]+)/g, (_, num) => convert(num));
			      return out;
			    }

			    function effectiveFeeSgd(option, fx) {
			      if (!option) return null;
			      if (option.feeSgd) {
			        const n = Number(option.feeSgd);
			        return Number.isFinite(n) && n > 0 ? n : null;
			      }
			      if (option.feeCny) return cnyToSgdAmount(option.feeCny, fx);
			      return null;
			    }

			    function normalizeOptionToSgd(option, fx) {
			      if (!option) return null;
			      const next = { ...option };
			      const fee = effectiveFeeSgd(option, fx);
			      if (fee) next.feeSgd = fee;
			      delete next.feeCny;
			      if (next.refundCn) next.refundCn = convertRefundTextToSgd(next.refundCn, fx);
			      if (next.refundEn) next.refundEn = convertRefundTextToSgd(next.refundEn, fx);
			      return next;
			    }

			    // Pricing rules (来源：02_Operations_and_Data/pricing/2025-11-29_Maple_Education_价目表_分类版.md)
			    const PRICING_RULES = {
		      main_private: {
		        title: "私立院校申请（新加坡）",
		        options: [
		          { id: "toc_private_doc", label: "私立院校申请（文书服务）", feeCny: 1500, source: "价目表 1.1" },
		        ],
		      },
		      main_sim: {
		        title: "SIM 申请（按私立院校）",
		        options: [
		          { id: "toc_sim_doc", label: "SIM 申请（文书服务）", feeCny: 1500, source: "价目表 1.1（私立院校申请）" },
		        ],
		      },
		      main_highend: {
		        title: "公立名校申请（NUS/NTU/SMU/SUTD）",
		        options: [
		          { id: "toc_highend_undergrad", label: "本科申请（包三所院校）", feeCny: 15000, source: "价目表 1.2", refundCn: "申请不成功退 ¥10,000", refundEn: "CNY ¥10,000 refund if unsuccessful" },
		          { id: "toc_highend_taught_master", label: "授课型硕士申请（包三所院校）", feeCny: 15000, source: "价目表 1.2", refundCn: "申请不成功退 ¥10,000", refundEn: "CNY ¥10,000 refund if unsuccessful" },
		          { id: "toc_highend_research", label: "研究型硕士/博士申请（包三所院校）", feeCny: 30000, source: "价目表 1.2", refundCn: "申请不成功退 ¥15,000；未获奖学金退 ¥10,000", refundEn: "CNY ¥15,000 refund if unsuccessful; CNY ¥10,000 refund if no scholarship" },
		        ],
		      },
			      main_k12_public: {
			        title: "低龄留学（政府学校/AEIS）",
			        options: [
			          { id: "toc_k12_public_kdg", label: "公立幼稚园申请", feeCny: 12000, source: "价目表 1.3", refundCn: "申请不成功退 ¥10,000", refundEn: "CNY ¥10,000 refund if unsuccessful" },
			          { id: "toc_k12_public_p1", label: "公立小一申请", feeCny: 12000, source: "价目表 1.3", refundCn: "申请不成功退 ¥10,000", refundEn: "CNY ¥10,000 refund if unsuccessful" },
			          { id: "toc_k12_public_aeis", label: "AEIS / S-AEIS 公立学校申请（小学/中学）", feeCny: 12000, source: "价目表 1.3", refundCn: "申请不成功退 ¥10,000", refundEn: "CNY ¥10,000 refund if unsuccessful" },
			        ],
			      },
		      main_k12_international: {
		        title: "国际学校申请",
		        options: [
		          { id: "toc_intl_tier1", label: "第一梯队（顶级）Case by case", source: "价目表 1.4" },
		          { id: "toc_intl_tier2", label: "第二梯队（约 S$2,000）", feeSgd: 2000, source: "价目表 1.4" },
		          { id: "toc_intl_tier3", label: "第三梯队（少量文书费用）", source: "价目表 1.4" },
		        ],
		      },
		      kindergarten: {
		        title: "幼儿园择校服务（本地私立）",
		        options: [
		          {
		            id: "toc_kindergarten_private",
		            label: "本地私立幼儿园择校服务（3–5所）",
		            feeSgd: 2000,
		            source: "价目表 1.5",
		            refundCn: "不因未录取自动退费（以合同为准）",
		            refundEn: "No automatic refund solely due to non-admission (subject to agreement)",
		          },
		        ],
		      },
		    };

		    const ADDON_RULES = [
		      { id: "toc_overseas_assistant", label: "境外小助手（8项落地服务）", feeSgd: 599, source: "价目表 1.1 / 4" },
		      { id: "toc_concierge_3m", label: "管家套餐A：3个月生活管家", feeSgd: 699, source: "价目表 4" },
		      { id: "toc_concierge_12m", label: "管家套餐B：12个月定制管家", feeSgd: 4399, source: "价目表 4" },
		      { id: "toc_pickup", label: "接机服务（管家可选）", feeSgd: 200, source: "价目表 4" },
		      { id: "toc_dep_pass", label: "陪读签证申请", feeCny: 13000, source: "价目表 1.3 / 1.5", refundCn: "申请不成功不退费", refundEn: "Non-refundable if unsuccessful" },
		    ];

			    function moneyParts(option) {
			      if (!option) return "";
			      const fee = effectiveFeeSgd(option, readFxCnyPerSgd());
			      if (fee) return `S$${Number(fee).toLocaleString()}`;
			      return "金额另议";
			    }

		    function escapeText(input) {
		      return String(input || "").replace(/\s+/g, " ").trim();
		    }

		    function readAddonsSelectedValue() {
		      const el = document.getElementById("addons-selected");
		      const raw = el ? String(el.value || "").trim() : "";
		      if (!raw) return [];
		      return raw.split(",").map((s) => s.trim()).filter(Boolean);
		    }

		    function syncAddonsSelectedValue() {
		      const el = document.getElementById("addons-selected");
		      if (!el) return;
		      const ids = Array.from(document.querySelectorAll('input[name="addon-item"]:checked')).map((n) => n.value);
		      el.value = ids.join(",");
		    }

			    function getSelectedAddOns() {
			      const ids = new Set(Array.from(document.querySelectorAll('input[name="addon-item"]:checked')).map((n) => n.value));
			      const fx = readFxCnyPerSgd();
			      return ADDON_RULES.filter((a) => ids.has(a.id)).map((a) => normalizeOptionToSgd(a, fx));
			    }

		    function renderAddonControls(filters) {
		      const container = document.getElementById("addon-items");
		      const noteEl = document.getElementById("addons-note");
		      if (!container || !noteEl) return;

		      const saved = new Set(readAddonsSelectedValue());
		      const currentChecked = new Set(Array.from(container.querySelectorAll('input[name="addon-item"]:checked')).map((n) => n.value));
		      const selected = currentChecked.size ? currentChecked : saved;

		      container.innerHTML = "";

		      ADDON_RULES.forEach((addon) => {
		        const item = document.createElement("div");
		        item.className = "list-item";

		        const label = document.createElement("label");
		        label.style.display = "flex";
		        label.style.alignItems = "center";
		        label.style.gap = "8px";
		        label.style.margin = "0";
		        label.style.color = "var(--text)";
		        label.style.fontSize = "13px";

		        const cb = document.createElement("input");
		        cb.type = "checkbox";
		        cb.name = "addon-item";
		        cb.value = addon.id;
		        cb.checked = selected.has(addon.id);
		        cb.style.width = "auto";

		        const text = document.createElement("span");
		        text.textContent = `${addon.label}（${moneyParts(addon)}）`;

		        label.appendChild(cb);
		        label.appendChild(text);
		        item.appendChild(label);

			        if (addon.refundCn) {
			          const small = document.createElement("small");
			          small.textContent = `退费：${convertRefundTextToSgd(addon.refundCn, readFxCnyPerSgd())}`;
			          item.appendChild(small);
			        }

		        container.appendChild(item);
		      });

		      syncAddonsSelectedValue();
		      updatePricingSummary(filters);
		    }

			    function buildRefundSuggestion(baseOption, addons) {
			      const cn = [];
			      const en = [];
			      const fx = readFxCnyPerSgd();
			      if (baseOption && baseOption.refundCn) cn.push(`- ${escapeText(baseOption.label)}：${escapeText(convertRefundTextToSgd(baseOption.refundCn, fx))}`);
			      if (baseOption && baseOption.refundEn) en.push(`- ${escapeText(baseOption.label)}: ${escapeText(convertRefundTextToSgd(baseOption.refundEn, fx))}`);
			      (addons || []).forEach((a) => {
			        if (a.refundCn) cn.push(`- ${escapeText(a.label)}：${escapeText(convertRefundTextToSgd(a.refundCn, fx))}`);
			        if (a.refundEn) en.push(`- ${escapeText(a.label)}: ${escapeText(convertRefundTextToSgd(a.refundEn, fx))}`);
			      });
			      if (cn.length === 0 && en.length === 0) return "";
			      const parts = [];
		      if (cn.length) parts.push(["退费政策（建议）", ...cn].join("\n"));
		      if (en.length) parts.push(["Refund policy (suggested)", ...en].join("\n"));
		      return parts.join("\n\n");
		    }

		    function updatePricingSummary(filters) {
		      const noteEl = document.getElementById("addons-note");
		      if (!noteEl) return;
		      const resolvedType = resolveContractType(filters);
		      if (resolvedType === "kindergarten") {
		        noteEl.textContent = "幼儿园协议为单独协议；服务费在协议内固定/按项目另议。如需附加服务收费，建议另出报价/合同。";
		        return;
		      }

			      const baseOption = getSelectedPricingOption(filters);
			      const addons = getSelectedAddOns();

			      const sgd = [baseOption, ...addons].reduce((sum, o) => sum + (o && o.feeSgd ? Number(o.feeSgd) : 0), 0);
			      const addonSgd = addons.reduce((sum, o) => sum + (o && o.feeSgd ? Number(o.feeSgd) : 0), 0);

		      const selectedCount = addons.length;
		      const parts = [];
		      parts.push(`已选附加项：${selectedCount} 个`);

			      const catalog = getPricingCatalog(resolvedType);
			      if (!catalog) {
			        if (selectedCount) parts.push(`附加项合计：${addonSgd ? `S$${addonSgd.toLocaleString()}` : "SGD —"}`);
			        parts.push("主服务金额请手动填写服务费总额。");
			      } else if (baseOption && baseOption.feeSgd) {
			        parts.push(`建议合计：${sgd ? `S$${sgd.toLocaleString()}` : "SGD —"}`);
			        parts.push("如需写入总额，可点一次“按价目表填充”或手动调整服务费总额。");
			      } else if (baseOption) {
			        parts.push("主服务为 Case by case，请手动填写服务费总额。");
		      } else {
		        parts.push("提示：选择收费项目后可生成合计建议。");
		      }
		      noteEl.textContent = parts.join(" · ");

		      const refundEl = document.getElementById("refund-terms");
		      if (refundEl && !String(refundEl.value || "").trim()) {
		        const suggestion = buildRefundSuggestion(baseOption, addons);
		        if (suggestion) refundEl.value = suggestion;
		      }
		    }

	    function getPricingCatalog(type) {
	      return PRICING_RULES[type] || null;
	    }

	    function defaultPricingId(filters, type) {
	      const catalog = getPricingCatalog(type);
	      if (!catalog || !catalog.options || catalog.options.length === 0) return "";

		      if (type === "main_highend") {
	        const education = filters.education || "";
	        const t = `${(document.getElementById("target-school").value || "")} ${(document.getElementById("target-major").value || "")}`.toLowerCase();
	        const isResearch = t.includes("phd") || t.includes("博士") || t.includes("research") || t.includes("研究") || t.includes("研博");
	        if (isResearch) return "toc_highend_research";
	        if (education === "master") return "toc_highend_taught_master";
	        if (education === "bachelor") return "toc_highend_undergrad";
	        return "toc_highend_undergrad";
		      }

		      if (type === "main_k12_public") {
		        const gradeRaw = String((document.getElementById("target-grade") || {}).value || "").trim().toLowerCase();
		        const isKindergarten = gradeRaw.startsWith("k") || gradeRaw.includes("幼稚园") || gradeRaw.includes("幼儿园") || gradeRaw.includes("幼稚") || gradeRaw.includes("幼儿");
		        const isP1 = gradeRaw === "p1" || gradeRaw.startsWith("p1") || gradeRaw.includes("p1") || gradeRaw.includes("primary 1") || gradeRaw.includes("小一") || gradeRaw.includes("小1");
		        if (isKindergarten) return "toc_k12_public_kdg";
		        if (isP1) return "toc_k12_public_p1";
		        return "toc_k12_public_aeis";
		      }

		      if (type === "main_k12_international") return "toc_intl_tier2";
		      return catalog.options[0].id;
		    }

			    function buildPricingNote(option) {
			      if (!option) return "";
			      const fx = readFxCnyPerSgd();
			      const parts = [];
			      if (option.source) parts.push(option.source);
			      const fee = effectiveFeeSgd(option, fx);
			      const isConverted = !option.feeSgd && Boolean(option.feeCny);
			      if (fee) parts.push(`建议：S$${Number(fee).toLocaleString()}${isConverted ? "（按汇率换算）" : ""}`);
			      if (option.refundCn) parts.push(`退费：${convertRefundTextToSgd(option.refundCn, fx)}`);
			      if (!fee) parts.push("金额：Case by case（请手动填写）");
			      return parts.join(" · ");
			    }

		    function renderPricingControls(filters) {
		      const select = document.getElementById("pricing-item");
		      const noteEl = document.getElementById("pricing-note");
		      const applyBtn = document.getElementById("apply-pricing");
		      if (!select || !noteEl || !applyBtn) return;

		      const type = resolveContractType(filters);
		      if (type === "kindergarten") {
		        const catalog = getPricingCatalog(type);
		        select.innerHTML = "";
		        if (catalog && Array.isArray(catalog.options) && catalog.options.length) {
		          catalog.options.forEach((o) => {
		            const opt = document.createElement("option");
		            opt.value = o.id;
		            opt.textContent = o.label;
		            select.appendChild(opt);
		          });
		          select.value = catalog.options[0].id;
		          noteEl.textContent = `${buildPricingNote(catalog.options[0])} · 固定服务费（幼儿园协议内写明）`;
		        } else {
		          const opt = document.createElement("option");
		          opt.value = "";
		          opt.textContent = "幼儿园协议（服务费在协议内固定/按项目另议）";
		          select.appendChild(opt);
		          noteEl.textContent = "提示：幼儿园协议为单独协议；如需改金额，请在模板中调整条款后再内置。";
		        }
		        select.disabled = true;
		        applyBtn.disabled = true;
		        return;
		      }

	      const catalog = getPricingCatalog(type);
	      if (!catalog) {
	        select.innerHTML = "";
	        const opt = document.createElement("option");
	        opt.value = "";
	        opt.textContent = "无可用价目表项（手动填写）";
	        select.appendChild(opt);
	        select.disabled = true;
	        applyBtn.disabled = true;
	        noteEl.textContent = "该合同包类型暂无标准价目表项，请手动填写服务费。";
	        return;
	      }

	      select.disabled = false;
	      applyBtn.disabled = false;

	      const options = catalog.options || [];
	      const current = select.value;
	      const fallback = defaultPricingId(filters, type);

	      select.innerHTML = "";
	      options.forEach((o) => {
	        const opt = document.createElement("option");
	        opt.value = o.id;
	        opt.textContent = o.label;
	        select.appendChild(opt);
	      });

	      if (current && options.some((o) => o.id === current)) select.value = current;
	      else if (fallback && options.some((o) => o.id === fallback)) select.value = fallback;
	      else if (options[0]) select.value = options[0].id;

	      const selected = options.find((o) => o.id === select.value);
	      noteEl.textContent = buildPricingNote(selected);
	    }

		    function getSelectedPricingOption(filters) {
		      const type = resolveContractType(filters);
		      const catalog = getPricingCatalog(type);
		      if (!catalog) return null;
		      const select = document.getElementById("pricing-item");
		      const selectedId = select ? select.value : "";
		      const options = catalog.options || [];
		      const picked = options.find((o) => o.id === selectedId) || options.find((o) => o.id === defaultPricingId(filters, type)) || null;
		      return normalizeOptionToSgd(picked, readFxCnyPerSgd());
		    }

			    function applySelectedPricing(filters, { force = false } = {}) {
			      const option = getSelectedPricingOption(filters);
			      if (!option) return false;

			      const feeSgdEl = document.getElementById("fee-sgd");
			      const initialSgdEl = document.getElementById("initial-sgd");
			      const payMethodEl = document.getElementById("pay-method");

			      if (!feeSgdEl || !initialSgdEl || !payMethodEl) return false;

			      const hasAny = option.feeSgd;
			      if (!hasAny) return false;

			      const hasExisting = Boolean(String(feeSgdEl.value || "").trim());
			      if (!force && hasExisting) return false;

			      const addons = getSelectedAddOns();
			      const addonSgd = addons.reduce((sum, a) => sum + (a.feeSgd ? Number(a.feeSgd) : 0), 0);
			      const totalSgd = (option.feeSgd ? Number(option.feeSgd) : 0) + addonSgd;

			      if (totalSgd) feeSgdEl.value = String(totalSgd);

			      if (payMethodEl.value === "full") {
			        if (totalSgd && !String(initialSgdEl.value || "").trim()) initialSgdEl.value = String(totalSgd);
			      }

			      return true;
			    }

		    function autoApplyPricingIfBlank(filters) {
		      const feeSgdEl = document.getElementById("fee-sgd");
		      if (!feeSgdEl) return;

	      const contractTypeVal = (document.getElementById("contract-type") || {}).value || "auto";
	      const hasClientInputs = Boolean(filters.age || filters.education || filters.budget || filters.major || filters.route);
	      if (contractTypeVal === "auto" && !hasClientInputs) return;

		      const hasExisting = Boolean(String(feeSgdEl.value || "").trim());
		      if (hasExisting) return;
		      applySelectedPricing(filters, { force: false });
		    }

	    function formatIsoDate(raw) {
	      const v = String(raw || "").trim();
	      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
	      const d = new Date();
	      const yyyy = String(d.getFullYear());
	      const mm = String(d.getMonth() + 1).padStart(2, "0");
	      const dd = String(d.getDate()).padStart(2, "0");
	      return `${yyyy}-${mm}-${dd}`;
	    }

	    function getTemplateText(id, label) {
	      const el = document.getElementById(id);
	      if (!el) throw new Error(`缺少模板：${label}（${id}）`);
	      const text = (el.textContent || "").trim();
	      if (!text) throw new Error(`模板为空：${label}（${id}）`);
	      return text;
	    }

	    function setCheckboxInMarkdown(md, lineIncludes, checked) {
	      const lines = String(md || "").split("\n");
	      const next = lines.map((line) => {
	        if (!line.includes(lineIncludes)) return line;
	        if (checked) return line.replace("☐", "☑");
	        return line.replace("☑", "☐");
	      });
	      return next.join("\n");
	    }

		    function fillFeePlaceholders(md, feeSgd, _feeCny, { onlyFirst = false } = {}) {
		      let next = String(md || "");
		      const sgd = String(feeSgd || "").trim().replace(/,/g, "");
		      if (sgd) {
		        const needle = "SGD ________";
		        const replacement = `SGD ${sgd}`;
		        next = onlyFirst ? replaceFirstText(next, needle, replacement) : replaceAllText(next, needle, replacement);
		      }
		      return next;
		    }

		    function buildFilledAppendixMd(kind, ctx) {
		      const clientName = ctx.clientName || "__________";
		      const dateIso = ctx.dateIso || formatIsoDate("");
		      const targetSchool = ctx.targetSchool || "";
		      const targetMajor = ctx.targetMajor || "";
		      const feeSgd = ctx.feeSgd || "";
		      const childName = ctx.childName || "__________";
		      const targetGrade = ctx.targetGrade || "__________";
		      const pricingId = ctx.pricingId || "";

		      if (kind === "private") {
		        let md = getTemplateText("appendix-private-template-md", "私立大学申请服务附录");
		        md = replaceAllText(md, "[姓名 / Name]", clientName);
		        md = replaceAllText(md, "[YYYY-MM-DD]", dateIso);
		        md = fillFeePlaceholders(md, feeSgd);

	        const hasKaplan = shortlistHasProvider("kaplan");
	        const hasPsb = shortlistHasProvider("psb");
	        const hasAmity = shortlistHasProvider("amity");
	        md = setCheckboxInMarkdown(md, "Kaplan Higher Education Institute", hasKaplan);
	        md = setCheckboxInMarkdown(md, "PSB Academy", hasPsb);
	        md = setCheckboxInMarkdown(md, "Amity Global Institute", hasAmity);

	        const known = hasKaplan || hasPsb || hasAmity;
	        const otherHasValue = Boolean(targetSchool);
	        if (otherHasValue) md = replaceAllText(md, "[院校名称 / 课程]", targetSchool);
	        md = setCheckboxInMarkdown(md, "Other private institutions", !known && otherHasValue);
	        return md;
	      }

		      if (kind === "sim") {
		        let md = getTemplateText("appendix-sim-template-md", "SIM 申请服务附录");
		        md = replaceAllText(md, "[姓名 / Name]", clientName);
		        md = replaceAllText(md, "[YYYY-MM-DD]", dateIso);
		        md = fillFeePlaceholders(md, feeSgd);
		        if (targetSchool) md = replaceAllText(md, "[例如：本科 / 大专 / 研究生文凭及具体专业名称]", targetSchool);
		        return md;
		      }

		      if (kind === "highend") {
		        let md = getTemplateText("appendix-highend-template-md", "NUS / NTU 高端申请服务附录");
		        md = replaceAllText(md, "[姓名 / Name]", clientName);
		        md = replaceAllText(md, "[YYYY-MM-DD]", dateIso);
		        md = fillFeePlaceholders(md, feeSgd, "", { onlyFirst: true });

	        const t = `${targetSchool} ${targetMajor}`.toLowerCase();
	        const hasNus = t.includes("nus");
	        const hasNtu = t.includes("ntu");
	        const hasOther = Boolean(targetSchool) && !(hasNus || hasNtu);
	        const defaultPick = !(hasNus || hasNtu || hasOther);

	        md = setCheckboxInMarkdown(md, "National University of Singapore", hasNus || defaultPick);
	        md = setCheckboxInMarkdown(md, "Nanyang Technological University", hasNtu || defaultPick);
	        md = setCheckboxInMarkdown(md, "Other universities / programs", hasOther);
	        if (targetSchool) md = replaceAllText(md, "[院校名称 / 专业]", targetSchool);
	        return md;
	      }

		      if (kind === "k12_public") {
		        let md = getTemplateText("appendix-k12-public-template-md", "K12 公立/AEIS 申请服务附录");
		        md = replaceAllText(md, "[家长姓名 / Parent Name]", clientName);
		        md = replaceAllText(md, "[孩子姓名 / Child Name]", childName);
		        md = replaceAllText(md, "[申请年级 / Target Grade]", targetGrade);
		        md = replaceAllText(md, "[YYYY-MM-DD]", dateIso);
			        md = fillFeePlaceholders(md, feeSgd);

		        const t = `${targetSchool} ${targetMajor}`.toLowerCase();
		        const gradeRaw = String(targetGrade || "").trim().toLowerCase();
		        const isKdg = pricingId.includes("k12_public_kdg") || gradeRaw.startsWith("k") || gradeRaw.includes("幼稚园") || gradeRaw.includes("幼儿园") || gradeRaw.includes("幼稚") || gradeRaw.includes("幼儿");
		        const isP1 = pricingId.includes("k12_public_p1") || gradeRaw === "p1" || gradeRaw.startsWith("p1") || gradeRaw.includes("p1") || gradeRaw.includes("primary 1") || gradeRaw.includes("小一") || gradeRaw.includes("小1");
		        const isOther = isKdg || isP1;

		        const preferSa = t.includes("s-aeis") || t.includes("saeis");
		        md = setCheckboxInMarkdown(md, "AEIS", !preferSa && !isOther);
		        md = setCheckboxInMarkdown(md, "S‑AEIS", preferSa && !isOther);
		        md = setCheckboxInMarkdown(md, "Other / 其他", isOther);

		        if (isOther) {
		          const otherText = isKdg
		            ? "MOE Kindergarten (K1/K2) / 公立幼稚园"
		            : "Primary 1 Registration / 公立小一";
		          md = replaceAllText(md, "[例如：转国际学校 Plan B]", otherText);
		        }
		        return md;
		      }

	      if (kind === "k12_international") {
	        let md = getTemplateText("appendix-k12-international-template-md", "国际学校申请服务附录");
	        md = replaceAllText(md, "[家长姓名 / Parent Name]", clientName);
	        md = replaceAllText(md, "[孩子姓名 / Child Name]", childName);
	        md = replaceAllText(md, "[申请年级 / Target Grade]", targetGrade);
	        md = replaceAllText(md, "[YYYY-MM-DD]", dateIso);
		        md = fillFeePlaceholders(md, feeSgd);

	        const tier = pricingId.includes("tier1") ? "tier1" : (pricingId.includes("tier3") ? "tier3" : (pricingId.includes("tier2") ? "tier2" : ""));
	        md = setCheckboxInMarkdown(md, "Tier 1 / 第一梯队", tier === "tier1");
	        md = setCheckboxInMarkdown(md, "Tier 2 / 第二梯队", tier === "tier2" || !tier);
	        md = setCheckboxInMarkdown(md, "Tier 3 / 第三梯队", tier === "tier3");

	        const names = String(targetSchool || "")
	          .split("/")
	          .map((s) => s.trim())
	          .filter(Boolean);
	        if (names[0]) md = replaceFirstText(md, "1) ____________________", `1) ${names[0]}`);
	        if (names[1]) md = replaceFirstText(md, "2) ____________________", `2) ${names[1]}`);
	        if (names[2]) md = replaceFirstText(md, "3) ____________________", `3) ${names[2]}`);
	        return md;
	      }

	      if (kind === "kindergarten") {
	        let md = getTemplateText("agreement-kindergarten-template-md", "幼儿园择校服务协议");
	        md = replaceAllText(md, "[家长姓名 / Parent Name]", clientName);
	        md = replaceAllText(md, "[Child’s Name]", childName);
	        md = replaceAllText(md, "[YYYY-MM-DD]", dateIso);
	        return md;
	      }

	      throw new Error(`未知附录类型：${kind}`);
	    }

	    function inlineMarkdown(text) {
	      let s = escapeHtml(text);
	      s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
	      s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
	      return s;
	    }

	    function markdownToHtml(md) {
	      const cleaned = String(md || "")
	        .replace(/<!--[\s\S]*?-->/g, "")
	        .replace(/\r\n/g, "\n");
	      const lines = cleaned.split("\n");
	      const out = [];

	      let inQuote = false;
	      let inList = false;
	      let listItems = [];
	      let currentLi = null;

	      const closeQuote = () => {
	        if (!inQuote) return;
	        out.push("</blockquote>");
	        inQuote = false;
	      };
	      const flushList = () => {
	        if (!inList) return;
	        if (currentLi !== null) listItems.push(currentLi);
	        out.push("<ul>");
	        listItems.forEach((item) => out.push(`<li>${item}</li>`));
	        out.push("</ul>");
	        inList = false;
	        listItems = [];
	        currentLi = null;
	      };

	      for (const rawLine of lines) {
	        const expanded = rawLine.replace(/\t/g, "    ");
	        const trimmed = expanded.trim();

	        if (!trimmed) {
	          flushList();
	          closeQuote();
	          continue;
	        }

	        const isHr = trimmed === "---";
	        const isBlockquote = trimmed.startsWith("> ");
	        const isHeading = trimmed.startsWith("#");
	        const isListItem = trimmed.startsWith("- ");
	        const isContinuation = inList && !isHr && !isBlockquote && !isHeading && !isListItem && /^ {2,}\S/.test(expanded);

	        if (isContinuation) {
	          const extra = inlineMarkdown(trimmed);
	          currentLi = currentLi === null ? extra : `${currentLi}<br>${extra}`;
	          continue;
	        }

	        if (isHr) {
	          flushList();
	          closeQuote();
	          out.push("<hr>");
	          continue;
	        }

	        if (isBlockquote) {
	          flushList();
	          if (!inQuote) {
	            out.push("<blockquote>");
	            inQuote = true;
	          }
	          out.push(`<p>${inlineMarkdown(trimmed.slice(2))}</p>`);
	          continue;
	        }
	        closeQuote();

	        if (isHeading) {
	          flushList();
	          const m = trimmed.match(/^#+/);
	          const level = m ? Math.min(m[0].length, 3) : 1;
	          const text = trimmed.slice(level).trim();
	          out.push(`<h${level}>${inlineMarkdown(text)}</h${level}>`);
	          continue;
	        }

	        if (isListItem) {
	          if (!inList) {
	            inList = true;
	            listItems = [];
	            currentLi = null;
	          }
	          if (currentLi !== null) listItems.push(currentLi);
	          currentLi = inlineMarkdown(trimmed.slice(2));
	          continue;
	        }

	        flushList();
	        out.push(`<p>${inlineMarkdown(trimmed)}</p>`);
	      }

	      flushList();
	      closeQuote();
	      return out.join("\n");
	    }

		    function buildAppendixParts(kind, ctx) {
		      const title = {
		        private: "私立大学申请服务附录",
		        sim: "SIM 申请服务附录",
		        highend: "NUS / NTU 高端申请服务附录",
		        kindergarten: "幼儿园择校服务协议",
		        k12_public: "K12 公立/AEIS 申请服务附录",
		        k12_international: "国际学校申请服务附录",
		      }[kind] || kind;
		      const appendixCss = `
		        .appendix { width: 210mm; box-sizing: border-box; padding: 18mm 15mm; margin: 0 auto; background: white; color: #111827; font-family: "Segoe UI", "Microsoft YaHei", Arial, sans-serif; }
		        .appendix h1 { font-size: 18pt; margin: 0 0 10px; }
		        .appendix h2 { font-size: 14pt; margin: 16px 0 8px; }
	        .appendix h3 { font-size: 12pt; margin: 14px 0 6px; }
	        .appendix p { margin: 6px 0; line-height: 1.55; }
	        .appendix li { margin: 4px 0; line-height: 1.55; }
	        .appendix code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; background: #f3f4f6; padding: 1px 4px; border-radius: 4px; }
	        .appendix blockquote { margin: 10px 0; padding: 8px 12px; border-left: 4px solid #d1d5db; background: #f9fafb; }
	        .appendix hr { border: none; border-top: 1px solid #e5e7eb; margin: 14px 0; }
	      `;
	      const md = buildFilledAppendixMd(kind, ctx);
		      const body = `<div class="appendix">${markdownToHtml(md)}</div>`;
		      return { title, style: appendixCss, body };
		    }

		    function buildQuoteParts(ctx) {
		      const quoteCss = `
		        .quote { width: 210mm; box-sizing: border-box; padding: 18mm 15mm; margin: 0 auto; background: white; color: #111827; font-family: "Segoe UI", "Microsoft YaHei", Arial, sans-serif; }
		        .quote h1 { font-size: 18pt; margin: 0 0 10px; }
		        .quote h2 { font-size: 13.5pt; margin: 16px 0 8px; }
		        .quote p { margin: 6px 0; line-height: 1.55; }
		        .quote table { width: 100%; border-collapse: collapse; margin-top: 8px; }
		        .quote th, .quote td { border: 1px solid #e5e7eb; padding: 7px 8px; vertical-align: top; }
		        .quote th { background: #f3f4f6; text-align: left; }
		        .quote .muted { color: #6b7280; font-size: 10pt; }
		        .quote .pre { white-space: pre-wrap; border: 1px solid #e5e7eb; background: #f9fafb; border-radius: 10px; padding: 10px 12px; }
		        .quote .sig { margin-top: 18px; display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
		        .quote .sig strong { display: block; margin-bottom: 6px; }
		      `;

			      const base = ctx.pricingOption;
			      const addons = Array.isArray(ctx.addons) ? ctx.addons : [];

			      const rows = [];
			      const pushRow = (label, feeSgd) => {
			        const sgdCell = feeSgd ? `S$${Number(feeSgd).toLocaleString()}` : "—";
			        rows.push(`<tr><td>${escapeHtml(label)}</td><td style="text-align:right;">${escapeHtml(sgdCell)}</td></tr>`);
			      };

			      if (base) pushRow(`主服务：${base.label || ""}`.trim(), base.feeSgd);
			      addons.forEach((a) => pushRow(`附加项：${a.label || ""}`.trim(), a.feeSgd));

			      const computedSgd = [base, ...addons].reduce((sum, o) => sum + (o && o.feeSgd ? Number(o.feeSgd) : 0), 0);
			      const totalSgd = String(ctx.feeSgd || "").trim() || (computedSgd ? String(computedSgd) : "");
			      const totalSgdCell = totalSgd ? `S$${Number(totalSgd).toLocaleString()}` : "—";

		      const refundText = String(ctx.refundTerms || "").trim();
		      const refundHtml = refundText
		        ? `<div class="pre">${escapeHtml(refundText)}</div>`
		        : `<p class="muted">无特殊退费约定（按主合同条款执行）。No supplementary refund schedule (the Main Agreement shall prevail).</p>`;

		      const routeInfo = ctx.resolvedType ? contractTypeLabel(ctx.resolvedType) : "";
		      const childLine = ctx.childName ? ` · Student/Child 学生/孩子：${escapeHtml(ctx.childName)}` : "";

		      const body = `
		        <div class="quote">
		          <h1>Supplementary Quotation & Refund Schedule<br/>报价与退费约定（补充页）</h1>
		          <p class="muted">Contract No 合同编号：${escapeHtml(ctx.contractNo || "__________")} · Date 日期：${escapeHtml(ctx.dateIso || "__________")}</p>
		          <p>Party A 甲方：${escapeHtml(ctx.clientName || "__________")}${childLine}</p>
		          <p>Party B 乙方：Maple Education Pte. Ltd.</p>
			          ${routeInfo ? `<p class="muted">Package 合同包：${escapeHtml(routeInfo)}</p>` : ""}
			          <h2>Fee Breakdown / 费用清单</h2>
			          <table>
			            <tr><th style="width:70%;">服务项目 Service Item</th><th style="width:30%; text-align:right;">Amount (SGD)</th></tr>
			            ${rows.join("\n") || `<tr><td colspan="2" class="muted">未选择标准收费项目（可在右侧“收费项目/服务费总额”处手动填写）。</td></tr>`}
			            <tr><td><strong>合计 Total</strong></td><td style="text-align:right;"><strong>${escapeHtml(totalSgdCell)}</strong></td></tr>
			          </table>
		          <h2>Refund Terms / 退费约定</h2>
		          ${refundHtml}
		          <div class="sig">
		            <div>
		              <strong>Party A 甲方</strong>
		              Name 姓名：_________________________<br/>
		              Signature 签名：_____________________<br/>
		              Date 日期：_________________________
		            </div>
		            <div>
		              <strong>Party B 乙方（Maple Education Pte. Ltd.）</strong>
		              Authorized Signatory 授权签署人：_____________________<br/>
		              Name 姓名：Leonard Chow Yi Ding<br/>
		              Title 职务：Director<br/>
		              Date 日期：_________________________
		            </div>
		          </div>
		        </div>
		      `;

		      return { title: "报价与退费约定", style: quoteCss, body };
		    }

		    function quoteNoFromContractNo(contractNo) {
		      const raw = String(contractNo || "").trim();
		      if (!raw) return generateContractNo().replace(/^MAPLE-/i, "QUO-");
		      if (/^QUO-/i.test(raw)) return raw;
		      if (/^MAPLE-/i.test(raw)) return raw.replace(/^MAPLE-/i, "QUO-");
		      return `QUO-${raw}`;
		    }

		    function buildQuotationParts(ctx) {
		      const quoteCss = `
		        .quote { width: 210mm; box-sizing: border-box; padding: 18mm 15mm; margin: 0 auto; background: white; color: #111827; font-family: "Segoe UI", "Microsoft YaHei", Arial, sans-serif; }
		        .quote h1 { font-size: 18pt; margin: 0 0 10px; }
		        .quote h2 { font-size: 13.5pt; margin: 16px 0 8px; }
		        .quote p { margin: 6px 0; line-height: 1.55; }
		        .quote table { width: 100%; border-collapse: collapse; margin-top: 8px; }
		        .quote th, .quote td { border: 1px solid #e5e7eb; padding: 7px 8px; vertical-align: top; }
		        .quote th { background: #f3f4f6; text-align: left; }
		        .quote .muted { color: #6b7280; font-size: 10pt; }
		        .quote .pre { white-space: pre-wrap; border: 1px solid #e5e7eb; background: #f9fafb; border-radius: 10px; padding: 10px 12px; }
		        .quote .sig { margin-top: 18px; display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
		        .quote .sig strong { display: block; margin-bottom: 6px; }
		      `;

			      const base = ctx.pricingOption;
			      const addons = Array.isArray(ctx.addons) ? ctx.addons : [];

			      const rows = [];
			      const pushRow = (label, feeSgd) => {
			        const sgdCell = feeSgd ? `S$${Number(feeSgd).toLocaleString()}` : "—";
			        rows.push(`<tr><td>${escapeHtml(label)}</td><td style="text-align:right;">${escapeHtml(sgdCell)}</td></tr>`);
			      };

				      if (base) pushRow(`主服务：${base.label || ""}`.trim(), base.feeSgd);
				      addons.forEach((a) => pushRow(`可选附加项：${a.label || ""}`.trim(), a.feeSgd));

				      const computedSgd = [base, ...addons].reduce((sum, o) => sum + (o && o.feeSgd ? Number(o.feeSgd) : 0), 0);
				      const totalSgdInput = parseMoneyToNumber(ctx.feeSgd);
				      const totalSgdValue = (totalSgdInput !== null && totalSgdInput > 0)
				        ? totalSgdInput
				        : (computedSgd > 0 ? computedSgd : null);
				      const totalSgdCell = totalSgdValue !== null ? `S$${Number(totalSgdValue).toLocaleString()}` : "—";

		      const refundText = String(ctx.refundTerms || "").trim();
		      const refundHtml = refundText
		        ? `<div class="pre">${escapeHtml(refundText)}</div>`
		        : `<p class="muted">退费政策：如无特别约定，以正式合同条款为准。Refund rules: subject to the signed Service Agreement unless otherwise agreed in writing.</p>`;

		      const quoteNo = escapeHtml(ctx.quoteNo || quoteNoFromContractNo(ctx.contractNo));
		      const dateIso = escapeHtml(ctx.dateIso || "__________");
		      const routeInfo = ctx.resolvedType ? contractTypeLabel(ctx.resolvedType) : "";
		      const childLine = ctx.childName ? ` · Student/Child 学生/孩子：${escapeHtml(ctx.childName)}` : "";
		      const contactParts = [ctx.clientPhone, ctx.clientEmail].map((v) => String(v || "").trim()).filter(Boolean);
		      const contactLine = contactParts.length ? escapeHtml(contactParts.join(" / ")) : "__________";

		      const body = `
		        <div class="quote">
		          <h1>Quotation<br/>报价单</h1>
		          <p class="muted">Quotation No 报价单编号：${quoteNo} · Date 日期：${dateIso}</p>
		          <p>Client 客户：${escapeHtml(ctx.clientName || "__________")}${childLine}</p>
		          <p>Contact 联系方式：${contactLine}</p>
		          <p>Company 公司：Maple Education Pte. Ltd. (UEN: 202349302E)</p>
		          ${routeInfo ? `<p class="muted">Project/Package 项目/合同包参考：${escapeHtml(routeInfo)}</p>` : ""}
			          ${ctx.targetSchool ? `<p class="muted">Target Schools 目标院校/项目：${escapeHtml(ctx.targetSchool)}</p>` : ""}
			          <h2>Fees / 费用</h2>
			          <table>
			            <tr><th style="width:70%;">项目 Item</th><th style="width:30%; text-align:right;">Amount (SGD)</th></tr>
			            ${rows.join("\n") || `<tr><td colspan="2" class="muted">未选择标准收费项目（可在右侧“收费项目/服务费总额”处手动填写）。</td></tr>`}
			            <tr><td><strong>Total 合计</strong></td><td style="text-align:right;"><strong>${escapeHtml(totalSgdCell)}</strong></td></tr>
			          </table>
		          <h2>Refund Policy / 退费政策</h2>
		          ${refundHtml}
		          <p class="muted">备注：本报价单仅用于业务沟通，不构成对录取结果或签证结果的保证；最终以双方签署的正式服务合同/附录为准。</p>
		          <p class="muted">Note: This quotation is for communication only and does not guarantee admission or visa outcomes. Final terms shall be subject to the signed Service Agreement and Service Schedule(s).</p>
		          <div class="sig">
		            <div>
		              <strong>Client Acknowledgement（可选）客户确认</strong>
		              Signature 签名：_____________________<br/>
		              Date 日期：_________________________
		            </div>
		            <div>
		              <strong>Maple Education</strong>
		              Authorized Signatory 授权签署人：_____________________<br/>
		              Date 日期：_________________________
		            </div>
		          </div>
		        </div>
		      `;

		      return { title: "报价单", style: quoteCss, body };
		    }

		    function extractHtmlParts(html, fallbackTitle) {
		      const parser = new DOMParser();
		      const doc = parser.parseFromString(String(html || ""), "text/html");
		      const style = Array.from(doc.querySelectorAll("style")).map((s) => s.textContent || "").join("\n");
		      const body = doc.body ? doc.body.innerHTML : "";
	      const title = doc.title || fallbackTitle || "";
	      return { title, style, body };
	    }

		    function buildCombinedHtml(title, docs) {
		      const baseStyle = `
		        .page-break { page-break-before: always; break-before: page; }
		        @media print { .page-break { break-before: page; } }
		      `;
	      const styles = docs.map((d) => d.style || "").join("\n\n");
	      const body = docs.map((d, idx) => {
	        const section = `<section class="doc">${d.body || ""}</section>`;
	        const sep = idx < docs.length - 1 ? '<div class="page-break"></div>' : "";
	        return section + sep;
	      }).join("\n");
		      return `<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8" />\n<title>${escapeHtml(title)}</title>\n<style>\n${baseStyle}\n${styles}\n</style>\n</head>\n<body>\n${body}\n</body>\n</html>`;
		    }

			    function buildQuotationPackage() {
		      const filters = getFilters();
		      const resolvedType = resolveContractType(filters);
		      const refundTermsEl = document.getElementById("refund-terms");
		      const pricingOption = getSelectedPricingOption(filters);
		      const addons = getSelectedAddOns();

		      const contractNo = (document.getElementById("contract-no").value || "").trim();
		      const ctx = {
		        resolvedType,
		        clientName: (document.getElementById("client-name").value || "").trim(),
		        childName: (document.getElementById("child-name").value || "").trim(),
		        targetGrade: (document.getElementById("target-grade").value || "").trim(),
		        clientPhone: (document.getElementById("client-phone").value || "").trim(),
		        clientEmail: (document.getElementById("client-email").value || "").trim(),
		        contractNo,
		        quoteNo: quoteNoFromContractNo(contractNo),
			        targetSchool: (document.getElementById("target-school").value || "").trim(),
			        targetMajor: (document.getElementById("target-major").value || "").trim(),
			        feeSgd: String(document.getElementById("fee-sgd").value || "").trim().replace(/,/g, ""),
			        pricingId: (document.getElementById("pricing-item").value || "").trim(),
			        pricingOption: pricingOption ? { ...pricingOption } : null,
			        addons: addons.map((a) => ({ ...a })),
			        refundTerms: refundTermsEl ? convertRefundTextToSgd(String(refundTermsEl.value || ""), readFxCnyPerSgd()) : "",
			        dateIso: formatIsoDate(document.getElementById("payment-date").value),
			      };

		      const docs = [buildQuotationParts(ctx)];
		      const title = `${ctx.clientName || "客户"} ${ctx.quoteNo || ""} 报价单`.trim();
		      const html = buildCombinedHtml(title, docs);
		      const filename = `${sanitizeFilenamePart(ctx.clientName || "客户")}_${sanitizeFilenamePart(ctx.quoteNo || "报价单")}_报价单.html`;
			      return { html, filename, note: "报价单（不具合同效力）" };
			    }

			    function generateInvoiceNo() {
			      const d = new Date();
			      const yyyy = String(d.getFullYear());
			      const mm = String(d.getMonth() + 1).padStart(2, "0");
			      const dd = String(d.getDate()).padStart(2, "0");
			      const today = `${yyyy}${mm}${dd}`;

			      const lastDateKey = "maple_invoice_last_date_v1";
			      const counterKey = "maple_invoice_daily_counter_v1";
			      const lastDate = localStorage.getItem(lastDateKey);
			      let counter = 1;
			      if (lastDate === today) counter = Number(localStorage.getItem(counterKey) || "0") + 1;

			      localStorage.setItem(lastDateKey, today);
			      localStorage.setItem(counterKey, String(counter));
			      return `INV-${today}-${String(counter).padStart(3, "0")}`;
			    }

				    function parseMoneyToNumber(raw) {
				      const s = String(raw || "").trim();
				      if (!s) return null;
				      const normalized = s.replace(/,/g, "");
				      const match = normalized.match(/-?\d+(\.\d+)?/);
				      if (!match) return null;
				      const n = Number(match[0]);
				      return Number.isFinite(n) ? n : null;
				    }

			    function formatMoney(currency, amount) {
			      const n = Number(amount);
			      if (!Number.isFinite(n)) return "—";
			      const formatted = n.toLocaleString(undefined, { maximumFractionDigits: 2 });
			      if (currency === "SGD") return `S$${formatted}`;
			      if (currency === "CNY") return `¥${formatted}`;
			      return formatted;
			    }

			    function buildInvoiceParts(ctx, currency, { invoiceNo, invoiceAmount, computedItems, computedTotal, isDeposit } = {}) {
			      const invoiceCss = `
			        .invoice { width: 210mm; box-sizing: border-box; padding: 16mm 15mm; margin: 0 auto; background: white; color: #111827; font-family: "Segoe UI", "Microsoft YaHei", Arial, sans-serif; }
			        .invoice .top { display: grid; grid-template-columns: 1fr 0.9fr; gap: 12px; align-items: start; }
			        .invoice .brand { display: grid; grid-template-columns: 84px 1fr; gap: 12px; align-items: start; }
			        .invoice .logo { width: 84px; height: 84px; object-fit: contain; }
			        .invoice .company { font-size: 10.5pt; line-height: 1.45; }
			        .invoice .company .name { font-size: 14pt; font-weight: 700; margin-bottom: 2px; }
			        .invoice .doc { border: 1px solid #e5e7eb; border-radius: 12px; padding: 10px 12px; }
			        .invoice .doc .title { font-size: 16pt; font-weight: 800; margin-bottom: 6px; }
			        .invoice .kv { display: grid; grid-template-columns: 1fr auto; gap: 10px; padding: 2px 0; font-size: 10.5pt; }
			        .invoice .kv span { color: #6b7280; }
			        .invoice hr { border: none; border-top: 1px solid #e5e7eb; margin: 10px 0; }
			        .invoice .bill { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 6px; }
			        .invoice .box { border: 1px solid #e5e7eb; border-radius: 12px; padding: 10px 12px; }
			        .invoice .box h3 { margin: 0 0 6px; font-size: 11.5pt; }
			        .invoice .box p { margin: 4px 0; font-size: 10.5pt; line-height: 1.5; }
			        .invoice table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 10.5pt; }
			        .invoice th, .invoice td { border: 1px solid #e5e7eb; padding: 8px 8px; vertical-align: top; }
			        .invoice th { background: #f3f4f6; text-align: left; }
			        .invoice td.num, .invoice th.num { text-align: right; }
			        .invoice .muted { color: #6b7280; font-size: 10pt; }
			        .invoice .right { text-align: right; }
			        .invoice .pay { margin-top: 10px; }
			        .invoice .pay .row { display: grid; grid-template-columns: 1fr 2fr; gap: 10px; padding: 2px 0; font-size: 10.5pt; }
			        .invoice .footer { margin-top: 12px; text-align: center; color: #6b7280; font-size: 9.5pt; }
			      `;

			      const logoDataUrl = typeof LOGO_DATA_URL === "string" ? LOGO_DATA_URL : "";
			      const companyLines = [
			        "Maple Education Pte. Ltd. (UEN: 202349302E)",
			        "111 North Bridge Road, #25-01, Peninsula Plaza, Singapore 179098",
			        "Email: Maple@maplesgedu.com · Website: maplesgedu.com",
			        "SG/WhatsApp: +65 86863695 · CN/WeChat: +86 13506938797",
			      ];

			      const dateIso = ctx.dateIso || formatIsoDate("");
			      const clientName = ctx.clientName || "__________";
			      const contactParts = [ctx.clientPhone, ctx.clientEmail].map((v) => String(v || "").trim()).filter(Boolean);
			      const contactLine = contactParts.length ? contactParts.join(" / ") : "";
			      const refNo = ctx.contractNo || "";

			      const displayAmount = formatMoney(currency, invoiceAmount);
			      const useBreakdown = Array.isArray(computedItems) && computedItems.length > 0 && Number.isFinite(computedTotal) && Math.abs(Number(invoiceAmount) - Number(computedTotal)) < 0.01;

			      const rows = [];
			      if (useBreakdown) {
			        computedItems.forEach((it) => {
			          rows.push(`<tr><td>${escapeHtml(it.label || "")}</td><td class="num">1</td><td class="num">${escapeHtml(formatMoney(currency, it.amount))}</td><td class="num">${escapeHtml(formatMoney(currency, it.amount))}</td></tr>`);
			        });
			      } else {
			        const label = isDeposit ? "Initial Payment / 首付款（按合同付款节点）" : "Service Fee / 服务费（按合同/报价）";
			        rows.push(`<tr><td>${escapeHtml(label)}</td><td class="num">1</td><td class="num">${escapeHtml(displayAmount)}</td><td class="num">${escapeHtml(displayAmount)}</td></tr>`);
			      }

			      rows.push(`<tr><td colspan="3" class="right"><strong>Total 合计</strong></td><td class="num"><strong>${escapeHtml(displayAmount)}</strong></td></tr>`);

			      const sgdBank = {
			        beneficiary: "MAPLE EDUCATION PTE. LTD.",
			        bank: "OCBC BANK",
			        account: "596-1491-38001",
			        bankCode: "7339",
			        branchCode: "713",
			        swift: "OCBCSGSG",
			        address: "65 Chulia Street, #01-100 OCBC Centre, Singapore 049513",
			      };

			      const payRows = [];
			      if (currency === "SGD") {
			        payRows.push(`<div class="row"><div class="muted">Beneficiary</div><div>${escapeHtml(sgdBank.beneficiary)}</div></div>`);
			        payRows.push(`<div class="row"><div class="muted">Bank</div><div>${escapeHtml(sgdBank.bank)}</div></div>`);
			        payRows.push(`<div class="row"><div class="muted">Account</div><div>${escapeHtml(sgdBank.account)}</div></div>`);
			        payRows.push(`<div class="row"><div class="muted">Bank Code</div><div>${escapeHtml(sgdBank.bankCode)}</div></div>`);
			        payRows.push(`<div class="row"><div class="muted">Branch Code</div><div>${escapeHtml(sgdBank.branchCode)}</div></div>`);
			        payRows.push(`<div class="row"><div class="muted">SWIFT</div><div>${escapeHtml(sgdBank.swift)}</div></div>`);
			        payRows.push(`<div class="row"><div class="muted">Bank Address</div><div>${escapeHtml(sgdBank.address)}</div></div>`);
			      } else {
			        payRows.push(`<div class="row"><div class="muted">Payment</div><div>Remit to Party B’s designated account or channels as notified in writing (e.g. bank transfer / PayNow / official collection accounts).</div></div>`);
			        payRows.push(`<div class="row"><div class="muted">收款方式</div><div>请按乙方书面指定的收款账户/渠道支付（如银行转账、PayNow、官方收款账号等）。</div></div>`);
			      }

			      const breakdownNote = (!useBreakdown && Number.isFinite(computedTotal) && computedTotal > 0)
			        ? `<p class="muted">参考明细（非本发票计费项）：${escapeHtml(formatMoney(currency, computedTotal))}（按已选收费项目/附加项合计）</p>`
			        : "";

			      const body = `
			        <div class="invoice">
			          <div class="top">
			            <div class="brand">
			              ${logoDataUrl ? `<img class="logo" src="${escapeHtml(logoDataUrl)}" alt="Maple Education Logo" />` : `<div></div>`}
			              <div class="company">
			                <div class="name">MAPLE EDUCATION</div>
			                ${companyLines.map((l) => `<div>${escapeHtml(l)}</div>`).join("")}
			              </div>
			            </div>
			            <div class="doc">
			              <div class="title">INVOICE / 发票</div>
			              <div class="kv"><span>Invoice No 发票号</span><strong>${escapeHtml(invoiceNo || "")}</strong></div>
			              <div class="kv"><span>Date 日期</span><strong>${escapeHtml(dateIso)}</strong></div>
			              <div class="kv"><span>Currency 币种</span><strong>${escapeHtml(currency)}</strong></div>
			              ${refNo ? `<div class="kv"><span>Reference 合同号</span><strong>${escapeHtml(refNo)}</strong></div>` : ""}
			            </div>
			          </div>
			          <hr/>
			          <div class="bill">
			            <div class="box">
			              <h3>Bill To / 开票给</h3>
			              <p><strong>${escapeHtml(clientName)}</strong></p>
			              ${contactLine ? `<p class="muted">${escapeHtml(contactLine)}</p>` : `<p class="muted">Contact 联系方式：__________</p>`}
			              ${ctx.clientAddress ? `<p class="muted">${escapeHtml(ctx.clientAddress)}</p>` : ""}
			            </div>
			            <div class="box">
			              <h3>Project / 项目</h3>
			              <p class="muted">${escapeHtml(ctx.resolvedType ? contractTypeLabel(ctx.resolvedType) : "")}</p>
			              ${ctx.targetSchool ? `<p>${escapeHtml(ctx.targetSchool)}</p>` : `<p class="muted">Target 目标院校/项目：__________</p>`}
			              ${ctx.targetMajor ? `<p class="muted">${escapeHtml(ctx.targetMajor)}</p>` : ""}
			              ${isDeposit ? `<p class="muted">This invoice is for initial payment / deposit.</p>` : ""}
			            </div>
			          </div>
			          <table>
			            <tr>
			              <th>Description / 项目说明</th>
			              <th class="num" style="width:10%;">Qty</th>
			              <th class="num" style="width:18%;">Unit Price</th>
			              <th class="num" style="width:18%;">Amount</th>
			            </tr>
			            ${rows.join("\n")}
			          </table>
			          ${breakdownNote}
			          <div class="box pay">
			            <h3>Payment Instructions / 付款信息</h3>
			            ${payRows.join("")}
			          </div>
			          <div class="footer">Account Department · Maple Education Pte. Ltd.</div>
			        </div>
			      `;

			      return { title: `发票 ${currency}`, style: invoiceCss, body };
			    }

				    function buildInvoicePackage() {
				      const filters = getFilters();
				      const resolvedType = resolveContractType(filters);
				      const pricingOption = getSelectedPricingOption(filters);
				      const addons = getSelectedAddOns();

				      const payMethod = (document.getElementById("pay-method").value || "").trim();
				      const feeSgd = parseMoneyToNumber(document.getElementById("fee-sgd").value);
				      const initialSgd = parseMoneyToNumber(document.getElementById("initial-sgd").value);
				      const hasInitial = Boolean(initialSgd !== null);
				      const isDeposit = payMethod === "installment" && hasInitial;

				      const computedSgdItems = [];
				      if (pricingOption && pricingOption.feeSgd) computedSgdItems.push({ label: pricingOption.label, amount: Number(pricingOption.feeSgd) });
				      addons.forEach((a) => {
				        if (a.feeSgd) computedSgdItems.push({ label: a.label, amount: Number(a.feeSgd) });
				      });
				      const computedSgdTotal = computedSgdItems.reduce((sum, it) => sum + (Number(it.amount) || 0), 0);

				      const invSgd = (isDeposit ? initialSgd : feeSgd) ?? (computedSgdTotal || null);

			      const ctx = {
			        resolvedType,
			        clientName: (document.getElementById("client-name").value || "").trim(),
			        childName: (document.getElementById("child-name").value || "").trim(),
			        targetGrade: (document.getElementById("target-grade").value || "").trim(),
			        clientPhone: (document.getElementById("client-phone").value || "").trim(),
			        clientEmail: (document.getElementById("client-email").value || "").trim(),
			        clientAddress: (document.getElementById("client-address").value || "").trim(),
			        contractNo: (document.getElementById("contract-no").value || "").trim(),
			        targetSchool: (document.getElementById("target-school").value || "").trim(),
			        targetMajor: (document.getElementById("target-major").value || "").trim(),
			        dateIso: formatIsoDate(document.getElementById("payment-date").value),
			      };

				      const docs = [];
				      if (Number.isFinite(invSgd) && invSgd > 0) {
				        docs.push(buildInvoiceParts(ctx, "SGD", {
				          invoiceNo: generateInvoiceNo(),
				          invoiceAmount: invSgd,
				          computedItems: computedSgdItems,
				          computedTotal: computedSgdTotal,
				          isDeposit,
				        }));
				      }
				      if (docs.length === 0) throw new Error("请先填写服务费/首付款金额，或选择价目表项。");

				      const title = `${ctx.clientName || "客户"} 发票`.trim();
				      const html = buildCombinedHtml(title, docs);
				      const filename = `${sanitizeFilenamePart(ctx.clientName || "客户")}_${sanitizeFilenamePart(ctx.contractNo || "合同")}_发票.html`;
				      const note = "发票（SGD）";
				      return { html, filename, note };
				    }

				    function buildContractPackage() {
			      const filters = getFilters();
			      const resolvedType = resolveContractType(filters);
			      const includeQuoteEl = document.getElementById("include-quote-page");
			      const refundTermsEl = document.getElementById("refund-terms");
			      const pricingOption = getSelectedPricingOption(filters);
			      const addons = getSelectedAddOns();
			      const ctx = {
			        resolvedType,
			        clientName: (document.getElementById("client-name").value || "").trim(),
			        childName: (document.getElementById("child-name").value || "").trim(),
			        targetGrade: (document.getElementById("target-grade").value || "").trim(),
			        contractNo: (document.getElementById("contract-no").value || "").trim(),
			        targetSchool: (document.getElementById("target-school").value || "").trim(),
			        targetMajor: (document.getElementById("target-major").value || "").trim(),
			        feeSgd: String(document.getElementById("fee-sgd").value || "").trim().replace(/,/g, ""),
			        pricingId: (document.getElementById("pricing-item").value || "").trim(),
			        pricingOption: pricingOption ? { ...pricingOption } : null,
			        addons: addons.map((a) => ({ ...a })),
			        refundTerms: refundTermsEl ? convertRefundTextToSgd(String(refundTermsEl.value || ""), readFxCnyPerSgd()) : "",
			        includeQuote: includeQuoteEl ? Boolean(includeQuoteEl.checked) : false,
			        dateIso: formatIsoDate(document.getElementById("payment-date").value),
			      };

		      const docs = [];
		      if (resolvedType === "kindergarten") {
		        docs.push(buildAppendixParts("kindergarten", ctx));
		      } else {
		        const main = extractHtmlParts(buildFilledContractHtml(), "出国留学服务合同");
		        docs.push(main);
		        if (resolvedType === "main_private") docs.push(buildAppendixParts("private", ctx));
		        if (resolvedType === "main_sim") docs.push(buildAppendixParts("sim", ctx));
		        if (resolvedType === "main_highend") docs.push(buildAppendixParts("highend", ctx));
		        if (resolvedType === "main_k12_public") docs.push(buildAppendixParts("k12_public", ctx));
		        if (resolvedType === "main_k12_international") docs.push(buildAppendixParts("k12_international", ctx));
		        if (ctx.includeQuote) docs.push(buildQuoteParts(ctx));
		      }

		      const title = `${ctx.clientName || "客户"} ${ctx.contractNo || ""} ${contractTypeLabel(resolvedType)}`.trim();
		      const html = buildCombinedHtml(title, docs);
		      const filename = buildContractFilename();
		      const note = resolvedType === "kindergarten"
		        ? "幼儿园择校服务协议"
		        : (docs.length > 1 ? `主合同 + 附录/补充页（共${docs.length}份）` : "主合同");
		      return { html, filename, note };
		    }
  </script>
  <script type="text/plain" id="student-contract-template">
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Maple Education Study Abroad Service Agreement - 枫叶留学出国留学服务合同</title>
    <style>
        @page {
            size: A4;
            margin: 0;
        }

        body {
            margin: 0;
            padding: 0;
            width: 210mm;
            background: white;
            font-family: 'Segoe UI', 'Microsoft YaHei', SimSun, serif;
            position: relative;
            box-sizing: border-box;
        }

        .watermark {
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            opacity: 0.04;
            width: 500px;
            z-index: 1;
            pointer-events: none;
        }

        .header {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            display: flex;
            align-items: flex-start;
            padding: 2mm 10mm 5mm 10mm;
            background: white;
            z-index: 10;
            border-bottom: 1px solid #333;
        }

        .logo {
            width: 80px;
            height: 80px;
            margin-right: 8mm;
        }

        .header-content {
            flex-grow: 1;
            padding-top: 5px;
        }

        .company-name {
            font-size: 16pt;
            font-weight: 600;
            color: #333;
            line-height: 1.3;
        }

        .company-name-en {
            font-size: 11pt;
            font-weight: 500;
            color: #2c5aa0;
        }

        .company-info {
            font-size: 8pt;
            color: #666;
            line-height: 1.4;
            margin-top: 2px;
        }

        .footer {
            position: fixed;
            bottom: 0;
            left: 0;
            right: 0;
            text-align: center;
            font-size: 7.5pt;
            color: #888;
            padding: 4mm 0;
            background: white;
            border-top: 1px solid #ccc;
            z-index: 10;
        }

        .content {
            margin-top: 38mm;
            margin-bottom: 18mm;
            padding: 0 15mm;
            z-index: 5;
            font-size: 9.5pt;
            line-height: 1.7;
            color: #333;
        }

        .contract-title {
            text-align: center;
            font-size: 20pt;
            font-weight: 700;
            color: #2c5aa0;
            margin: 15px 0 5px 0;
            letter-spacing: 2px;
        }

        .contract-subtitle {
            text-align: center;
            font-size: 13pt;
            font-weight: 500;
            color: #666;
            margin-bottom: 18px;
            font-style: italic;
        }

        .info-box {
            background: #f9f9f9;
            border-left: 3px solid #2c5aa0;
            padding: 10px 12px;
            margin: 15px 0;
            font-size: 9pt;
            line-height: 1.6;
        }

        .warning-box {
            background: #fff5f5;
            border: 2px solid #d32f2f;
            border-radius: 4px;
            padding: 12px;
            margin: 15px 0;
            font-size: 9pt;
            line-height: 1.7;
        }

        .section-title {
            font-size: 13pt;
            font-weight: 700;
            color: #2c5aa0;
            margin: 20px 0 10px 0;
            padding-bottom: 5px;
            border-bottom: 2px solid #2c5aa0;
        }

        .cn {
            color: #333;
            line-height: 1.9;
            margin-bottom: 3px;
        }

        .en {
            color: #666;
            font-style: italic;
            font-size: 8.5pt;
            line-height: 1.6;
            margin-bottom: 12px;
        }

        table {
            width: 100%;
            border-collapse: collapse;
            margin: 12px 0;
            font-size: 9pt;
        }

        table th,
        table td {
            border: 1px solid #ccc;
            padding: 8px;
        }

        table th {
            background-color: #2c5aa0;
            color: white;
            font-weight: 600;
        }

        ol {
            margin: 10px 0 10px 20px;
            padding: 0;
        }

        li {
            margin-bottom: 10px;
            line-height: 1.8;
        }

        .signature-section {
            margin-top: 35px;
            display: flex;
            justify-content: space-between;
            page-break-inside: avoid;
        }

        .signature-block {
            width: 48%;
        }

        .signature-line {
            border-bottom: 1px solid #333;
            margin: 25px 0 5px 0;
            height: 40px;
        }

        .page-break {
            page-break-after: always;
        }

        @media print {
            body {
                border: none;
            }
        }
    </style>
</head>
<body>
    <img src="../../04_Brand_Assets/01_Logo/Logo_MapleEducation_Main.jpg" alt="Watermark" class="watermark">

    <div class="header">
        <img src="../../04_Brand_Assets/01_Logo/Logo_MapleEducation_Main.jpg" alt="Maple Education Logo" class="logo">
        <div class="header-content">
            <div class="company-name">SG枫叶留学</div>
            <div class="company-name-en">MAPLE EDUCATION PTE. LTD.</div>
            <div class="company-info">
                UEN: 202349302E | Singapore Business Registration<br>
                111 North Bridge Road, #25-01, Peninsula Plaza, Singapore 179098
            </div>
        </div>
    </div>

    <div class="footer">
        <strong style="color: #2c5aa0;">Maple Education Pte. Ltd.</strong> | UEN: 202349302E<br>
        📧 Maple@maplesgedu.com | 🌐 www.maplesgedu.com | 📱 SG +65 86863695 | CN +86 13506938797
    </div>

    <div class="content">
        <div class="contract-title">出国留学服务合同</div>
        <div class="contract-subtitle">Study Abroad Service Agreement</div>

        <div class="info-box">
            <strong>服务邮箱 Service Email:</strong> Maple@maplesgedu.com<br>
            <strong>合同编号 Contract No.:</strong> MAPLE-________ <br>
            <strong>留学顾问 Study Consultant:</strong> __________ <br>
            <strong>联系手机 Contact Phone:</strong> +65 86863695 (SG/WhatsApp) | +86 13506938797 (CN/WeChat)
        </div>

        <div class="warning-box">
            <div style="font-size: 12pt; font-weight: 700; color: #d32f2f; margin-bottom: 12px;">特别告知</div>
            <div style="font-size: 10.5pt; font-weight: 600; color: #d32f2f; margin-bottom: 12px; font-style: italic;">IMPORTANT NOTICE</div>

            <div class="cn">尊敬的申请人：</div>
            <div class="en">Dear Applicant,</div>

            <div class="cn">您好。感谢您选择Maple Education Pte. Ltd.（以下称"枫叶留学"）为您提供出国留学服务。为确保更好地为您提供服务，枫叶留学特别提示您注意以下内容：</div>
            <div class="en">Thank you for choosing Maple Education Pte. Ltd. (hereinafter referred to as "Maple Education") to provide you with study abroad services. To ensure better service delivery, Maple Education would like to draw your special attention to the following:</div>

            <ol>
                <li>
                    <div class="cn">申请人必须符合新加坡及目标国家/地区自费出国留学的必备条件。</div>
                    <div class="en">The applicant must meet the necessary requirements for self-funded study abroad in Singapore and the target country/region.</div>
                </li>
                <li>
                    <div class="cn">在留学申请办理过程中，申请人将前往的国家或地区的留学政策、签证政策或申请留学院校的入学要求可能会发生变化，如申请人届时不能满足新的要求则可能导致留学手续无法办理。</div>
                    <div class="en">During the study abroad application process, the study abroad policies, visa policies, or admission requirements of the institutions in the country or region to which the applicant intends to go may change. If the applicant cannot meet the new requirements at that time, it may result in the inability to complete the study abroad procedures.</div>
                </li>
                <li>
                    <div class="cn">发放签证是申请人申请留学的国家或地区政府独立行使的权利。虽然申请人具备了签证的条件，但是否能够获得签证存在不确定性；同时，申请人获得签证的时间亦具有不确定性。在未获得前往国家或地区签证或入境批准文件之前，申请人切勿轻易变更目前就学或就业状况，且不得随意动用所提供的经济担保资金或做出其他重大经济行为，还应避免使（领）馆调查时出现与原申请材料不符的情况，以免签证申请失败给申请人造成损失。</div>
                    <div class="en">The issuance of visas is an independent right exercised by the government of the country or region to which the applicant applies for study. Although the applicant meets the visa requirements, there is uncertainty as to whether a visa can be obtained; at the same time, the time for the applicant to obtain a visa is also uncertain. Before obtaining a visa or entry approval document for the destination country or region, the applicant should not easily change their current study or employment status, should not arbitrarily use the provided financial guarantee funds or make other major economic actions, and should also avoid situations where the embassy (consulate) investigation reveals inconsistencies with the original application materials, so as to avoid losses caused by visa application failure.</div>
                </li>
                <li>
                    <div class="cn">申请人获得签证或入境许可文件后，该国家或院校发生的任何变化是枫叶留学无法预测的，此变化可能会对申请人的留学产生一定的影响。</div>
                    <div class="en">After the applicant obtains a visa or entry permit document, any changes that occur in the country or institution are unpredictable by Maple Education, and such changes may have a certain impact on the applicant's study abroad.</div>
                </li>
                <li>
                    <div class="cn">申请人向枫叶留学缴付款项时，应汇入枫叶留学指定的银行账户或当面交至枫叶留学财务部并索取盖有枫叶留学财务专用章的正式收据。当申请人采用汇款方式时，收款人处应填写正确、完整的枫叶留学名称。申请人不得以任何方式将费用交给枫叶留学指定账户或财务部以外的任何单位或个人。</div>
                    <div class="en">When the applicant pays fees to Maple Education, they should remit to the bank account designated by Maple Education or pay in person to Maple Education's finance department and obtain an official receipt stamped with Maple Education's financial seal. When the applicant uses the remittance method, the payee should fill in the correct and complete name of Maple Education. The applicant must not pay fees to any unit or individual other than Maple Education's designated account or finance department in any way.</div>
                </li>
                <li>
                    <div class="cn">如果申请人不符合申请留学院校的直接入学要求，院校可能会给申请人签发有条件的课程录取通知书，要求申请人必须通过一个阶段的学习，达到校方录取通知书上的要求后，方可进入该校专业课程学习，在此期间申请人可能因无法达到院校要求而最终不能获得入学资格。</div>
                    <div class="en">If the applicant does not meet the direct admission requirements of the application institution, the institution may issue a conditional course admission letter to the applicant, requiring the applicant to complete a period of study and meet the requirements on the institution's admission letter before entering the institution's professional course study. During this period, the applicant may ultimately fail to obtain admission qualification due to inability to meet the institution's requirements.</div>
                </li>
                <li>
                    <div class="cn">申请人前往的国家或地区使（领）馆发出申请人申请的签证（预签）或入境批准文件后，申请人不得擅自更改入学院校或专业。</div>
                    <div class="en">After the embassy (consulate) of the country or region to which the applicant is going issues the visa (pre-visa) or entry approval document applied for by the applicant, the applicant shall not change the admission institution or major without authorization.</div>
                </li>
                <li>
                    <div class="cn">申请人不得提供任何虚假的书面、电子或口头材料和信息。</div>
                    <div class="en">The applicant must not provide any false written, electronic, or verbal materials and information.</div>
                </li>
                <li>
                    <div class="cn">申请人出境后应自觉遵守前往国家的法律、法规、留学院校和境外机构的规章制度，申请人应对入学以后的个人行为负责，避免与院校或境外机构产生任何纠纷。申请人入学后，因学习成绩不合格或其它原因，可能会导致申请人不能获得相应证书。</div>
                    <div class="en">After departure, the applicant should consciously comply with the laws and regulations of the destination country, the rules and regulations of the study abroad institutions and overseas institutions. The applicant shall be responsible for personal behavior after enrollment and avoid any disputes with institutions or overseas institutions. After enrollment, the applicant may not be able to obtain the corresponding certificate due to unqualified academic performance or other reasons.</div>
                </li>
                <li>
                    <div class="cn">枫叶留学禁止工作人员对申请人做出任何"百分百"、"绝对没问题"等口头或书面方式的过度承诺，该承诺属违规行为，若申请人发现枫叶留学工作人员任何的违规行为，请及时将此情况反馈给枫叶留学。</div>
                    <div class="en">Maple Education prohibits staff from making any excessive promises such as "one hundred percent" or "absolutely no problem" in oral or written form to applicants. Such promises are violations. If the applicant discovers any violations by Maple Education staff, please promptly report this situation to Maple Education.</div>
                </li>
            </ol>

            <div class="cn" style="margin-top: 15px;">因上述原因或申请人违反上述规定及本合同约定所引起的任何后果、纠纷和损失，枫叶留学不承担任何责任。</div>
            <div class="en">Maple Education shall not bear any responsibility for any consequences, disputes, and losses caused by the above reasons or the applicant's violation of the above provisions and this contract.</div>

            <div class="cn">如申请人发现任何商业贿赂行为，可向枫叶留学举报。枫叶留学举报电话：+65 86863695；举报邮箱：Maple@maplesgedu.com</div>
            <div class="en">If the applicant discovers any commercial bribery, they can report it to Maple Education. Maple Education reporting hotline: +65 86863695; Reporting email: Maple@maplesgedu.com</div>

            <div class="cn">申请人在签字前应仔细阅读合同，并应完全了解合同文本的全部条款，特别应对合同中的"退费规定"全面了解。</div>
            <div class="en">The applicant should carefully read the contract before signing and should fully understand all terms of the contract text, especially should have a comprehensive understanding of the "Refund Regulations" in the contract.</div>

            <div style="margin-top: 20px; padding: 10px; background: #fffbf0; border: 1px solid #ffa000;">
                <div class="cn"><strong>申请人（委托人/代理人）已阅读、并清楚了解上述条款的内容和含义。</strong></div>
                <div class="en"><strong>The Applicant (Principal/Agent) has read and clearly understands the content and meaning of the above terms.</strong></div>

                <div style="margin-top: 20px;">
                    <div class="cn">申请人（委托人/代理人）签名：______________________ 日期：____ 年 __ 月 __ 日</div>
                    <div class="en">Applicant (Principal/Agent) Signature: ______________________ Date: ___/___/______</div>
                </div>
            </div>
        </div>

        <div class="page-break"></div>

        <!-- 第一章 -->
        <div class="section-title">第一章 合同双方 | Chapter 1: Contracting Parties</div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>委托人（下称"申请人"）Applicant (Principal)：</strong></div>
            <table>
                <tr>
                    <td style="width: 30%"><strong>姓名 Name:</strong></td>
                    <td>______________________</td>
                </tr>
                <tr>
                    <td><strong>身份证号 ID Number:</strong></td>
                    <td>______________________</td>
                </tr>
                <tr>
                    <td><strong>护照号 Passport Number:</strong></td>
                    <td>______________________</td>
                </tr>
                <tr>
                    <td><strong>联系地址 Contact Address:</strong></td>
                    <td>______________________</td>
                </tr>
                <tr>
                    <td><strong>联系电话 Contact Phone:</strong></td>
                    <td>______________________</td>
                </tr>
                <tr>
                    <td><strong>电子邮箱 Email:</strong></td>
                    <td>______________________</td>
                </tr>
            </table>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>受托人 Service Provider：</strong></div>
            <div class="info-box">
                <strong>公司名称 Company Name:</strong> Maple Education Pte. Ltd.<br>
                <strong>注册编号 UEN:</strong> 202349302E<br>
                <strong>注册地址 Registered Address:</strong> 111 North Bridge Road, #25-01, Peninsula Plaza, Singapore 179098<br>
                <strong>联系电话 Phone:</strong> +65 86863695 (Singapore/WhatsApp)<br>
                <strong>中国联系 China Contact:</strong> +86 13506938797 (WeChat)<br>
                <strong>电子邮箱 Email:</strong> Maple@maplesgedu.com<br>
                <strong>官方网站 Website:</strong> www.maplesgedu.com
            </div>
        </div>

        <div class="cn">申请人、枫叶留学双方本着自愿、平等、诚信的原则，就申请人接受枫叶留学提供有关自费出国留学中介服务事宜，经协商，达成如下协议，以共同遵守。</div>
        <div class="en">Based on the principles of voluntariness, equality, and good faith, the applicant and Maple Education have reached the following agreement through negotiation regarding the applicant's acceptance of Maple Education's provision of intermediary services related to self-funded study abroad, to be jointly observed.</div>

        <!-- 第二章 -->
        <div class="section-title">第二章 服务内容 | Chapter 2: Service Scope</div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第一条</strong> 枫叶留学向申请人提供留学前往国家的教育概况、院校、院系、专业的信息，供申请人参考，提供相应的咨询建议，最终由申请人决定留学方案。</div>
            <div class="en"><strong>Article 1</strong> Maple Education shall provide the applicant with information about the education overview, institutions, faculties, and majors of the study abroad destination country for the applicant's reference, provide corresponding consultation and advice, with the final study abroad plan to be decided by the applicant.</div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第二条</strong> 根据自身条件，申请人决定申请赴 __________ (国家/地区) 留学，合同类型为 __________ (院校类型) 申请服务；目标院校为 __________，专业为 __________。并自愿接受枫叶留学提供涉及上述自费出国留学的中介服务。</div>
            <div class="en"><strong>Article 2</strong> Based on personal qualifications, the applicant decides to apply for study in __________ (Country/Region), the contract type is __________ (Institution Type) application service; the target institution is __________, the major is __________. And voluntarily accepts Maple Education's provision of intermediary services related to the aforementioned self-funded study abroad.</div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第三条</strong> 申请全过程包含的服务如下：</div>
            <div class="en"><strong>Article 3</strong> The complete application process includes the following services:</div>

            <ol>
                <li>
                    <div class="cn">为申请人提供前期留学相关的咨询服务，规划申请院校，确认专业。</div>
                    <div class="en">Provide the applicant with preliminary study abroad consultation services, plan application institutions, and confirm majors.</div>
                </li>
                <li>
                    <div class="cn">收集申请人的申请资料并协助申请人整理材料。（包含代写文书服务）</div>
                    <div class="en">Collect the applicant's application materials and assist the applicant in organizing materials. (Including document writing services)</div>
                </li>
                <li>
                    <div class="cn">评估申请人的申请材料并完成申请递交。</div>
                    <div class="en">Evaluate the applicant's application materials and complete the application submission.</div>
                </li>
                <li>
                    <div class="cn">为申请人监督申请过程并确认offer情况。</div>
                    <div class="en">Monitor the application process for the applicant and confirm the offer status.</div>
                </li>
                <li>
                    <div class="cn">协助申请人办理签证，递交签证材料，确认签证审批情况。</div>
                    <div class="en">Assist the applicant in visa processing, submit visa materials, and confirm visa approval status.</div>
                </li>
                <li>
                    <div class="cn">协助申请人做好入学前准备。</div>
                    <div class="en">Assist the applicant in pre-enrollment preparations.</div>
                </li>
                <li>
                    <div class="cn">协助申请人在目的地国家的学习生活相关咨询服务。</div>
                    <div class="en">Assist the applicant with consultation services related to study and living in the destination country.</div>
                </li>
            </ol>

            <div class="warning-box">
                <div class="cn"><strong>备注：</strong> 第三条"附加内容"手写无效。本合同服务不包含语言培训、院校申请费、签证费、学费、生活费、机票等第三方费用。</div>
                <div class="en"><strong>Note:</strong> Handwritten "additional content" in Article 3 is invalid. Services under this contract do not include language training, institution application fees, visa fees, tuition fees, living expenses, airfare, and other third-party costs.</div>
            </div>
        </div>

        <div class="page-break"></div>

        <!-- 第三章 -->
        <div class="section-title">第三章 申请人的权利和义务 | Chapter 3: Rights and Obligations of the Applicant</div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第四条</strong> 确认本合同委托事项，并按本合同约定按时向枫叶留学支付中介服务费。</div>
            <div class="en"><strong>Article 4</strong> Confirm the commissioned matters of this contract and pay the intermediary service fee to Maple Education on time as stipulated in this contract.</div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第五条</strong> 申请人应在本合同签订后，于 ____ 年 __ 月 __ 日前把入学申请所需材料交给枫叶留学（入学材料以各院校公布的当年最新招生标准为准），并遵守本合同《特别告知》中规定。如申请人不能如期提供入学申请所需材料或违反《特别告知》中规定，因此而造成的损失由申请人承担。</div>
            <div class="en"><strong>Article 5</strong> After signing this contract, the applicant shall submit the required materials for the admission application to Maple Education by __/__/____ (admission materials shall be based on the latest enrollment standards published by each institution for the current year), and comply with the provisions in the "Important Notice" of this contract. If the applicant cannot provide the required materials for the admission application on time or violates the provisions in the "Important Notice," the losses caused thereby shall be borne by the applicant.</div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第六条</strong> 在留学申请办理过程中，如前往国家或地区的留学政策、签证政策或申请留学院校的入学要求发生变化，申请人应根据新的要求，及时提供补充材料。</div>
            <div class="en"><strong>Article 6</strong> During the study abroad application process, if the study abroad policies, visa policies, or admission requirements of the institutions in the destination country or region change, the applicant shall promptly provide supplementary materials according to the new requirements.</div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第七条</strong> 在留学申请办理过程中，申请人应在枫叶留学的指导下，自行将申请留学院校报名费、学费、杂费等费用按时足额汇往学校指定的银行账号。</div>
            <div class="en"><strong>Article 7</strong> During the study abroad application process, under the guidance of Maple Education, the applicant shall remit the application institution's registration fee, tuition, miscellaneous fees, and other fees on time and in full to the bank account designated by the school.</div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第八条</strong> 在留学申请办理过程中，如申请人前往国家或地区使（领）馆要求申请人进行面试，申请人应按使（领）馆要求，按时到使（领）馆面试。</div>
            <div class="en"><strong>Article 8</strong> During the study abroad application process, if the embassy (consulate) of the destination country or region requires the applicant to attend an interview, the applicant shall attend the embassy (consulate) interview on time as required by the embassy (consulate).</div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第九条</strong> 申请人如未能获得留学前往国家或地区签证或入境批准文件，或者已获签证或入境批准文件而放弃前往该国已申请留学学院学习，均由申请人自行负责向该院校提出退费申请，要求该院校按规定退还学费、杂费等费用。</div>
            <div class="en"><strong>Article 9</strong> If the applicant fails to obtain a visa or entry approval document for the study abroad destination country or region, or abandons going to the applied study abroad institution in that country after obtaining a visa or entry approval document, the applicant shall be solely responsible for submitting a refund application to the institution and requesting the institution to refund tuition, miscellaneous fees, and other fees according to regulations.</div>
        </div>

        <!-- 第四章 -->
        <div class="section-title">第四章 枫叶留学的权利和义务 | Chapter 4: Rights and Obligations of Maple Education</div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第十条</strong> 如实向申请人介绍前往国家或地区的留学政策、签证政策和申请留学院校的基本情况、入学要求等留学相关信息。</div>
            <div class="en"><strong>Article 10</strong> Truthfully introduce to the applicant the study abroad policies, visa policies, and basic information about the application institutions, admission requirements, and other study abroad related information of the destination country or region.</div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第十一条</strong> 根据各国使（领）馆的要求，枫叶留学收到申请人符合签证要求的全部签证申请材料后，在十个工作日内向相关使（领）馆递交签证申请材料。</div>
            <div class="en"><strong>Article 11</strong> According to the requirements of embassies (consulates) of various countries, after receiving all visa application materials from the applicant that meet visa requirements, Maple Education shall submit the visa application materials to the relevant embassy (consulate) within ten working days.</div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第十二条</strong> 申请人理解并同意，枫叶留学有权在不暴露申请人真实身份及隐私的前提下，根据枫叶留学需要公开及使用枫叶留学指导申请人撰写的文书及其它材料。</div>
            <div class="en"><strong>Article 12</strong> The applicant understands and agrees that Maple Education has the right to publicly use documents and other materials guided by Maple Education for the applicant's writing, provided that the applicant's true identity and privacy are not exposed, according to Maple Education's needs.</div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第十三条</strong> 枫叶留学有权要求申请人提供并及时从申请人处获得与申请有关的各项信息。</div>
            <div class="en"><strong>Article 13</strong> Maple Education has the right to request and promptly obtain from the applicant all information related to the application.</div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第十四条</strong> 枫叶留学同意并确认，枫叶留学有权拆阅并处理各申请和非申请学校寄给申请人的信函（包括但不限于邮件、电子邮件、传真）。</div>
            <div class="en"><strong>Article 14</strong> Maple Education agrees and confirms that Maple Education has the right to open and handle letters sent to the applicant by various application and non-application schools (including but not limited to mail, email, fax).</div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第十五条</strong> 枫叶留学有权按本合同规定向申请人收取服务费；如果申请人拖欠费用，枫叶留学有权就申请人应付但未付的款项自应付之日起按日0.05%比例收取滞纳金。</div>
            <div class="en"><strong>Article 15</strong> Maple Education has the right to charge service fees to the applicant as stipulated in this contract; if the applicant is in arrears with fees, Maple Education has the right to charge a late fee at a rate of 0.05% per day from the date due on the amounts payable but not paid by the applicant.</div>
        </div>

        <div class="page-break"></div>

        <!-- 第五章 -->
        <div class="section-title">第五章 缴费及退费规定 | Chapter 5: Payment and Refund Regulations</div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第十六条</strong> 申请人在与枫叶留学签署本合同的同时，需向枫叶留学支付服务费，费用详情如下：</div>
            <div class="en"><strong>Article 16</strong> When signing this contract with Maple Education, the applicant shall pay service fees to Maple Education, with fee details as follows:</div>

            <table style="margin-top: 15px;">
	                <tr>
	                    <td style="width: 50%"><strong>服务费总额 Total Service Fee:</strong></td>
	                    <td><strong>SGD $__________</strong></td>
	                </tr>
                <tr>
                    <td><strong>支付方式 Payment Method:</strong></td>
                    <td>☐ 一次性付清 Full Payment ☐ 分期付款 Installment</td>
                </tr>
	                <tr>
	                    <td><strong>首次付款 Initial Payment:</strong></td>
	                    <td>SGD $__________</td>
	                </tr>
                <tr>
                    <td><strong>付款日期 Payment Date:</strong></td>
                    <td>____ 年 __ 月 __ 日 / ___/___/______</td>
                </tr>
            </table>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第十七条</strong> 交纳服务费的有效途径如下，由于枫叶留学充分发挥新加坡本土服务+互联网留学模式，建议学生可通过银行汇款或在线支付：</div>
            <div class="en"><strong>Article 17</strong> Valid payment methods for service fees are as follows. As Maple Education fully utilizes the Singapore local service + online study abroad model, students are advised to use bank transfer or online payment:</div>

            <div class="info-box" style="margin-top: 12px;">
                <div style="margin-bottom: 12px;">
                    <strong style="color: #2c5aa0;">1) 银行转账 Bank Transfer (推荐 Recommended)</strong><br>
                    <div style="margin-left: 15px; margin-top: 6px; font-size: 8.5pt;">
                        <strong>Account Name 账户名称:</strong> Maple Education Pte. Ltd.<br>
                        <strong>Bank 开户行:</strong> DBS Bank Ltd. / OCBC Bank<br>
                        <strong>Account Number 账号:</strong> __________<br>
                        <strong>Swift Code:</strong> __________<br>
                        <em style="color: #666;">汇款后请将凭证发送至 Maple@maplesgedu.com<br>Please send transfer receipt to Maple@maplesgedu.com after remittance</em>
                    </div>
                </div>

                <div style="margin-bottom: 12px;">
                    <strong style="color: #2c5aa0;">2) 支付宝/微信支付 Alipay/WeChat Pay</strong><br>
                    <div style="margin-left: 15px; margin-top: 6px; font-size: 8.5pt;">
                        联系客服老师领取官方收款码 Contact customer service for official payment QR code<br>
                        WeChat: +86 13506938797 | WhatsApp: +65 86863695<br>
                        <em style="color: #666;">提示：因国家政策预防诈骗风控，异地扫码支付可能会被提示风险支付，建议通过银行汇款。<br>
                        Note: Due to national anti-fraud policies, cross-regional QR code payments may trigger risk alerts; bank transfer is recommended.</em>
                    </div>
                </div>

                <div>
                    <strong style="color: #2c5aa0;">3) 上门现金交款或POS机刷卡 In-Person Cash or Card Payment</strong><br>
                    <div style="margin-left: 15px; margin-top: 6px; font-size: 8.5pt;">
                        需提前联系预约 Appointment required<br>
                        Address: 111 North Bridge Road, #25-01, Peninsula Plaza, Singapore 179098
                    </div>
                </div>
            </div>

            <div class="warning-box" style="margin-top: 12px;">
                <div class="cn"><strong>⚠️ 重要提示：</strong>请勿向个人账户或非指定账户支付费用，否则枫叶留学不承担任何责任。付款后请索取盖有枫叶留学财务专用章的正式收据。</div>
                <div class="en"><strong>⚠️ Important Notice:</strong> Do not pay fees to personal accounts or non-designated accounts, otherwise Maple Education will not assume any responsibility. Please request an official receipt stamped with Maple Education's financial seal after payment.</div>
            </div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第十八条</strong> 申请人必须自行承担在留学申请办理过程中发生的其他费用（如院校报名费、护照工本费、公证费、体检费、签证费、银行手续费及汇款费、机票款、保险费、院校学费、杂费、接机费、住宿费等）。上述费用由申请人自行向有关机构缴付，缴费标准和缴费方式以相关收费机构对申请人的要求为准。</div>
            <div class="en"><strong>Article 18</strong> The applicant must bear other costs incurred during the study abroad application process (such as institution registration fees, passport fees, notarization fees, medical examination fees, visa fees, bank handling fees and remittance fees, airfare, insurance premiums, institution tuition, miscellaneous fees, airport pickup fees, accommodation fees, etc.). The above fees shall be paid by the applicant directly to relevant institutions, with payment standards and payment methods subject to the requirements of the relevant fee-charging institutions for the applicant.</div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第十九条</strong> 为了保证申请材料迅速安全到达，申请人与学校所有往来邮件全部采用国际大型速递公司DHL的服务，邮递费缴费标准和缴费方式以相关收费机构对申请人的要求为准。</div>
            <div class="en"><strong>Article 19</strong> To ensure the rapid and safe arrival of application materials, all correspondence between the applicant and the school shall use the services of international major courier company DHL, with courier fee payment standards and payment methods subject to the requirements of the relevant fee-charging institution for the applicant.</div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第二十条</strong> 如申请人因自身原因，在本合同签署后单方面要求解除本合同，申请人已缴付的中介服务费按以下方法处理：</div>
            <div class="en"><strong>Article 20</strong> If the applicant unilaterally requests to terminate this contract for personal reasons after signing this contract, the intermediary service fees paid by the applicant shall be handled as follows:</div>

            <table style="margin-top: 12px;">
                <thead>
                    <tr>
                        <th style="width: 40%">时间节点 Timeline</th>
                        <th>退费标准 Refund Standard</th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <td>
                            <div class="cn">签约后7日内（含7日）</div>
                            <div class="en" style="font-size: 8pt; font-style: italic;">Within 7 days after signing (including day 7)</div>
                        </td>
                        <td>
                            <div class="cn">扣除50%服务费，余款退还，本合同终止。</div>
                            <div class="en" style="font-size: 8pt; font-style: italic;">Deduct 50% service fee, refund balance, contract terminated.</div>
                        </td>
                    </tr>
                    <tr>
                        <td>
                            <div class="cn">签约7日后至文书材料尚未完成之前</div>
                            <div class="en" style="font-size: 8pt; font-style: italic;">After 7 days of signing until before document materials are completed</div>
                        </td>
                        <td>
                            <div class="cn">扣除70%服务费，余款退还，本合同终止。</div>
                            <div class="en" style="font-size: 8pt; font-style: italic;">Deduct 70% service fee, refund balance, contract terminated.</div>
                        </td>
                    </tr>
                    <tr>
                        <td>
                            <div class="cn">文书材料已完成，申请尚未递交</div>
                            <div class="en" style="font-size: 8pt; font-style: italic;">Document materials completed, application not yet submitted</div>
                        </td>
                        <td>
                            <div class="cn">扣除90%服务费，余款退还，本合同终止。</div>
                            <div class="en" style="font-size: 8pt; font-style: italic;">Deduct 90% service fee, refund balance, contract terminated.</div>
                        </td>
                    </tr>
                    <tr>
                        <td>
                            <div class="cn">已完成网申或已将申请材料递交至申请院校</div>
                            <div class="en" style="font-size: 8pt; font-style: italic;">Online application completed or application materials submitted to application institutions</div>
                        </td>
                        <td>
                            <div class="cn">服务费不予退还，本合同终止。</div>
                            <div class="en" style="font-size: 8pt; font-style: italic;">Service fee non-refundable, contract terminated.</div>
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第二十一条</strong> 如发生以下情形之一，则申请人已交付的中介服务费一律不予退还，本合同终止：</div>
            <div class="en"><strong>Article 21</strong> If any of the following circumstances occur, the intermediary service fees paid by the applicant will not be refunded, and this contract shall be terminated:</div>

            <ol>
                <li>
                    <div class="cn">申请人无正当理由拒付或不按时支付本合同约定的任何一笔款项或学校要求的文件材料；</div>
                    <div class="en">The applicant refuses to pay or fails to pay any amount stipulated in this contract or the document materials required by the school without valid reason;</div>
                </li>
                <li>
                    <div class="cn">申请人由于自身的违法行为，导致本合同无法履行；</div>
                    <div class="en">The applicant's illegal conduct leads to the inability to perform this contract;</div>
                </li>
                <li>
                    <div class="cn">申请人未按前往国家或地区使（领）馆签证要求办妥签证申请所需文件及手续，并书面（正本）要求坚持送签而被拒签；</div>
                    <div class="en">The applicant fails to complete the documents and procedures required for visa application as required by the embassy (consulate) of the destination country or region, and insists on submitting the visa in writing (original) and is refused;</div>
                </li>
                <li>
                    <div class="cn">申请人提供虚假材料或隐瞒相关实情；</div>
                    <div class="en">The applicant provides false materials or conceals relevant facts;</div>
                </li>
                <li>
                    <div class="cn">申请人被前往国家或地区使（领）馆查实有非法移民、犯罪前科等不良记录而被拒签；</div>
                    <div class="en">The applicant is refused a visa after being verified by the embassy (consulate) of the destination country or region to have adverse records such as illegal immigration or criminal record;</div>
                </li>
                <li>
                    <div class="cn">申请人前往国家或地区使（领）馆已发出申请人申请的签证（预签）或入境批准文件后，申请人拒绝领取签证或入境批准文件或提出要求转学或不向留学院校缴付学费、杂费等费用的。</div>
                    <div class="en">After the embassy (consulate) of the destination country or region has issued the visa (pre-visa) or entry approval document applied for by the applicant, the applicant refuses to collect the visa or entry approval document or requests a transfer or fails to pay tuition, miscellaneous fees, and other fees to the study abroad institution.</div>
                </li>
            </ol>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第二十二条</strong> 枫叶留学应按上述退费规定，在申请人办妥退费手续后将应退款无息退还申请人，申请人将合同及相关收费凭证退还枫叶留学，本合同终止；如申请人未能提供合同及收费凭证，需签署"遗失声明"，经枫叶留学核实后，办理相关退款手续，本合同终止。</div>
            <div class="en"><strong>Article 22</strong> Maple Education shall refund the refundable amount to the applicant without interest after the applicant completes the refund procedures according to the above refund regulations, the applicant shall return the contract and relevant fee receipts to Maple Education, and this contract shall be terminated; if the applicant fails to provide the contract and fee receipts, a "Loss Declaration" must be signed, and after verification by Maple Education, the relevant refund procedures shall be processed, and this contract shall be terminated.</div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第二十三条</strong> 申请人申请留学院校的报名费和学费、杂费以及在留学申请办理过程中发生的其他费用（除枫叶留学收取的中介服务费）的退费事宜，由申请人自行与申请留学院校和相关收费机构负责处理。</div>
            <div class="en"><strong>Article 23</strong> Refund matters for the application institution's registration fee and tuition, miscellaneous fees, and other costs incurred during the study abroad application process (excluding the intermediary service fees charged by Maple Education) shall be handled by the applicant directly with the application institution and relevant fee-charging institutions.</div>
        </div>

        <div class="page-break"></div>

        <!-- 第六章 -->
        <div class="section-title">第六章 终止条款 | Chapter 6: Termination Clauses</div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第二十四条</strong> 申请人前往国家或地区使（领）馆发出申请人申请的签证或入境批准文件后，即视为枫叶留学已完成为申请人提供自费出国留学中介服务事宜，本合同即告终止。</div>
            <div class="en"><strong>Article 24</strong> After the embassy (consulate) of the destination country or region issues the visa or entry approval document applied for by the applicant, it shall be deemed that Maple Education has completed the provision of self-funded study abroad intermediary services for the applicant, and this contract shall be terminated.</div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第二十五条</strong> 在本合同的履行过程中，经枫叶留学挂号信或特快专递催告后，在三十天之内，申请人仍无继续履行本合同或终止本合同的书面意思表示，本合同终止，枫叶留学所收取的服务费均不予退还。</div>
            <div class="en"><strong>Article 25</strong> During the performance of this contract, after being urged by Maple Education via registered mail or express delivery, if the applicant still has no written intention to continue performing this contract or terminate this contract within thirty days, this contract shall be terminated, and all service fees collected by Maple Education shall not be refunded.</div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第二十六条</strong> 出现本合同其他条款规定的合同终止条件，本合同即告终止。</div>
            <div class="en"><strong>Article 26</strong> When the contract termination conditions stipulated in other terms of this contract occur, this contract shall be terminated.</div>
        </div>

        <!-- 第七章 -->
        <div class="section-title">第七章 通知送达 | Chapter 7: Notice Delivery</div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第二十七条</strong> 申请人与枫叶留学发出的通知应以书面或电子数据形式进行，除面交本人外，以本合同以下所述的通讯地址并以对方为收件人一经发出后5日期满，均视为已经送达；或者向对方下列号码发送短信、微信或电子邮箱发送邮件，任一方式发送成功即视为送达。</div>
            <div class="en"><strong>Article 27</strong> Notices issued by the applicant and Maple Education shall be in written or electronic data form. Except for hand delivery to the person, notices sent to the communication address described below in this contract with the other party as the recipient shall be deemed delivered after 5 days from issuance; or sending SMS, WeChat, or email to the other party's numbers below, successful delivery by any method shall be deemed delivered.</div>

            <table style="margin-top: 12px;">
                <tr>
                    <td style="width: 35%"><strong>申请人联系方式<br>Applicant Contact:</strong></td>
                    <td>
                        收件人 Recipient: __________<br>
                        邮寄地址 Mailing Address: __________<br>
                        手机号码 Phone Number: __________<br>
                        微信号码 WeChat ID: __________<br>
                        电子邮箱 Email: __________
                    </td>
                </tr>
                <tr>
                    <td><strong>枫叶留学联系方式<br>Maple Education Contact:</strong></td>
                    <td>
                        收件人 Recipient: Maple Education Service Team<br>
                        通讯地址 Address: 111 North Bridge Road, #25-01, Peninsula Plaza, Singapore 179098<br>
                        手机号码 Phone: +65 86863695<br>
                        微信号码 WeChat: +86 13506938797<br>
                        电子邮箱 Email: Maple@maplesgedu.com
                    </td>
                </tr>
            </table>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第二十八条</strong> 任何一方若指定其他邮寄地址、手机号码、微信号或电子邮箱，必须及时以书面形式通知另一方，如未通知对方，另一方以本合同确认的联系信息送达视为有效送达。</div>
            <div class="en"><strong>Article 28</strong> If either party designates other mailing addresses, mobile phone numbers, WeChat IDs, or email addresses, they must promptly notify the other party in writing. If the other party is not notified, delivery to the contact information confirmed in this contract shall be deemed valid delivery.</div>
        </div>

        <!-- 第八章 -->
        <div class="section-title">第八章 适用的法律及争议解决方法 | Chapter 8: Applicable Law and Dispute Resolution</div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第二十九条</strong> 本合同的效力、履行、解释及争议解决均适用新加坡共和国法律。</div>
            <div class="en"><strong>Article 29</strong> The validity, performance, interpretation, and dispute resolution of this contract shall all be governed by the laws of the Republic of Singapore.</div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第三十条</strong> 申请人、枫叶留学在履行本合同中如发生争议，应由双方协商解决。如协商不成，双方可向枫叶留学注册地有管辖权的新加坡法院提起诉讼，或提交新加坡国际仲裁中心(SIAC)进行仲裁。</div>
            <div class="en"><strong>Article 30</strong> If disputes arise between the applicant and Maple Education during the performance of this contract, they shall be resolved through consultation between both parties. If consultation fails, both parties may file a lawsuit with a Singapore court having jurisdiction over Maple Education's place of registration, or submit to arbitration at the Singapore International Arbitration Centre (SIAC).</div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第三十一条</strong> 诉讼或仲裁费用由败诉方承担。胜诉方为维权支出的合理费用（如律师费、差旅费等），由败诉方承担，具体金额以法院或仲裁庭判决为准。</div>
            <div class="en"><strong>Article 31</strong> Litigation or arbitration costs shall be borne by the losing party. Reasonable expenses incurred by the prevailing party for rights protection (such as attorney fees, travel expenses, etc.) shall be borne by the losing party, with specific amounts subject to court or arbitration tribunal judgment.</div>
        </div>

        <!-- 第九章 -->
        <div class="section-title">第九章 本合同的补充、变更、修改 | Chapter 9: Supplement, Change, and Modification of this Contract</div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第三十二条</strong> 对本合同的任何补充、变更、修改应采用书面补充合同形式。补充合同在双方签署后与本合同具有同等法律效力。</div>
            <div class="en"><strong>Article 32</strong> Any supplement, change, or modification to this contract shall be in the form of a written supplementary contract. The supplementary contract shall have equal legal effect with this contract after being signed by both parties.</div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第三十三条</strong> 除本合同上明确规定可以填写的内容之外，任何在本合同上的手写内容或修改均对双方没有约束力。</div>
            <div class="en"><strong>Article 33</strong> Except for content explicitly specified in this contract that can be filled in, any handwritten content or modifications on this contract shall not be binding on both parties.</div>
        </div>

        <!-- 第十章 -->
        <div class="section-title">第十章 特别条款 | Chapter 10: Special Clauses</div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第三十四条</strong> 申请人、枫叶留学作如下特别约定：申请人对《特别告知》的内容已仔细阅读，并同意将《特别告知》的全部内容作为本合同的条款，与枫叶留学共同遵守履行。</div>
            <div class="en"><strong>Article 34</strong> The applicant and Maple Education make the following special agreement: The applicant has carefully read the content of the "Important Notice" and agrees to treat all content of the "Important Notice" as terms of this contract, to be jointly observed and performed with Maple Education.</div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第三十五条</strong> 本合同是申请人、枫叶留学双方真实意思的表示，双方已仔细阅读并完全知晓其内容。</div>
            <div class="en"><strong>Article 35</strong> This contract represents the true intentions of both the applicant and Maple Education, and both parties have carefully read and fully understand its content.</div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第三十六条</strong> 枫叶留学的服务承诺以本合同及附件约定为准，任何工作人员的口头承诺若与本合同约定不一致，均视为无效。</div>
            <div class="en"><strong>Article 36</strong> Maple Education's service commitments are subject to this contract and appendices. Any verbal promises by staff members that are inconsistent with this contract shall be deemed invalid.</div>
        </div>

        <!-- 第十一章 -->
        <div class="section-title">第十一章 生效条款 | Chapter 11: Effective Clauses</div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第三十七条</strong> 本合同自枫叶留学盖章（合同专用章）及申请人（如申请人未满18周岁由申请人法定监护人）签字并支付服务费之日起生效。本合同有效期限为贰年。</div>
            <div class="en"><strong>Article 37</strong> This contract shall become effective from the date when Maple Education affixes its seal (contract special seal) and the applicant (or the applicant's legal guardian if the applicant is under 18 years old) signs and pays the service fee. The validity period of this contract is two years.</div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第三十八条</strong> 若申请人在贰年之后仍然要求继续履行合同，则申请人在取得枫叶留学许可后，与枫叶留学另行签订补充协议。</div>
            <div class="en"><strong>Article 38</strong> If the applicant still requires continued performance of the contract after two years, the applicant shall sign a supplementary agreement with Maple Education separately after obtaining Maple Education's permission.</div>
        </div>

        <div style="margin: 15px 0;">
            <div class="cn"><strong>第三十九条</strong> 本合同正本一式两份，申请人、枫叶留学双方各执一份，各份具有同等效力。</div>
            <div class="en"><strong>Article 39</strong> This contract is made in duplicate originals, with the applicant and Maple Education each holding one copy, each having equal effect.</div>
        </div>

        <!-- PDPA Statement -->
        <div style="margin: 25px 0; padding: 15px; background: #f0f8ff; border: 2px solid #2c5aa0; border-radius: 4px;">
            <div style="font-size: 11pt; font-weight: 700; color: #2c5aa0; margin-bottom: 10px;">数据保护声明 Personal Data Protection Statement</div>
            <div class="cn" style="margin-bottom: 8px;">根据新加坡《个人数据保护法》(Personal Data Protection Act, PDPA)，Maple Education Pte. Ltd. 承诺妥善保护申请人的个人信息，仅用于本合同约定的留学服务目的，不会向第三方泄露或出售申请人的个人信息（法律要求除外）。申请人有权查询、更正或删除其个人信息。如有数据保护相关问题，请联系：Maple@maplesgedu.com</div>
            <div class="en">In accordance with Singapore's Personal Data Protection Act (PDPA), Maple Education Pte. Ltd. commits to properly protecting the applicant's personal information, using it only for the study abroad service purposes stipulated in this contract, and will not disclose or sell the applicant's personal information to third parties (except as required by law). The applicant has the right to inquire about, correct, or delete their personal information. For data protection related inquiries, please contact: Maple@maplesgedu.com</div>
        </div>

        <!-- Signature Section -->
        <div class="signature-section" style="margin-top: 40px;">
            <div class="signature-block">
                <div class="cn" style="font-weight: 600;">委托人（申请人）签名：</div>
                <div class="en" style="font-size: 8.5pt; font-style: italic;">Applicant Signature:</div>
                <div class="signature-line"></div>

                <div class="cn" style="margin-top: 20px;">未满18周岁法定代理人/监护人签名：</div>
                <div class="en" style="font-size: 8.5pt; font-style: italic;">Legal Guardian Signature (if under 18):</div>
                <div class="signature-line"></div>

                <div class="cn" style="margin-top: 20px; font-weight: 600;">签署日期 Date：</div>
                <div>____ 年 __ 月 __ 日 / ___/___/______</div>
            </div>

            <div class="signature-block">
                <div class="cn" style="font-weight: 600;">受托人（盖章）：</div>
                <div class="en" style="font-size: 8.5pt; font-style: italic;">Service Provider (Seal):</div>
                <div class="signature-line">
                    <div style="text-align: center; padding-top: 8px; font-weight: 600; color: #2c5aa0; font-size: 10pt;">
                        Maple Education Pte. Ltd.<br>
                        [公司印章 Company Seal]<br>
                        UEN: 202349302E
                    </div>
                </div>

                <div class="cn" style="margin-top: 20px;">授权代表签字：</div>
                <div class="en" style="font-size: 8.5pt; font-style: italic;">Authorized Representative:</div>
                <div class="signature-line"></div>

                <div class="cn" style="margin-top: 20px; font-weight: 600;">签署日期 Date：</div>
                <div>____ 年 __ 月 __ 日 / ___/___/______</div>
            </div>
        </div>

        <div style="margin-top: 40px; text-align: center; font-size: 9pt; color: #666; padding-top: 20px; border-top: 1px solid #ccc;">
            <div class="cn">--- 合同正文完 ---</div>
            <div class="en" style="margin-top: 4px;">--- End of Contract ---</div>
            <div style="margin-top: 10px; font-size: 8pt;">
                本合同依据新加坡法律及最佳实践标准准备 | This contract has been prepared in accordance with Singapore law and best practices
            </div>
        </div>

    </div>

  <script type="text/plain" id="appendix-k12-public-template-md">
<!-- Service Schedule for Singapore Public Schools & AEIS / S-AEIS pathways -->

# Service Schedule – Singapore Public Schools & AEIS / S‑AEIS  
# 新加坡政府学校 & AEIS / S‑AEIS 申请服务附录

> This Service Schedule forms an integral part of the Maple Study Abroad Service Agreement (the “**Main Agreement**”) signed between the Parties. In case of inconsistency, the Main Agreement shall prevail.  
> 本服务附录为双方签署的《枫叶留学出国留学服务合同》（下称“**主合同**”）的组成部分。如本附录与主合同存在不一致，应以主合同为准。

---

## 1. Parties and Basic Information  
## 一、双方与基本信息

- **Parent / Client (Party A) 家长/客户（甲方）**：`[家长姓名 / Parent Name]`  
- **Child / Student 孩子/学生**：`[孩子姓名 / Child Name]`  
- **Target Grade / Level 目标年级/阶段**：`[申请年级 / Target Grade]`  
- **Service Provider (Party B) 服务提供方（乙方）**：Maple Education Pte. Ltd.  
- **Date of this Schedule 本附录签署日期**：`[YYYY-MM-DD]`  

This Schedule specifies the target pathway, scope of services and service fees for applications to Singapore government schools via AEIS / S‑AEIS and related school‑placement planning.  
本附录用于明确甲方委托乙方就 AEIS / S‑AEIS 及新加坡政府学校路径规划与申请所涉及的目标项目、服务内容及收费标准。  

---

## 2. Target Pathway  
## 二、目标路径

- Target Pathway 目标路径：Singapore Government School via AEIS / S‑AEIS  
  新加坡政府学校路径（AEIS / S‑AEIS）  

- Exam Window / Plan 考试窗口与规划（可勾选）：  
  - ☐ AEIS  
  - ☐ S‑AEIS  
  - ☐ Other / 其他：`[例如：转国际学校 Plan B]`  

- Main Preference 主要偏好（可选）：`[例如：小学/中学；区域；预算；是否需要陪读等]`  

---

## 3. Scope of Services  
## 三、服务内容

Party B shall, on a best‑efforts basis, provide consulting and application support for the above pathway, including but not limited to:  
乙方将在最大努力原则下，为上述路径提供咨询与申请协助服务，包括但不限于：

- (a) Initial assessment of the Child’s age/grade eligibility and basic pathway planning (AEIS / S‑AEIS timeline, grade mapping, Plan B options);  
  (a) 对孩子年龄/年级匹配度进行初步评估与路径规划（AEIS / S‑AEIS 时间线、年级对应、备选方案）；  
- (b) Guidance on required documents and application forms;  
  (b) 指导准备所需材料与表格；  
- (c) Application submission support based on official instructions and follow‑up on status / requests for additional documents;  
  (c) 按官方要求协助递交申请并跟进进度/补件要求；  
- (d) General guidance on student pass / visa procedures based on official requirements (if applicable);  
  (d) 在适用情况下，按官方要求就学生准证/签证流程提供一般性指导；  
- (e) Pre‑departure briefing and basic landing guidance (if applicable).  
  (e) 在适用情况下，提供行前说明与基础落地指导。  

---

## 4. Service Fees and Payment  
## 四、服务费用与付款

4.1 **Service Fee 服务费**

- Service Fee 服务费：`SGD ________`  

4.2 **Third‑Party Fees 第三方费用**

All school fees, examination fees, deposits, accommodation fees, insurance premiums, visa charges, travel expenses and any other third‑party charges are **not** included in the above Service Fee and shall be paid directly by Party A to the relevant institutions/providers according to their official instructions.  
学校学费、考试费、押金、住宿费、保险费、签证费、差旅费及其他第三方费用**均不包含**在上述服务费内，甲方应按官方要求直接向相关机构/第三方支付。  

4.3 **Payment Method and Schedule 付款方式与时间**

- Unless otherwise agreed in writing, the Service Fee is payable as follows (select one):  
  除非双方书面另有约定，服务费的支付方式如下（二选一）：  
  - ☐ 100% upon signing this Service Schedule / 本附录签署时一次性支付 100%；  
  - ☐ Other / 其他：`[自行约定]`。  

---

## 5. No Guarantee of Admission  
## 五、不保证录取

Party A understands and agrees that AEIS / S‑AEIS examinations and school placements involve uncertainty and that admission decisions are made solely by the relevant authorities and schools. Party B cannot and does not guarantee admission, placement, scholarship or visa outcomes.  
甲方理解并同意：AEIS / S‑AEIS 考试及政府学校学位安排具有不确定性，录取/分配由主管部门及学校独立决定。乙方不能也不会保证任何录取、学位分配、奖学金或签证结果。  

Service Fee is charged for consulting and application efforts rather than any guaranteed outcome. Refund rules, if any, shall follow the Main Agreement and any refund schedule agreed by the Parties.  
服务费系就咨询与申请工作本身收取，并非就任何结果作出保证。任何退费安排（如有）应以主合同及双方另行约定的退费说明为准。  

---

## 6. Signatures for this Schedule  
## 六、本附录确认

This Service Schedule is executed together with the Main Agreement and shall take effect upon signature by both Parties.  
本服务附录与主合同一并签署，自双方签字之日起生效。  

**Party A – Parent / Client 甲方 – 家长/客户**  

Name 姓名：_____________________________  
Signature 签名：_____________________________  
Date 日期：_____________________________  

**Party B – Maple Education Pte. Ltd. 乙方 – Maple Education Pte. Ltd.**  

Authorized Signatory 授权签署人：_____________________________  
Name 姓名：Leonard Chow Yi Ding  
Title 职务：Director  
Date 日期：_____________________________
  </script>

  <script type="text/plain" id="appendix-k12-international-template-md">
<!-- Service Schedule for International School applications (K12) -->

# Service Schedule – International School Applications  
# 国际学校申请服务附录

> This Service Schedule forms an integral part of the Maple Study Abroad Service Agreement (the “**Main Agreement**”) signed between the Parties. In case of inconsistency, the Main Agreement shall prevail.  
> 本服务附录为双方签署的《枫叶留学出国留学服务合同》（下称“**主合同**”）的组成部分。如本附录与主合同存在不一致，应以主合同为准。

---

## 1. Parties and Basic Information  
## 一、双方与基本信息

- **Parent / Client (Party A) 家长/客户（甲方）**：`[家长姓名 / Parent Name]`  
- **Child / Student 孩子/学生**：`[孩子姓名 / Child Name]`  
- **Target Grade / Level 目标年级/阶段**：`[申请年级 / Target Grade]`  
- **Service Provider (Party B) 服务提供方（乙方）**：Maple Education Pte. Ltd.  
- **Date of this Schedule 本附录签署日期**：`[YYYY-MM-DD]`  

This Schedule specifies the target schools, scope of services and service fees for international school applications in Singapore (and related planning services).  
本附录用于明确甲方委托乙方办理新加坡国际学校申请时的目标学校、服务内容及收费标准。  

---

## 2. Target Schools and Tier  
## 二、目标学校与梯队

- School Tier 学校梯队（可勾选）：  
  - ☐ Tier 1 / 第一梯队（顶级）  
  - ☐ Tier 2 / 第二梯队  
  - ☐ Tier 3 / 第三梯队  

- Main Target Schools 主要目标学校（可多选，或填“备选名单”）：  
  - `1) ____________________`  
  - `2) ____________________`  
  - `3) ____________________`  
  - Other / 其他：`[学校名称]`  

---

## 3. Scope of Services  
## 三、服务内容

Party B shall, on a best‑efforts basis, provide consulting and application support for the above international school applications, including but not limited to:  
乙方将在最大努力原则下，围绕上述国际学校申请向甲方提供咨询与申请协助服务，包括但不限于：

- (a) Needs analysis (budget, location, curriculum, language environment, timeline, etc.) and school shortlist strategy;  
  (a) 需求分析（预算、区域、课程体系、语言环境、时间线等）与择校策略；  
- (b) Guidance on application documents and forms (including basic review/polishing where reasonable);  
  (b) 申请材料与表格指导（在合理范围内进行形式性审核/润色）；  
- (c) Interview / assessment preparation guidance where applicable;  
  (c) 在适用情况下，提供面试/测评准备指导；  
- (d) Submission support via official channels and follow‑up on requests for additional documents;  
  (d) 通过官方渠道协助递交并跟进补件要求；  
- (e) General guidance on next steps after an offer (acceptance, deposits, enrollment procedures).  
  (e) 获录取后的后续步骤说明（确认学位、押金、入学手续等）。  

---

## 4. Service Fees and Payment  
## 四、服务费用与付款

4.1 **Service Fee 服务费**

- Service Fee 服务费：`SGD ________`  

> Note: The service fee may vary by school tier, child’s grade and case complexity. The final fee shall be as agreed by the Parties and recorded above.  
> 说明：服务费可能随学校梯队、年级及个案复杂度而变化，最终以双方确认并记录的金额为准。  

4.2 **Third‑Party Fees 第三方费用**

All tuition fees, application fees, deposits, assessment fees, accommodation fees, insurance premiums, visa charges, travel expenses and any other third‑party charges are **not** included in the above Service Fee and shall be paid directly by Party A to the relevant schools/providers according to their official instructions.  
学校学费、报名费、押金、测评费、住宿费、保险费、签证费、差旅费及其他第三方费用**均不包含**在上述服务费内，甲方应按官方要求直接向相关学校/第三方支付。  

4.3 **Payment Method and Schedule 付款方式与时间**

- Unless otherwise agreed in writing, the Service Fee is payable as follows (select one):  
  除非双方书面另有约定，服务费的支付方式如下（二选一）：  
  - ☐ 100% upon signing this Service Schedule / 本附录签署时一次性支付 100%；  
  - ☐ Other / 其他：`[自行约定]`。  

---

## 5. No Guarantee of Admission  
## 五、不保证录取

Party A understands and agrees that admission decisions are made solely by each school based on its policies and capacity. Party B cannot and does not guarantee any admission, scholarship or visa outcomes.  
甲方理解并同意：录取结果由各学校依据其政策及学位情况独立决定。乙方不能也不会保证任何录取、奖学金或签证结果。  

Service Fee is charged for consulting and application efforts rather than any guaranteed outcome. Refund rules, if any, shall follow the Main Agreement and any refund schedule agreed by the Parties.  
服务费系就咨询与申请工作本身收取，并非就任何结果作出保证。任何退费安排（如有）应以主合同及双方另行约定的退费说明为准。  

---

## 6. Signatures for this Schedule  
## 六、本附录确认

This Service Schedule is executed together with the Main Agreement and shall take effect upon signature by both Parties.  
本服务附录与主合同一并签署，自双方签字之日起生效。  

**Party A – Parent / Client 甲方 – 家长/客户**  

Name 姓名：_____________________________  
Signature 签名：_____________________________  
Date 日期：_____________________________  

**Party B – Maple Education Pte. Ltd. 乙方 – Maple Education Pte. Ltd.**  

Authorized Signatory 授权签署人：_____________________________  
Name 姓名：Leonard Chow Yi Ding  
Title 职务：Director  
Date 日期：_____________________________
  </script>
</body>
</html>
  </script>

  <script type="text/plain" id="appendix-private-template-md">
<!-- Service Schedule for private universities (Kaplan / PSB / Amity / others) -->

# Service Schedule – Private University Applications  
# 私立大学申请服务附录

> This Service Schedule forms an integral part of the Maple Study Abroad Service Agreement (the “**Main Agreement**”) signed between the Parties. In case of inconsistency, the Main Agreement shall prevail.  
> 本服务附录为双方签署的《枫叶留学出国留学服务合同》（下称“**主合同**”）的组成部分。如本附录与主合同存在不一致，应以主合同为准。

---

## 1. Parties and Basic Information  
## 一、双方与基本信息

- **Student (Party A) 学生（甲方）**：`[姓名 / Name]`  
- **Service Provider (Party B) 服务提供方（乙方）**：Maple Education Pte. Ltd.  
- **Date of this Schedule 本附录签署日期**：`[YYYY-MM-DD]`  

This Schedule specifies the target institutions, scope of services and service fees for private university applications in Singapore and related partner institutions.  
本附录用于明确甲方通过乙方办理新加坡及相关合作私立大学申请时的目标院校、服务内容及收费标准。  

---

## 2. Target Programs and Institutions  
## 二、目标项目与院校

- Target Level 申请层级：  
  - ☐ Diploma / Advanced Diploma 文凭 / 高级文凭  
  - ☐ Bachelor’s Degree 本科  
  - ☐ Other 其他：`[例如：预科 / 研究生文凭等]`  

- Main Target Institutions 主要目标院校（可多选）：  
  - ☐ Kaplan Higher Education Institute / Kaplan 新加坡  
  - ☐ PSB Academy  
  - ☐ Amity Global Institute  
  - ☐ Other private institutions 其他私立院校：`[院校名称 / 课程]`  

> Note: SIM Global Education typically adopts different commission and pricing arrangements. For SIM applications, please refer to the separate SIM Service Schedule template.  
> 说明：SIM Global Education 通常采用不同的返佣及定价结构。涉及 SIM 的申请，请使用单独的《SIM 申请服务附录》模板。  

---

## 3. Scope of Services  
## 三、服务内容

Party B shall provide study abroad consulting and application assistance for the above private university programs, including but not limited to:  
乙方将围绕上述私立大学项目向甲方提供留学咨询与申请协助服务，包括但不限于：

- (a) Initial consultation on academic background, English level and study plans;  
  (a) 对甲方现有学历、英语水平及留学目标进行初步评估与咨询；  
- (b) Recommendations on suitable majors and programs offered by the selected institutions;  
  (b) 结合目标院校课程，为甲方提供适合的专业与项目建议；  
- (c) Guidance on application documents (CV, personal statements, essays, forms, etc.);  
  (c) 就申请材料（简历、个人陈述、文书、表格等）提供结构与内容指导；  
- (d) Reasonable review and polishing of written materials provided by Party A;  
  (d) 在甲方提供初稿的前提下，对书面材料进行合理修改与润色；  
- (e) Creation and submission of online applications through official channels of the institutions;  
  (e) 通过院校官方渠道创建并递交网申；  
- (f) Tracking and updating application status (supplementary documents, interviews, offers, etc.);  
  (f) 跟踪申请进度（补件、面试、录取结果等）并向甲方反馈；  
- (g) General guidance on student pass / visa procedures based on official requirements;  
  (g) 根据官方要求就学生准证 / 签证流程提供一般性指导；  
- (h) Pre‑departure briefing on enrollment procedures and basic living arrangements;  
  (h) 为甲方提供基础的报到流程与生活信息说明。  

The Parties acknowledge that Party B’s role is to provide professional consulting and application support on a best‑efforts basis and that admission decisions are made solely by the institutions.  
双方确认：乙方的职责是以最大努力提供专业咨询与申请协助服务，录取决定由院校独立作出。  

---

## 4. Service Fees and Payment  
## 四、服务费用与付款

4.1 **Application & Documentation Service Fee 文书 / 申请服务费**

- Service Fee 服务费：`SGD ________`  
- This fee covers consulting, document guidance, application preparation and related services described in Clause 3 above.  
  本费用用于支付本附录第三条所述的咨询、文书指导、申请准备及相关服务。  

4.2 **Tuition and Third‑Party Fees 学费及第三方费用**

- Tuition, school application fees, deposits, accommodation fees, insurance premiums, air tickets, visa fees, bank charges and any other third‑party charges are **not** included in the above Service Fee.  
  院校学费、报名费、押金、住宿费、保险费、机票、签证费、银行手续费及其他第三方费用**均不包含**在上述服务费内。  
- Party A shall pay all such amounts **directly** to the relevant institution or third‑party provider in accordance with their official instructions. Party B does not collect or hold such funds on behalf of institutions.  
  甲方应按照院校或第三方的官方要求，**直接**向相关院校或第三方支付上述费用。乙方不代收、不代管任何学费或第三方费用。  

4.3 **Payment Method and Schedule 付款方式与时间**

- Unless otherwise agreed in writing, the Service Fee is payable as follows:  
  除非双方书面另有约定，服务费的支付方式如下：  
  - ☐ 100% upon signing this Service Schedule / 本附录签署时一次性支付 100%；  
  - ☐ Other / 其他：`[例如：签约 50%，获录取或递交后 50%]`。  

The specific option selected above shall be deemed part of the Main Agreement’s fee and payment clause.  
以上所选付款安排视为主合同中服务费及付款条款的补充约定。  

---

## 5. No Guarantee of Admission  
## 五、不保证录取

Party A understands and agrees that:  
甲方理解并同意：

- Admission decisions, scholarship grants and visa approvals are made solely by the relevant institutions and authorities;  
  院校录取结果、奖学金授予及签证批准由相关院校及主管部门独立决定；  
- Service Fee is charged for consulting and application efforts rather than for any guaranteed outcome;  
  服务费系就咨询与申请工作本身收取，并非就任何结果作出保证；  
- Any marketing expressions such as “high success rate” or “backup schools” are to be understood as describing the service strategy (e.g. applying to multiple schools), not as a legal guarantee of admission.  
  市场宣传中如有“成功率较高”或“多校保底”等表述，仅反映服务策略（例如：同时申请多所院校），不构成对录取结果的法律保证。  

In case of conflict, the risk disclosure and limitation of liability clauses in the Main Agreement shall apply.  
如有冲突，以主合同中关于风险提示与责任限制的条款为准。  

---

## 6. Signatures for this Schedule  
## 六、本附录确认

This Service Schedule is executed together with the Main Agreement and shall take effect upon signature by both Parties.  
本服务附录与主合同一并签署，自双方签字之日起生效。  

**Party A – Student 甲方 – 学生**  

Name 姓名：_____________________________  
Signature 签名：_____________________________  
Date 日期：_____________________________  

**Party B – Maple Education Pte. Ltd. 乙方 – Maple Education Pte. Ltd.**  

Authorized Signatory 授权签署人：_____________________________  
Name 姓名：Leonard Chow Yi Ding  
Title 职务：Director  
Date 日期：_____________________________
  </script>

  <script type="text/plain" id="appendix-sim-template-md">
<!-- Service Schedule for SIM Global Education applications -->

# Service Schedule – SIM Global Education Applications  
# SIM 申请服务附录

> This Service Schedule forms an integral part of the Maple Study Abroad Service Agreement (the “**Main Agreement**”) signed between the Parties. In case of inconsistency, the Main Agreement shall prevail.  
> 本服务附录为双方签署的《枫叶留学出国留学服务合同》（下称“**主合同**”）的组成部分。如本附录与主合同存在不一致，应以主合同为准。

---

## 1. Parties and Basic Information  
## 一、双方与基本信息

- **Student (Party A) 学生（甲方）**：`[姓名 / Name]`  
- **Service Provider (Party B) 服务提供方（乙方）**：Maple Education Pte. Ltd.  
- **Date of this Schedule 本附录签署日期**：`[YYYY-MM-DD]`  

This Schedule specifies the target programs, scope of services and service fees for applications to SIM Global Education and its partner programs.  
本附录用于明确甲方通过乙方办理 SIM Global Education 及其合作项目申请时的目标课程、服务内容及收费标准。  

---

## 2. Target Programs  
## 二、目标项目

- Institution 院校：SIM Global Education  
- Program(s) 申请项目：`[例如：本科 / 大专 / 研究生文凭及具体专业名称]`  

Party A confirms that it understands the basic entry requirements, tuition range and study plan for the above program(s).  
甲方确认其已了解上述项目的基本录取条件、学费区间及学业规划。  

---

## 3. Scope of Services  
## 三、服务内容

Party B shall provide consulting and application assistance for the above SIM program(s), including but not limited to:  
乙方将围绕上述 SIM 项目向甲方提供咨询与申请协助服务，包括但不限于：

- (a) Evaluation of academic background and eligibility for SIM program(s);  
  (a) 评估甲方学术背景与 SIM 项目匹配度；  
- (b) Advice on program selection and study plan;  
  (b) 提供项目选择及学习规划建议；  
- (c) Guidance on application documents and personal statements;  
  (c) 针对申请材料及个人陈述提供指导；  
- (d) Review and polishing of documents provided by Party A;  
  (d) 在甲方提供初稿基础上，对材料进行合理修改与润色；  
- (e) Creation and submission of online applications to SIM;  
  (e) 通过 SIM 官方渠道创建并递交申请；  
- (f) Follow‑up on application status and communication of key updates;  
  (f) 跟进申请进度并向甲方通报重要更新；  
- (g) General guidance on visa / student pass procedures based on official requirements.  
  (g) 按官方要求就签证 / 学生准证流程提供一般性指导。  

---

## 4. Service Fees and Payment  
## 四、服务费用与付款

4.1 **Application & Documentation Service Fee 文书 / 申请服务费**

- Service Fee 服务费：`SGD ________`  
- This fee is specific to SIM applications and may differ from other private university projects due to SIM’s separate commission policy.  
  本费用专用于 SIM 申请项目，鉴于 SIM 佣金政策不同，金额可能与其他私立大学项目有所差异。  

4.2 **Tuition and Third‑Party Fees 学费及第三方费用**

- Tuition and all other third‑party fees (including but not limited to school application fees, deposits, accommodation, insurance, air tickets, visa fees and bank charges) are **not** included in the above Service Fee.  
  院校学费及其他第三方费用（包括但不限于报名费、押金、住宿费、保险费、机票、签证费及银行手续费）**均不包含**在上述服务费中。  
- Party A shall pay all such amounts directly to SIM or other third‑party providers according to their official instructions. Party B does not collect or hold such funds on behalf of SIM.  
  甲方应按照 SIM 或相关第三方的官方要求，直接向其支付上述费用。乙方不代表 SIM 代收或代管任何此类款项。  

4.3 **Payment Method and Schedule 付款方式与时间**

- Unless otherwise agreed in writing, the Service Fee is payable as follows (select one):  
  除非双方书面另有约定，服务费的支付方式如下（二选一）：  
  - ☐ 100% upon signing this Service Schedule / 本附录签署时一次性支付 100%；  
  - ☐ Other / 其他：`[自行约定]`。  

---

## 5. No Guarantee of Admission  
## 五、不保证录取

Party A understands that SIM and its partner universities independently decide on admission and that Party B cannot guarantee admission or scholarship outcomes.  
甲方理解：SIM 及其合作大学独立决定录取结果，乙方不能保证录取或奖学金。  

Service Fee is charged for consulting and application work and shall not be refunded solely because the final outcome does not meet Party A’s expectations, except as provided in the Main Agreement and any refund schedule agreed by the Parties.  
服务费系就咨询与申请工作本身收取，除非主合同及双方约定的退费说明另有规定，否则不得仅以结果不符合预期为由要求退费。  

---

## 6. Signatures for this Schedule  
## 六、本附录确认

This Service Schedule is executed together with the Main Agreement and shall take effect upon signature by both Parties.  
本服务附录与主合同一并签署，自双方签字之日起生效。  

**Party A – Student 甲方 – 学生**  

Name 姓名：_____________________________  
Signature 签名：_____________________________  
Date 日期：_____________________________  

**Party B – Maple Education Pte. Ltd. 乙方 – Maple Education Pte. Ltd.**  

Authorized Signatory 授权签署人：_____________________________  
Name 姓名：Leonard Chow Yi Ding  
Title 职务：Director  
Date 日期：_____________________________
  </script>

  <script type="text/plain" id="appendix-highend-template-md">
<!-- Service Schedule for NUS / NTU and other high-end university applications -->

# Service Schedule – NUS / NTU & High‑End University Applications  
# NUS / NTU 等高端大学申请服务附录

> This Service Schedule forms an integral part of the Maple Study Abroad Service Agreement (the “**Main Agreement**”) signed between the Parties. In case of inconsistency, the Main Agreement shall prevail.  
> 本服务附录为双方签署的《枫叶留学出国留学服务合同》（下称“**主合同**”）的组成部分。如本附录与主合同存在不一致，应以主合同为准。

---

## 1. Parties and Basic Information  
## 一、双方与基本信息

- **Student (Party A) 学生（甲方）**：`[姓名 / Name]`  
- **Service Provider (Party B) 服务提供方（乙方）**：Maple Education Pte. Ltd.  
- **Date of this Schedule 本附录签署日期**：`[YYYY-MM-DD]`  

This Schedule specifies the target universities / programs, scope of services and service fees for high‑end applications such as NUS, NTU and similar competitive institutions.  
本附录用于明确甲方通过乙方办理 NUS、NTU 等高端大学项目申请时的目标院校/项目、服务内容及收费标准。  

---

## 2. Target Universities and Programs  
## 二、目标院校与项目

- Target Universities 目标院校：  
  - ☐ National University of Singapore (NUS)  
  - ☐ Nanyang Technological University (NTU)  
  - ☐ Other universities / programs 其他大学/项目：`[院校名称 / 专业]`  

- Level and Type 申请层级及类型：  
  - ☐ Undergraduate 本科  
  - ☐ Master’s / Postgraduate 硕士 / 研究生  
  - ☐ Other 其他：`[例如：Graduate Diploma 等]`  

---

## 3. Scope of Services  
## 三、服务内容

Party B shall, on a best‑efforts basis, provide consulting and application services tailored to competitive university applications, including but not limited to:  
乙方将在最大努力原则下，为竞争激烈的高端大学申请提供定制化咨询与申请服务，包括但不限于：

- (a) Eligibility assessment based on academic results, standardised tests and background;  
  (a) 根据甲方的成绩、标化考试及背景情况评估其申请资格；  
- (b) Strategy design (university and program selection, application timeline, backup options);  
  (b) 制定申请策略（院校与专业选择、时间规划及备选方案）；  
- (c) Guidance on all required documents and forms;  
  (c) 指导甲方准备各类申请材料与表格；  
- (d) In‑depth personal statement / essay planning and multiple‑round polishing;  
  (d) 对文书/个人陈述进行深度规划及多轮润色；  
- (e) Coordination of reference letters and additional materials (portfolios, writing samples, etc.) where applicable;  
  (e) 在适用情况下，协调推荐信及作品集、写作样本等补充材料；  
- (f) Creation and submission of online applications, plus follow‑up on status and requests for further information;  
  (f) 创建并递交网申，跟进申请状态及院校补件要求；  
- (g) General guidance on visa / student pass after offer, as described in the Main Agreement.  
  (g) 在获得录取后，根据主合同约定提供签证/学生准证的一般性指导。  

---

## 4. Service Fees and Payment  
## 四、服务费用与付款

4.1 **Application Service Fee 申请服务费（留空由个案确定）**

- Application Service Fee 申请服务费：`SGD ________`  

4.2 **Background Enhancement Service Fee 背景提升服务费（如适用，留空）**

- Background Enhancement Package Fee 背景提升服务项目费：`SGD ________`  
- This may cover, for example, research projects, internships, competitions, additional courses or other curated experiences arranged or coordinated by Party B and its partners.  
  可包括但不限于：由乙方及其合作方安排或协调的科研项目、实习、竞赛、补充课程或其他定制化背景提升项目。  

4.3 **Tuition and Third‑Party Fees 学费及第三方费用**

All tuition fees, school application fees, deposits, accommodation fees, insurance premiums, examination fees (such as IELTS/TOEFL/GRE/GMAT), visa charges, travel expenses and other third‑party charges are **not** included in the above service fees and shall be paid directly by Party A to the relevant institutions or providers.  
院校学费、报名费、押金、住宿费、保险费、各类考试费用（如雅思/托福/GRE/GMAT）、签证费用、差旅费用及其他第三方费用**均不包含**在上述服务费内，应由甲方直接向相关院校或第三方支付。  

4.4 **Payment Schedule 付款时间**

The Parties shall agree on a suitable payment schedule (e.g. by milestones such as contract signing, strategy completion, application submission, offer). The agreed schedule shall be recorded here:  
双方可按项目阶段（如签约、完成策略制定、正式递交申请、获得录取等）约定合适的付款节点，并记录如下：  

- Payment Schedule 付款安排：`[例如：签约 40%，完成材料 30%，全部递交 30%]`  

---

## 5. No Guarantee of Admission  
## 五、不保证录取

5.1 Party A understands that applications to NUS, NTU and similar universities are highly competitive and that even strong applicants may not be admitted. Party B cannot and does not guarantee any admission, scholarship or immigration outcome.  
甲方理解：NUS、NTU 等高端大学的录取竞争极为激烈，即便条件优秀的申请人亦可能未被录取。乙方不能也不会保证任何录取、奖学金或移民结果。  

5.2 Service Fees are charged for professional consulting and application work, not for any guaranteed results. Refund rules, if any, shall follow the Main Agreement and any supplementary refund schedule agreed by the Parties.  
服务费系就专业咨询与申请工作收取，而非对结果收费。任何退费安排（如有）应以主合同及双方另行约定的退费说明为准。  

---

## 6. Signatures for this Schedule  
## 六、本附录确认

This Service Schedule is executed together with the Main Agreement and shall take effect upon signature by both Parties.  
本服务附录与主合同一并签署，自双方签字之日起生效。  

**Party A – Student 甲方 – 学生**  

Name 姓名：_____________________________  
Signature 签名：_____________________________  
Date 日期：_____________________________  

**Party B – Maple Education Pte. Ltd. 乙方 – Maple Education Pte. Ltd.**  

Authorized Signatory 授权签署人：_____________________________  
Name 姓名：Leonard Chow Yi Ding  
Title 职务：Director  
Date 日期：_____________________________
  </script>

  <script type="text/plain" id="agreement-kindergarten-template-md">
<!-- Standalone but short agreement for kindergarten placement services -->

# Kindergarten Placement Service Agreement  
# 幼儿园择校服务协议

**Party A (Client) 甲方（客户）**：`[家长姓名 / Parent Name]`  
**Child’s Name 孩子姓名**：`[Child’s Name]`  
**Party B (Service Provider) 乙方（服务提供方）**：Maple Education Pte. Ltd.  

Date 日期：`[YYYY-MM-DD]`  

---

## 1. Purpose and Scope  
## 一、目的与服务范围

1.1 Party A entrusts Party B to provide consulting and placement services in relation to selecting and applying for suitable private kindergarten(s) in Singapore for the Child.  
甲方委托乙方就为其子女在新加坡选择并申请合适的本地私立幼儿园提供咨询与择校服务。  

1.2 This Agreement covers **kindergarten placement services only** and does not extend to primary or secondary school applications, student pass, long‑term immigration planning or comprehensive relocation concierge services, unless otherwise agreed in writing.  
本协议仅涵盖**幼儿园择校服务**，不包括小学/中学申请、学生证办理、长期移民规划或全面管家服务，除非双方书面另有约定。  

---

## 2. Service Content  
## 二、服务内容

Party B shall provide the following services to Party A:  
乙方将向甲方提供以下服务：

2.1 Understand basic needs and constraints of Party A’s family (budget, preferred location, language environment, curriculum type, schedule, etc.).  
了解甲方家庭的基本需求与限制（预算、位置偏好、语言环境、课程类型、作息安排等）。  

2.2 Shortlist suitable private kindergarten options (generally 3–5 schools) that match the above needs.  
根据上述需求筛选出适合的本地私立幼儿园备选名单（原则上 3–5 所）。  

2.3 Provide basic information about shortlisted schools (approximate fees, general admission requirements and application timelines) based on publicly available information or information provided by the schools.  
基于公开信息或幼儿园提供的信息，为甲方提供备选学校的基本情况（大致费用、一般入学要求及申请时间安排）。  

2.4 Assist Party A in making appointments for school visits or online information sessions where reasonably practicable.  
在合理可行的情况下，协助甲方预约校园参观或线上说明会。  

2.5 Assist Party A in preparing and submitting kindergarten applications (including filling in forms and basic document checking) in accordance with the schools’ instructions.  
协助甲方按照幼儿园要求准备并递交入学申请（包括填写表格及对基本材料进行形式性核对）。  

2.6 Provide general guidance on next steps after an offer is received (e.g. confirming place, paying deposits, first‑day procedures).  
在获得录取后，就后续步骤（确认学位、缴纳押金、开学第一天流程等）提供一般性说明。  

> Party B does not provide specialised psychological or educational assessments and does not guarantee that any particular kindergarten will admit the Child.  
> 乙方不提供专业心理或教育评估，亦不保证任何特定幼儿园必然录取甲方子女。  

---

## 3. Service Fee and Payment  
## 三、服务费及付款

3.1 **Kindergarten Placement Service Fee 幼儿园择校服务费**

- Service Fee 服务费总额：**SGD 2,000 (two thousand Singapore dollars)**  
  服务费总额为 **新币 2,000 元整**。  

3.2 **What the Fee Covers 费用涵盖范围**

The above Service Fee covers only the consulting and placement services described in Clause 2. It **does not** include any of the following:  
上述服务费仅涵盖第二条所述的咨询与择校服务，**不包括**下列任何费用：

- Kindergarten tuition fees, registration/application fees or deposits;  
  幼儿园学费、注册/报名费或学位押金；  
- Uniform, school bus, meal plans or other school‑related charges;  
  校服、校车、餐费或其他与学校相关的费用；  
- Visa, travel, accommodation or insurance costs;  
  签证、差旅、住宿或保险费用；  
- Any other third‑party fees not expressly listed as Party B’s service fees.  
  任何未被明确列为乙方服务费的第三方费用。  

All such amounts shall be paid **directly** by Party A to the relevant school or third‑party provider according to their official instructions. Party B does not collect or hold such funds on behalf of any kindergarten.  
上述各项应由甲方按照相关幼儿园或第三方的官方要求，**直接**向其支付。乙方不代任何幼儿园收取或保管学费及其他第三方费用。  

3.3 **Payment Schedule 付款时间**

- Unless otherwise agreed in writing, Party A shall pay the full Service Fee to Party B **upon signing this Agreement**.  
  除非双方书面另有约定，甲方应于本协议签署时向乙方支付全额服务费。  

---

## 4. No Guarantee of Admission  
## 四、不保证录取

4.1 Party A understands that admission decisions are made solely by each kindergarten based on its own policies and capacity. Party B cannot and does not guarantee that any specific kindergarten will grant an offer or permit enrollment.  
甲方理解：是否录取完全由各幼儿园依据其自身政策及学位情况独立决定。乙方不能也不会保证任何特定幼儿园必然录取或允许入读。  

4.2 Service Fee is charged for consulting and service efforts rather than any guaranteed outcome. Non‑admission by a particular kindergarten shall not, by itself, constitute a reason for refund.  
服务费系就乙方提供的咨询与服务过程收取，并非就任何特定结果作出保证。某一幼儿园未录取本身不构成退费理由。  

---

## 5. Term and Termination  
## 五、期限与终止

5.1 This Agreement takes effect upon signature by both Parties and remains in force until the earlier of: (i) completion of services described in Clause 2; or (ii) 12 months from the date of this Agreement.  
本协议自双方签字之日起生效，并持续有效至以下较早发生之日：(i) 第二条所述服务全部完成；或 (ii) 本协议签署之日起 12 个月届满。  

5.2 If Party A unilaterally terminates this Agreement for personal reasons after Party B has commenced substantive services, the Service Fee already paid shall, in principle, be non‑refundable.  
如甲方在乙方已经开始实质性服务后因个人原因单方解除本协议，原则上已支付的服务费不予退还。  

---

## 6. Miscellaneous  
## 六、其他

6.1 This Agreement is governed by the laws of Singapore.  
本协议受新加坡法律管辖并依其进行解释。  

6.2 Any matters not covered herein may be further agreed in writing by both Parties. In case of conflict between different language versions, the English version shall prevail to the extent of inconsistency.  
本协议未尽事宜，双方可另行以书面方式补充约定。如中英文版本存在不一致，应在不一致范围内以英文版本为准。  

---

## 7. Signatures  
## 七、签署

**Party A – Client 甲方 – 客户**  

Name 姓名：_____________________________  
Signature 签名：_____________________________  
Date 日期：_____________________________  

**Party B – Maple Education Pte. Ltd. 乙方 – Maple Education Pte. Ltd.**  

Authorized Signatory 授权签署人：_____________________________  
Name 姓名：Leonard Chow Yi Ding  
Title 职务：Director  
Date 日期：_____________________________
  </script>

</body>
</html>
```
