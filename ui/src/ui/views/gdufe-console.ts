import { LitElement, html } from "lit";
import { state } from "lit/decorators.js";

const GDUFE_API_BASE_STORAGE_KEY = "openclaw.gdufe.apiBaseUrl.v1";
const DEFAULT_GDUFE_API_BASE_URL = "http://127.0.0.1:5001";

type JwxtStatusResponse = {
  loggedIn?: boolean;
  studentName?: string;
  username?: string;
};

type JwxtCaptchaResponse = {
  success?: boolean;
  captcha?: string;
  error?: string;
};

type JwxtLoginResponse = {
  success?: boolean;
  studentName?: string;
  error?: string;
};

type GradeRecord = {
  semester?: string;
  courseCode?: string;
  courseName?: string;
  score?: string;
  credit?: string;
};

type JwxtDataResponse = {
  success?: boolean;
  error?: string;
  data?: unknown;
};

function normalizeSearchText(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function resolveScoreToneClass(score: number | null): string {
  if (score == null) {
    return "score-na";
  }
  if (score >= 90) {
    return "score-a";
  }
  if (score >= 80) {
    return "score-b";
  }
  if (score >= 60) {
    return "score-c";
  }
  return "score-d";
}

function normalizeApiBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return DEFAULT_GDUFE_API_BASE_URL;
  }
  return trimmed.replace(/\/$/, "");
}

function deriveDefaultApiBaseUrl(): string {
  if (typeof window === "undefined") {
    return DEFAULT_GDUFE_API_BASE_URL;
  }
  const protocol = window.location.protocol === "https:" ? "https:" : "http:";
  const host = window.location.hostname || "127.0.0.1";
  return `${protocol}//${host}:5001`;
}

function buildFetchFailureMessage(baseUrl: string, path: string): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "(unknown origin)";
  return [
    `无法访问教务后端：${baseUrl}${path}`,
    "可能原因：",
    "1) 后端未启动，或端口不是 5001。",
    `2) 当前控制台来源 ${origin} 不在后端 CORS_ORIGINS 白名单。`,
    "3) 控制台是 HTTPS 时，浏览器会拦截 HTTP 接口（混合内容）。",
    "建议：",
    "- 将后端地址改成与当前页面同主机可达地址（例如 http://<当前主机>:5001）。",
    "- 如使用 HTTPS 控制台，请提供 HTTPS 后端地址。",
  ].join("\n");
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return "未知错误";
  }
}

function parseNumericScore(raw: string | undefined): number | null {
  if (!raw) {
    return null;
  }
  const value = Number.parseFloat(raw);
  if (Number.isFinite(value)) {
    return value;
  }
  const matched = raw.match(/\d+(\.\d+)?/);
  if (!matched) {
    return null;
  }
  const fallback = Number.parseFloat(matched[0]);
  return Number.isFinite(fallback) ? fallback : null;
}

function parseNumericCredit(raw: string | undefined): number {
  if (!raw) {
    return 0;
  }
  const value = Number.parseFloat(raw);
  if (Number.isFinite(value)) {
    return value;
  }
  const matched = raw.match(/\d+(\.\d+)?/);
  if (!matched) {
    return 0;
  }
  const fallback = Number.parseFloat(matched[0]);
  return Number.isFinite(fallback) ? fallback : 0;
}

function loadSavedApiBaseUrl(): string {
  try {
    const stored = localStorage.getItem(GDUFE_API_BASE_STORAGE_KEY);
    if (!stored) {
      return deriveDefaultApiBaseUrl();
    }
    return normalizeApiBaseUrl(stored);
  } catch {
    return deriveDefaultApiBaseUrl();
  }
}

function saveApiBaseUrl(url: string) {
  try {
    localStorage.setItem(GDUFE_API_BASE_STORAGE_KEY, url);
  } catch {
    // Ignore localStorage failures.
  }
}

