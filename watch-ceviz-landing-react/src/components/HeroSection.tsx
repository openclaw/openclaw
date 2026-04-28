type HeroSectionProps = {
  hero: {
    eyebrow: string;
    headline: string;
    lede: string;
    bullets: readonly string[];
    primaryCta: string;
    secondaryCta: string;
    watchMockTitle: string;
    watchMockBody: string;
    phoneMockTitle: string;
    phoneMockBody: string;
  };
  pricing: {
    kicker: string;
    plan: string;
    price: string;
    interval: string;
    audience: string;
  };
};

export function HeroSection({ hero, pricing }: HeroSectionProps) {
  return (
    <section className="hero section">
      <div className="hero-copy">
        <div className="eyebrow">{hero.eyebrow}</div>
        <h1>{hero.headline}</h1>
        <p className="hero-lede">{hero.lede}</p>
        <ul className="bullet-list">
          {hero.bullets.map((bullet) => (
            <li key={bullet}>{bullet}</li>
          ))}
        </ul>
        <div className="cta-row">
          <a className="btn btn-primary" href="#cta">
            {hero.primaryCta}
          </a>
          <a className="btn btn-secondary" href="#workflows">
            {hero.secondaryCta}
          </a>
        </div>
      </div>

      <aside className="hero-aside">
        <div className="device-card">
          <div className="device-label">Watch</div>
          <h3>{hero.watchMockTitle}</h3>
          <p>{hero.watchMockBody}</p>
        </div>
        <div className="device-card">
          <div className="device-label">Phone</div>
          <h3>{hero.phoneMockTitle}</h3>
          <p>{hero.phoneMockBody}</p>
        </div>
        <div className="pricing-card">
          <div className="card-kicker">{pricing.kicker}</div>
          <div className="plan-name">{pricing.plan}</div>
          <div className="price">
            {pricing.price}
            <span>{pricing.interval}</span>
          </div>
          <p>{pricing.audience}</p>
          <a className="btn btn-primary full-width" href="#cta">
            Get early access
          </a>
        </div>
      </aside>
    </section>
  );
}
