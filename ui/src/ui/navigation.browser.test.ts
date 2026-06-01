import { describe, expect, it, vi } from "vitest";
import { mountApp as mountTestApp, registerAppMountHooks } from "./test-helpers/app-mount.ts";

registerAppMountHooks();

function mountApp(pathname: string) {
  return mountTestApp(pathname);
}

function nextFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function expectElement<T extends Element>(
  root: Element,
  selector: string,
  constructor: new () => T,
): T {
  const element = root.querySelector<T>(selector);
  expect(element).toBeInstanceOf(constructor);
  if (!(element instanceof constructor)) {
    throw new Error(`Expected ${selector} to match ${constructor.name}`);
  }
  return element;
}

function expectButtonWithText(app: ReturnType<typeof mountApp>, text: string): HTMLButtonElement {
  const button = Array.from(app.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  expect(button).toBeInstanceOf(HTMLButtonElement);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected button with text "${text}"`);
  }
  return button;
}

function expectButtonContainingText(
  app: ReturnType<typeof mountApp>,
  text: string,
): HTMLButtonElement {
  const button = Array.from(app.querySelectorAll<HTMLButtonElement>("button")).find((candidate) =>
    candidate.textContent?.includes(text),
  );
  expect(button).toBeInstanceOf(HTMLButtonElement);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected button containing text "${text}"`);
  }
  return button;
}

function createSessionsResult(sessions: Array<Record<string, unknown>>) {
  return {
    ts: 0,
    path: "",
    count: sessions.length,
    defaults: { modelProvider: "openai", model: "gpt-5.5", contextTokens: null },
    sessions: sessions.map((session) => ({
      kind: "direct",
      updatedAt: Date.now(),
      ...session,
    })),
  };
}

async function confirmPendingGatewayChange(app: ReturnType<typeof mountApp>) {
  const confirmButton = expectButtonWithText(app, "Confirm");
  confirmButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await app.updateComplete;
}

function expectConfirmedGatewayChange(app: ReturnType<typeof mountApp>) {
  expect(app.settings.gatewayUrl).toBe("wss://other-gateway.example/openclaw");
  expect(app.settings.token).toBe("abc123");
  expect(window.location.search).toBe("");
  expect(window.location.hash).toBe("");
}

function fillAicsRoleBuilderRequiredFields(
  app: ReturnType<typeof mountApp>,
  overrides: Record<string, string> = {},
) {
  const fields = {
    requestZh: "生成一个客服质检岗位包",
    roleBuildBriefJson: JSON.stringify({
      name: "客服质检岗位",
      deliverables: ["role_package/manifest.json"],
    }),
    cloudAccessToken: "cloud_customer_token",
    executionId: "exec_123",
    executionToken: "token_123",
    roleListingId: "role_123",
    entitlementId: "ent_123",
    deviceId: "device_123",
    workspaceRef: "workspace_123",
    localGatewayId: "gateway_123",
    ...overrides,
  };
  for (const [field, value] of Object.entries(fields)) {
    app.updateAicsRoleBuilderField(field as never, value);
  }
}

