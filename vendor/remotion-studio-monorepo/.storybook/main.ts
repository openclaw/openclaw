import type { StorybookConfig } from "@storybook/react-vite";
import path from "path";

const config: StorybookConfig = {
  stories: [
    "../packages/**/*.stories.@(js|jsx|mjs|ts|tsx)",
    "../apps/**/*.stories.@(js|jsx|mjs|ts|tsx)",
  ],
  addons: [
    "@storybook/addon-links",
    "@storybook/addon-essentials",
    "@storybook/addon-interactions",
  ],
  framework: {
    name: "@storybook/react-vite",
    options: {},
  },
  docs: {
    autodocs: "tag",
  },
  viteFinal: async (config) => {
    if (config.resolve) {
      config.resolve.alias = {
        ...config.resolve.alias,
        "@studio/timing": path.resolve(
          __dirname,
          "../packages/@studio/timing/src",
        ),
        "@studio/hooks": path.resolve(
          __dirname,
          "../packages/@studio/hooks/src",
        ),
        "@studio/core-types": path.resolve(
          __dirname,
          "../packages/@studio/core-types/src",
        ),
        "@studio/easings": path.resolve(
          __dirname,
          "../packages/@studio/easings/src",
        ),
        "@studio/transitions": path.resolve(
          __dirname,
          "../packages/@studio/transitions/src",
        ),
      };
    }
    return config;
  },
};

export default config;
