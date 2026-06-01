import { html } from "lit";
import { icons, type IconName } from "../icons.ts";
import type { Tab } from "../navigation.ts";

export type AicsRoleBuilderForm = {
  requestZh: string;
  roleBuildBriefJson: string;
  cloudAccessToken: string;
  executionId: string;
  executionToken: string;
  roleListingId: string;
  entitlementId: string;
  deviceId: string;
  workspaceRef: string;
  localGatewayId: string;
  developerId: string;
  outputRoot: string;
  timeoutMs: string;
};

export type AicsRoleBuilderState = {
  form: AicsRoleBuilderForm;
  running: boolean;
  tokenRunning: boolean;
  auditRunning: boolean;
  result: unknown;
  error: string | null;
};

export type AicsMarketplaceRole = {
  id: string;
  title: string;
  detail?: string;
  status?: string;
  roleListingId?: string;
  entitlementId?: string;
};

export type AicsMarketplaceState = {
  roles: AicsMarketplaceRole[];
  loading: boolean;
  error: string | null;
  result: unknown;
};

export type AicsDashboardProps = {
  connected: boolean;
  version: string;
  roleBuilder: AicsRoleBuilderState;
  marketplace: AicsMarketplaceState;
  onNavigate: (tab: Tab) => void;
  onRoleBuilderFieldChange: (field: keyof AicsRoleBuilderForm, value: string) => void;
  onMarketplaceRolesRefresh: () => void;
  onMarketplaceRoleUse: (role: AicsMarketplaceRole) => void;
  onDeveloperModeStart: () => void;
  onExecutionTokenRequest: () => void;
  onExecutionAuditRead: () => void;
  onRoleBuilderRun: () => void;
};

type DashboardAction = {
  label: string;
  detail: string;
  tab?: Tab;
  onSelect?: () => void;
  icon: IconName;
};

const actions = [
  {
    label: "开发岗位",
    detail: "进入开发者模式，只讲业务逻辑，平台自动处理岗位包标准。",
    icon: "wrench",
  },
  {
    label: "进入主对话",
    detail: "用自然语言安排任务、选择岗位和调用工具。",
    tab: "chat",
    icon: "messageSquare",
  },
  {
    label: "查看工作板",
    detail: "查看任务队列、运行状态和交接记录。",
    tab: "workboard",
    icon: "folder",
  },
  {
    label: "使用记录",
    detail: "查看对话和岗位任务的使用情况。",
    tab: "usage",
    icon: "barChart",
  },
] satisfies DashboardAction[];

function renderStatusPill(connected: boolean) {
  return html`
    <span class="aics-status ${connected ? "aics-status--ok" : "aics-status--warn"}">
      <span class="aics-status__dot"></span>
      ${connected ? "本机连接已就绪" : "本机连接未就绪"}
    </span>
  `;
}

function renderAction(action: DashboardAction, onNavigate: (tab: Tab) => void) {
  return html`
    <button
      class="aics-action"
      type="button"
      @click=${() => (action.tab ? onNavigate(action.tab) : action.onSelect?.())}
    >
      <span class="aics-action__icon" aria-hidden="true">${icons[action.icon]}</span>
      <span class="aics-action__copy">
        <span class="aics-action__label">${action.label}</span>
        <span class="aics-action__detail">${action.detail}</span>
      </span>
      <span class="aics-action__arrow" aria-hidden="true">${icons.chevronRight}</span>
    </button>
  `;
}

