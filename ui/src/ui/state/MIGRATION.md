# State Migration Guide

## 概述

本指南说明如何从 `app.ts` 的 `@state` 属性迁移到状态切片模式。

## 背景

`app.ts` 当前有 150+ 个 `@state` 属性，导致：
- 组件耦合度高
- 难以测试
- 状态管理混乱

新的状态切片模式使用 Lit Context 提供：
- 按领域分组的状态
- 组件独立注入
- 更好的可测试性

## 迁移步骤

### 1. 使用 StateMixin（推荐）

```typescript
// 之前
import { customElement, property } from 'lit/decorators.js';
import type { OpenClawApp } from './app.ts';

@customElement('my-component')
export class MyComponent extends LitElement {
  @property({ type: Object }) app!: OpenClawApp;

  render() {
    return html`Messages: ${this.app.chatMessages.length}`;
  }
}

// 之后
import { customElement } from 'lit/decorators.js';
import { StateMixin } from './state/state-mixin.ts';

@customElement('my-component')
export class MyComponent extends StateMixin(LitElement) {
  render() {
    return html`Messages: ${this.chatState.chatMessages.length}`;
  }
}
```

### 2. 使用 @consume 装饰器（细粒度控制）

```typescript
import { LitElement } from 'lit';
import { customElement } from 'lit/decorators.js';
import { consume } from '@lit/context';
import { chatStateContext, type ChatState } from './state/index.ts';

@customElement('my-component')
export class MyComponent extends LitElement {
  @consume({ context: chatStateContext, subscribe: true })
  chatState!: ChatState;

  render() {
    return html`${this.chatState.chatMessage}`;
  }
}
```

### 3. 更新状态

```typescript
import { getStateUpdater } from './state/state-mixin.ts';

// 在事件处理器中
handleSendMessage() {
  const updater = getStateUpdater(this);
  updater?.updateChatState({
    chatMessage: '',
    chatSending: true,
  });
}
```

## 状态切片映射

| 原属性 | 新切片 | 新属性名 |
|--------|--------|----------|
| chatMessages | ChatState | chatMessages |
| chatStream | ChatState | chatStream |
| chatAttachments | ChatState | chatAttachments |
| configRaw | ConfigState | configRaw |
| configSchema | ConfigState | configSchema |
| agentsList | AgentsState | agentsList |
| toolsEffectiveResult | AgentsState | toolsEffectiveResult |
| tab | UIState | tab |
| theme | UIState | theme |
| sidebarOpen | UIState | sidebarOpen |
| sessionsResult | SessionsState | sessionsResult |
| logsEntries | LogsState | logsEntries |
| cronJobs | CronState | cronJobs |
| usageResult | UsageState | usageResult |

## 兼容性

迁移期间保持向后兼容：

1. `app.ts` 保留原有 `@state` 属性
2. 组件可以逐步迁移
3. StateProvider 自动同步状态

## 测试

测试组件时可以单独提供状态：

```typescript
import { fixture, html } from '@open-wc/testing';
import { StateProvider } from './state/state-provider.ts';

const el = await fixture(html`
  <state-provider>
    <my-component></my-component>
  </state-provider>
`);

// 直接访问状态
el.chatState = { ...el.chatState, chatMessage: 'test' };
await el.updateComplete;
```

## 下一步

1. 创建 StateProvider 实例包装 `<openclaw-app>`
2. 更新高频组件（chat-view, config-view 等）
3. 逐步移除 app.ts 中的 @state 属性