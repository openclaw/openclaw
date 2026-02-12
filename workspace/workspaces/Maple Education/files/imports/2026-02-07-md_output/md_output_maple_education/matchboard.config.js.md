---
title: "matchboard.config.js"
source_path: "matchboard.config.js"
tags: ["合同", "Maple", "js"]
ocr: false
---

# matchboard.config.js

简介：内容概述：// Optional runtime config for `School_Matchboard.html`.

## 内容

```text
// Optional runtime config for `School_Matchboard.html`.
// This file is served to all LAN users via Nginx — do NOT put any passwords or private tokens here.
//
// Usage:
// 1) In NocoDB, create a table (e.g. `Courses`) and create a Shared View.
// 2) Paste the Shared View link/ID into `sharedView` below.
// 3) In Matchboard, switch dataset to "NocoDB 数据库（共享视图）".
//
// If you leave `baseUrl` empty, Matchboard will auto-detect as: `${location.protocol}//${location.hostname}:8090`.

window.MAPLE_MATCHBOARD_CONFIG = window.MAPLE_MATCHBOARD_CONFIG || {};
window.MAPLE_MATCHBOARD_CONFIG.nocodb = {
  baseUrl: "",
  sharedView: "",
};

// Optional (NAS MVP): API base URL for archiving generated contracts/quotes/invoices.
// Leave empty to use same-origin (recommended when you proxy `/api/*` via Nginx).
window.MAPLE_MATCHBOARD_CONFIG.api = {
  baseUrl: "",
};
```
