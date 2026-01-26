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
    id: 'idea-development',
    icon: '💡',
    title: 'Idea Development',
    description: 'From napkin sketch to actionable plan. Your concepts get researched, structured, and refined into something real.',
    size: 'large',
    accent: 'primary',
  },
  {
    id: 'research',
    icon: '🔍',
    title: 'Research & Discovery',
    description: 'Explores topics deeply so you don\'t have to.',
    size: 'medium',
  },
  {
    id: 'automation',
    icon: '⚙️',
    title: 'Task Automation',
    description: 'Handles operational busywork automatically.',
    size: 'medium',
  },
  {
    id: 'learning',
    icon: '📈',
    title: 'Learning & Growth',
    description: 'Surfaces insights tailored to your goals.',
    size: 'small',
  },
  {
    id: 'content',
    icon: '✍️',
    title: 'Content Creation',
    description: 'Drafts, iterates, and refines on your behalf.',
    size: 'small',
  },
  {
    id: 'integrations',
    icon: '🔗',
    title: 'External Integrations',
    description: 'Connects to your existing tools and workflows.',
    size: 'small',
  },
];

@customElement('landing-features')
export class LandingFeatures extends LitElement {
  static styles = css`
    :host {
      display: block;
      background: var(--landing-bg-elevated);
      padding: 8rem 2rem;
      font-family: var(--landing-font-body, inherit);
    }

    .section-container {
      max-width: 1100px;
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
      font-weight: 600;
      line-height: 1.2;
      color: var(--landing-text-primary);
      margin: 0;
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

    /* Responsive */
    @media (max-width: 900px) {
      .bento-grid {
        grid-template-columns: repeat(2, 1fr);
      }

      .feature-card.large {
        grid-column: span 2;
        grid-row: span 1;
      }
    }

    @media (max-width: 600px) {
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
            <span class="section-label">Capabilities</span>
            <h2 class="section-headline">What Clawdbrain can do</h2>
          </div>

          <div class="bento-grid">
            ${FEATURES.map((feature, i) => this.renderFeatureCard(feature, i))}
          </div>
        </div>
      </section>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'landing-features': LandingFeatures;
  }
}
