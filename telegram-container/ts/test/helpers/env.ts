type EnvVars = Record<string, string | undefined>;

function assign(vars: EnvVars): void {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

/** Sets env vars and returns a function restoring the previous values (vars that were unset are deleted again). */
export function setMelvbotEnv(vars: EnvVars): () => void {
  const previous = Object.keys(vars).map((key) => [key, process.env[key]] as const);
  assign(vars);
  return () => assign(Object.fromEntries(previous));
}

/** Runs `fn` with env vars set, restoring them afterwards. */
export async function withMelvbotEnv<T>(vars: EnvVars, fn: () => T | Promise<T>): Promise<T> {
  const restore = setMelvbotEnv(vars);
  try {
    return await fn();
  } finally {
    restore();
  }
}
