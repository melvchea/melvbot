import { writeFileSync } from "node:fs";
import path from "node:path";

/** Writes a rule file in the prompt catalog format (frontmatter plus body). */
export function writePrompt(dir: string, name: string, description: string, always: boolean, body: string): void {
  writeFileSync(
    path.join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${description}\nalways: ${always}\n---\n${body}\n`,
  );
}
