type CardGridItem = {
  kicker?: string;
  title?: string;
  body: string;
};

import { SectionHeading } from "./SectionHeading";

type CardGridSectionProps = {
  title: string;
  items: readonly CardGridItem[];
  columns?: 2 | 3;
  emphasis?: string;
  id?: string;
};

export function CardGridSection({ title, items, columns = 3, emphasis, id }: CardGridSectionProps) {
  return (
    <section className="section" id={id}>
      <SectionHeading title={title} />
      <div className={`grid grid-${columns}`}>
        {items.map((item) => (
          <article className="panel-card" key={`${item.title ?? "item"}-${item.body}`}>
            {item.kicker ? <div className="card-kicker">{item.kicker}</div> : null}
            {item.title ? <h3>{item.title}</h3> : null}
            <p>{item.body}</p>
          </article>
        ))}
      </div>
      {emphasis ? <p className="emphasis-line">{emphasis}</p> : null}
    </section>
  );
}
