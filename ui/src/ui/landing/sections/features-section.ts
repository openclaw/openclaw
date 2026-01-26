import { html, css, LitElement, TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';

interface Feature {
  id: string;
  icon: string;
  title: string;
  description: string;
  size: 'large' | 'medium' | 'small';
  accent?: string;
}

const FEATURES: Feature[] = [
  {
    id: 'orchestration',
    icon: '🤖',
    title: 'Multi-Agent Orchestration',
    description: 'Coordinate specialized agents under a single objective. Clawdbrain plans the work, delegates tasks, and keeps the run aligned.',
    size: 'large',
    accent: 'primary',
  },
  {
    id: 'execution',
    icon: '🎯',
    title: 'Goal-Driven Execution',
    description: 'Define the outcome, constraints, and tools. Agents execute step-by-step with checkpoints and clear artifacts.',
    size: 'medium',
  },
  {
    id: 'memory',
    icon: '🧠',
    title: 'Persistent Memory',
    description: 'Shared memory captures decisions, preferences, and context so every run starts smarter than the last.',
    size: 'medium',
  },
  {
    id: 'approvals',
    icon: '✅',
    title: 'Human-in-the-Loop',
    description: 'Approval gates for sensitive actions—send, merge, deploy—so autonomy never becomes risk.',
    size: 'small',
  },
  {
    id: 'observability',
    icon: '📊',
    title: 'Observability',
    description: 'Live activity timelines, logs, and outputs you can audit and replay.',
    size: 'small',
  },
  {
    id: 'integrations',
    icon: '🔗',
    title: 'Tool Integrations',
    description: 'Connect the tools you already use and let agents operate where work happens.',
    size: 'small',
  },
];

@customElement('landing-features')
export class LandingFeatures extends LitElement {
  static styles = css`
    :host {
      display: block;
      background: var(--landing-bg-elevated);
      padding: var(--landing-section-padding-y, 8rem) var(--landing-padding-x, 2rem);
      font-family: var(--landing-font-body, inherit);
      scroll-margin-top: var(--landing-scroll-offset, 92px);
    }

    .section-container {
      max-width: var(--landing-max-width, 1100px);
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
      margin: 0;
    }

    .section-subheadline {
      margin: 1rem auto 0;
      max-width: 720px;
      font-size: 1.125rem;
      line-height: 1.7;
      color: var(--landing-text-secondary);
    }

    /* Bento grid */
    .bento-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      grid-template-rows: repeat(3, auto);
      gap: 1.25rem;
    }

    /* Feature card base */
    .feature-card {
      position: relative;
      padding: 2rem;
      background: var(--landing-bg-surface);
      border: 1px solid var(--landing-border);
      border-radius: 20px;
      overflow: hidden;
      opacity: 0;
      transform: translateY(20px);
      transition: all 0.6s ease-out;
    }

    .feature-card.is-visible {
      opacity: 1;
      transform: translateY(0);
    }

    .feature-card:hover {
      border-color: var(--landing-border-hover);
      transform: translateY(-4px);
      box-shadow: var(--landing-shadow-md);
    }

    .feature-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 100%;
      background: var(--landing-gradient-card);
      pointer-events: none;
    }

    /* Size variants */
    .feature-card.large {
      grid-column: span 2;
      grid-row: span 2;
    }

    .feature-card.medium {
      grid-column: span 1;
      grid-row: span 1;
    }

    .feature-card.small {
      grid-column: span 1;
      grid-row: span 1;
    }

    /* Card content */
    .feature-icon {
      font-size: 2.5rem;
      margin-bottom: 1.5rem;
      opacity: 0.9;
    }

    .feature-card.large .feature-icon {
      font-size: 3.5rem;
    }

    .feature-title {
      font-size: 1.25rem;
      font-weight: 600;
      color: var(--landing-text-primary);
      margin-bottom: 0.75rem;
    }

    .feature-card.large .feature-title {
      font-size: 1.5rem;
    }

    .feature-description {
      font-size: 0.9375rem;
      line-height: 1.6;
      color: var(--landing-text-secondary);
    }

    .feature-card.large .feature-description {
      font-size: 1rem;
      max-width: 400px;
    }

    /* Primary accent card */
    .feature-card.accent-primary {
      border-color: rgba(99, 102, 241, 0.3);
      background: linear-gradient(
        135deg,
        rgba(99, 102, 241, 0.1) 0%,
        var(--landing-bg-surface) 50%
      );
    }

    .feature-card.accent-primary:hover {
      border-color: rgba(99, 102, 241, 0.5);
      box-shadow: var(--landing-shadow-glow);
    }

    /* Section next CTA */
    .section-next {
      display: flex;
      justify-content: center;
      margin-top: 3.5rem;
    }

    .next-button {
      font-family: var(--landing-font-body, inherit);
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

    /* Responsive */
    @media (max-width: 1024px) {
      .bento-grid {
        grid-template-columns: repeat(2, 1fr);
      }

      .feature-card.large {
        grid-column: span 2;
        grid-row: span 1;
      }
    }

    @media (max-width: 768px) {
      .bento-grid {
        grid-template-columns: 1fr;
      }

      .feature-card.large,
      .feature-card.medium,
      .feature-card.small {
        grid-column: span 1;
        grid-row: span 1;
      }
    }

    @media (max-width: 480px) {
      .feature-card {
        padding: 1.5rem;
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
      { threshold: 0.1 }
    );

    observer.observe(this);
  }

  private renderFeatureCard(feature: Feature, index: number): TemplateResult {
    const visibleClass = this.isVisible ? 'is-visible' : '';
    const accentClass = feature.accent ? `accent-${feature.accent}` : '';
    const delay = index * 100;

    return html`
      <div
        class="feature-card ${feature.size} ${accentClass} ${visibleClass}"
        style="transition-delay: ${delay}ms"
      >
        <div class="feature-icon">${feature.icon}</div>
        <h3 class="feature-title">${feature.title}</h3>
        <p class="feature-description">${feature.description}</p>
      </div>
    `;
  }

  render(): TemplateResult {
    return html`
      <section id="features-section">
        <div class="section-container">
          <div class="section-header">
            <span class="section-label">Platform</span>
            <h2 class="section-headline">Autonomous AI agent orchestration—end to end.</h2>
            <p class="section-subheadline">
              Give Clawdbrain a goal and it coordinates agents to plan, execute, and report—across your tools,
              with memory and guardrails built in.
            </p>
          </div>

          <div class="bento-grid">
            ${FEATURES.map((feature, i) => this.renderFeatureCard(feature, i))}
          </div>

          <div class="section-next">
            <button class="next-button" @click=${this.handleNext}>
              Next: Shared memory & alignment <span class="next-arrow">→</span>
            </button>
          </div>
        </div>
      </section>
    `;
  }

  private handleNext(): void {
    this.dispatchEvent(new CustomEvent('landing-navigate', {
      detail: { section: 'understanding' },
      bubbles: true,
      composed: true,
    }));
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'landing-features': LandingFeatures;
  }
}
