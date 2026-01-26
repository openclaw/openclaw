import { html, css, LitElement, TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';

const NAV_LINKS = [
  { label: 'Product', href: '#' },
  { label: 'Pricing', href: '#' },
  { label: 'Docs', href: '#' },
  { label: 'Blog', href: '#' },
  { label: 'Contact', href: '#' },
];

const SOCIAL_LINKS = [
  { icon: 'twitter', href: '#', label: 'Twitter' },
  { icon: 'github', href: '#', label: 'GitHub' },
  { icon: 'discord', href: '#', label: 'Discord' },
];

const LEGAL_LINKS = [
  { label: 'Privacy', href: '#' },
  { label: 'Terms', href: '#' },
];

@customElement('landing-footer')
export class LandingFooter extends LitElement {
  static styles = css`
    :host {
      display: block;
      background: var(--landing-bg-dark);
      border-top: 1px solid var(--landing-border);
      font-family: var(--landing-font-body, inherit);
    }

    .footer-container {
      max-width: var(--landing-max-width, 1100px);
      margin: 0 auto;
      padding: 3rem var(--landing-padding-x, 2rem);
    }

    .footer-main {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 2rem;
      padding-bottom: 2rem;
      border-bottom: 1px solid var(--landing-border);
    }

    .footer-brand {
      display: flex;
      flex-direction: column;
      gap: 0.375rem;
    }

    .footer-logo {
      font-family: var(--landing-font-display, inherit);
      font-size: 1.25rem;
      font-weight: 600;
      color: var(--landing-text-primary);
      text-decoration: none;
      letter-spacing: -0.02em;
    }

    .footer-logo span {
      background: linear-gradient(135deg, var(--landing-primary), var(--landing-accent-lavender));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .footer-tagline {
      font-size: 0.875rem;
      line-height: 1.4;
      color: var(--landing-text-muted);
      max-width: 360px;
    }

    .footer-nav {
      display: flex;
      gap: 2rem;
    }

    .footer-nav-link {
      font-size: 0.875rem;
      color: var(--landing-text-muted);
      text-decoration: none;
      transition: color 0.2s ease;
    }

    .footer-nav-link:hover {
      color: var(--landing-text-primary);
    }

    .footer-nav-link:focus-visible {
      outline: 2px solid var(--landing-primary);
      outline-offset: 2px;
      border-radius: 4px;
    }

    .footer-social {
      display: flex;
      gap: 1rem;
    }

    .footer-social-link {
      width: 36px;
      height: 36px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      background: var(--landing-bg-surface);
      border: 1px solid var(--landing-border);
      color: var(--landing-text-muted);
      transition: all 0.2s ease;
      text-decoration: none;
    }

    .footer-social-link:hover {
      border-color: var(--landing-border-hover);
      color: var(--landing-text-primary);
    }

    .footer-social-link:focus-visible {
      outline: 2px solid var(--landing-primary);
      outline-offset: 2px;
    }

    .footer-social-icon {
      width: 18px;
      height: 18px;
    }

    .footer-bottom {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .footer-copyright {
      font-size: 0.8125rem;
      color: var(--landing-text-muted);
    }

    .footer-legal {
      display: flex;
      gap: 1.5rem;
    }

    .footer-legal-link {
      font-size: 0.8125rem;
      color: var(--landing-text-muted);
      text-decoration: none;
      transition: color 0.2s ease;
    }

    .footer-legal-link:hover {
      color: var(--landing-text-primary);
    }

    .footer-legal-link:focus-visible {
      outline: 2px solid var(--landing-primary);
      outline-offset: 2px;
      border-radius: 4px;
    }

    .footer-logo:focus-visible {
      outline: 2px solid var(--landing-primary);
      outline-offset: 4px;
      border-radius: 4px;
    }

    /* Responsive */
    @media (max-width: 768px) {
      .footer-main {
        flex-direction: column;
        gap: 2rem;
        text-align: center;
      }

      .footer-brand {
        align-items: center;
      }

      .footer-nav {
        flex-wrap: wrap;
        justify-content: center;
        gap: 1rem;
      }

      .footer-bottom {
        flex-direction: column;
        gap: 1rem;
        text-align: center;
      }
    }

    @media (max-width: 480px) {
      .footer-container {
        padding-top: 2.5rem;
        padding-bottom: 2.5rem;
      }
    }
  `;

  private renderSocialIcon(icon: string): TemplateResult {
    switch (icon) {
      case 'twitter':
        return html`
          <svg class="footer-social-icon" viewBox="0 0 24 24" fill="currentColor">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
          </svg>
        `;
      case 'github':
        return html`
          <svg class="footer-social-icon" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
          </svg>
        `;
      case 'discord':
        return html`
          <svg class="footer-social-icon" viewBox="0 0 24 24" fill="currentColor">
            <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
          </svg>
        `;
      default:
        return html``;
    }
  }

  render(): TemplateResult {
    const year = new Date().getFullYear();

    return html`
      <footer>
        <div class="footer-container">
          <div class="footer-main">
            <div class="footer-brand">
              <a href="/" class="footer-logo">
                Clawd<span>brain</span>
              </a>
              <div class="footer-tagline">
                Autonomous AI agent orchestration with memory, approvals, and observability.
              </div>
            </div>

            <nav class="footer-nav">
              ${NAV_LINKS.map(link => html`
                <a href=${link.href} class="footer-nav-link">${link.label}</a>
              `)}
            </nav>

            <div class="footer-social">
              ${SOCIAL_LINKS.map(link => html`
                <a
                  href=${link.href}
                  class="footer-social-link"
                  aria-label=${link.label}
                >
                  ${this.renderSocialIcon(link.icon)}
                </a>
              `)}
            </div>
          </div>

          <div class="footer-bottom">
            <p class="footer-copyright">
              © ${year} Clawdbrain. All rights reserved.
            </p>

            <div class="footer-legal">
              ${LEGAL_LINKS.map(link => html`
                <a href=${link.href} class="footer-legal-link">${link.label}</a>
              `)}
            </div>
          </div>
        </div>
      </footer>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'landing-footer': LandingFooter;
  }
}