describe("control UI routing", () => {
  it("renders responsive navigation shell, drawer, and collapsed states", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    expect(window.matchMedia("(max-width: 768px)").matches).toBe(true);

    expectElement(app, 'a.nav-item[href="/dreaming"]', HTMLAnchorElement);
  });

  it("renders the dashboard breadcrumb as an AICS home link", async () => {
    const app = mountApp("/channels");
    await app.updateComplete;

    const breadcrumb = expectElement(
      app,
      "dashboard-header .dashboard-header__breadcrumb-link",
      HTMLAnchorElement,
    );
    expect(breadcrumb.getAttribute("href")).toBe("/aics");

    breadcrumb.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await app.updateComplete;

    expect(app.tab).toBe("aics");
    expect(window.location.pathname).toBe("/aics");
  });

  it("keeps AICS from rendering a second role-builder conversation form", async () => {
    const app = mountApp("/aics");
    await app.updateComplete;

    const aicsPage = expectElement(app, ".aics-page", HTMLElement);
    expect(aicsPage.textContent).not.toContain("中文需求");
    expect(aicsPage.textContent).not.toContain("RoleBuildBrief JSON");
    expect(
      Array.from(aicsPage.querySelectorAll<HTMLButtonElement>("button")).some(
        (candidate) => candidate.textContent?.trim() === "启动生成",
      ),
    ).toBe(false);
  });

  it("keeps AICS customer-facing copy in Chinese without internal platform names", async () => {
    const app = mountApp("/aics");
    await app.updateComplete;

    const aicsPage = expectElement(app, ".aics-page", HTMLElement);
    const text = aicsPage.textContent ?? "";
    expect(text).toContain("岗位工作台");
    expect(text).toContain("我的岗位");
    expect(text).toContain("已安装岗位");
    expect(text).toContain("使用记录");
    for (const hiddenWord of [
      "OpenClaw",
      "Mercur",
      "Medusa",
      "主系统",
      "API Bridge",
      "Gateway",
      "runtime",
      "授权与审计状态",
      "云端授权凭证",
      "执行授权凭证",
      "roleListingId",
      "role_quality_agent",
      "cloud access token",
      "cloud_customer_token",
      "execution token",
      "token_123",
      "dijie.marketplace.roles.list",
      "RoleBuildBrief",
    ]) {
      expect(text).not.toContain(hiddenWord);
    }
  });

  it("syncs installed marketplace roles through Gateway without rendering fake cards", async () => {
    const app = mountApp("/aics");
    const request = vi.fn(async () => ({
      ok: true,
      roles: [
        {
          entitlementId: "ordgrp_001",
          orderId: "order_001",
          authorizedAt: "2026-05-31T00:00:00.000Z",
          role: {
            id: "role_quality_agent",
            title: "客服质检岗位",
            description: "检查客服对话质量",
            listingStatus: "published",
          },
        },
      ],
    }));
    app.client = { request, stop: vi.fn() } as never;
    app.connected = true;
    fillAicsRoleBuilderRequiredFields(app);
    await app.updateComplete;

    expect(expectElement(app, ".aics-page", HTMLElement).textContent).toContain("暂无已安装岗位");
    expectButtonWithText(app, "同步岗位").dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await app.updateComplete;
    await nextFrame();
    await app.updateComplete;

    expect(request).toHaveBeenCalledWith("dijie.marketplace.roles.list", {
      cloud_access_token: "cloud_customer_token",
      workspace_ref: "workspace_123",
      device_id: "device_123",
    });
    expect(app.aicsMarketplace.error).toBeNull();
    expect(app.aicsMarketplace.roles).toEqual([
      {
        id: "role_quality_agent",
        title: "客服质检岗位",
        detail: "检查客服对话质量",
        status: "published",
        roleListingId: "role_quality_agent",
        entitlementId: "ordgrp_001",
      },
    ]);
    expect(expectElement(app, ".aics-page", HTMLElement).textContent).toContain("客服质检岗位");
    expect(JSON.stringify(app.aicsMarketplace.result)).not.toContain("cloud_customer_token");
  });

  it("uses a marketplace role by jumping into the existing main chat draft", async () => {
    const app = mountApp("/aics");
    const request = vi.fn(async () => ({
      ok: true,
      roles: [
        {
          id: "role_quality_agent",
          title: "客服质检岗位",
          description: "检查客服对话质量",
          status: "installed",
        },
      ],
    }));
    app.client = { request, stop: vi.fn() } as never;
    app.connected = true;
    fillAicsRoleBuilderRequiredFields(app);
    await app.refreshAicsMarketplaceRoles();
    await app.updateComplete;

    expectButtonWithText(app, "使用岗位").dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await app.updateComplete;

    expect(app.tab).toBe("chat");
    expect(window.location.pathname).toBe("/chat");
    expect(app.chatMessage).toContain("客服质检岗位");
    expect(app.chatMessage).not.toContain("role_quality_agent");
    expect(app.chatMessage).not.toContain("cloud_customer_token");
    expect(app.chatMessage).not.toContain("token_123");
    expect(app.chatMessage).not.toContain("dijie");
    expect(app.chatMessage).not.toContain("Gateway");
    expect(app.chatMessage).not.toContain("execution");
    expect(app.chatMessages).toEqual([]);
    expect(app.aicsRoleBuilder.form.roleListingId).toBe("role_quality_agent");
  });

  it("starts developer mode from AICS without rendering platform internals", async () => {
    const app = mountApp("/aics");
    await app.updateComplete;

    expectButtonWithText(app, "开发岗位").dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await app.updateComplete;

    expect(app.tab).toBe("chat");
    expect(window.location.pathname).toBe("/chat");
    expect(app.aicsConversationMode).toBe("developer");
    expect(app.aicsConversationStage).toBe("idle");
    expect(app.aicsConversationProtocol).toMatchObject({
      role: "developerAssistant",
      roleLabel: "岗位开发专属助手",
      stage: "idle",
      stageLabel: "开发待命",
    });
    expect(app.chatMessage).toContain("你只需要讲清楚这个岗位要解决什么业务问题");
    const text = app.textContent ?? "";
    expect(text).toContain("开发者模式");
    expect(text).toContain("使用者模式");
    expect(text).toContain("当前角色");
    expect(text).toContain("工作身份");
    expect(text).toContain("当前流程阶段");
    expect(text).toContain("岗位开发专属助手");
    expect(text).toContain("岗位使用与执行助手");
    expect(text).toContain("开发待命");
    expect(text).toContain("只讲业务逻辑");
    expect(text).not.toContain(`对话${"对象"}`);
    for (const hiddenWord of [
      "RoleBuildBrief",
      "execution token",
      "cloud bearer",
      "entitlementId",
      "roleListingId",
      "cloud_customer_token",
      "token_123",
    ]) {
      expect(text).not.toContain(hiddenWord);
    }
  });

  it("keeps developer mode context out of the visible chat transcript", async () => {
    const app = mountApp("/chat");
    const request = vi.fn(async () => ({ runId: "run_1", status: "ok" }));
    app.client = { request, stop: vi.fn() } as never;
    app.connected = true;
    await app.updateComplete;

    expectButtonContainingText(app, "开发者模式").dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await app.updateComplete;

    app.chatMessage = "我想做一个发票审核岗位，按金额和供应商风险分流。";
    await app.handleSendChat();
    await app.updateComplete;

    expect(app.aicsConversationStage).toBe("intake");
    expect(app.aicsConversationProtocol).toMatchObject({
      roleLabel: "岗位开发专属助手",
      stage: "intake",
      stageLabel: "收集业务逻辑",
    });
    expect(request).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({
        message: "我想做一个发票审核岗位，按金额和供应商风险分流。",
        modelPrompt: expect.stringContaining("[迭界AI开发者模式]"),
      }),
    );
    const sentPayload = request.mock.calls[0]?.[1] as
      | { message?: string; modelPrompt?: string }
      | undefined;
    expect(sentPayload?.modelPrompt).toContain("当前角色：岗位开发专属助手");
    expect(sentPayload?.modelPrompt).toContain("工作身份：同一个聊天框下的岗位开发工作身份");
    expect(sentPayload?.modelPrompt).toContain("当前流程阶段：收集业务逻辑");
    expect(sentPayload?.modelPrompt).toContain("开发者只需要用自然语言讲业务逻辑");
    expect(sentPayload?.modelPrompt).toContain(
      "输入、输出、规则、验收标准、岗位包结构、协议映射、验证材料和上传标准都是平台职责",
    );
    expect(sentPayload?.modelPrompt).toContain("不要让开发者定义、填写或逐项确认");
    expect(sentPayload?.message).not.toContain("[迭界AI开发者模式]");
    const transcript = JSON.stringify(app.chatMessages);
    expect(transcript).toContain("发票审核岗位");
    expect(transcript).not.toContain("[迭界AI开发者模式]");
    expect(transcript).not.toContain("执行 token");

    expectButtonContainingText(app, "使用者模式").dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await app.updateComplete;

    expect(app.aicsConversationMode).toBe("user");
    expect(app.aicsConversationStage).toBe("ready");
    expect(app.aicsConversationProtocol).toMatchObject({
      roleLabel: "岗位使用与执行助手",
      stage: "ready",
      stageLabel: "使用就绪",
    });
    app.chatMessage = "使用我的质检岗位处理今天的记录。";
    await app.handleSendChat();
    const chatSendCalls = request.mock.calls.filter(([method]) => method === "chat.send");
    const secondPayload = chatSendCalls[1]?.[1] as
      | { message?: string; modelPrompt?: string }
      | undefined;
    expect(secondPayload?.message).toBe("使用我的质检岗位处理今天的记录。");
    expect(secondPayload?.modelPrompt).toBeUndefined();
  });

  it("fails marketplace role sync clearly before RPC when cloud auth is missing", async () => {
    const app = mountApp("/aics");
    const request = vi.fn(async () => ({ ok: true }));
    app.client = { request, stop: vi.fn() } as never;
    app.connected = true;
    fillAicsRoleBuilderRequiredFields(app, { cloudAccessToken: "" });
    await app.updateComplete;

    await app.refreshAicsMarketplaceRoles();
    await app.updateComplete;

    expect(request).not.toHaveBeenCalled();
    expect(app.aicsMarketplace.error).toContain("需要先连接岗位商场账号");
    expect(app.aicsMarketplace.roles).toEqual([]);
  });

  it("fails marketplace role sync clearly when Gateway is disconnected", async () => {
    const app = mountApp("/aics");
    const request = vi.fn(async () => ({ ok: true }));
    app.client = { request, stop: vi.fn() } as never;
    app.connected = false;
    fillAicsRoleBuilderRequiredFields(app);
    await app.updateComplete;

    await app.refreshAicsMarketplaceRoles();
    await app.updateComplete;

    expect(request).not.toHaveBeenCalled();
    expect(app.aicsMarketplace.error).toContain("本机连接未就绪");
  });

  it("does not fake marketplace role sync success when Gateway returns ok=false", async () => {
    const app = mountApp("/aics");
    const request = vi.fn(async () => ({
      ok: false,
      error: "marketplace unavailable",
    }));
    app.client = { request, stop: vi.fn() } as never;
    app.connected = true;
    fillAicsRoleBuilderRequiredFields(app);
    await app.updateComplete;

    await app.refreshAicsMarketplaceRoles();
    await app.updateComplete;
    await nextFrame();
    await app.updateComplete;

    expect(request).toHaveBeenCalledWith("dijie.marketplace.roles.list", expect.any(Object));
    expect(app.aicsMarketplace.error).toBe("岗位同步失败，请检查岗位商场连接状态。");
    expect(app.aicsMarketplace.roles).toEqual([]);
  });

  it("submits the AICS role-builder handler through the Gateway RPC", async () => {
    const app = mountApp("/aics");
    const request = vi.fn(async () => ({
      ok: true,
      summary: "done",
      executionId: "exec_role_builder_123",
      executionEngine: "openclaw-native",
      changedFiles: ["role_package/manifest.json"],
    }));
    app.client = { request, stop: vi.fn() } as never;
    app.connected = true;
    fillAicsRoleBuilderRequiredFields(app);
    await app.updateComplete;

    await app.runAicsRoleBuilder();
    await app.updateComplete;
    await nextFrame();
    await app.updateComplete;

    expect(request).toHaveBeenCalledWith(
      "dijie.roleBuilder.run",
      expect.objectContaining({
        request_zh: "生成一个客服质检岗位包",
        confirm_brief: true,
        role_build_brief_json: expect.stringContaining("客服质检岗位"),
        execution_token: "token_123",
        role_listing_id: "role_123",
        entitlement_id: "ent_123",
        device_id: "device_123",
        workspace_ref: "workspace_123",
        local_gateway_id: "gateway_123",
        timeout_ms: 120000,
      }),
    );
    expect(app.aicsRoleBuilder.error).toBeNull();
    expect(app.aicsRoleBuilder.result).toMatchObject({
      ok: true,
      executionEngine: "openclaw-native",
    });
    expect(app.aicsRoleBuilder.form.executionId).toBe("exec_role_builder_123");
  });

  it("fails the AICS role-builder form before RPC when the execution token is missing", async () => {
    const app = mountApp("/aics");
    const request = vi.fn(async () => ({ ok: true }));
    app.client = { request, stop: vi.fn() } as never;
    app.connected = true;
    fillAicsRoleBuilderRequiredFields(app, { executionToken: "" });
    await app.updateComplete;

    await app.runAicsRoleBuilder();
    await app.updateComplete;

    expect(request).not.toHaveBeenCalled();
    expect(app.aicsRoleBuilder.error).toContain("执行授权凭证不能为空");
  });

  it("requests an AICS execution token through the Gateway RPC and fills the form", async () => {
    const app = mountApp("/aics");
    const request = vi.fn(async () => ({
      ok: true,
      summary: "issued",
      grant: {
        executionId: "exec_123",
        token: "short_lived_execution_token",
      },
    }));
    app.client = { request, stop: vi.fn() } as never;
    app.connected = true;
    fillAicsRoleBuilderRequiredFields(app, {
      cloudAccessToken: "cloud_customer_token",
      executionId: "",
      executionToken: "",
    });
    await app.updateComplete;
    await app.requestAicsExecutionToken();
    await app.updateComplete;
    await nextFrame();
    await app.updateComplete;

    expect(request).toHaveBeenCalledWith("dijie.executionToken.request", {
      cloud_access_token: "cloud_customer_token",
      role_listing_id: "role_123",
      entitlement_id: "ent_123",
      device_id: "device_123",
      workspace_ref: "workspace_123",
      local_gateway_id: "gateway_123",
    });
    expect(app.aicsRoleBuilder.form.executionToken).toBe("short_lived_execution_token");
    expect(app.aicsRoleBuilder.form.executionId).toBe("exec_123");
    expect(app.aicsRoleBuilder.error).toBeNull();
    expect(JSON.stringify(app.aicsRoleBuilder.result)).not.toContain("cloud_customer_token");
  });

  it("fails the AICS execution-token request before RPC when the cloud bearer is missing", async () => {
    const app = mountApp("/aics");
    const request = vi.fn(async () => ({ ok: true }));
    app.client = { request, stop: vi.fn() } as never;
    app.connected = true;
    fillAicsRoleBuilderRequiredFields(app, {
      cloudAccessToken: "",
      executionToken: "",
    });
    await app.updateComplete;
    await app.requestAicsExecutionToken();
    await app.updateComplete;

    expect(request).not.toHaveBeenCalled();
    expect(app.aicsRoleBuilder.error).toContain("云端授权凭证不能为空");
  });

  it("reads an AICS execution audit through Gateway without storing the cloud bearer in result", async () => {
    const app = mountApp("/aics");
    const request = vi.fn(async () => ({
      ok: true,
      summary: "read",
      execution: {
        executionId: "exec_123",
        status: "completed",
        note: "cloud_customer_token should be redacted if returned",
      },
    }));
    app.client = { request, stop: vi.fn() } as never;
    app.connected = true;
    fillAicsRoleBuilderRequiredFields(app);
    await app.updateComplete;
    await app.readAicsExecutionAudit();
    await app.updateComplete;
    await nextFrame();
    await app.updateComplete;

    expect(request).toHaveBeenCalledWith("dijie.executionAudit.read", {
      cloud_access_token: "cloud_customer_token",
      execution_id: "exec_123",
    });
    expect(app.aicsRoleBuilder.error).toBeNull();
    expect(app.aicsRoleBuilder.result).toMatchObject({
      ok: true,
      execution: {
        executionId: "exec_123",
        status: "completed",
        note: "[redacted_cloud_access_token] should be redacted if returned",
      },
    });
    expect(JSON.stringify(app.aicsRoleBuilder.result)).not.toContain("cloud_customer_token");
  });

  it("fails the AICS execution audit read before RPC when executionId is missing", async () => {
    const app = mountApp("/aics");
    const request = vi.fn(async () => ({ ok: true }));
    app.client = { request, stop: vi.fn() } as never;
    app.connected = true;
    fillAicsRoleBuilderRequiredFields(app, { executionId: "" });
    await app.updateComplete;
    await app.readAicsExecutionAudit();
    await app.updateComplete;

    expect(request).not.toHaveBeenCalled();
    expect(app.aicsRoleBuilder.error).toContain("执行编号不能为空");
  });

  it("fails the AICS execution audit read before RPC when the cloud bearer is missing", async () => {
    const app = mountApp("/aics");
    const request = vi.fn(async () => ({ ok: true }));
    app.client = { request, stop: vi.fn() } as never;
    app.connected = true;
    fillAicsRoleBuilderRequiredFields(app, { cloudAccessToken: "" });
    await app.updateComplete;
    await app.readAicsExecutionAudit();
    await app.updateComplete;

    expect(request).not.toHaveBeenCalled();
    expect(app.aicsRoleBuilder.error).toContain("云端授权凭证不能为空");
  });

  it("fails the AICS execution audit read when Gateway is disconnected", async () => {
    const app = mountApp("/aics");
    const request = vi.fn(async () => ({ ok: true }));
    app.client = { request, stop: vi.fn() } as never;
    app.connected = false;
    fillAicsRoleBuilderRequiredFields(app);
    await app.readAicsExecutionAudit();
    await app.updateComplete;

    expect(request).not.toHaveBeenCalled();
    expect(app.aicsRoleBuilder.error).toContain("本机连接未就绪");
  });

  it("surfaces Gateway ok=false audit read failures without storing the cloud bearer", async () => {
    const app = mountApp("/aics");
    const request = vi.fn(async () => ({
      ok: false,
      summary: "rejected",
      error: "cloud_customer_token is not authorized",
    }));
    app.client = { request, stop: vi.fn() } as never;
    app.connected = true;
    fillAicsRoleBuilderRequiredFields(app);
    await app.updateComplete;
    await app.readAicsExecutionAudit();
    await app.updateComplete;
    await nextFrame();
    await app.updateComplete;

    expect(request).toHaveBeenCalledWith("dijie.executionAudit.read", expect.any(Object));
    expect(app.aicsRoleBuilder.error).toBe("审计记录查询失败。");
    expect(JSON.stringify(app.aicsRoleBuilder.result)).not.toContain("cloud_customer_token");
  });

  it("surfaces Gateway ok=false executor failures in the AICS role-builder result", async () => {
    const app = mountApp("/aics");
    const request = vi.fn(async () => ({
      ok: false,
      summary: "failed",
      error:
        "No role-builder executor is configured. Configure OpenClaw-native runEmbeddedAgent or aics.localExecutorCommand before confirming a brief.",
    }));
    app.client = { request, stop: vi.fn() } as never;
    app.connected = true;
    fillAicsRoleBuilderRequiredFields(app);
    await app.updateComplete;

    await app.runAicsRoleBuilder();
    await app.updateComplete;
    await nextFrame();
    await app.updateComplete;

    expect(request).toHaveBeenCalledWith("dijie.roleBuilder.run", expect.any(Object));
    expect(app.aicsRoleBuilder.error).toBe("迭界AI生成请求失败。");
    expect(app.aicsRoleBuilder.result).toMatchObject({ ok: false });
  });

  it("keeps the dashboard breadcrumb link inside the configured base path", async () => {
    const app = mountApp("/ui/channels");
    await app.updateComplete;

    const breadcrumb = expectElement(
      app,
      "dashboard-header .dashboard-header__breadcrumb-link",
      HTMLAnchorElement,
    );
    expect(breadcrumb.getAttribute("href")).toBe("/ui/aics");
  });

  it("renders the dreaming view on the /dreaming route", async () => {
    const app = mountApp("/dreaming");
    app.dreamingStatus = {
      enabled: true,
      timezone: "Europe/Madrid",
      verboseLogging: false,
      storageMode: "inline",
      separateReports: false,
      shortTermCount: 2,
      recallSignalCount: 1,
      dailySignalCount: 1,
      groundedSignalCount: 0,
      totalSignalCount: 2,
      phaseSignalCount: 0,
      lightPhaseHitCount: 0,
      remPhaseHitCount: 0,
      promotedTotal: 1,
      promotedToday: 1,
      shortTermEntries: [],
      signalEntries: [],
      promotedEntries: [],
      phases: {
        light: { enabled: true, cron: "", managedCronPresent: false, lookbackDays: 7, limit: 20 },
        deep: {
          enabled: true,
          cron: "",
          managedCronPresent: false,
          limit: 20,
          minScore: 0.75,
          minRecallCount: 3,
          minUniqueQueries: 2,
          recencyHalfLifeDays: 7,
        },
        rem: {
          enabled: true,
          cron: "",
          managedCronPresent: false,
          lookbackDays: 7,
          limit: 20,
          minPatternStrength: 0.6,
        },
      },
    };
    app.dreamDiaryPath = "DREAMS.md";
    app.dreamDiaryContent = [
      "# Dream Diary",
      "",
      "<!-- openclaw:dreaming:diary:start -->",
      "",
      "---",
      "",
      "*January 1, 2026*",
      "",
      "What Happened",
      "1. Stable operator rule surfaced.",
      "",
      "<!-- openclaw:dreaming:diary:end -->",
    ].join("\n");
    app.requestUpdate();
    await app.updateComplete;

    expect(app.tab).toBe("dreams");
    expectElement(app, ".dreams__tab", HTMLElement);
    expectElement(app, ".dreams__lobster", HTMLElement);
  });

  it("requires confirmation before sending dreaming restart patch", async () => {
    const app = mountApp("/dreaming");
    const request = vi.fn(async (method: string) => {
      if (method === "config.schema.lookup") {
        return {
          schema: {
            additionalProperties: true,
          },
          children: [{ key: "dreaming" }],
        };
      }
      if (method === "config.patch") {
        return { ok: true };
      }
      if (method === "config.get") {
        return {
          hash: "hash-2",
          config: {
            plugins: {
              slots: {
                memory: "memory-core",
              },
              entries: {
                "memory-core": {
                  config: {
                    dreaming: {
                      enabled: true,
                    },
                  },
                },
              },
            },
          },
        };
      }
      if (method === "doctor.memory.status") {
        return {
          dreaming: {
            enabled: true,
            timezone: "UTC",
            verboseLogging: false,
            storageMode: "inline",
            separateReports: false,
            shortTermCount: 0,
            recallSignalCount: 0,
            dailySignalCount: 0,
            groundedSignalCount: 0,
            totalSignalCount: 0,
            phaseSignalCount: 0,
            lightPhaseHitCount: 0,
            remPhaseHitCount: 0,
            promotedTotal: 0,
            promotedToday: 0,
            shortTermEntries: [],
            signalEntries: [],
            promotedEntries: [],
            phases: {
              light: {
                enabled: true,
                cron: "",
                managedCronPresent: false,
                lookbackDays: 7,
                limit: 20,
              },
              deep: {
                enabled: true,
                cron: "",
                managedCronPresent: false,
                limit: 20,
                minScore: 0.75,
                minRecallCount: 3,
                minUniqueQueries: 2,
                recencyHalfLifeDays: 7,
              },
              rem: {
                enabled: true,
                cron: "",
                managedCronPresent: false,
                lookbackDays: 7,
                limit: 20,
                minPatternStrength: 0.6,
              },
            },
          },
        };
      }
      return {};
    });

    app.client = {
      request,
      stop: vi.fn(),
    } as unknown as NonNullable<typeof app.client>;
    app.connected = true;
    app.configSnapshot = {
      hash: "hash-1",
      config: {
        plugins: {
          slots: {
            memory: "memory-core",
          },
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                },
              },
            },
          },
        },
      },
    };
    app.dreamingStatus = {
      enabled: true,
      timezone: "UTC",
      verboseLogging: false,
      storageMode: "inline",
      separateReports: false,
      shortTermCount: 0,
      recallSignalCount: 0,
      dailySignalCount: 0,
      groundedSignalCount: 0,
      totalSignalCount: 0,
      phaseSignalCount: 0,
      lightPhaseHitCount: 0,
      remPhaseHitCount: 0,
      promotedTotal: 0,
      promotedToday: 0,
      shortTermEntries: [],
      signalEntries: [],
      promotedEntries: [],
      phases: {
        light: { enabled: true, cron: "", managedCronPresent: false, lookbackDays: 7, limit: 20 },
        deep: {
          enabled: true,
          cron: "",
          managedCronPresent: false,
          limit: 20,
          minScore: 0.75,
          minRecallCount: 3,
          minUniqueQueries: 2,
          recencyHalfLifeDays: 7,
        },
        rem: {
          enabled: true,
          cron: "",
          managedCronPresent: false,
          lookbackDays: 7,
          limit: 20,
          minPatternStrength: 0.6,
        },
      },
    };
    app.requestUpdate();
    await app.updateComplete;

    const toggle = expectElement(app, ".dreams__phase-toggle--on", HTMLButtonElement);
    toggle.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await app.updateComplete;

    expect(request.mock.calls.some((call) => call[0] === "config.patch")).toBe(false);
    const confirmRestart = expectButtonWithText(app, "Confirm Restart");
    confirmRestart.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    await nextFrame();
    await app.updateComplete;

    const patchCall = request.mock.calls.find((call) => call[0] === "config.patch") as
      | [string, { baseHash?: string }]
      | undefined;
    expect(patchCall?.[1].baseHash).toBe("hash-1");
  });

  it("renders the refreshed top navigation shell", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    expectElement(app, ".topnav-shell", HTMLElement);
    expectElement(app, ".topnav-shell__content", HTMLElement);
    expectElement(app, ".topnav-shell__actions", HTMLElement);
    expect(app.querySelector(".topnav-shell .brand-title")).toBeNull();

    expectElement(app, ".sidebar-shell", HTMLElement);
    expectElement(app, ".sidebar-shell__header", HTMLElement);
    expectElement(app, ".sidebar-shell__body", HTMLElement);
    expectElement(app, ".sidebar-shell__footer", HTMLElement);
    expectElement(app, ".sidebar-brand", HTMLElement);
    expectElement(app, ".sidebar-brand__logo", HTMLElement);
    expectElement(app, ".sidebar-brand__copy", HTMLElement);

    app.hello = {
      ok: true,
      server: { version: "1.2.3" },
    } as never;
    app.requestUpdate();
    await app.updateComplete;

    expectElement(app, ".sidebar-version", HTMLElement);
    const statusDot = expectElement(app, ".sidebar-version__status", HTMLElement);
    expect(statusDot.getAttribute("aria-label")).toBe("Gateway status: Online");
    expect(statusDot.getAttribute("title")).toBe("Gateway status: Online");
    expect([...statusDot.classList]).toEqual([
      "sidebar-version__status",
      "sidebar-connection-status--online",
    ]);

    app.applySettings({ ...app.settings, navWidth: 360 });
    await app.updateComplete;

    expect(app.querySelector(".sidebar-resizer")).toBeNull();
    const shell = expectElement(app, ".shell", HTMLElement);
    expect(shell.style.getPropertyValue("--shell-nav-width")).toBe("");

    const split = expectElement(app, ".chat-split-container", HTMLElement);
    split.classList.add("chat-split-container--open");
    await app.updateComplete;
    expect([...split.classList]).toEqual(["chat-split-container", "chat-split-container--open"]);

    expectElement(app, ".chat-main", HTMLElement);

    const topShell = expectElement(app, ".topnav-shell", HTMLElement);
    const content = expectElement(app, ".topnav-shell__content", HTMLElement);

    expect([...topShell.classList]).toEqual(["topnav-shell"]);
    expect([...content.classList]).toEqual(["topnav-shell__content"]);
    expectElement(topShell, ".topbar-nav-toggle", HTMLElement);
    expect(topShell.children[1]).toBe(content);
    expectElement(topShell, ".topnav-shell__actions", HTMLElement);

    const toggle = expectElement(app, ".topbar-nav-toggle", HTMLElement);
    const actions = expectElement(app, ".topnav-shell__actions", HTMLElement);

    expect([...toggle.classList]).toEqual(["sidebar-menu-trigger", "topbar-nav-toggle"]);
    expect([...actions.classList]).toEqual(["topnav-shell__actions"]);
    expect(topShell.firstElementChild).toBe(toggle);
    expect(topShell.querySelector(".topbar-nav-toggle")).toBe(toggle);
    expectElement(actions, ".topbar-search", HTMLElement);
    expect(toggle.getAttribute("aria-label")).toBe("Expand sidebar");

    const nav = expectElement(app, ".shell-nav", HTMLElement);

    expect([...shell.classList]).toEqual(["shell", "shell--chat"]);
    toggle.click();
    await app.updateComplete;

    expect([...shell.classList]).toEqual(["shell", "shell--chat", "shell--nav-drawer-open"]);
    expect([...nav.classList]).toEqual(["shell-nav"]);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    const link = expectElement(app, 'a.nav-item[href="/config"]', HTMLAnchorElement);
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));

    await app.updateComplete;
    expect(app.tab).toBe("config");
    expect([...shell.classList]).toEqual(["shell"]);

    app.applySettings({ ...app.settings, navCollapsed: true });
    await app.updateComplete;

    expect(app.querySelector(".nav-section__label")).toBeNull();
    expect(app.querySelector(".sidebar-brand__logo")).toBeNull();

    expectElement(app, ".sidebar-shell__footer", HTMLElement);
    expectElement(app, ".sidebar-utility-link", HTMLElement);

    const item = expectElement(app, ".sidebar .nav-item", HTMLElement);
    const header = expectElement(app, ".sidebar-shell__header", HTMLElement);
    const sidebar = expectElement(app, ".sidebar", HTMLElement);

    expect([...sidebar.classList]).toEqual(["sidebar", "sidebar--collapsed"]);
    expectElement(item, ".nav-item__icon", HTMLElement);
    expect(item.querySelector(".nav-item__text")).toBeNull();
    expect(app.querySelector(".sidebar-brand__copy")).toBeNull();
    expectElement(header, ".nav-collapse-toggle", HTMLElement);
  });

  it("hides child nav items when the active group is collapsed", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    app.applySettings({
      ...app.settings,
      navGroupsCollapsed: { ...app.settings.navGroupsCollapsed, aics: true },
    });
    await app.updateComplete;

    const chatLink = expectElement(app, 'a.nav-item[href="/chat"]', HTMLAnchorElement);
    const section = chatLink.closest(".nav-section");
    expect(section).toBeInstanceOf(HTMLElement);
    if (!(section instanceof HTMLElement)) {
      throw new Error("Expected chat link to be inside a nav section");
    }

    expect([...section.classList]).toContain("nav-section--collapsed");
    expect(
      section
        .querySelector<HTMLButtonElement>(".nav-section__label")
        ?.getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("shows recent sessions in the sidebar and switches through them", async () => {
    const app = mountApp("/overview");
    app.sessionKey = "agent:main:second";
    app.sessionsResult = createSessionsResult([
      { key: "global", kind: "global", label: "Global", updatedAt: Date.now() },
      { key: "unknown", kind: "unknown", label: "Unknown", updatedAt: Date.now() - 10_000 },
      { key: "cron:daily", kind: "cron", label: "Daily cron", updatedAt: Date.now() - 20_000 },
      {
        key: "agent:main:subagent:task",
        label: "Subagent",
        spawnedBy: "agent:main:second",
        updatedAt: Date.now() - 25_000,
      },
      { key: "agent:main:first", label: "First workspace", updatedAt: Date.now() - 5 * 60_000 },
      { key: "agent:main:second", label: "Second workspace", updatedAt: Date.now() - 30_000 },
    ]) as typeof app.sessionsResult;
    await app.updateComplete;

    const recent = Array.from(app.querySelectorAll<HTMLAnchorElement>(".sidebar-recent-session"));
    expect(recent.map((entry) => entry.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      "Second workspace just now",
      "First workspace 5m ago",
    ]);

    const recentSection = expectElement(app, ".sidebar-recent-sessions", HTMLElement);
    const recentToggle = expectElement(
      recentSection,
      ".sidebar-recent-sessions__label",
      HTMLButtonElement,
    );
    expect(recentToggle.getAttribute("aria-expanded")).toBe("true");

    recentToggle.click();
    await app.updateComplete;

    expect(app.settings.recentSessionsCollapsed).toBe(true);
    expect(recentToggle.getAttribute("aria-expanded")).toBe("false");
    expect([...recentSection.classList]).toContain("sidebar-recent-sessions--collapsed");

    recentToggle.click();
    await app.updateComplete;

    expect(app.settings.recentSessionsCollapsed).toBe(false);
    expect(recentToggle.getAttribute("aria-expanded")).toBe("true");
    expect([...recentSection.classList]).not.toContain("sidebar-recent-sessions--collapsed");

    recent[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await app.updateComplete;

    expect(app.tab).toBe("chat");
    expect(app.sessionKey).toBe("agent:main:first");
    expect(window.location.pathname).toBe("/chat");
    expect(window.location.search).toBe("?session=agent%3Amain%3Afirst");
  });

  it("creates a new chat session from the sidebar", async () => {
    const app = mountApp("/overview");
    app.sessionKey = "agent:main:main";
    app.sessionsResult = createSessionsResult([
      { key: "agent:main:main", label: "Main Session" },
    ]) as typeof app.sessionsResult;
    app.client = {
      stop: vi.fn(),
      request: vi.fn(async (method: string) => {
        if (method === "sessions.create") {
          return { key: "agent:main:fresh" };
        }
        if (method === "sessions.list") {
          return createSessionsResult([
            { key: "agent:main:fresh", label: "Fresh session" },
            { key: "agent:main:main", label: "Main Session" },
          ]);
        }
        return null;
      }),
    } as unknown as typeof app.client;
    await app.updateComplete;

    expectButtonWithText(app, "New session").click();

    await vi.waitFor(() => {
      expect(app.sessionKey).toBe("agent:main:fresh");
    });
    expect(app.tab).toBe("chat");
    expect(window.location.pathname).toBe("/chat");
    expect(app.client?.["request"]).toHaveBeenCalledWith("sessions.create", {
      agentId: "main",
      parentSessionKey: "agent:main:main",
      emitCommandHooks: true,
    });
  });

  it("closes composer view settings on Escape, outside pointerdown, and tab changes", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    const toggle = expectElement(app, ".chat-settings-chip", HTMLButtonElement);
    const dropdown = expectElement(app, ".chat-settings-popover", HTMLElement);

    toggle.focus();
    toggle.click();
    await app.updateComplete;

    expect(app.chatMobileControlsOpen).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect([...toggle.classList]).toEqual(["chat-settings-chip", "chat-settings-chip--open"]);
    expect([...dropdown.classList]).toEqual([
      "chat-settings-popover",
      "chat-settings-popover--open",
    ]);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await app.updateComplete;
    await nextFrame();

    expect(app.chatMobileControlsOpen).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect([...dropdown.classList]).toEqual(["chat-settings-popover"]);
    expect(document.activeElement).toBe(toggle);

    toggle.click();
    await app.updateComplete;
    app.requestUpdate();
    await app.updateComplete;

    const openDropdown = expectElement(app, ".chat-settings-popover", HTMLElement);
    expect(app.chatMobileControlsOpen).toBe(true);
    expect([...openDropdown.classList]).toEqual([
      "chat-settings-popover",
      "chat-settings-popover--open",
    ]);

    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, composed: true }));
    await app.updateComplete;

    const closedDropdown = expectElement(app, ".chat-settings-popover", HTMLElement);
    expect(app.chatMobileControlsOpen).toBe(false);
    expect([...closedDropdown.classList]).toEqual(["chat-settings-popover"]);

    expectElement(app, ".chat-settings-chip", HTMLButtonElement).click();
    await app.updateComplete;
    expect(app.chatMobileControlsOpen).toBe(true);

    app.setTab("channels");
    await app.updateComplete;
    expect(app.chatMobileControlsOpen).toBe(false);
  });

  it("preserves session navigation without hiding the page chrome", async () => {
    const app = mountApp("/sessions?session=agent:main:subagent:task-123");
    await app.updateComplete;

    const link = expectElement(app, 'a.nav-item[href="/chat"]', HTMLAnchorElement);
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));

    await app.updateComplete;
    expect(app.tab).toBe("chat");
    expect(app.sessionKey).toBe("agent:main:subagent:task-123");
    expect(window.location.pathname).toBe("/chat");
    expect(window.location.search).toBe("?session=agent%3Amain%3Asubagent%3Atask-123");

    const shell = expectElement(app, ".shell", HTMLElement);
    const topbar = expectElement(app, ".topbar", HTMLElement);
    const sessionSelect = expectElement(app, ".sidebar-session-select", HTMLElement);
    expect([...shell.classList]).toEqual(["shell", "shell--chat"]);
    expect(topbar.hasAttribute("inert")).toBe(false);
    expect(topbar.hasAttribute("aria-hidden")).toBe(false);
    expect(app.querySelector(".content-header")).toBeNull();
    expect(sessionSelect.querySelector(".chat-controls__session-picker")).toBeInstanceOf(
      HTMLElement,
    );

    app.setTab("channels");

    await app.updateComplete;
    expect(app.tab).toBe("channels");
    expect([...shell.classList]).toEqual(["shell"]);
    expect(topbar.hasAttribute("inert")).toBe(false);
    expect(topbar.hasAttribute("aria-hidden")).toBe(false);
    const channelsContentHeader = expectElement(app, ".content-header", HTMLElement);
    expect(channelsContentHeader.hasAttribute("inert")).toBe(false);
    expect(channelsContentHeader.hasAttribute("aria-hidden")).toBe(false);

    const chatLink = expectElement(app, 'a.nav-item[href="/chat"]', HTMLAnchorElement);
    chatLink.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));

    await app.updateComplete;
    expect(app.tab).toBe("chat");
    expect([...shell.classList]).toEqual(["shell", "shell--chat"]);
    expect(topbar.hasAttribute("inert")).toBe(false);
    expect(topbar.hasAttribute("aria-hidden")).toBe(false);
    expect(app.querySelector(".content-header")).toBeNull();
  });

  it("auto-scrolls chat history to the latest message", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      queueMicrotask(() => callback(performance.now()));
      return 1;
    });
    const app = mountApp("/chat");
    await app.updateComplete;

    const initialContainer = app.querySelector<HTMLElement>(".chat-thread");
    expect(initialContainer).toBeInstanceOf(HTMLElement);
    const initialThread = initialContainer!;
    initialThread.style.maxHeight = "180px";
    initialThread.style.overflow = "auto";
    let scrollTop = 0;
    Object.defineProperty(initialThread, "clientHeight", {
      configurable: true,
      get: () => 180,
    });
    Object.defineProperty(initialThread, "scrollHeight", {
      configurable: true,
      get: () => 2400,
    });
    Object.defineProperty(initialThread, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    initialThread.scrollTo = ((options?: ScrollToOptions | number, y?: number) => {
      const top =
        typeof options === "number" ? (y ?? 0) : typeof options?.top === "number" ? options.top : 0;
      scrollTop = Math.max(0, Math.min(top, 2400 - 180));
    }) as typeof initialThread.scrollTo;

    app.chatMessages = Array.from({ length: 3 }, (_, index) => ({
      role: "assistant",
      content: `Line ${index}`,
      timestamp: Date.now() + index,
    }));

    await app.updateComplete;
    for (let i = 0; i < 6; i++) {
      await nextFrame();
    }

    const container = app.querySelector<HTMLElement>(".chat-thread");
    expect(container).toBeInstanceOf(HTMLElement);
    const thread = container!;
    let finalScrollTop = 0;
    Object.defineProperty(thread, "clientHeight", {
      value: 180,
      configurable: true,
    });
    Object.defineProperty(thread, "scrollHeight", {
      value: 960,
      configurable: true,
    });
    Object.defineProperty(thread, "scrollTop", {
      configurable: true,
      get: () => finalScrollTop,
      set: (value: number) => {
        finalScrollTop = value;
      },
    });
    Object.defineProperty(thread, "scrollTo", {
      configurable: true,
      value: ({ top }: { top: number }) => {
        finalScrollTop = top;
      },
    });
    const targetScrollTop = thread.scrollHeight;
    expect(targetScrollTop).toBeGreaterThan(thread.clientHeight);
    app.chatMessages = [
      ...app.chatMessages,
      {
        role: "assistant",
        content: "Line 3",
        timestamp: Date.now() + 3,
      },
    ];
    await app.updateComplete;
    for (let i = 0; i < 10; i++) {
      if (thread.scrollTop === targetScrollTop) {
        break;
      }
      await nextFrame();
    }
    expect(thread.scrollTop).toBe(targetScrollTop);
  });

  it("hydrates hash tokens, restores same-tab refreshes, and clears after gateway changes", async () => {
    const app = mountApp("/ui/overview#token=abc123");
    await app.updateComplete;

    expect(app.settings.token).toBe("abc123");
    expect(JSON.parse(localStorage.getItem("openclaw.control.settings.v1") ?? "{}").token).toBe(
      undefined,
    );
    expect(window.location.pathname).toBe("/ui/overview");
    expect(window.location.hash).toBe("");
    app.remove();

    const refreshed = mountApp("/ui/overview");
    await refreshed.updateComplete;

    expect(refreshed.settings.token).toBe("abc123");
    expect(JSON.parse(localStorage.getItem("openclaw.control.settings.v1") ?? "{}").token).toBe(
      undefined,
    );

    const gatewayUrlInput = expectElement(
      refreshed,
      'input[placeholder="ws://100.x.y.z:18789"]',
      HTMLInputElement,
    );
    gatewayUrlInput.value = "wss://other-gateway.example/openclaw";
    gatewayUrlInput.dispatchEvent(new Event("input", { bubbles: true }));
    await refreshed.updateComplete;

    expect(refreshed.settings.gatewayUrl).toBe("wss://other-gateway.example/openclaw");
    expect(refreshed.settings.token).toBe("");
  });

  it("keeps a hash token pending until the gateway URL change is confirmed", async () => {
    const app = mountApp(
      "/ui/overview?gatewayUrl=wss://other-gateway.example/openclaw#token=abc123",
    );
    await app.updateComplete;

    expect(app.settings.gatewayUrl).not.toBe("wss://other-gateway.example/openclaw");
    expect(app.settings.token).toBe("");

    await confirmPendingGatewayChange(app);

    expectConfirmedGatewayChange(app);
  });
});
