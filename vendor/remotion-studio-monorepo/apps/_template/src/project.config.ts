export type ProjectConfig = {
  title?: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
};

export const projectConfig: ProjectConfig = {
  title: "Template Project",
  width: __WIDTH__,
  height: __HEIGHT__,
  fps: __FPS__,
  durationInFrames: __DURATION__,
};
