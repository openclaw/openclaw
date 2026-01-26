import { html, css, LitElement, TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { TextRotator, initParallax } from '../animation-utils';

interface FloatingCard {
  id: string;
  icon: string;
  label: string;
  status: 'active' | 'complete' | 'pending';
  position: {
    top?: string;
    bottom?: string;
    left?: string;
    right?: string;
  };
  rotation: number;
  parallaxSpeed: number;
}

const FLOATING_CARDS: FloatingCard[] = [
  {
    id: 'planning',
    icon: '🧭',
    label: 'Planning the run',
    status: 'active',
    position: { top: '15%', left: '8%' },
    rotation: -3,
    parallaxSpeed: 0.3,
  },
  {
    id: 'coordinating',
    icon: '🤖',
    label: 'Coordinating agents',
    status: 'active',
    position: { top: '20%', right: '10%' },
    rotation: 4,
    parallaxSpeed: 0.5,
  },
  {
    id: 'executing',
    icon: '⚡',
    label: 'Executing tasks',
    status: 'active',
    position: { bottom: '25%', left: '12%' },
    rotation: 2,
    parallaxSpeed: 0.4,
  },
  {
    id: 'reporting',
    icon: '✅',
    label: 'Results ready',
    status: 'complete',
    position: { bottom: '20%', right: '8%' },
    rotation: -2,
    parallaxSpeed: 0.6,
  },
];

const ROTATING_TEXTS = [
  'Across your tools.',
  'With shared memory.',
  'With guardrails.',
  'From goal to done.',
];

@customElement('landing-hero')
export class LandingHero extends LitElement {
  static styles = css`
    :host {
      display: block;
      position: relative;
      min-height: 100vh;
      overflow: hidden;
      background: var(--landing-bg-dark);
    }

    /* Aurora background effect */
    .hero-background {
      position: absolute;
      inset: 0;
      z-index: 0;
      background: var(--landing-gradient-aurora);
      opacity: 0.8;
    }

    .hero-background::before {
      content: '';
      position: absolute;
      inset: 0;
      background: var(--landing-gradient-hero);
    }

    /* Animated mesh gradient */
    .hero-mesh {
      position: absolute;
      inset: 0;
      z-index: 1;
      opacity: 0.4;
      background:
        radial-gradient(circle at 20% 80%, rgba(99, 102, 241, 0.15) 0%, transparent 50%),
        radial-gradient(circle at 80% 20%, rgba(168, 85, 247, 0.1) 0%, transparent 50%),
        radial-gradient(circle at 40% 40%, rgba(45, 212, 191, 0.08) 0%, transparent 40%);
      animation: meshMove 20s ease-in-out infinite;
    }

    @keyframes meshMove {
      0%, 100% { transform: translate(0, 0) scale(1); }
      25% { transform: translate(2%, -2%) scale(1.02); }
      50% { transform: translate(-1%, 1%) scale(0.98); }
      75% { transform: translate(1%, 2%) scale(1.01); }
    }

    /* Content container */
    .hero-content {
      position: relative;
      z-index: 10;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 2rem var(--landing-padding-x, 2rem);
      text-align: center;
    }

    /* Headline */
    .hero-headline {
      font-family: var(--landing-font-display, inherit);
      font-size: clamp(2.5rem, 6vw, 4.5rem);
      font-weight: 700;
      line-height: 1.1;
      letter-spacing: -0.02em;
      color: var(--landing-text-primary);
      margin: 0 0 0.5rem;
      opacity: 0;
      animation: fadeInUp 0.8s ease-out 0.2s forwards;
      max-width: 800px;
    }

    @keyframes fadeInUp {
      from {
        opacity: 0;
        transform: translateY(30px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    @keyframes float {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-10px); }
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    /* Rotating text line */
    .hero-rotating-line {
      font-family: var(--landing-font-display, inherit);
      font-size: clamp(2.5rem, 6vw, 4.5rem);
      font-weight: 700;
      line-height: 1.1;
      letter-spacing: -0.02em;
      margin: 0.25rem 0 0;
      opacity: 0;
      animation: fadeInUp 0.8s ease-out 0.35s forwards;
      display: inline-block;
      min-width: 300px;
      height: 1.2em;
      overflow: hidden;
      position: relative;
    }

    .hero-rotating-text {
      display: inline-block;
      background: linear-gradient(
        135deg,
        var(--landing-primary) 0%,
        var(--landing-accent-lavender) 50%,
        var(--landing-accent-teal) 100%
      );
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      background-size: 200% 100%;
      animation: gradientShift 6s ease-in-out infinite;
    }

    @keyframes gradientShift {
      0%, 100% { background-position: 0% 50%; }
      50% { background-position: 100% 50%; }
    }

    /* Subheadline */
    .hero-subheadline {
      font-family: var(--landing-font-body, inherit);
      max-width: 560px;
      margin: 2rem auto;
      font-size: clamp(1rem, 2vw, 1.25rem);
      line-height: 1.7;
      color: var(--landing-text-secondary);
      opacity: 0;
      animation: fadeInUp 0.8s ease-out 0.5s forwards;
    }

    /* CTA buttons */
    .hero-ctas {
      display: flex;
      gap: 1rem;
      margin-top: 2rem;
      opacity: 0;
      animation: fadeInUp 0.8s ease-out 0.65s forwards;
    }

    .cta-primary {
      font-family: var(--landing-font-body, inherit);
      padding: 1rem 2rem;
      font-size: 1rem;
      font-weight: 600;
      color: white;
      background: var(--landing-primary);
      border: none;
      border-radius: 12px;
      cursor: pointer;
      transition: all 0.2s ease;
      box-shadow: var(--landing-shadow-md), var(--landing-shadow-glow);
    }

    .cta-primary:hover {
      transform: translateY(-2px);
      box-shadow: var(--landing-shadow-lg), 0 0 60px rgba(99, 102, 241, 0.4);
    }

    .cta-primary:active {
      transform: translateY(0);
    }

    .cta-primary:focus-visible {
      outline: 2px solid var(--landing-primary-light, #818cf8);
      outline-offset: 2px;
    }

    .cta-secondary {
      font-family: var(--landing-font-body, inherit);
      padding: 1rem 2rem;
      font-size: 1rem;
      font-weight: 600;
      color: var(--landing-text-primary);
      background: transparent;
      border: 1px solid var(--landing-border);
      border-radius: 12px;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .cta-secondary:hover {
      background: rgba(255, 255, 255, 0.05);
      border-color: var(--landing-border-hover);
      transform: translateY(-1px);
    }

    .cta-secondary:active {
      transform: translateY(0);
    }

    .cta-secondary:focus-visible {
      outline: 2px solid var(--landing-primary);
      outline-offset: 2px;
    }

    /* Social proof hint */
    .hero-social-hint {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-top: 3rem;
      opacity: 0;
      animation: fadeInUp 0.8s ease-out 0.8s forwards;
    }

    .hero-avatars {
      display: flex;
    }

    .hero-avatar {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      border: 2px solid var(--landing-bg-dark);
      background: linear-gradient(135deg, var(--landing-primary), var(--landing-accent-lavender));
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.75rem;
      color: white;
      font-weight: 600;
    }

    .hero-avatar + .hero-avatar {
      margin-left: -8px;
    }

    .hero-social-text {
      font-family: var(--landing-font-body, inherit);
      font-size: 0.875rem;
      color: var(--landing-text-muted);
    }

    .hero-social-text strong {
      color: var(--landing-text-secondary);
    }

    /* Floating cards */
    .floating-card {
      position: absolute;
      z-index: 5;
      padding: 0.75rem 1rem;
      background: var(--landing-glass-bg);
      backdrop-filter: var(--landing-glass-blur);
      -webkit-backdrop-filter: var(--landing-glass-blur);
      border: 1px solid var(--landing-glass-border);
      border-radius: 12px;
      box-shadow: var(--landing-shadow-md);
      opacity: 0;
      animation: fadeIn 0.6s ease-out forwards;
      transition: transform 0.3s ease, box-shadow 0.3s ease;
      --parallax-y: 0px;
      transform: rotate(var(--card-rotation, 0deg)) translateY(var(--parallax-y, 0px));
    }

    .floating-card:hover {
      transform: rotate(var(--card-rotation, 0deg)) translateY(var(--parallax-y, 0px)) scale(1.05);
      box-shadow: var(--landing-shadow-lg);
    }

    .floating-card-content {
      display: flex;
      align-items: center;
      gap: 0.625rem;
      white-space: nowrap;
    }

    .floating-card-icon {
      font-size: 1.125rem;
    }

    .floating-card-label {
      font-family: var(--landing-font-body, inherit);
      font-size: 0.875rem;
      font-weight: 500;
      color: var(--landing-text-secondary);
    }

    .floating-card-status {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      margin-left: 0.25rem;
      flex-shrink: 0;
    }

    .floating-card-status.active {
      background: var(--landing-accent-teal);
      animation: pulse 2s ease-in-out infinite;
    }

    .floating-card-status.complete {
      background: var(--landing-accent-warm);
    }

    /* Scroll indicator */
    .scroll-indicator {
      position: absolute;
      bottom: 2rem;
      left: 50%;
      transform: translateX(-50%);
      opacity: 0;
      animation: fadeIn 0.6s ease-out 1.2s forwards;
      cursor: pointer;
    }

    .scroll-indicator:hover .scroll-arrow {
      color: var(--landing-text-secondary);
    }

    .scroll-indicator:focus-visible {
      outline: 2px solid var(--landing-primary);
      outline-offset: 4px;
      border-radius: 50%;
    }

    .scroll-arrow {
      width: 24px;
      height: 24px;
      color: var(--landing-text-muted);
      animation: float 2s ease-in-out infinite;
      transition: color 0.2s ease;
    }

    /* Responsive */
    @media (max-width: 768px) {
      .floating-card {
        display: none;
      }

      .hero-ctas {
        flex-direction: column;
        width: 100%;
        max-width: 300px;
      }

      .cta-primary,
      .cta-secondary {
        width: 100%;
        text-align: center;
      }
    }

    @media (max-width: 480px) {
      .hero-social-hint {
        margin-top: 2rem;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .hero-mesh {
        animation: none;
      }

      .hero-headline,
      .hero-rotating-line,
      .hero-subheadline,
      .hero-ctas,
      .hero-social-hint,
      .scroll-indicator,
      .floating-card {
        animation: none !important;
        opacity: 1;
      }

      .scroll-arrow {
        animation: none;
      }
    }
  `;

  @state()
  private parallaxCleanup?: () => void;

  private textRotator?: TextRotator;

  firstUpdated(): void {
    this.parallaxCleanup = initParallax(this.renderRoot as HTMLElement);

    const rotatingEl = this.renderRoot.querySelector('.hero-rotating-text');
    if (rotatingEl) {
      this.textRotator = new TextRotator(
        rotatingEl as HTMLElement,
        ROTATING_TEXTS,
        3000
      );
      this.textRotator.start();
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.parallaxCleanup?.();
    this.textRotator?.stop();
  }

  private renderFloatingCard(card: FloatingCard, index: number): TemplateResult {
    const style = `
      top: ${card.position.top || 'auto'};
      bottom: ${card.position.bottom || 'auto'};
      left: ${card.position.left || 'auto'};
      right: ${card.position.right || 'auto'};
      --card-rotation: ${card.rotation}deg;
      --parallax-speed: ${card.parallaxSpeed};
      animation-delay: ${0.8 + index * 0.15}s;
    `;

    return html`
      <div
        class="floating-card parallax-layer"
        style=${style}
      >
        <div class="floating-card-content">
          <span class="floating-card-icon">${card.icon}</span>
          <span class="floating-card-label">${card.label}</span>
          <span class="floating-card-status ${card.status}"></span>
        </div>
      </div>
    `;
  }

  render(): TemplateResult {
    return html`
      <section class="hero">
        <div class="hero-background"></div>
        <div class="hero-mesh"></div>

        ${FLOATING_CARDS.map((card, i) => this.renderFloatingCard(card, i))}

        <div class="hero-content">
          <h1 class="hero-headline">
            Orchestrate Autonomous AI Agents.
          </h1>
          <div class="hero-rotating-line">
            <span class="hero-rotating-text">${ROTATING_TEXTS[0]}</span>
          </div>

          <p class="hero-subheadline">
            Clawdbrain coordinates a fleet of specialized agents to plan, execute, and verify work across your stack.
            Persistent memory keeps every agent aligned—approvals and audit trails keep you in control.
          </p>

          <div class="hero-ctas">
            <button class="cta-primary" @click=${this.handleGetStarted}>
              Get Started
            </button>
            <button class="cta-secondary" @click=${this.handleLearnMore}>
              See It In Action
            </button>
          </div>

          <div class="hero-social-hint">
            <div class="hero-avatars">
              <div class="hero-avatar">S</div>
              <div class="hero-avatar">M</div>
              <div class="hero-avatar">E</div>
            </div>
            <span class="hero-social-text">
              Trusted by <strong>early teams</strong> building agentic workflows
            </span>
          </div>
        </div>

        <div
          class="scroll-indicator"
          role="button"
          tabindex="0"
          aria-label="Scroll to learn more"
          @click=${this.handleLearnMore}
          @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.handleLearnMore(); } }}
        >
          <svg class="scroll-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M7 13l5 5 5-5M7 6l5 5 5-5"/>
          </svg>
        </div>
      </section>
    `;
  }

  private handleGetStarted(): void {
    this.dispatchEvent(new CustomEvent('get-started', { bubbles: true, composed: true }));
  }

  private handleLearnMore(): void {
    this.dispatchEvent(new CustomEvent('learn-more', { bubbles: true, composed: true }));
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'landing-hero': LandingHero;
  }
}
