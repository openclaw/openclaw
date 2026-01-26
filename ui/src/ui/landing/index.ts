/**
 * Clawdbrain Landing Page
 *
 * Main component that composes all landing page sections together.
 * This creates a full-page scrolling experience with scroll-triggered
 * animations and parallax effects.
 */

import { html, css, LitElement, TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';

// Import all section components
import './sections/hero-section';
import './sections/understanding-section';
import './sections/activity-section';
import './sections/control-section';
import './sections/features-section';
import './sections/social-proof-section';
import './sections/footer-section';

@customElement('landing-page')
export class LandingPage extends LitElement {
  static styles = css`
    :host {
      display: block;
      min-height: 100vh;
      background: var(--landing-bg-dark);
      color: var(--landing-text-primary);

      /* Landing page design tokens */
      --landing-primary: #6366f1;
      --landing-primary-light: #818cf8;
      --landing-primary-dark: #4f46e5;

      --landing-accent-warm: #f59e0b;
      --landing-accent-coral: #fb7185;
      --landing-accent-teal: #2dd4bf;
      --landing-accent-lavender: #a78bfa;

      --landing-bg-dark: #0a0a0f;
      --landing-bg-elevated: #12121a;
      --landing-bg-surface: #1a1a24;
      --landing-border: rgba(255, 255, 255, 0.08);
      --landing-border-hover: rgba(255, 255, 255, 0.15);

      --landing-text-primary: #f8fafc;
      --landing-text-secondary: #94a3b8;
      --landing-text-muted: #64748b;

      --landing-gradient-hero: linear-gradient(
        135deg,
        rgba(99, 102, 241, 0.15) 0%,
        rgba(168, 85, 247, 0.08) 50%,
        rgba(45, 212, 191, 0.05) 100%
      );

      --landing-gradient-aurora: radial-gradient(
        ellipse 80% 50% at 50% -20%,
        rgba(99, 102, 241, 0.3) 0%,
        transparent 70%
      );

      --landing-gradient-card: linear-gradient(
        180deg,
        rgba(255, 255, 255, 0.05) 0%,
        rgba(255, 255, 255, 0.02) 100%
      );

      --landing-shadow-sm: 0 2px 8px rgba(0, 0, 0, 0.3);
      --landing-shadow-md: 0 4px 20px rgba(0, 0, 0, 0.4);
      --landing-shadow-lg: 0 8px 40px rgba(0, 0, 0, 0.5);
      --landing-shadow-glow: 0 0 40px rgba(99, 102, 241, 0.3);

      --landing-glass-bg: rgba(255, 255, 255, 0.03);
      --landing-glass-border: rgba(255, 255, 255, 0.08);
      --landing-glass-blur: blur(20px);

      --landing-font-display: 'Unbounded', 'Times New Roman', serif;
      --landing-font-body: 'Work Sans', system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
    }

    /* Light mode support */
    :host([data-theme="light"]) {
      --landing-bg-dark: #fafafa;
      --landing-bg-elevated: #ffffff;
      --landing-bg-surface: #f8fafc;
      --landing-border: rgba(0, 0, 0, 0.06);
      --landing-border-hover: rgba(0, 0, 0, 0.12);
      --landing-text-primary: #0f172a;
      --landing-text-secondary: #475569;
      --landing-text-muted: #64748b;
      --landing-shadow-sm: 0 2px 8px rgba(0, 0, 0, 0.1);
      --landing-shadow-md: 0 4px 20px rgba(0, 0, 0, 0.1);
      --landing-shadow-lg: 0 8px 40px rgba(0, 0, 0, 0.15);

      --landing-gradient-aurora: radial-gradient(
        ellipse 80% 50% at 50% -20%,
        rgba(99, 102, 241, 0.1) 0%,
        transparent 70%
      );
    }

    .landing-wrapper {
      display: flex;
      flex-direction: column;
    }

    /* Sticky navigation */
    .landing-nav {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      z-index: 100;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 1rem 2rem;
      transition: all 0.3s ease;
    }

    .landing-nav.scrolled {
      background: rgba(10, 10, 15, 0.85);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border-bottom: 1px solid var(--landing-border);
      padding: 0.75rem 2rem;
    }

    .nav-logo {
      font-size: 1.25rem;
      font-weight: 700;
      color: var(--landing-text-primary);
      text-decoration: none;
      letter-spacing: -0.02em;
    }

    .nav-logo span {
      background: linear-gradient(135deg, var(--landing-primary), var(--landing-accent-lavender));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .nav-links {
      display: flex;
      align-items: center;
      gap: 2rem;
    }

    .nav-link {
      font-size: 0.875rem;
      font-weight: 500;
      color: var(--landing-text-muted);
      text-decoration: none;
      cursor: pointer;
      background: none;
      border: none;
      padding: 0;
      transition: color 0.2s ease;
    }

    .nav-link:hover {
      color: var(--landing-text-primary);
    }

    .nav-link:focus-visible {
      outline: 2px solid var(--landing-primary);
      outline-offset: 2px;
      border-radius: 4px;
    }

    .nav-logo:focus-visible {
      outline: 2px solid var(--landing-primary);
      outline-offset: 4px;
      border-radius: 4px;
    }

    .nav-cta {
      padding: 0.5rem 1.25rem;
      font-size: 0.875rem;
      font-weight: 600;
      color: white;
      background: var(--landing-primary);
      border: none;
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .nav-cta:hover {
      background: var(--landing-primary-light);
      transform: translateY(-1px);
    }

    .nav-cta:focus-visible {
      outline: 2px solid var(--landing-primary-light);
      outline-offset: 2px;
    }

    /* Responsive */
    @media (max-width: 768px) {
      .landing-nav {
        padding: 0.75rem 1rem;
      }

      .nav-links {
        gap: 1rem;
      }

      .nav-link {
        display: none;
      }
    }
  `;

  @state()
  private navScrolled = false;

  private scrollHandler?: () => void;

  connectedCallback(): void {
    super.connectedCallback();
    this.scrollHandler = () => {
      this.navScrolled = window.scrollY > 50;
    };
    window.addEventListener('scroll', this.scrollHandler, { passive: true });
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.scrollHandler) {
      window.removeEventListener('scroll', this.scrollHandler);
    }
  }

  render(): TemplateResult {
    return html`
      <nav class="landing-nav ${this.navScrolled ? 'scrolled' : ''}">
        <a href="/" class="nav-logo">
          Clawd<span>brain</span>
        </a>
        <div class="nav-links">
          <button class="nav-link" @click=${this.scrollToSection.bind(this, 'features')}>Features</button>
          <button class="nav-link" @click=${this.scrollToSection.bind(this, 'control')}>Trust</button>
          <button class="nav-link" @click=${this.scrollToSection.bind(this, 'social-proof')}>Stories</button>
          <button class="nav-cta" @click=${this.handleGetStarted}>
            Get Started
          </button>
        </div>
      </nav>

      <div class="landing-wrapper">
        <landing-hero
          @get-started=${this.handleGetStarted}
          @learn-more=${() => this.scrollToSection('understanding')}
        ></landing-hero>

        <landing-understanding></landing-understanding>

        <landing-activity></landing-activity>

        <landing-control></landing-control>

        <landing-features></landing-features>

        <landing-social-proof
          @get-started=${this.handleGetStarted}
          @book-demo=${this.handleBookDemo}
        ></landing-social-proof>

        <landing-footer></landing-footer>
      </div>
    `;
  }

  private scrollToSection(sectionId: string): void {
    const sectionMap: Record<string, string> = {
      'understanding': 'landing-understanding',
      'activity': 'landing-activity',
      'control': 'landing-control',
      'features': 'landing-features',
      'social-proof': 'landing-social-proof',
    };
    const tagName = sectionMap[sectionId];
    if (!tagName) return;
    const el = this.renderRoot.querySelector(tagName);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  private handleGetStarted(): void {
    this.dispatchEvent(new CustomEvent('get-started', { bubbles: true, composed: true }));
  }

  private handleBookDemo(): void {
    this.dispatchEvent(new CustomEvent('book-demo', { bubbles: true, composed: true }));
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'landing-page': LandingPage;
  }
}

// Export all components for potential individual use
export { LandingHero } from './sections/hero-section';
export { LandingUnderstanding } from './sections/understanding-section';
export { LandingActivity } from './sections/activity-section';
export { LandingControl } from './sections/control-section';
export { LandingFeatures } from './sections/features-section';
export { LandingSocialProof } from './sections/social-proof-section';
export { LandingFooter } from './sections/footer-section';
