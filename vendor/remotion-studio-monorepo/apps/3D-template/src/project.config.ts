export type ProjectConfig = {
  title?: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
};

export const projectConfig: ProjectConfig = {
  title: "Template Project",
  width: 1920,
  height: 1080,
  fps: 30,
  durationInFrames: 180,
};
