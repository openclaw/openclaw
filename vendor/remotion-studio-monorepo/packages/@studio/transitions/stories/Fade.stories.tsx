import type { Meta, StoryObj } from "@storybook/react";
import React from "react";
import { Player } from "@remotion/player";
import { AbsoluteFill } from "remotion";
import { FadeIn, FadeOut } from "../src/Fade";

const meta: Meta<typeof FadeIn> = {
  title: "Transitions/Fade",
  component: FadeIn,
  parameters: {
    layout: "centered",
  },
  tags: ["autodocs"],
};

export default meta;
type Story = StoryObj<typeof meta>;

const SampleContent = () => (
  <div
    style={{
      width: 400,
      height: 300,
      backgroundColor: "#3498db",
      borderRadius: 10,
      display: "flex",
      justifyContent: "center",
      alignItems: "center",
      color: "white",
      fontSize: 32,
      fontWeight: "bold",
    }}
  >
    Sample Content
  </div>
);

const FadeInComposition: React.FC = () => {
  return (
    <AbsoluteFill
      style={{
        backgroundColor: "#1a1a2e",
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <FadeIn startFrame={0} duration={30}>
        <SampleContent />
      </FadeIn>
    </AbsoluteFill>
  );
};

const FadeOutComposition: React.FC = () => {
  return (
    <AbsoluteFill
      style={{
        backgroundColor: "#1a1a2e",
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <FadeOut startFrame={30} duration={30}>
        <SampleContent />
      </FadeOut>
    </AbsoluteFill>
  );
};

export const FadeInExample: Story = {
  render: () => (
    <Player
      component={FadeInComposition}
      durationInFrames={60}
      compositionWidth={800}
      compositionHeight={450}
      fps={30}
      controls
      loop
    />
  ),
};

export const FadeOutExample: Story = {
  render: () => (
    <Player
      component={FadeOutComposition}
      durationInFrames={60}
      compositionWidth={800}
      compositionHeight={450}
      fps={30}
      controls
      loop
    />
  ),
};
