import React from "react";
import {
  Composition,
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { z } from "zod";
import { LinkedParticles } from "./scenes/LinkedParticles";

// These placeholders are replaced by scripts/create-project.ts when generating a new project
const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;
const DURATION = 180;

const templateMainSchema = z.object({
  title: z.string(),
  subtitle: z.string(),
  background: z.string(),
  textColor: z.string(),
});

const linkedParticlesSchema = z.object({
  seed: z.union([z.string(), z.number()]).optional(),
  showGUI: z.boolean().optional(),
});

type TemplateMainProps = z.infer<typeof templateMainSchema>;
type LinkedParticlesProps = z.infer<typeof linkedParticlesSchema>;

const templateMainDefaults: TemplateMainProps = {
  title: "New Remotion Project",
  subtitle: "Frame/FPS preview",
  background: "#0b0d12",
  textColor: "#fff",
};

const linkedParticlesDefaults: LinkedParticlesProps = {
  seed: "LinkedParticles",
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

export const Root: React.FC = () => {
  return (
    <>
      <CompositionWithSchema
        id="Main"
        component={TemplateMain}
        width={WIDTH}
        height={HEIGHT}
        fps={FPS}
        durationInFrames={DURATION}
        schema={templateMainSchema}
        defaultProps={templateMainDefaults}
      />
      <CompositionWithSchema
        id="LinkedParticles"
        component={LinkedParticles}
        width={WIDTH}
        height={HEIGHT}
        fps={FPS}
        durationInFrames={DURATION}
        schema={linkedParticlesSchema}
        defaultProps={linkedParticlesDefaults}
      />
    </>
  );
};

export { TemplateMain };
