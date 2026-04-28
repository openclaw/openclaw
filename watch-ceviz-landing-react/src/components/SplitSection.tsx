import { SectionHeading } from "./SectionHeading";

type SplitSectionProps = {
  title: string;
  intro: string;
  bullets?: readonly string[];
  paragraphs?: readonly string[];
};

export function SplitSection({ title, intro, bullets, paragraphs }: SplitSectionProps) {
  return (
    <section className="section section-split">
      <div>
        <SectionHeading title={title} />
        <p>{intro}</p>
      </div>
      <div className="stack">
        {bullets ? (
          <ul className="bullet-list compact">
            {bullets.map((bullet) => (
              <li key={bullet}>{bullet}</li>
            ))}
          </ul>
        ) : null}
        {paragraphs ? paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>) : null}
      </div>
    </section>
  );
}
