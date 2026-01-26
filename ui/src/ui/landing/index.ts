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
      font-family: var(--landing-font-body, var(--font-body, system-ui, sans-serif));
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
      padding: 1rem var(--landing-padding-x, 2rem);
      transition: all 0.3s ease;
    }

    .landing-nav.scrolled {
      background: rgba(10, 10, 15, 0.85);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border-bottom: 1px solid var(--landing-border);
      padding: 0.75rem var(--landing-padding-x, 2rem);
    }

    :host-context([data-theme="light"]) .landing-nav.scrolled {
      background: rgba(255, 255, 255, 0.85);
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
        padding: 0.75rem var(--landing-padding-x, 1.5rem);
      }

      .nav-links {
        gap: 1rem;
      }

      .nav-link {
        display: none;
      }
    }

    @media (max-width: 480px) {
      .nav-cta {
        padding: 0.5rem 1rem;
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
          <button class="nav-link" @click=${this.scrollToSection.bind(this, 'features')}>Platform</button>
          <button class="nav-link" @click=${this.scrollToSection.bind(this, 'activity')}>How it works</button>
          <button class="nav-link" @click=${this.scrollToSection.bind(this, 'control')}>Safety</button>
          <button class="nav-link" @click=${this.scrollToSection.bind(this, 'social-proof')}>Stories</button>
          <button class="nav-cta" @click=${this.handleGetStarted}>
            Get Started
          </button>
        </div>
      </nav>

      <div class="landing-wrapper" @landing-navigate=${this.handleLandingNavigate}>
        <landing-hero
          @get-started=${this.handleGetStarted}
          @learn-more=${() => this.scrollToSection('features')}
        ></landing-hero>

        <landing-features></landing-features>

        <landing-understanding></landing-understanding>

        <landing-control></landing-control>

        <landing-activity></landing-activity>

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

  private handleLandingNavigate(event: CustomEvent<{ section: string }>): void {
    event.stopPropagation();
    this.scrollToSection(event.detail.section);
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
