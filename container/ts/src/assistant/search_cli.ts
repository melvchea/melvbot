import { formatWebSearchResults, webFetchMany, webSearch, type WebSearchResult } from "./tools.js";

const USAGE = 'usage: melvbot search <query...> | melvbot fetch <url...>   (search: Kagi, then Brave; fetch: Firecrawl, Bright Data, in-process)\n';

type Deps = {
  search: (query: string) => Promise<WebSearchResult>;
  fetchMany: (urls: readonly string[]) => Promise<string>;
};

const defaultDeps: Deps = { search: (query) => webSearch(query, "interactive"), fetchMany: webFetchMany };

/** `melvbot search|fetch`: web search (Kagi, Brave fallback only) and page extraction for host Claude Code via `docker exec`. */
export async function runSearchCli(cmd: "search" | "fetch", args: string[], deps: Deps = defaultDeps): Promise<number> {
  const input = cmd === "search" ? args.join(" ").trim() : args;
  if (cmd === "search" ? input === "" : (input as string[]).length === 0) {
    process.stderr.write(USAGE);
    return 2;
  }
  try {
    if (cmd === "search") {
      // This process is separate from the bot daemon, so the narrower provider list stays local to the CLI.
      process.env.SEARCH_PROVIDERS = "kagi,brave";
      console.log(formatWebSearchResults(await deps.search(input as string)));
    } else {
      console.log(await deps.fetchMany(input as string[]));
    }
    return 0;
  } catch (err) {
    console.error(`${cmd} failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
