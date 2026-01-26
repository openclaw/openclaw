import { html, css, LitElement, TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';

interface Testimonial {
  id: string;
  quote: string;
  author: string;
  role: string;
  avatar: string;
  transformation?: string;
}

const TESTIMONIALS: Testimonial[] = [
  {
    id: '1',
    quote: 'We replaced a patchwork of scripts with an agent workflow. Clawdbrain now plans the run, opens PRs, and posts daily summaries.',
    author: 'Alex P.',
    role: 'Engineering lead',
    avatar: 'A',
    transformation: 'Manual ops → Automated runs',
  },
  {
    id: '2',
    quote: 'I give it a goal and get back a report with sources, drafts, and next steps. The shared memory means it keeps getting better.',
    author: 'Jamie L.',
    role: 'Product manager',
    avatar: 'J',
    transformation: 'Busywork → Leverage',
  },
  {
    id: '3',
    quote: 'The approval gates are a game-changer. Agents move fast without risking customer comms or production changes.',
    author: 'Priya S.',
    role: 'Security & compliance',
    avatar: 'P',
    transformation: 'Risky automation → Guardrailed autonomy',
  },
];

const TRUST_BADGES = [
  'No credit card required',
  'Approval gates included',
  'Audit logs by default',
];

@customElement('landing-social-proof')
export class LandingSocialProof extends LitElement {
  static styles = css`
    :host {
      display: block;
      font-family: var(--landing-font-body, inherit);
      scroll-margin-top: var(--landing-scroll-offset, 92px);
    }

    /* Testimonials section */
    .testimonials-section {
      background: var(--landing-bg-dark);
      padding: var(--landing-section-padding-y, 8rem) var(--landing-padding-x, 2rem);
    }

    .section-container {
      max-width: var(--landing-max-width, 1100px);
      margin: 0 auto;
    }

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
      font-size: clamp(1.75rem, 3vw, 2.5rem);
      font-weight: 600;
      line-height: 1.3;
      color: var(--landing-text-primary);
      margin: 0;
      max-width: 600px;
      margin-left: auto;
      margin-right: auto;
    }

    /* Testimonials grid */
    .testimonials-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 1.5rem;
    }

    .testimonial-card {
      padding: 2rem;
      background: var(--landing-bg-surface);
      border: 1px solid var(--landing-border);
      border-radius: 20px;
      opacity: 0;
      transform: translateY(20px);
      transition: all 0.6s ease-out;
    }

    .testimonial-card.is-visible {
      opacity: 1;
      transform: translateY(0);
    }

    .testimonial-card:hover {
      border-color: var(--landing-border-hover);
      transform: translateY(-4px);
    }

    .quote-mark {
      font-size: 3rem;
      line-height: 1;
      color: var(--landing-primary);
      opacity: 0.5;
      margin-bottom: 1rem;
    }

    .testimonial-quote {
      font-size: 1rem;
      line-height: 1.7;
      color: var(--landing-text-secondary);
      margin-bottom: 1.5rem;
    }

    .testimonial-transformation {
      display: inline-block;
      padding: 0.375rem 0.75rem;
      font-size: 0.75rem;
      font-weight: 500;
      color: var(--landing-accent-teal);
      background: rgba(45, 212, 191, 0.1);
      border: 1px solid rgba(45, 212, 191, 0.3);
      border-radius: 100px;
      margin-bottom: 1.5rem;
    }

    .testimonial-author {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .author-avatar {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: linear-gradient(135deg, var(--landing-primary), var(--landing-accent-lavender));
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1rem;
      font-weight: 600;
      color: white;
    }

    .author-info {
      display: flex;
      flex-direction: column;
    }

    .author-name {
      font-size: 0.9375rem;
      font-weight: 600;
      color: var(--landing-text-primary);
    }

    .author-role {
      font-size: 0.8125rem;
      color: var(--landing-text-muted);
    }

    /* CTA section */
    .cta-section {
      background: linear-gradient(
        180deg,
        var(--landing-bg-dark) 0%,
        var(--landing-bg-elevated) 100%
      );
      padding: var(--landing-section-padding-y, 8rem) var(--landing-padding-x, 2rem);
      text-align: center;
    }

    .cta-headline {
      font-family: var(--landing-font-display, inherit);
      font-size: clamp(2rem, 4vw, 3rem);
      font-weight: 600;
      line-height: 1.2;
      color: var(--landing-text-primary);
      margin: 0 0 1rem;
    }

    .cta-subheadline {
      font-size: 1.25rem;
      color: var(--landing-text-secondary);
      margin-bottom: 2.5rem;
    }

    .cta-buttons {
      display: flex;
      gap: 1rem;
      justify-content: center;
      margin-bottom: 2rem;
    }

    .cta-primary {
      padding: 1.125rem 2.5rem;
      font-size: 1.125rem;
      font-weight: 600;
      color: white;
      background: var(--landing-primary);
      border: none;
      border-radius: 14px;
      cursor: pointer;
      transition: all 0.2s ease;
      box-shadow: var(--landing-shadow-md), var(--landing-shadow-glow);
    }

    .cta-primary:hover {
      transform: translateY(-2px);
      box-shadow: var(--landing-shadow-lg), 0 0 60px rgba(99, 102, 241, 0.4);
    }

    .cta-primary:focus-visible {
      outline: 2px solid var(--landing-primary-light, #818cf8);
      outline-offset: 2px;
    }

    .cta-secondary {
      padding: 1.125rem 2.5rem;
      font-size: 1.125rem;
      font-weight: 600;
      color: var(--landing-text-primary);
      background: transparent;
      border: 1px solid var(--landing-border);
      border-radius: 14px;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .cta-secondary:hover {
      background: rgba(255, 255, 255, 0.05);
      border-color: var(--landing-border-hover);
    }

    .cta-secondary:focus-visible {
      outline: 2px solid var(--landing-primary);
      outline-offset: 2px;
    }

    .trust-badges {
      display: flex;
      gap: 2rem;
      justify-content: center;
      flex-wrap: wrap;
    }

    .trust-badge {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.875rem;
      color: var(--landing-text-muted);
    }

    .trust-badge-check {
      width: 16px;
      height: 16px;
      color: var(--landing-accent-teal);
    }

    /* Responsive */
    @media (max-width: 1024px) {
      .testimonials-grid {
        grid-template-columns: repeat(2, 1fr);
        margin: 0 auto;
      }
    }

    @media (max-width: 768px) {
      .testimonials-grid {
        grid-template-columns: 1fr;
        max-width: 500px;
      }

      .cta-buttons {
        flex-direction: column;
        max-width: 300px;
        margin-left: auto;
        margin-right: auto;
      }

      .trust-badges {
        flex-direction: column;
        align-items: center;
        gap: 0.75rem;
      }
    }

    @media (max-width: 480px) {
      .testimonial-card {
        padding: 1.5rem;
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

  private renderTestimonial(testimonial: Testimonial, index: number): TemplateResult {
    const visibleClass = this.isVisible ? 'is-visible' : '';
    const delay = index * 150;

    return html`
      <div
        class="testimonial-card ${visibleClass}"
        style="transition-delay: ${delay}ms"
      >
        <div class="quote-mark">"</div>
        <p class="testimonial-quote">${testimonial.quote}</p>
        ${testimonial.transformation ? html`
          <div class="testimonial-transformation">${testimonial.transformation}</div>
        ` : ''}
        <div class="testimonial-author">
          <div class="author-avatar">${testimonial.avatar}</div>
          <div class="author-info">
            <span class="author-name">${testimonial.author}</span>
            <span class="author-role">${testimonial.role}</span>
          </div>
        </div>
      </div>
    `;
  }

  render(): TemplateResult {
    return html`
      <section id="social-proof-section">
        <div class="testimonials-section">
          <div class="section-container">
            <div class="section-header">
              <span class="section-label">Success Stories</span>
              <h2 class="section-headline">
                Teams ship faster with orchestrated agents.
              </h2>
            </div>

            <div class="testimonials-grid">
              ${TESTIMONIALS.map((t, i) => this.renderTestimonial(t, i))}
            </div>
          </div>
        </div>

        <div class="cta-section">
          <div class="section-container">
            <h2 class="cta-headline">Start orchestrating your first agent team.</h2>
            <p class="cta-subheadline">Connect tools, set a goal, and let Clawdbrain run—with memory and guardrails.</p>

            <div class="cta-buttons">
              <button class="cta-primary" @click=${this.handleGetStarted}>
                Get Started
              </button>
              <button class="cta-secondary" @click=${this.handleDemo}>
                Book a Demo
              </button>
            </div>

            <div class="trust-badges">
              ${TRUST_BADGES.map(badge => html`
                <div class="trust-badge">
                  <svg class="trust-badge-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="20 6 9 17 4 12"></polyline>
                  </svg>
                  <span>${badge}</span>
                </div>
              `)}
            </div>
          </div>
        </div>
      </section>
    `;
  }

  private handleGetStarted(): void {
    this.dispatchEvent(new CustomEvent('get-started', { bubbles: true, composed: true }));
  }

  private handleDemo(): void {
    this.dispatchEvent(new CustomEvent('book-demo', { bubbles: true, composed: true }));
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'landing-social-proof': LandingSocialProof;
  }
}
