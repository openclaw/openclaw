import { SectionHeading } from "./SectionHeading";

type CtaSectionProps = {
  title: string;
  body: string;
  primary: string;
  secondary?: string;
};

export function CtaSection({ title, body, primary, secondary }: CtaSectionProps) {
  return (
    <section className="section section-cta" id="cta">
      <SectionHeading title={title} centered>
        <p>{body}</p>
      </SectionHeading>
      <div className="cta-row center">
        <a className="btn btn-primary" href="#">
          {primary}
        </a>
        {secondary ? (
          <a className="btn btn-secondary" href="#faq">
            {secondary}
          </a>
        ) : null}
      </div>
    </section>
  );
}
