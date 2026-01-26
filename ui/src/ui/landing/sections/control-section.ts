import { html, css, LitElement, TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';

interface Agent {
  id: string;
  name: string;
  status: 'running' | 'paused' | 'pending';
  icon: string;
}

const MOCK_AGENTS: Agent[] = [
  { id: '1', name: 'Planner Agent', status: 'running', icon: '🧭' },
  { id: '2', name: 'Research Agent', status: 'running', icon: '🔍' },
  { id: '3', name: 'Delivery Agent', status: 'paused', icon: '📦' },
];

const TRUST_SIGNALS = [
  { icon: '🧾', label: 'Audit log & artifacts' },
  { icon: '✋', label: 'Approval checkpoints' },
  { icon: '🔐', label: 'Scoped permissions' },
];

@customElement('landing-control')
export class LandingControl extends LitElement {
  static styles = css`
    :host {
      display: block;
      background: var(--landing-bg-dark);
      padding: var(--landing-section-padding-y, 8rem) var(--landing-padding-x, 2rem);
      font-family: var(--landing-font-body, inherit);
      scroll-margin-top: var(--landing-scroll-offset, 92px);
    }

    .section-container {
      max-width: var(--landing-max-width-narrow, 1000px);
      margin: 0 auto;
    }

    /* Header */
    .section-header {
      text-align: center;
      margin-bottom: 4rem;
    }

    .section-label {
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--landing-primary);
      margin-bottom: 1rem;
    }

    .section-headline {
      font-family: var(--landing-font-display, inherit);
      font-size: clamp(2rem, 4vw, 3rem);
      font-weight: 700;
      line-height: 1.2;
      color: var(--landing-text-primary);
      margin: 0 0 1rem;
    }

    .section-subheadline {
      font-size: 1.125rem;
      color: var(--landing-text-secondary);
      max-width: 600px;
      margin: 0 auto;
    }

    /* Section next CTA */
    .section-next {
      display: flex;
      justify-content: center;
      margin-top: 2.5rem;
    }

    .next-button {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.75rem 1.125rem;
      font-size: 0.9375rem;
      font-weight: 600;
      color: var(--landing-text-primary);
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--landing-border);
      border-radius: 999px;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .next-button:hover {
      transform: translateY(-1px);
      border-color: var(--landing-border-hover);
      background: rgba(255, 255, 255, 0.05);
    }

    .next-button:focus-visible {
      outline: 2px solid var(--landing-primary);
      outline-offset: 2px;
    }

    .next-arrow {
      color: var(--landing-primary);
    }

    /* Dashboard mockup */
    .dashboard {
      background: var(--landing-bg-surface);
      border: 1px solid var(--landing-border);
      border-radius: 20px;
      overflow: hidden;
      box-shadow: var(--landing-shadow-lg);
      opacity: 0;
      transform: translateY(30px) scale(0.98);
      transition: all 0.8s ease-out;
    }

    .dashboard.is-visible {
      opacity: 1;
      transform: translateY(0) scale(1);
    }

    /* Dashboard header */
    .dashboard-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 1rem 1.5rem;
      border-bottom: 1px solid var(--landing-border);
      background: var(--landing-bg-elevated);
    }

    .dashboard-title {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      font-size: 0.875rem;
      font-weight: 600;
      color: var(--landing-text-primary);
    }

    .dashboard-title-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--landing-accent-teal);
      animation: pulse 2s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    .dashboard-action {
      padding: 0.5rem 1rem;
      font-size: 0.75rem;
      font-weight: 500;
      color: var(--landing-text-muted);
      background: transparent;
      border: 1px solid var(--landing-border);
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .dashboard-action:hover {
      color: var(--landing-text-primary);
      border-color: var(--landing-border-hover);
    }

    .dashboard-action:focus-visible {
      outline: 2px solid var(--landing-primary);
      outline-offset: 2px;
    }

    /* Dashboard body */
    .dashboard-body {
      padding: 1.5rem;
    }

    /* Agent cards grid */
    .agents-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 1rem;
      margin-bottom: 1.5rem;
    }

    .agent-card {
      padding: 1.25rem;
      background: var(--landing-bg-elevated);
      border: 1px solid var(--landing-border);
      border-radius: 12px;
      transition: all 0.3s ease;
    }

    .agent-card:hover {
      border-color: var(--landing-border-hover);
    }

    .agent-header {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 0.75rem;
    }

    .agent-icon {
      font-size: 1.5rem;
    }

    .agent-name {
      font-size: 0.875rem;
      font-weight: 600;
      color: var(--landing-text-primary);
    }

    .agent-status {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.75rem;
      color: var(--landing-text-muted);
      margin-bottom: 1rem;
    }

    .status-indicator {
      width: 6px;
      height: 6px;
      border-radius: 50%;
    }

    .status-indicator.running {
      background: var(--landing-accent-teal);
    }

    .status-indicator.paused {
      background: var(--landing-accent-warm);
    }

    .agent-actions {
      display: flex;
      gap: 0.5rem;
    }

    .agent-action {
      padding: 0.375rem 0.75rem;
      font-size: 0.75rem;
      font-weight: 500;
      color: var(--landing-text-muted);
      background: var(--landing-bg-surface);
      border: 1px solid var(--landing-border);
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .agent-action:hover {
      color: var(--landing-text-primary);
      border-color: var(--landing-border-hover);
    }

    .agent-action:focus-visible {
      outline: 2px solid var(--landing-primary);
      outline-offset: 2px;
    }

    /* Guardrail row */
    .guardrail-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 1rem 1.25rem;
      background: var(--landing-bg-elevated);
      border: 1px solid var(--landing-border);
      border-radius: 12px;
    }

    .guardrail-content {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .guardrail-icon {
      color: var(--landing-accent-warm);
    }

    .guardrail-label {
      font-size: 0.875rem;
      color: var(--landing-text-secondary);
    }

    .guardrail-label strong {
      color: var(--landing-text-primary);
    }

    .guardrail-action {
      padding: 0.375rem 0.75rem;
      font-size: 0.75rem;
      font-weight: 500;
      color: var(--landing-primary);
      background: transparent;
      border: 1px solid var(--landing-primary);
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .guardrail-action:hover {
      background: rgba(99, 102, 241, 0.1);
    }

    .guardrail-action:focus-visible {
      outline: 2px solid var(--landing-primary);
      outline-offset: 2px;
    }

    /* Trust signals */
    .trust-signals {
      display: flex;
      justify-content: center;
      gap: 3rem;
      margin-top: 3rem;
    }

    .trust-signal {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.875rem;
      color: var(--landing-text-muted);
      opacity: 0;
      transform: translateY(10px);
      transition: all 0.5s ease-out;
    }

    .trust-signal.is-visible {
      opacity: 1;
      transform: translateY(0);
    }

    .trust-signal-icon {
      font-size: 1rem;
    }

    /* Responsive */
    @media (max-width: 768px) {
      .agents-grid {
        grid-template-columns: 1fr;
      }

      .trust-signals {
        flex-direction: column;
        align-items: center;
        gap: 1rem;
      }

      .guardrail-row {
        flex-direction: column;
        gap: 1rem;
        text-align: center;
      }

      .guardrail-content {
        flex-direction: column;
      }
    }

    @media (max-width: 480px) {
      .dashboard-header {
        padding: 0.875rem 1.125rem;
      }

      .dashboard-body {
        padding: 1.125rem;
      }

      .next-button {
        width: 100%;
        max-width: 320px;
        justify-content: center;
      }
    }
  `;

  @state()
  private isVisible = false;

  firstUpdated(): void {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            this.isVisible = true;
            observer.disconnect();
          }
        });
      },
      { threshold: 0.2 }
    );

    observer.observe(this);
  }

  private renderAgent(agent: Agent): TemplateResult {
    const statusLabel = agent.status === 'running' ? 'Running' : 'Paused';
    const actionLabel = agent.status === 'running' ? 'View' : 'Resume';

    return html`
      <div class="agent-card">
        <div class="agent-header">
          <span class="agent-icon">${agent.icon}</span>
          <span class="agent-name">${agent.name}</span>
        </div>
        <div class="agent-status">
          <span class="status-indicator ${agent.status}"></span>
          <span>${statusLabel}</span>
        </div>
        <div class="agent-actions">
          <button class="agent-action">${actionLabel}</button>
          ${agent.status === 'running' ? html`
            <button class="agent-action">Stop</button>
          ` : ''}
        </div>
      </div>
    `;
  }

  render(): TemplateResult {
    const visibleClass = this.isVisible ? 'is-visible' : '';

    return html`
      <section id="control-section">
        <div class="section-container">
          <div class="section-header">
            <span class="section-label">Safety & Control</span>
            <h2 class="section-headline">Autonomous, with guardrails.</h2>
            <p class="section-subheadline">
              Define scopes, approvals, and policies. Review before sensitive actions, and keep a full audit trail.
            </p>
          </div>

          <div class="dashboard ${visibleClass}">
            <div class="dashboard-header">
              <div class="dashboard-title">
                <span class="dashboard-title-dot"></span>
                Active Agents (3)
              </div>
              <button class="dashboard-action">Pause All</button>
            </div>

            <div class="dashboard-body">
              <div class="agents-grid">
                ${MOCK_AGENTS.map(agent => this.renderAgent(agent))}
              </div>

              <div class="guardrail-row">
                <div class="guardrail-content">
                  <svg class="guardrail-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                  </svg>
                  <span class="guardrail-label">
                    <strong>Guardrail:</strong> "Never send without approval"
                  </span>
                </div>
                <button class="guardrail-action">Edit</button>
              </div>
            </div>
          </div>

          <div class="trust-signals">
            ${TRUST_SIGNALS.map((signal, i) => html`
              <div
                class="trust-signal ${visibleClass}"
                style="transition-delay: ${300 + i * 150}ms"
              >
                <span class="trust-signal-icon">${signal.icon}</span>
                <span>${signal.label}</span>
              </div>
            `)}
          </div>

          <div class="section-next">
            <button class="next-button" @click=${this.handleNext}>
              Next: Watch a run in action <span class="next-arrow">→</span>
            </button>
          </div>
        </div>
      </section>
    `;
  }

  private handleNext(): void {
    this.dispatchEvent(new CustomEvent('landing-navigate', {
      detail: { section: 'activity' },
      bubbles: true,
      composed: true,
    }));
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'landing-control': LandingControl;
  }
}