function renderRoleWorkbench(props: AicsDashboardProps) {
  const marketplace = props.marketplace;
  const hasRoles = marketplace.roles.length > 0;
  return html`
    <section class="aics-workbench" aria-labelledby="aics-workbench-title">
      <div class="aics-section-heading">
        <div class="aics-kicker">岗位工作台</div>
        <h2 id="aics-workbench-title">我的岗位</h2>
      </div>

      <div class="aics-boundary-grid" aria-label="岗位工作台">
        <article class="aics-panel">
          <div class="aics-panel__icon" aria-hidden="true">${icons.brain}</div>
          <div class="aics-panel__eyebrow">当前入口</div>
          <h2>主对话</h2>
          <p>从这里用自然语言安排任务、调用工具、完成编程和资料处理。</p>
          <div class="aics-runner__actions">
            <button
              class="aics-runner__secondary"
              type="button"
              @click=${() => props.onNavigate("chat")}
            >
              <span aria-hidden="true">${icons.messageSquare}</span>
              <span>进入主对话</span>
            </button>
            <button
              class="aics-runner__secondary"
              type="button"
              @click=${props.onDeveloperModeStart}
            >
              <span aria-hidden="true">${icons.wrench}</span>
              <span>开发岗位</span>
            </button>
          </div>
        </article>

        <article class="aics-context-panel">
          <div class="aics-context-panel__mark" aria-hidden="true">${icons.folder}</div>
          <div class="aics-panel__eyebrow">岗位列表</div>
          <h2>已安装岗位</h2>
          <p>从岗位商场同步已购买和已授权的岗位；暂时连不上时会明确提示。</p>
          <button
            class="aics-runner__secondary"
            type="button"
            ?disabled=${marketplace.loading}
            @click=${props.onMarketplaceRolesRefresh}
          >
            <span aria-hidden="true">${marketplace.loading ? icons.loader : icons.refresh}</span>
            <span>${marketplace.loading ? "同步中" : "同步岗位"}</span>
          </button>
          ${marketplace.error
            ? html`<div class="aics-runner__error">${marketplace.error}</div>`
            : hasRoles
              ? html`
                  <div class="aics-api-grid">
                    ${marketplace.roles.map(
                      (role) => html`
                        <div class="aics-api-grid__item">
                          <span>${role.title}</span>
                          ${role.detail ? html`<small>${role.detail}</small>` : null}
                          <button
                            class="aics-runner__secondary"
                            type="button"
                            @click=${() => props.onMarketplaceRoleUse(role)}
                          >
                            <span aria-hidden="true">${icons.messageSquare}</span>
                            <span>使用岗位</span>
                          </button>
                        </div>
                      `,
                    )}
                  </div>
                `
              : html`<div class="aics-runner__empty">暂无已安装岗位。</div>`}
        </article>

        <article class="aics-panel">
          <div class="aics-panel__icon" aria-hidden="true">${icons.fileText}</div>
          <div class="aics-panel__eyebrow">最近任务</div>
          <h2>任务记录</h2>
          <p>查看已经启动、正在运行或已经完成的任务交接记录。</p>
          <button
            class="aics-runner__secondary"
            type="button"
            @click=${() => props.onNavigate("workboard")}
          >
            <span aria-hidden="true">${icons.folder}</span>
            <span>查看工作板</span>
          </button>
        </article>
      </div>

      <section class="aics-lane" aria-label="使用记录">
        <div class="aics-section-heading">
          <div class="aics-kicker">使用记录</div>
          <h2>对话和岗位任务的消耗会在这里汇总</h2>
        </div>
        <div class="aics-api-grid">
          <div class="aics-api-grid__item"><span>对话用量</span></div>
          <div class="aics-api-grid__item"><span>岗位任务记录</span></div>
          <div class="aics-api-grid__item"><span>费用与授权状态</span></div>
        </div>
      </section>
    </section>
  `;
}

export function renderAicsDashboard(props: AicsDashboardProps) {
  const version = props.version || "unknown";

  return html`
    <section class="aics-page">
      <section class="aics-hero" aria-labelledby="aics-title">
        <div class="aics-hero__main">
          <div class="aics-kicker">迭界AI</div>
          <h1 id="aics-title">岗位工作台</h1>
          <p>
            这里是终端客户开始工作的地方。先进入主对话安排任务；岗位商场接入后，已购买和已授权的岗位会出现在这里。
          </p>
          <div class="aics-hero__meta">
            ${renderStatusPill(props.connected)}
            <span class="aics-chip">版本 ${version}</span>
            <span class="aics-chip">岗位列表可同步</span>
          </div>
        </div>
        <div class="aics-hero__actions">
          ${actions.map((action) =>
            renderAction(
              action.label === "开发岗位"
                ? { ...action, onSelect: props.onDeveloperModeStart }
                : action,
              props.onNavigate,
            ),
          )}
        </div>
      </section>

      ${renderRoleWorkbench(props)}
    </section>
  `;
}