export class GdufeConsoleView extends LitElement {
  @state() apiBaseUrl = loadSavedApiBaseUrl();
  @state() apiBaseDraft = this.apiBaseUrl;
  @state() statusLoading = false;
  @state() loginLoading = false;
  @state() dataLoading = false;
  @state() captchaLoading = false;
  @state() loggedIn = false;
  @state() studentName = "";
  @state() username = "";
  @state() password = "";
  @state() captchaCode = "";
  @state() captchaImage = "";
  @state() lastError = "";
  @state() grades: GradeRecord[] = [];
  @state() gradeSearchQuery = "";
  @state() gradeSemesterFilter = "all";
  @state() gradeSortMode: "default" | "scoreDesc" | "scoreAsc" = "default";

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    void this.bootstrap();
  }

  private async bootstrap() {
    this.lastError = "";
    await this.refreshStatus();
    if (this.loggedIn) {
      await this.loadGrades();
      return;
    }
    await this.refreshCaptcha();
  }

  private async requestJson<T>(path: string, init?: RequestInit): Promise<T> {
    const target = `${this.apiBaseUrl}${path}`;
    const headers = new Headers(init?.headers ?? {});
    if (!headers.has("Accept")) {
      headers.set("Accept", "application/json");
    }
    const hasBody = init?.body != null;
    if (hasBody && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const res = await fetch(target, {
      ...init,
      headers,
      credentials: "include",
      mode: "cors",
    });

    const text = await res.text();
    let parsed: unknown = {};
    if (text.trim()) {
      try {
        parsed = JSON.parse(text);
      } catch {
        if (!res.ok) {
          throw new Error(`请求失败 (${res.status})`);
        }
      }
    }

    if (!res.ok) {
      const payload = parsed as { error?: string; message?: string };
      throw new Error(payload.error ?? payload.message ?? `请求失败 (${res.status})`);
    }

    return parsed as T;
  }

  private applyApiBase() {
    const next = normalizeApiBaseUrl(this.apiBaseDraft);
    this.apiBaseUrl = next;
    this.apiBaseDraft = next;
    saveApiBaseUrl(next);
    void this.bootstrap();
  }

  private useDetectedHostBase() {
    const next = deriveDefaultApiBaseUrl();
    this.apiBaseDraft = next;
    this.apiBaseUrl = next;
    saveApiBaseUrl(next);
    void this.bootstrap();
  }

  private async refreshStatus() {
    this.statusLoading = true;
    this.lastError = "";
    try {
      const payload = await this.requestJson<JwxtStatusResponse>("/api/jwxt/status", {
        method: "GET",
      });
      this.loggedIn = payload.loggedIn === true;
      this.studentName = payload.studentName ?? "";
      if (this.loggedIn && payload.username) {
        this.username = payload.username;
      }
      if (!this.loggedIn) {
        this.studentName = "";
        this.grades = [];
        this.gradeSearchQuery = "";
        this.gradeSemesterFilter = "all";
      }
    } catch (error) {
      this.loggedIn = false;
      this.studentName = "";
      const message = normalizeErrorMessage(error);
      this.lastError = message.includes("Failed to fetch")
        ? buildFetchFailureMessage(this.apiBaseUrl, "/api/jwxt/status")
        : message;
    } finally {
      this.statusLoading = false;
    }
  }

  private async refreshCaptcha() {
    this.captchaLoading = true;
    this.lastError = "";
    try {
      const payload = await this.requestJson<JwxtCaptchaResponse>("/api/jwxt/captcha", {
        method: "GET",
      });
      if (payload.success !== true || !payload.captcha) {
        throw new Error(payload.error ?? "获取验证码失败");
      }
      this.captchaImage = payload.captcha;
      this.captchaCode = "";
    } catch (error) {
      const message = normalizeErrorMessage(error);
      this.lastError = message.includes("Failed to fetch")
        ? buildFetchFailureMessage(this.apiBaseUrl, "/api/jwxt/captcha")
        : message;
    } finally {
      this.captchaLoading = false;
    }
  }

  private async submitLogin() {
    if (!this.username.trim() || !this.password.trim() || !this.captchaCode.trim()) {
      this.lastError = "请输入账号、密码和验证码。";
      return;
    }
    this.loginLoading = true;
    this.lastError = "";
    try {
      const payload = await this.requestJson<JwxtLoginResponse>("/api/jwxt/login", {
        method: "POST",
        body: JSON.stringify({
          username: this.username.trim(),
          password: this.password,
          captcha: this.captchaCode.trim(),
        }),
      });
      if (payload.success !== true) {
        throw new Error(payload.error ?? "登录失败，请重试");
      }
      this.loggedIn = true;
      this.studentName = payload.studentName ?? this.username;
      this.password = "";
      this.captchaCode = "";
      await this.loadGrades();
    } catch (error) {
      const message = normalizeErrorMessage(error);
      this.lastError = message.includes("Failed to fetch")
        ? buildFetchFailureMessage(this.apiBaseUrl, "/api/jwxt/login")
        : message;
      await this.refreshCaptcha();
    } finally {
      this.loginLoading = false;
    }
  }

  private async logout() {
    this.lastError = "";
    try {
      await this.requestJson<{ success?: boolean; error?: string }>("/api/jwxt/logout", {
        method: "POST",
      });
      this.loggedIn = false;
      this.studentName = "";
      this.password = "";
      this.captchaCode = "";
      this.grades = [];
      this.gradeSearchQuery = "";
      this.gradeSemesterFilter = "all";
      await this.refreshCaptcha();
    } catch (error) {
      const message = normalizeErrorMessage(error);
      this.lastError = message.includes("Failed to fetch")
        ? buildFetchFailureMessage(this.apiBaseUrl, "/api/jwxt/logout")
        : message;
    }
  }

  private async loadGrades() {
    this.dataLoading = true;
    this.lastError = "";
    try {
      const payload = await this.requestJson<JwxtDataResponse>("/api/jwxt/data?type=grades", {
        method: "GET",
      });
      if (payload.success !== true) {
        throw new Error(payload.error ?? "获取教务数据失败");
      }
      this.grades = Array.isArray(payload.data) ? (payload.data as GradeRecord[]) : [];
    } catch (error) {
      const message = normalizeErrorMessage(error);
      this.lastError = message.includes("Failed to fetch")
        ? buildFetchFailureMessage(this.apiBaseUrl, "/api/jwxt/data?type=grades")
        : message;
      this.grades = [];
    } finally {
      this.dataLoading = false;
    }
  }

  private get gradeSummary() {
    const totalCourses = this.grades.length;
    const numericScores = this.grades
      .map((entry) => parseNumericScore(entry.score))
      .filter((value): value is number => value != null);
    const passedCount = numericScores.filter((score) => score >= 60).length;
    const averageScore =
      numericScores.length > 0
        ? (numericScores.reduce((sum, score) => sum + score, 0) / numericScores.length).toFixed(1)
        : "--";
    const totalCredits = this.grades.reduce(
      (sum, entry) => sum + parseNumericCredit(entry.credit),
      0,
    );

    return {
      totalCourses,
      passedCount,
      averageScore,
      totalCredits: totalCredits.toFixed(1),
      passRate:
        numericScores.length > 0 ? Math.round((passedCount / numericScores.length) * 100) : 0,
    };
  }

  private get semesterOptions(): string[] {
    return Array.from(
      new Set(
        this.grades
          .map((entry) => entry.semester?.trim())
          .filter((value): value is string => Boolean(value)),
      ),
    ).toSorted((left, right) => left.localeCompare(right, "zh-CN", { numeric: true }));
  }

  private get filteredGrades(): GradeRecord[] {
    const keyword = normalizeSearchText(this.gradeSearchQuery);
    const filtered = this.grades.filter((entry) => {
      const semester = (entry.semester ?? "").trim();
      if (this.gradeSemesterFilter !== "all" && semester !== this.gradeSemesterFilter) {
        return false;
      }
      if (!keyword) {
        return true;
      }
      const haystack = [entry.courseName, entry.courseCode, entry.semester]
        .map((value) => normalizeSearchText(value))
        .join(" ");
      return haystack.includes(keyword);
    });

    if (this.gradeSortMode === "default") {
      return filtered;
    }

    return [...filtered].toSorted((left, right) => {
      const leftScore = parseNumericScore(left.score);
      const rightScore = parseNumericScore(right.score);
      if (leftScore == null && rightScore == null) {
        return (left.courseName ?? "").localeCompare(right.courseName ?? "", "zh-CN");
      }
      if (leftScore == null) {
        return 1;
      }
      if (rightScore == null) {
        return -1;
      }
      return this.gradeSortMode === "scoreAsc" ? leftScore - rightScore : rightScore - leftScore;
    });
  }

  private get gradeBandStats() {
    const numericScores = this.grades
      .map((entry) => parseNumericScore(entry.score))
      .filter((value): value is number => value != null);
    const total = numericScores.length;

    const definitions = [
      { label: "90+ 优秀", className: "score-a", match: (value: number) => value >= 90 },
      {
        label: "80-89 良好",
        className: "score-b",
        match: (value: number) => value >= 80 && value < 90,
      },
      {
        label: "60-79 及格",
        className: "score-c",
        match: (value: number) => value >= 60 && value < 80,
      },
      { label: "<60 待提升", className: "score-d", match: (value: number) => value < 60 },
    ];

    return definitions.map((definition) => {
      const count = numericScores.filter((value) => definition.match(value)).length;
      const percentage = total > 0 ? Math.round((count / total) * 100) : 0;
      return {
        label: definition.label,
        className: definition.className,
        count,
        percentage,
      };
    });
  }

  private get semesterStats() {
    type SemesterAggregate = {
      semester: string;
      courseCount: number;
      scoreCount: number;
      scoreSum: number;
      passCount: number;
      creditSum: number;
    };

    const map = new Map<string, SemesterAggregate>();
    for (const entry of this.grades) {
      const semester = (entry.semester ?? "").trim() || "未标注学期";
      const score = parseNumericScore(entry.score);
      const credit = parseNumericCredit(entry.credit);
      const current =
        map.get(semester) ??
        ({
          semester,
          courseCount: 0,
          scoreCount: 0,
          scoreSum: 0,
          passCount: 0,
          creditSum: 0,
        } satisfies SemesterAggregate);
      current.courseCount += 1;
      current.creditSum += credit;
      if (score != null) {
        current.scoreCount += 1;
        current.scoreSum += score;
        if (score >= 60) {
          current.passCount += 1;
        }
      }
      map.set(semester, current);
    }

    return Array.from(map.values())
      .map((item) => {
        const averageScore = item.scoreCount > 0 ? item.scoreSum / item.scoreCount : null;
        const passRate =
          item.scoreCount > 0 ? Math.round((item.passCount / item.scoreCount) * 100) : 0;
        return {
          semester: item.semester,
          courseCount: item.courseCount,
          averageScore,
          averageScoreText: averageScore == null ? "--" : averageScore.toFixed(1),
          passRate,
          totalCredits: item.creditSum.toFixed(1),
        };
      })
      .toSorted((left, right) => {
        if (left.semester === "未标注学期") {
          return 1;
        }
        if (right.semester === "未标注学期") {
          return -1;
        }
        return left.semester.localeCompare(right.semester, "zh-CN", { numeric: true });
      });
  }

  render() {
    const summary = this.gradeSummary;
    const gradeBandStats = this.gradeBandStats;
    const semesterStats = this.semesterStats;
    const recentSemesterStats = semesterStats.slice(-6);
    const filteredGrades = this.filteredGrades;
    const visibleGrades = filteredGrades.slice(0, 20);

    return html`
      <section class="gdufe-console">
        <div class="stack">
          <div class="card">
            <div class="card-title">GDUFE 校园智能体控制台</div>
            <div class="card-sub">面向非专业用户的教务登录与数据可视化页面。</div>
            <div class="gdufe-console__status-row">
              <span class="pill ${this.loggedIn ? "ok" : "danger"}">
                ${this.loggedIn ? "教务已登录" : "教务未登录"}
              </span>
              ${this.studentName
                ? html`<span class="muted">当前用户：${this.studentName}</span>`
                : null}
            </div>
            <div class="callout info" style="margin-top: 12px;">
              提示：请先启动教务后端（推荐 ${deriveDefaultApiBaseUrl()}）。 如果出现 Failed to
              fetch，请检查后端地址是否可达、协议是否一致（HTTPS 页面需 HTTPS API），并确保后端 CORS
              配置包含当前控制台来源。
            </div>
          </div>

          <div class="card">
            <div class="card-title">教务后端连接</div>
            <div class="field" style="margin-top: 10px;">
              <span>后端地址</span>
              <input
                .value=${this.apiBaseDraft}
                @input=${(event: Event) => {
                  this.apiBaseDraft = (event.target as HTMLInputElement).value;
                }}
                placeholder="http://127.0.0.1:5001"
              />
            </div>
            <div class="row" style="margin-top: 10px;">
              <button class="btn btn--sm" @click=${() => this.useDetectedHostBase()}>
                使用当前主机地址
              </button>
              <button class="btn btn--sm" @click=${() => this.applyApiBase()}>保存并重连</button>
              <button
                class="btn btn--sm"
                @click=${() => {
                  void this.refreshStatus();
                }}
                ?disabled=${this.statusLoading}
              >
                ${this.statusLoading ? "检查中..." : "检查状态"}
              </button>
            </div>
            <div class="muted" style="margin-top: 8px;">
              当前控制台来源：${typeof window !== "undefined" ? window.location.origin : ""}
            </div>
          </div>

          <div class="card">
            <div class="card-title">教务系统登录</div>
            ${!this.loggedIn
              ? html`
                  <div class="stack" style="margin-top: 12px;">
                    <label class="field">
                      <span>学号</span>
                      <input
                        .value=${this.username}
                        @input=${(event: Event) => {
                          this.username = (event.target as HTMLInputElement).value;
                        }}
                        placeholder="请输入学号"
                      />
                    </label>
                    <label class="field">
                      <span>密码</span>
                      <input
                        type="password"
                        .value=${this.password}
                        @input=${(event: Event) => {
                          this.password = (event.target as HTMLInputElement).value;
                        }}
                        placeholder="请输入密码"
                      />
                    </label>
                    <div class="gdufe-console__captcha-row">
                      <label class="field gdufe-console__captcha-field">
                        <span>验证码</span>
                        <input
                          .value=${this.captchaCode}
                          @input=${(event: Event) => {
                            this.captchaCode = (event.target as HTMLInputElement).value;
                          }}
                          placeholder="请输入验证码"
                        />
                      </label>
                      <div class="gdufe-console__captcha-preview" title="点击刷新验证码">
                        ${this.captchaImage
                          ? html`<img
                              src=${this.captchaImage}
                              alt="验证码"
                              @click=${() => {
                                void this.refreshCaptcha();
                              }}
                            />`
                          : html`<span class="muted">暂无验证码</span>`}
                      </div>
                    </div>
                    <div class="row">
                      <button
                        class="btn btn--sm"
                        @click=${() => {
                          void this.refreshCaptcha();
                        }}
                        ?disabled=${this.captchaLoading}
                      >
                        ${this.captchaLoading ? "刷新中..." : "刷新验证码"}
                      </button>
                      <button
                        class="btn btn--sm primary"
                        @click=${() => {
                          void this.submitLogin();
                        }}
                        ?disabled=${this.loginLoading}
                      >
                        ${this.loginLoading ? "登录中..." : "登录教务系统"}
                      </button>
                    </div>
                  </div>
                `
              : html`
                  <div class="stack" style="margin-top: 12px;">
                    <div class="callout success">登录成功，可直接获取成绩。</div>
                    <div class="row">
                      <button
                        class="btn btn--sm"
                        @click=${() => {
                          void this.loadGrades();
                        }}
                        ?disabled=${this.dataLoading}
                      >
                        ${this.dataLoading ? "加载成绩中..." : "刷新成绩"}
                      </button>
                      <button
                        class="btn btn--sm danger"
                        @click=${() => {
                          void this.logout();
                        }}
                      >
                        退出登录
                      </button>
                    </div>
                  </div>
                `}
            ${this.lastError
              ? html`<pre class="callout danger" style="margin-top: 12px; white-space: pre-wrap;">
${this.lastError}</pre
                >`
              : null}
          </div>

          <div class="card">
            <div class="card-title">教务数据可视化</div>
            <div class="grid gdufe-console__stats" style="margin-top: 12px;">
              <div class="pill">课程总数：${summary.totalCourses}</div>
              <div class="pill">通过课程：${summary.passedCount}</div>
              <div class="pill">平均分：${summary.averageScore}</div>
              <div class="pill">累计学分：${summary.totalCredits}</div>
            </div>
            <div class="gdufe-console__progress" aria-hidden="true">
              <div class="gdufe-console__progress-bar" style=${`width:${summary.passRate}%`}></div>
            </div>
            <div class="muted" style="margin-top: 8px;">成绩通过率：${summary.passRate}%</div>

            <div class="gdufe-console__split-grid" style="margin-top: 12px;">
              <div class="gdufe-console__chart-card">
                <div class="card-sub">成绩分布</div>
                ${gradeBandStats.map(
                  (item) => html`
                    <div class="gdufe-console__bar-row">
                      <div class="gdufe-console__bar-meta">
                        <span>${item.label}</span>
                        <span>${item.count} 门 (${item.percentage}%)</span>
                      </div>
                      <div class="gdufe-console__bar-track">
                        <div
                          class=${`gdufe-console__bar-fill ${item.className}`}
                          style=${`width:${item.percentage}%`}
                        ></div>
                      </div>
                    </div>
                  `,
                )}
              </div>
              <div class="gdufe-console__chart-card">
                <div class="card-sub">学期均分趋势</div>
                ${recentSemesterStats.length > 0
                  ? recentSemesterStats.map((item) => {
                      const barWidth =
                        item.averageScore == null ? 0 : Math.max(Math.round(item.averageScore), 8);
                      return html`
                        <div class="gdufe-console__trend-row">
                          <span class="gdufe-console__trend-label">${item.semester}</span>
                          <div class="gdufe-console__bar-track">
                            <div
                              class="gdufe-console__bar-fill score-b"
                              style=${`width:${barWidth}%`}
                            ></div>
                          </div>
                          <span class="gdufe-console__trend-value">${item.averageScoreText}</span>
                        </div>
                      `;
                    })
                  : html`<div class="muted">暂无可计算的学期趋势。</div>`}
              </div>
            </div>

            <div class="gdufe-console__data-block">
              <div class="card-sub">成绩明细检索</div>
              <div class="gdufe-console__toolbar">
                <input
                  class="gdufe-console__search"
                  .value=${this.gradeSearchQuery}
                  @input=${(event: Event) => {
                    this.gradeSearchQuery = (event.target as HTMLInputElement).value;
                  }}
                  placeholder="搜索课程名 / 课程代码 / 学期"
                />
                <select
                  .value=${this.gradeSemesterFilter}
                  @change=${(event: Event) => {
                    this.gradeSemesterFilter = (event.target as HTMLSelectElement).value;
                  }}
                >
                  <option value="all">全部学期</option>
                  ${this.semesterOptions.map(
                    (semester) => html`<option value=${semester}>${semester}</option>`,
                  )}
                </select>
                <select
                  .value=${this.gradeSortMode}
                  @change=${(event: Event) => {
                    this.gradeSortMode = (event.target as HTMLSelectElement).value as
                      | "default"
                      | "scoreDesc"
                      | "scoreAsc";
                  }}
                >
                  <option value="default">默认顺序</option>
                  <option value="scoreDesc">按成绩降序</option>
                  <option value="scoreAsc">按成绩升序</option>
                </select>
              </div>
              <div class="muted">
                已筛选 ${filteredGrades.length} 条，当前展示 ${visibleGrades.length} 条（总计
                ${this.grades.length} 条）
              </div>
              ${filteredGrades.length > 0
                ? html`
                    <div class="gdufe-console__simple-table">
                      ${visibleGrades.map((entry) => {
                        const numericScore = parseNumericScore(entry.score);
                        return html`
                          <div class="gdufe-console__simple-row">
                            <div>
                              <div class="gdufe-console__course-name">
                                ${entry.courseName ?? "未命名课程"}
                              </div>
                              <div class="gdufe-console__course-meta">
                                ${entry.courseCode ?? "课程代码未知"} ·
                                ${entry.semester ?? "未知学期"}
                              </div>
                            </div>
                            <div class="gdufe-console__score-cell">
                              <strong
                                class=${`gdufe-console__score-tag ${resolveScoreToneClass(numericScore)}`}
                                >${entry.score ?? "--"}</strong
                              >
                              <span class="muted">${entry.credit ?? "0"} 学分</span>
                            </div>
                          </div>
                        `;
                      })}
                    </div>
                    ${filteredGrades.length > visibleGrades.length
                      ? html`<div class="muted">
                          仅展示前 ${visibleGrades.length} 条结果，请继续使用筛选缩小范围。
                        </div>`
                      : null}
                  `
                : html`<div class="muted">暂无匹配成绩，试试调整关键词或筛选条件。</div>`}
            </div>

            ${semesterStats.length > 0
              ? html`
                  <div class="gdufe-console__data-block">
                    <div class="card-sub">学期概览</div>
                    <div class="gdufe-console__simple-table">
                      ${semesterStats.map(
                        (item) => html`
                          <div class="gdufe-console__simple-row">
                            <div>
                              <div class="gdufe-console__course-name">${item.semester}</div>
                              <div class="muted">
                                ${item.courseCount} 门课 · ${item.totalCredits} 学分
                              </div>
                            </div>
                            <div class="gdufe-console__score-cell">
                              <strong>${item.averageScoreText}</strong>
                              <span class="muted">通过率 ${item.passRate}%</span>
                            </div>
                          </div>
                        `,
                      )}
                    </div>
                  </div>
                `
              : null}
          </div>
        </div>
      </section>
    `;
  }
}

if (!customElements.get("gdufe-console-view")) {
  customElements.define("gdufe-console-view", GdufeConsoleView);
}

export function renderGdufeConsole() {
  return html`<gdufe-console-view></gdufe-console-view>`;
}
