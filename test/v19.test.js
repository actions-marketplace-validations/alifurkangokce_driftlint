import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scan } from "../dist/scan.js";
import { enclosingProjectRoot } from "../dist/checks/deadPaths.js";

function workspace(name, files = {}) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "driftlint-v19-"));
  const dir = path.join(parent, name);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

// Reported in #27: 39 of one workspace's 44 findings were this single shape.
test("a nested project's own paths resolve against that project, not the scan root", () => {
  const dir = workspace("outer", {
    "sub/.agents/skills/myskill/SKILL.md":
      "# My Skill\n\nSee `eval/comparison/test-sim/` for results.\n",
    "sub/eval/comparison/test-sim/.keep": "",
  });
  const result = scan(dir);
  assert.deepEqual(
    result.findings.filter((f) => f.rule === "dead-path"),
    [],
    "a path relative to the nested project's root is not drift",
  );
});

// The reporter proposed walking up to the nearest `.git`. Their own stated
// case — vendored mirrors under `.research/` — has no `.git` to find.
test("the nested project is found without relying on a .git directory", () => {
  const dir = workspace("outer", {
    ".research/mirror/.claude/skills/x/SKILL.md":
      "# X\n\nEntry point is `src/core/main.ts`.\n",
    ".research/mirror/src/core/main.ts": "export {};\n",
  });
  assert.deepEqual(scan(dir).findings.filter((f) => f.rule === "dead-path"), []);
});

test("enclosingProjectRoot names the directory that owns the agent config", () => {
  assert.equal(enclosingProjectRoot("sub/.agents/skills/myskill"), "sub");
  assert.equal(enclosingProjectRoot(".research/mirror/.claude/skills/x"), ".research/mirror");
  assert.equal(enclosingProjectRoot("a/b/.codex/rules"), "a/b");
  assert.equal(enclosingProjectRoot(".claude/skills/y"), "", "top-level config is owned by the scan root");
  assert.equal(enclosingProjectRoot("docs"), null, "a plain directory owns nothing");
  assert.equal(enclosingProjectRoot("sub"), null);
});

// Resolving more references pushed files under the foreign-context ratio, so
// their genuinely-external references started arriving as errors. They are a
// nested project's surroundings, not this repo's drift.
test("what a nested project still can't resolve is a warning, not an error", () => {
  const dir = workspace("outer", {
    "sub/.claude/agents/describer.md": [
      "---",
      "name: describer",
      "description: describes the upstream service",
      "---",
      "Notes live in `notes/design.md`.",
      "The handler is `Actions/SetFieldHandler.cs` in the upstream repo.",
    ].join("\n"),
    "sub/notes/design.md": "# design\n",
  });
  const dead = scan(dir).findings.filter((f) => f.rule === "dead-path");
  assert.equal(dead.length, 1, "the unresolvable reference is still reported");
  assert.equal(dead[0].severity, "warning", "but not as an error");
  assert.match(dead[0].hint ?? "", /nested project/);
});

test("a file that resolves nothing nested keeps error severity", () => {
  const dir = workspace("outer", {
    "CLAUDE.md": "# Outer\n\nThe entry point is `src/app.ts`.\n",
    "package.json": '{"name":"outer"}\n',
  });
  const dead = scan(dir).findings.filter((f) => f.rule === "dead-path");
  assert.equal(dead.length, 1);
  assert.equal(dead[0].severity, "error", "ordinary drift must not be softened");
});
