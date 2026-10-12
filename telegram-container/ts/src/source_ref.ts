import { AsyncLocalStorage } from "node:async_hooks";

const sourceRefStore = new AsyncLocalStorage<string>();

export function currentSourceRef(): string {
  return sourceRefStore.getStore() ?? "cli";
}

export function runWithSourceRef<T>(sourceRef: string, fn: () => Promise<T>): Promise<T> {
  return sourceRefStore.run(sourceRef, fn);
}
