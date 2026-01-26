import { html, css, LitElement, TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { createScrollObserver } from '../animation-utils';

interface MemoryTile {
  id: string;
  type: 'goal' | 'constraint' | 'tool' | 'preference';
  icon: string;
  label: string;
  color: string;
  delay: number;
}

const MEMORY_TILES: MemoryTile[] = [
  { id: 'goal-1', type: 'goal', icon: '🎯', label: 'Ship v1 in 2 weeks', color: 'primary', delay: 0 },
  { id: 'goal-2', type: 'goal', icon: '🚀', label: 'Launch onboarding flow', color: 'lavender', delay: 100 },
  { id: 'constraint-1', type: 'constraint', icon: '🛡️', label: 'No prod changes without approval', color: 'amber', delay: 250 },
  { id: 'constraint-2', type: 'constraint', icon: '⏱️', label: 'Daily status at 9:00 AM', color: 'teal', delay: 350 },
  { id: 'tool-1', type: 'tool', icon: '🔗', label: 'GitHub + CI', color: 'primary', delay: 500 },
  { id: 'tool-2', type: 'tool', icon: '💬', label: 'Slack', color: 'teal', delay: 600 },
  { id: 'preference-1', type: 'preference', icon: '✍️', label: 'Concise summaries', color: 'lavender', delay: 720 },
  { id: 'preference-2', type: 'preference', icon: '🧩', label: 'TypeScript-first', color: 'coral', delay: 820 },
];

@customElement('landing-understanding')
export class LandingUnderstanding extends LitElement {
  static styles = css`
    :host {
      display: block;
      background: var(--landing-bg-dark);
      padding: var(--landing-section-padding-y, 8rem) var(--landing-padding-x, 2rem);
      font-family: var(--landing-font-body, inherit);
      scroll-margin-top: var(--landing-scroll-offset, 92px);
    }

    .section-container {
      max-width: 1200px;
      margin: 0 auto;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 4rem;
      align-items: center;
    }

    /* Left column - Text */
    .text-column {
      opacity: 0;
      transform: translateX(-30px);
      transition: all 0.8s ease-out;
    }

    .text-column.is-visible {
      opacity: 1;
      transform: translateX(0);
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
      margin: 0 0 1.5rem;
    }

    .section-body {
      font-size: 1.125rem;
      line-height: 1.8;
      color: var(--landing-text-secondary);
    }

    .section-body strong {
      color: var(--landing-text-primary);
      font-weight: 500;
    }

    .section-footnote {
      margin-top: 2rem;
      font-size: 0.875rem;
      color: var(--landing-text-muted);
      font-style: italic;
    }

    /* Right column - Profile card */
    .profile-column {
      display: flex;
      justify-content: center;
    }

    .profile-card {
      position: relative;
      width: 100%;
      max-width: 400px;
      min-height: 450px;
      padding: 2rem;
      background: var(--landing-bg-surface);
      border: 1px solid var(--landing-border);
      border-radius: 24px;
      box-shadow: var(--landing-shadow-lg);
    }

    .profile-card::before {
      content: '';
      position: absolute;
      inset: -1px;
      border-radius: 24px;
      background: linear-gradient(
        135deg,
        rgba(99, 102, 241, 0.3) 0%,
        transparent 50%,
        rgba(45, 212, 191, 0.2) 100%
      );
      z-index: -1;
      opacity: 0;
      transition: opacity 0.3s ease;
    }

    .profile-card:hover::before {
      opacity: 1;
    }

    .profile-header {
      display: flex;
      align-items: center;
      gap: 1rem;
      margin-bottom: 2rem;
      padding-bottom: 1.5rem;
      border-bottom: 1px solid var(--landing-border);
    }

    .profile-avatar {
      width: 48px;
      height: 48px;
      border-radius: 50%;
      background: linear-gradient(135deg, var(--landing-primary), var(--landing-accent-lavender));
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.5rem;
    }

    .profile-name {
      font-size: 1.125rem;
      font-weight: 600;
      color: var(--landing-text-primary);
    }

    .profile-subtitle {
      font-size: 0.875rem;
      color: var(--landing-text-muted);
    }

    /* Tiles container */
    .tiles-container {
      display: flex;
      flex-wrap: wrap;
      gap: 0.75rem;
    }

    /* Individual tile */
    .profile-tile {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.625rem 1rem;
      background: var(--landing-bg-elevated);
      border: 1px solid var(--landing-border);
      border-radius: 100px;
      font-size: 0.875rem;
      color: var(--landing-text-secondary);
      opacity: 0;
      transform: translateY(20px) scale(0.9);
      transition: all 0.5s cubic-bezier(0.34, 1.56, 0.64, 1);
    }

    .profile-tile.is-visible {
      opacity: 1;
      transform: translateY(0) scale(1);
    }

    .profile-tile:hover {
      transform: translateY(-2px) scale(1.02);
      border-color: var(--landing-border-hover);
    }

    .tile-icon {
      font-size: 1rem;
    }

    /* Color variants */
    .profile-tile.amber {
      border-color: rgba(245, 158, 11, 0.3);
      background: rgba(245, 158, 11, 0.1);
    }

    .profile-tile.coral {
      border-color: rgba(251, 113, 133, 0.3);
      background: rgba(251, 113, 133, 0.1);
    }

    .profile-tile.teal {
      border-color: rgba(45, 212, 191, 0.3);
      background: rgba(45, 212, 191, 0.1);
    }

    .profile-tile.lavender {
      border-color: rgba(167, 139, 250, 0.3);
      background: rgba(167, 139, 250, 0.1);
    }

    .profile-tile.primary {
      border-color: rgba(99, 102, 241, 0.3);
      background: rgba(99, 102, 241, 0.1);
    }

    /* Section dividers in profile */
    .tile-section {
      width: 100%;
      margin: 1rem 0 0.5rem;
    }

    .tile-section-label {
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--landing-text-muted);
    }

    /* Section next CTA */
    .section-next {
      margin-top: 2.25rem;
      display: flex;
      justify-content: flex-start;
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
    @media (max-width: 1024px) {
      .section-container {
        gap: 3rem;
      }
    }

    @media (max-width: 768px) {
      .section-container {
        grid-template-columns: 1fr;
        gap: 3rem;
      }

      .text-column {
        text-align: center;
      }

      .profile-column {
        order: -1;
      }

      .section-next {
        justify-content: center;
      }
    }
  `;

  @state()
  private tilesVisible = false;

  private observer?: IntersectionObserver;

  connectedCallback(): void {
    super.connectedCallback();
  }

  firstUpdated(): void {
    this.observer = createScrollObserver({ threshold: 0.3 });

    const textColumn = this.renderRoot.querySelector('.text-column');
    if (textColumn) {
      this.observer.observe(textColumn);
    }

    // Observe profile card for tile animations
    const profileCard = this.renderRoot.querySelector('.profile-card');
    if (profileCard) {
      const tileObserver = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              this.tilesVisible = true;
              tileObserver.disconnect();
            }
          });
        },
        { threshold: 0.2 }
      );
      tileObserver.observe(profileCard);
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.observer?.disconnect();
  }

  private renderTile(tile: MemoryTile): TemplateResult {
    const visibleClass = this.tilesVisible ? 'is-visible' : '';

    return html`
      <div
        class="profile-tile ${tile.color} ${visibleClass}"
        style="transition-delay: ${tile.delay}ms"
      >
        <span class="tile-icon">${tile.icon}</span>
        <span>${tile.label}</span>
      </div>
    `;
  }

  render(): TemplateResult {
    const goals = MEMORY_TILES.filter(t => t.type === 'goal');
    const constraints = MEMORY_TILES.filter(t => t.type === 'constraint');
    const tools = MEMORY_TILES.filter(t => t.type === 'tool');
    const preferences = MEMORY_TILES.filter(t => t.type === 'preference');

    return html`
      <section id="understanding-section">
        <div class="section-container">
          <div class="text-column animate-on-scroll">
            <span class="section-label">Persistent Memory</span>
            <h2 class="section-headline">
              Shared context that keeps every agent aligned.
            </h2>
            <p class="section-body">
              Clawdbrain builds a durable memory layer for your workspace—goals, constraints, tools, and decisions.
            </p>
            <p class="section-body">
              Every agent runs with the same north star, so handoffs are clean and execution stays on track.
            </p>
            <p class="section-footnote">
              You can inspect and edit memory at any time.
            </p>

            <div class="section-next">
              <button class="next-button" @click=${this.handleNext}>
                Next: Safety & control <span class="next-arrow">→</span>
              </button>
            </div>
          </div>

          <div class="profile-column">
            <div class="profile-card">
              <div class="profile-header">
                <div class="profile-avatar">🧠</div>
                <div>
                  <div class="profile-name">Workspace Memory</div>
                  <div class="profile-subtitle">Shared across agents</div>
                </div>
              </div>

              <div class="tile-section">
                <span class="tile-section-label">Goals</span>
              </div>
              <div class="tiles-container">
                ${goals.map(t => this.renderTile(t))}
              </div>

              <div class="tile-section">
                <span class="tile-section-label">Constraints</span>
              </div>
              <div class="tiles-container">
                ${constraints.map(t => this.renderTile(t))}
              </div>

              <div class="tile-section">
                <span class="tile-section-label">Tools</span>
              </div>
              <div class="tiles-container">
                ${tools.map(t => this.renderTile(t))}
              </div>

              <div class="tile-section">
                <span class="tile-section-label">Preferences</span>
              </div>
              <div class="tiles-container">
                ${preferences.map(t => this.renderTile(t))}
              </div>
            </div>
          </div>
        </div>
      </section>
    `;
  }

  private handleNext(): void {
    this.dispatchEvent(new CustomEvent('landing-navigate', {
      detail: { section: 'control' },
      bubbles: true,
      composed: true,
    }));
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'landing-understanding': LandingUnderstanding;
  }
}
