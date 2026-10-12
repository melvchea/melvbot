import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  const parentURL = context.parentURL;
  if (
    parentURL &&
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    specifier.endsWith(".js")
  ) {
    const jsUrl = new URL(specifier, parentURL);
    const tsUrl = new URL(jsUrl.href.replace(/\.js$/, ".ts"));
    if (existsSync(fileURLToPath(tsUrl))) {
      return { url: tsUrl.href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
