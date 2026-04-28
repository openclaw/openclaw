import type { ReactNode } from "react";

type SectionHeadingProps = {
  title: string;
  centered?: boolean;
  children?: ReactNode;
};

export function SectionHeading({ title, centered = false, children }: SectionHeadingProps) {
  return (
    <div className={`section-heading${centered ? " centered" : ""}`}>
      <h2>{title}</h2>
      {children}
    </div>
  );
}
