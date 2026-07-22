export function validate(
  contractName: string,
  value: unknown,
): { readonly valid: boolean; readonly errors: readonly string[] };
