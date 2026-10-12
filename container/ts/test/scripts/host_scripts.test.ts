import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { withTempDir } from "../helpers/temp.js";

const scriptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts");

function writeExecutable(file: string, body: string): void {
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
}

// smoke-eval.sh: a stub melvbot-compose stands in for the container exec.
test("smoke-eval: a failing exec is FAIL and exits 1, even when its stderr matches the expectation", async () => {
  await withTempDir("smoke-eval-", (dir) => {
    const compose = path.join(dir, "compose");
    writeExecutable(compose, "echo 'sudo: pong' >&2\nexit 1");
    const prompts = path.join(dir, "prompts.json");
    writeFileSync(prompts, JSON.stringify([{ id: "greeting", prompt: "hi", expect: "pong" }]));
    const run = spawnSync("sh", [path.join(scriptsDir, "smoke-eval.sh"), prompts], {
      env: { ...process.env, MELVBOT_COMPOSE_BIN: compose, TMPDIR: dir },
      encoding: "utf8",
    });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /^FAIL greeting/m);
    assert.doesNotMatch(run.stdout, /PASS greeting/);
  });
});

test("smoke-eval: log lines on stdout are not a reply; no reply is FAIL", async () => {
  await withTempDir("smoke-eval-", (dir) => {
    const compose = path.join(dir, "compose");
    writeExecutable(compose, "echo 'assistant_turn pong'");
    const prompts = path.join(dir, "prompts.json");
    writeFileSync(prompts, JSON.stringify([{ id: "empty", prompt: "hi", expect: "pong" }]));
    const run = spawnSync("sh", [path.join(scriptsDir, "smoke-eval.sh"), prompts], {
      env: { ...process.env, MELVBOT_COMPOSE_BIN: compose, TMPDIR: dir },
      encoding: "utf8",
    });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /^FAIL empty/m);
  });
});

test("smoke-eval: a matching stdout reply is PASS and exits 0", async () => {
  await withTempDir("smoke-eval-", (dir) => {
    const compose = path.join(dir, "compose");
    writeExecutable(compose, "echo 'assistant_turn {}'\nprintf '\\n<<REPLY>>pong'");
    const prompts = path.join(dir, "prompts.json");
    // "\\bpong\\b" in JSON: backslashes in the expectation must reach grep intact.
    writeFileSync(prompts, JSON.stringify([{ id: "greeting", prompt: "hi", expect: "\\bpong\\b" }]));
    const run = spawnSync("sh", [path.join(scriptsDir, "smoke-eval.sh"), prompts], {
      env: { ...process.env, MELVBOT_COMPOSE_BIN: compose, TMPDIR: dir },
      encoding: "utf8",
    });
    assert.equal(run.status, 0);
    assert.match(run.stdout, /^PASS greeting/m);
  });
});

// daily-maint-melvbot.sh: sourced with DAILY_MAINT_SOURCE_ONLY=1; docker and date are stubbed on PATH.
type RebuildCase = { day: string; imageChanged: boolean; buildFails?: boolean; unstable?: boolean };

async function runWeeklyRebuild(c: RebuildCase): Promise<{ status: number | null; docker: string }> {
  return withTempDir("maint-rebuild-", (dir) => {
    const bin = path.join(dir, "bin");
    const dockerLog = path.join(dir, "docker.log");
    const built = path.join(dir, "built");
    mkdirSync(bin);
    writeExecutable(
      path.join(bin, "docker"),
      [
        `echo "$*" >> "${dockerLog}"`,
        `case "$*" in`,
        `  *"image inspect"*) if [ -f "${built}" ]; then echo "${c.imageChanged ? "sha256:new" : "sha256:old"}"; else echo "sha256:old"; fi ;;`,
        `  *"State.Running"*) echo "${c.unstable ? "false 3" : "true 0"}" ;;`,
        `  *" build "*)${c.buildFails ? "exit 1" : `touch "${built}"`} ;;`,
        `esac`,
      ].join("\n"),
    );
    writeExecutable(path.join(bin, "sleep"), "exit 0");
    writeExecutable(path.join(bin, "date"), `if [ "$1" = "+%u" ]; then echo ${c.day}; else exec /bin/date "$@"; fi`);
    const run = spawnSync(
      "sh",
      ["-c", '. "$0"; run_weekly_melvbot_rebuild', "./daily-maint-melvbot.sh"],
      {
        cwd: scriptsDir,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          DAILY_MAINT_SOURCE_ONLY: "1",
          LOG: path.join(dir, "maint.log"),
          STATE_DIR: dir,
          COMPOSE_FILE: path.join(dir, "docker-compose.yml"),
        },
        encoding: "utf8",
      },
    );
    const docker = existsSync(dockerLog) ? readFileSync(dockerLog, "utf8") : "";
    return { status: run.status, docker };
  });
}

test("weekly rebuild on Sunday recreates the container only when the image ID changed", async () => {
  const changed = await runWeeklyRebuild({ day: "7", imageChanged: true });
  assert.equal(changed.status, 0);
  assert.match(changed.docker, /build --pull melvbot/);
  assert.match(changed.docker, /up -d --force-recreate melvbot/);

  const unchanged = await runWeeklyRebuild({ day: "7", imageChanged: false });
  assert.equal(unchanged.status, 0);
  assert.match(unchanged.docker, /build --pull melvbot/);
  assert.doesNotMatch(unchanged.docker, /up -d/);
});

test("weekly rebuild restores the previous image and fails when the recreated container is unstable", async () => {
  const result = await runWeeklyRebuild({ day: "7", imageChanged: true, unstable: true });
  assert.notEqual(result.status, 0);
  assert.match(result.docker, /tag sha256:old melvbot-ts:prev/);
  assert.match(result.docker, /tag melvbot-ts:prev melvbot-ts:latest/);
  assert.match(result.docker, /up -d --no-build --force-recreate melvbot/);
});

test("weekly rebuild returns non-zero and does not recreate when the build fails", async () => {
  const result = await runWeeklyRebuild({ day: "7", imageChanged: true, buildFails: true });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.docker, /up -d/);
});
