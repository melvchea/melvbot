import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { applyProfile, loadProfile, type Profile } from "../profile.js";

export const ALWAYS_PROMPTS_MAX_CHARS = 20_000;
const ALLOWED_FRONTMATTER_KEYS = new Set(["name", "description", "always"]);
const RULE_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type PromptFile = {
  name: string;
  description: string;
  always: boolean;
  body: string;
};

export type PromptCatalog = {
  always: PromptFile[];
  indexed: PromptFile[];
  alwaysCharsTotal: number;
};

export function promptsDir(): string {
  return process.env.MELVBOT_PROMPTS_DIR ?? "/opt/melvbot-ts/prompts";
}

function parseFrontmatter(raw: string, fileName: string): { fields: Record<string, string>; body: string } {
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== "---") {
    throw new Error(`${fileName}: missing frontmatter (must start with ---)`);
  }
  const closeIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closeIndex === -1) {
    throw new Error(`${fileName}: unterminated frontmatter (missing closing ---)`);
  }
  const fields: Record<string, string> = {};
  for (const line of lines.slice(1, closeIndex)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const sep = trimmed.indexOf(":");
    if (sep === -1) {
      throw new Error(`${fileName}: malformed frontmatter line: ${trimmed}`);
    }
    const key = trimmed.slice(0, sep).trim();
    const value = trimmed.slice(sep + 1).trim();
    if (key in fields) {
      throw new Error(`${fileName}: duplicate frontmatter key: ${key}`);
    }
    fields[key] = value;
  }
  const body = lines.slice(closeIndex + 1).join("\n").trim();
  return { fields, body };
}

function parsePromptFile(filePath: string, profile: Profile): PromptFile {
  const fileName = path.basename(filePath);
  const stem = fileName.replace(/\.md$/, "");
  const raw = applyProfile(readFileSync(filePath, "utf8"), profile, fileName);
  const { fields, body } = parseFrontmatter(raw, fileName);
  const unknownKeys = Object.keys(fields).filter((key) => !ALLOWED_FRONTMATTER_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`${fileName}: unknown frontmatter key(s): ${unknownKeys.join(", ")}`);
  }
  if (!fields.name) {
    throw new Error(`${fileName}: missing frontmatter field: name`);
  }
  if (!fields.description) {
    throw new Error(`${fileName}: missing frontmatter field: description`);
  }
  if (fields.always !== "true" && fields.always !== "false") {
    throw new Error(`${fileName}: missing or invalid frontmatter field: always (must be true or false)`);
  }
  if (fields.name !== stem) {
    throw new Error(`${fileName}: frontmatter name "${fields.name}" must equal the filename stem "${stem}"`);
  }
  return {
    name: fields.name,
    description: fields.description,
    always: fields.always === "true",
    body,
  };
}

export function loadPromptCatalog(dir = promptsDir()): PromptCatalog {
  const fileNames = readdirSync(dir).filter((name) => name.endsWith(".md")).sort();
  const profile = loadProfile();
  const seenNames = new Set<string>();
  const always: PromptFile[] = [];
  const indexed: PromptFile[] = [];
  for (const fileName of fileNames) {
    const prompt = parsePromptFile(path.join(dir, fileName), profile);
    if (seenNames.has(prompt.name)) {
      throw new Error(`duplicate prompt name: ${prompt.name}`);
    }
    seenNames.add(prompt.name);
    if (prompt.always) {
      always.push(prompt);
    } else {
      indexed.push(prompt);
    }
  }
  const alwaysCharsTotal = always.reduce((sum, prompt) => sum + prompt.body.length, 0);
  return { always, indexed, alwaysCharsTotal };
}

export function findRule(catalog: PromptCatalog, name: string): PromptFile | null {
  if (!RULE_NAME_RE.test(name)) {
    return null;
  }
  const all = [...catalog.always, ...catalog.indexed];
  return all.find((prompt) => prompt.name === name) ?? null;
}

export function readRule(catalog: PromptCatalog, name: string): string {
  const prompt = findRule(catalog, name);
  if (!prompt) {
    throw new Error(`unknown rule: ${name}`);
  }
  return prompt.body;
}
