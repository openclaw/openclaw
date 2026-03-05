import React from "react";
import { Composition } from "remotion";
import { ShowcaseComposition } from "./ShowcaseComposition";

export const Root: React.FC = () => {
  return (
    <>
      <Composition
        id="AnimationsShowcase"
        component={ShowcaseComposition}
        durationInFrames={300}
        fps={30}
        width={1920}
        height={1080}
      />
    </>
  );
};
