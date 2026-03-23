type EnvMap = Record<string, string | undefined>;

const isEnabled = (value: string | undefined): boolean => {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
};

export function loadVitestExperimentalConfig(env: EnvMap = process.env): {
  experimental?: {
    fsModuleCache?: true;
    importDurations?: { print: true };
    printImportBreakdown?: true;
  };
} {
  const experimental: {
    fsModuleCache?: true;
    importDurations?: { print: true };
    printImportBreakdown?: true;
  } = {};

  if (isEnabled(env.OPENCLAW_VITEST_FS_MODULE_CACHE)) {
    experimental.fsModuleCache = true;
  }
  if (isEnabled(env.OPENCLAW_VITEST_IMPORT_DURATIONS)) {
    experimental.importDurations = { print: true };
  }
  if (isEnabled(env.OPENCLAW_VITEST_PRINT_IMPORT_BREAKDOWN)) {
    experimental.printImportBreakdown = true;
  }

  return Object.keys(experimental).length > 0 ? { experimental } : {};
}
