import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createGatewayVitestConfig(
	env?: Record<string, string | undefined>,
) {
	return createScopedVitestConfig(["src/gateway/**/*.test.ts"], {
		dir: "src/gateway",
		env,
	});
}

export default createGatewayVitestConfig();
