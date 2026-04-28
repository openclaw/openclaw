import { CardGridSection } from "./components/CardGridSection";
import { CtaSection } from "./components/CtaSection";
import { HeroSection } from "./components/HeroSection";
import { SectionHeading } from "./components/SectionHeading";
import { SplitSection } from "./components/SplitSection";
import { landingContent } from "./content/landingContent";
import "./landing.css";

export function LandingPage() {
  return (
    <main className="page-shell">
      <HeroSection hero={landingContent.hero} pricing={landingContent.pricing} />

      <section className="section">
        <SectionHeading title={landingContent.productDefinition.title} />
        <div className="stack copy-stack">
          {landingContent.productDefinition.paragraphs.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </div>
      </section>

      <CardGridSection
        title={landingContent.howItWorks.title}
        items={landingContent.howItWorks.items}
        columns={3}
        emphasis={landingContent.howItWorks.emphasis}
      />

      <SplitSection
        title={landingContent.whyItMatters.title}
        intro={landingContent.whyItMatters.intro}
        bullets={landingContent.whyItMatters.bullets}
      />

      <SplitSection
        title={landingContent.personalIncludes.title}
        intro="Personal is the public launch plan."
        bullets={landingContent.personalIncludes.bullets}
        paragraphs={landingContent.personalIncludes.framing}
      />

      <CardGridSection
        id="workflows"
        title={landingContent.workflows.title}
        items={landingContent.workflows.items}
        columns={3}
      />

      <section className="section">
        <SectionHeading title={landingContent.handoff.title} />
        <div className="stack copy-stack">
          {landingContent.handoff.paragraphs.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
          <p className="emphasis-line">{landingContent.handoff.emphasis}</p>
        </div>
      </section>

      <CtaSection {...landingContent.cta} />

      <CardGridSection
        id="faq"
        title={landingContent.faq.title}
        columns={2}
        items={landingContent.faq.items.map((item) => ({
          title: item.question,
          body: item.answer,
        }))}
      />
    </main>
  );
}

export default LandingPage;
