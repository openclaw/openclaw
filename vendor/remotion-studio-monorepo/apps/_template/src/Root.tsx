import React from "react";
import {
  Composition,
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { z } from "zod";

// These placeholders are replaced by scripts/create-project.ts when generating a new project
const WIDTH = __WIDTH__;
const HEIGHT = __HEIGHT__;
const FPS = __FPS__;
const DURATION = __DURATION__;

const templateMainSchema = z.object({
  title: z.string(),
  subtitle: z.string(),
  background: z.string(),
  textColor: z.string(),
});

type TemplateMainProps = z.infer<typeof templateMainSchema>;

const templateMainDefaults: TemplateMainProps = {
  title: "New Remotion Project",
  subtitle: "Frame/FPS preview",
  background: "#0b0d12",
  textColor: "#fff",
};

type CompositionWithSchemaProps = Omit<
  React.ComponentProps<typeof Composition>,
  "schema"
> & {
  schema: z.ZodTypeAny;
};

const CompositionWithSchema: React.FC<CompositionWithSchemaProps> = (props) => {
  return <Composition {...props} />;
};

const TemplateMain: React.FC<TemplateMainProps> = ({
  title,
  subtitle,
  background,
  textColor,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill
      style={{
        alignItems: "center",
        justifyContent: "center",
        background,
        color: textColor,
      }}
    >
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 64, fontWeight: 800, marginBottom: 16 }}>
          {title}
        </div>
        <div style={{ fontSize: 24, opacity: 0.8 }}>
          {subtitle} / Frame: {frame} / FPS: {fps}
        </div>
      </div>
    </AbsoluteFill>
  );
};

const Root: React.FC = () => {
  return (
    <>
      <CompositionWithSchema
        id="TemplateMain"
        component={TemplateMain}
        width={WIDTH}
        height={HEIGHT}
        fps={FPS}
        durationInFrames={DURATION}
        schema={templateMainSchema}
        defaultProps={templateMainDefaults}
      />
    </>
  );
};

export { TemplateMain };
export { Root };
