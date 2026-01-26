import { html, css, LitElement, TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';

interface ActivityEvent {
  id: string;
  time: string;
  icon: string;
  title: string;
  description: string;
  status: 'complete' | 'active';
}

const ACTIVITY_EVENTS: ActivityEvent[] = [
  {
    id: '1',
    time: '09:12',
    icon: '🧭',
    title: 'Plan generated',
    description: 'Goal broken into tasks with owners',
    status: 'complete',
  },
  {
    id: '2',
    time: '09:18',
    icon: '🔍',
    title: 'Research executed',
    description: 'Sources collected and summarized',
    status: 'complete',
  },
  {
    id: '3',
    time: '09:41',
    icon: '🛠️',
    title: 'Changes prepared',
    description: 'Draft PR and rollout notes created',
    status: 'complete',
  },
  {
    id: '4',
    time: 'Now',
    icon: '✅',
    title: 'Approval requested',
    description: 'Review before merge & message send',
    status: 'active',
  },
];

const FEATURE_CALLOUTS = [
  { icon: '⏱️', title: 'Runs continuously with checkpoints' },
  { icon: '🧾', title: 'Every action logged & replayable' },
  { icon: '✋', title: 'Asks before sensitive steps' },
];

@customElement('landing-activity')
export class LandingActivity extends LitElement {
  static styles = css`
    :host {
      display: block;
      background: var(--landing-bg-elevated);
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
      margin: 0;
    }

    .section-subheadline {
      font-size: 1.25rem;
      color: var(--landing-text-muted);
      margin-top: 0.5rem;
    }

    /* Timeline */
    .timeline {
      position: relative;
      display: flex;
      justify-content: space-between;
      padding: 2rem 0;
      margin-bottom: 4rem;
      overflow-x: auto;
      scrollbar-width: none;
    }

    .timeline::-webkit-scrollbar {
      display: none;
    }

    /* Timeline line */
    .timeline::before {
      content: '';
      position: absolute;
      top: 50%;
      left: 0;
      right: 0;
      height: 2px;
      background: var(--landing-border);
      transform: translateY(-50%);
    }

    .timeline-line-animated {
      position: absolute;
      top: 50%;
      left: 0;
      height: 2px;
      background: linear-gradient(90deg, var(--landing-primary), var(--landing-accent-teal));
      transform: translateY(-50%);
      width: 0;
      transition: width 1.5s ease-out;
    }

    .timeline-line-animated.is-visible {
      width: 100%;
    }

    /* Timeline event */
    .timeline-event {
      position: relative;
      flex: 1;
      min-width: 200px;
      padding: 0 1rem;
      opacity: 0;
      transform: translateY(20px);
      transition: all 0.6s ease-out;
    }

    .timeline-event.is-visible {
      opacity: 1;
      transform: translateY(0);
    }

    .event-card {
      background: var(--landing-bg-surface);
      border: 1px solid var(--landing-border);
      border-radius: 16px;
      padding: 1.5rem;
      text-align: center;
      transition: all 0.3s ease;
    }

    .event-card:hover {
      transform: translateY(-4px);
      border-color: var(--landing-border-hover);
      box-shadow: var(--landing-shadow-md);
    }

    .event-card.active {
      border-color: var(--landing-primary);
      box-shadow: var(--landing-shadow-glow);
    }

    .event-time {
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--landing-text-muted);
      margin-bottom: 0.75rem;
    }

    .event-card.active .event-time {
      color: var(--landing-primary);
    }

    .event-icon {
      font-size: 2rem;
      margin-bottom: 0.75rem;
    }

    .event-title {
      font-size: 1rem;
      font-weight: 600;
      color: var(--landing-text-primary);
      margin-bottom: 0.25rem;
    }

    .event-description {
      font-size: 0.875rem;
      color: var(--landing-text-muted);
    }

    /* Status dot */
    .event-status {
      position: absolute;
      bottom: -30px;
      left: 50%;
      transform: translateX(-50%);
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: var(--landing-bg-surface);
      border: 2px solid var(--landing-border);
      z-index: 1;
    }

    .event-status.complete {
      background: var(--landing-accent-teal);
      border-color: var(--landing-accent-teal);
    }

    .event-status.active {
      background: var(--landing-primary);
      border-color: var(--landing-primary);
      animation: pulseGlow 2s ease-in-out infinite;
    }

    @keyframes pulseGlow {
      0%, 100% {
        box-shadow: 0 0 10px rgba(99, 102, 241, 0.3);
      }
      50% {
        box-shadow: 0 0 20px rgba(99, 102, 241, 0.6);
      }
    }

    /* Feature callouts */
    .callouts {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 2rem;
    }

    .callout {
      text-align: center;
      opacity: 0;
      transform: translateY(20px);
      transition: all 0.6s ease-out;
    }

    .callout.is-visible {
      opacity: 1;
      transform: translateY(0);
    }

    .callout-icon {
      font-size: 2rem;
      margin-bottom: 0.75rem;
    }

    .callout-title {
      font-size: 1rem;
      font-weight: 500;
      color: var(--landing-text-secondary);
    }

    /* Section next CTA */
    .section-next {
      display: flex;
      justify-content: center;
      margin-top: 3rem;
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

    /* Responsive */
    @media (max-width: 768px) {
      .timeline {
        flex-direction: column;
        gap: 1.5rem;
      }

      .timeline::before {
        top: 0;
        bottom: 0;
        left: 50%;
        right: auto;
        width: 2px;
        height: 100%;
        transform: translateX(-50%);
      }

      .timeline-line-animated {
        top: 0;
        left: 50%;
        width: 2px !important;
        height: 0;
        transform: translateX(-50%);
        transition: height 1.5s ease-out;
      }

      .timeline-line-animated.is-visible {
        height: 100%;
      }

      .timeline-event {
        min-width: auto;
        padding: 0;
      }

      .event-status {
        left: -30px;
        bottom: auto;
        top: 50%;
        transform: translateY(-50%);
      }

      .callouts {
        grid-template-columns: 1fr;
        gap: 1.5rem;
      }
    }

    @media (max-width: 480px) {
      .timeline-event {
        transform: translateY(12px);
      }

      .event-card {
        padding: 1.25rem;
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

  private renderEvent(event: ActivityEvent, index: number): TemplateResult {
    const visibleClass = this.isVisible ? 'is-visible' : '';
    const delay = index * 200;

    return html`
      <div
        class="timeline-event ${visibleClass}"
        style="transition-delay: ${delay}ms"
      >
        <div class="event-card ${event.status}">
          <div class="event-time">${event.time}</div>
          <div class="event-icon">${event.icon}</div>
          <div class="event-title">${event.title}</div>
          <div class="event-description">${event.description}</div>
        </div>
        <div class="event-status ${event.status}"></div>
      </div>
    `;
  }

  render(): TemplateResult {
    const visibleClass = this.isVisible ? 'is-visible' : '';

    return html`
      <section id="activity-section">
        <div class="section-container">
          <div class="section-header">
            <span class="section-label">How It Works</span>
            <h2 class="section-headline">From goal to outcome—without babysitting.</h2>
            <p class="section-subheadline">A coordinated run you can monitor, steer, and approve.</p>
          </div>

          <div class="timeline">
            <div class="timeline-line-animated ${visibleClass}"></div>
            ${ACTIVITY_EVENTS.map((event, i) => this.renderEvent(event, i))}
          </div>

          <div class="callouts">
            ${FEATURE_CALLOUTS.map((callout, i) => html`
              <div
                class="callout ${visibleClass}"
                style="transition-delay: ${800 + i * 150}ms"
              >
                <div class="callout-icon">${callout.icon}</div>
                <div class="callout-title">${callout.title}</div>
              </div>
            `)}
          </div>

          <div class="section-next">
            <button class="next-button" @click=${this.handleNext}>
              Next: Stories & getting started <span class="next-arrow">→</span>
            </button>
          </div>
        </div>
      </section>
    `;
  }

  private handleNext(): void {
    this.dispatchEvent(new CustomEvent('landing-navigate', {
      detail: { section: 'social-proof' },
      bubbles: true,
      composed: true,
    }));
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'landing-activity': LandingActivity;
  }
}
