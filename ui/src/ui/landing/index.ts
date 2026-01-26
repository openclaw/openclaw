/**
 * Clawdbrain Landing Page
 *
 * Main component that composes all landing page sections together.
 * This creates a full-page scrolling experience with scroll-triggered
 * animations and parallax effects.
 */

import { html, css, LitElement, TemplateResult, nothing } from 'lit';
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

    /* Skip-to-content for accessibility */
    .skip-to-content {
      position: absolute;
      top: -100%;
      left: 50%;
      transform: translateX(-50%);
      z-index: 200;
      padding: 0.75rem 1.5rem;
      background: var(--landing-primary);
      color: white;
      font-weight: 600;
      border-radius: 0 0 8px 8px;
      text-decoration: none;
      transition: top 0.2s ease;
    }

    .skip-to-content:focus {
      top: 0;
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

    /* Hamburger menu button (mobile) */
    .nav-hamburger {
      display: none;
      background: none;
      border: none;
      cursor: pointer;
      padding: 0.5rem;
      color: var(--landing-text-primary);
      z-index: 110;
    }

    .nav-hamburger svg {
      width: 24px;
      height: 24px;
      transition: transform 0.3s ease;
    }

    .nav-hamburger:focus-visible {
      outline: 2px solid var(--landing-primary);
      outline-offset: 2px;
      border-radius: 4px;
    }

    /* Mobile overlay menu */
    .mobile-menu-overlay {
      display: none;
      position: fixed;
      inset: 0;
      z-index: 99;
      background: rgba(0, 0, 0, 0.6);
      opacity: 0;
      transition: opacity 0.3s ease;
    }

    .mobile-menu-overlay.open {
      opacity: 1;
    }

    .mobile-menu {
      display: none;
      position: fixed;
      top: 0;
      right: 0;
      bottom: 0;
      z-index: 105;
      width: 280px;
      max-width: 80vw;
      background: rgba(10, 10, 15, 0.95);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border-left: 1px solid var(--landing-border);
      flex-direction: column;
      padding: 5rem 2rem 2rem;
      gap: 0.5rem;
      transform: translateX(100%);
      transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }

    .mobile-menu.open {
      transform: translateX(0);
    }

    :host-context([data-theme="light"]) .mobile-menu {
      background: rgba(255, 255, 255, 0.95);
    }

    .mobile-menu-link {
      font-size: 1.125rem;
      font-weight: 500;
      color: var(--landing-text-secondary);
      text-decoration: none;
      cursor: pointer;
      background: none;
      border: none;
      padding: 0.875rem 0;
      text-align: left;
      transition: color 0.2s ease;
      border-bottom: 1px solid var(--landing-border);
    }

    .mobile-menu-link:hover,
    .mobile-menu-link:focus {
      color: var(--landing-text-primary);
    }

    .mobile-menu-link:focus-visible {
      outline: 2px solid var(--landing-primary);
      outline-offset: 2px;
      border-radius: 4px;
    }

    .mobile-menu-cta {
      margin-top: 1rem;
      padding: 0.875rem 1.5rem;
      font-size: 1rem;
      font-weight: 600;
      color: white;
      background: var(--landing-primary);
      border: none;
      border-radius: 10px;
      cursor: pointer;
      transition: all 0.2s ease;
      text-align: center;
    }

    .mobile-menu-cta:hover {
      background: var(--landing-primary-light);
    }

    .mobile-menu-cta:focus-visible {
      outline: 2px solid var(--landing-primary-light);
      outline-offset: 2px;
    }

    /* Back-to-top button */
    .back-to-top {
      position: fixed;
      bottom: 2rem;
      right: 2rem;
      z-index: 90;
      width: 44px;
      height: 44px;
      border-radius: 50%;
      background: var(--landing-primary);
      color: white;
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: var(--landing-shadow-md);
      opacity: 0;
      transform: translateY(20px);
      transition: opacity 0.3s ease, transform 0.3s ease, background 0.2s ease;
      pointer-events: none;
    }

    .back-to-top.visible {
      opacity: 1;
      transform: translateY(0);
      pointer-events: auto;
    }

    .back-to-top:hover {
      background: var(--landing-primary-light);
      transform: translateY(-2px);
    }

    .back-to-top:focus-visible {
      outline: 2px solid var(--landing-primary-light);
      outline-offset: 2px;
    }

    .back-to-top svg {
      width: 20px;
      height: 20px;
    }

    /* Responsive — Tablet */
    @media (max-width: 1024px) {
      .nav-links {
        gap: 1.5rem;
      }
    }

    /* Responsive — Mobile */
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

      .nav-hamburger {
        display: flex;
        align-items: center;
      }

      .mobile-menu-overlay {
        display: block;
        pointer-events: none;
      }

      .mobile-menu-overlay.open {
        pointer-events: auto;
      }

      .mobile-menu {
        display: flex;
      }
    }

    @media (max-width: 480px) {
      .nav-cta {
        padding: 0.5rem 1rem;
      }

      .back-to-top {
        bottom: 1.25rem;
        right: 1.25rem;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .mobile-menu,
      .mobile-menu-overlay,
      .back-to-top {
        transition: none;
      }
    }
  `;

  @state()
  private navScrolled = false;

  @state()
  private showBackToTop = false;

  @state()
  private mobileMenuOpen = false;

  private scrollHandler?: () => void;

  connectedCallback(): void {
    super.connectedCallback();
    this.scrollHandler = () => {
      this.navScrolled = window.scrollY > 50;
      this.showBackToTop = window.scrollY > 600;
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
      <a class="skip-to-content" href="#main-content">Skip to content</a>

      <nav class="landing-nav ${this.navScrolled ? 'scrolled' : ''}" role="navigation" aria-label="Main navigation">
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
          <button
            class="nav-hamburger"
            @click=${this.toggleMobileMenu}
            aria-label="${this.mobileMenuOpen ? 'Close menu' : 'Open menu'}"
            aria-expanded="${this.mobileMenuOpen}"
            aria-controls="mobile-menu"
          >
            ${this.mobileMenuOpen
              ? html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>`
              : html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 12h18M3 6h18M3 18h18"/></svg>`
            }
          </button>
        </div>
      </nav>

      <!-- Mobile slide-out menu -->
      <div
        class="mobile-menu-overlay ${this.mobileMenuOpen ? 'open' : ''}"
        @click=${this.closeMobileMenu}
      ></div>
      <div
        id="mobile-menu"
        class="mobile-menu ${this.mobileMenuOpen ? 'open' : ''}"
        role="dialog"
        aria-label="Mobile navigation"
      >
        <button class="mobile-menu-link" @click=${() => this.mobileNavigate('features')}>Platform</button>
        <button class="mobile-menu-link" @click=${() => this.mobileNavigate('activity')}>How it works</button>
        <button class="mobile-menu-link" @click=${() => this.mobileNavigate('control')}>Safety</button>
        <button class="mobile-menu-link" @click=${() => this.mobileNavigate('social-proof')}>Stories</button>
        <button class="mobile-menu-cta" @click=${() => { this.closeMobileMenu(); this.handleGetStarted(); }}>
          Get Started
        </button>
      </div>

      <div class="landing-wrapper" id="main-content" @landing-navigate=${this.handleLandingNavigate}>
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

      <!-- Back-to-top button -->
      <button
        class="back-to-top ${this.showBackToTop ? 'visible' : ''}"
        @click=${this.scrollToTop}
        aria-label="Back to top"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 15l-6-6-6 6"/>
        </svg>
      </button>
    `;
  }

  private toggleMobileMenu(): void {
    this.mobileMenuOpen = !this.mobileMenuOpen;
    // Prevent body scroll when menu is open
    document.body.style.overflow = this.mobileMenuOpen ? 'hidden' : '';
  }

  private closeMobileMenu(): void {
    this.mobileMenuOpen = false;
    document.body.style.overflow = '';
  }

  private mobileNavigate(section: string): void {
    this.closeMobileMenu();
    // Small delay so the menu animates closed before scrolling
    setTimeout(() => this.scrollToSection(section), 100);
  }

  private scrollToTop(): void {
    window.scrollTo({ top: 0, behavior: 'smooth' });
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
