import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scan } from "../dist/scan.js";
import { applyFixes } from "../dist/fix.js";

function workspace(name, files = {}) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "driftlint-v17-"));
  const dir = path.join(parent, name);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

// Reported by a user scanning an agent workspace called "Ajanlarim".
test("paths written with the repo's own directory name resolve", () => {
  const dir = workspace("Ajanlarim", {
    "CLAUDE.md": [
      "# Ajanlarim",
      "",
      "Memory lives in `Ajanlarim/hafiza/`, reminders in `Ajanlarim/.remember/`.",
      "Settings are in `Ajanlarim/.claude/settings.json`.",
      "The archive is at `Ajanlarim/arsiv/eski.md`.",
    ].join("\n"),
    "hafiza/note.md": "note\n",
    ".remember/todo.md": "todo\n",
    ".claude/settings.json": "{}\n",
  });
  const dead = scan(dir).findings.filter((f) => f.rule === "dead-path");
  assert.equal(dead.length, 1, "only the genuinely missing one is reported");
  assert.match(dead[0].message, /arsiv\/eski\.md/);
});

test("the self-prefix shortcut applies to links too", () => {
  const dir = workspace("Ajanlarim", {
    "CLAUDE.md": "# App\n\nSee [notes](Ajanlarim/docs/notes.md) and [gone](Ajanlarim/docs/gone.md).\n",
    "docs/notes.md": "# Notes\n",
  });
  const links = scan(dir).findings.filter((f) => f.rule === "dead-link");
  assert.equal(links.length, 1);
  assert.match(links[0].message, /gone\.md/);
});

// $CLAUDE_PROJECT_DIR means the project the config belongs to, not the scan root.
test("hooks in a nested project resolve against that project's root", () => {
  const dir = workspace("workspace", {
    "CLAUDE.md": "# Workspace\n\nProjects live under `projeler/`.\n",
    "projeler/basaran/.claude/settings.json": JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            { hooks: [{ type: "command", command: "$CLAUDE_PROJECT_DIR/.claude/hooks/db-koruma.ps1" }] },
            { hooks: [{ type: "command", command: "$CLAUDE_PROJECT_DIR/.claude/hooks/eksik.ps1" }] },
          ],
        },
      },
      null,
      2,
    ),
    "projeler/basaran/.claude/hooks/db-koruma.ps1": "# guard\n",
  });
  const found = scan(dir).findings.filter((f) => f.rule === "dead-config-ref");
  assert.equal(found.length, 1, "the existing hook must not be reported");
  assert.match(found[0].message, /eksik\.ps1/);
});

// A marketplace plugin's skills describe the project they generate; each is
// small, so the 5-reference threshold never catches them one by one.
test("a small skill where nothing resolves collapses instead of flooding", () => {
  const dir = workspace("repo", {
    ".claude/skills/motion/SKILL.md":
      "---\nname: motion\ndescription: animate scenes\n---\nScenes live in `scenes.json`, styles in `styles.css`, colors in `palette.json`.\n",
    "src/app.ts": "export {};\n",
  });
  const findings = scan(dir).findings;
  assert.equal(findings.filter((f) => f.rule === "dead-path").length, 0);
  const collapsed = findings.filter((f) => f.rule === "foreign-context");
  assert.equal(collapsed.length, 1);
  assert.equal(collapsed[0].severity, "warning");
  assert.match(collapsed[0].hint, /installed plugin/);
});

test("a skill directory named build is not mistaken for build output", () => {
  const dir = workspace("repo", {
    ".claude/skills/build/SKILL.md":
      "---\nname: build\ndescription: build it\n---\nEntry is `src/app.ts`, helper `src/gone.ts`.\n",
    "build/artifact.js": "// real build output\n",
    "src/app.ts": "export {};\n",
  });
  const result = scan(dir);
  assert.ok(
    result.contextFiles.includes(".claude/skills/build/SKILL.md"),
    "a skill named build must still be scanned",
  );
  assert.ok(
    !result.findings.some((f) => f.file.startsWith("build/")),
    "real build output stays ignored",
  );
});

test("a skill that half resolves is still reported reference by reference", () => {
  const dir = workspace("repo", {
    ".claude/skills/release/SKILL.md":
      "---\nname: release\ndescription: cut a release\n---\nEntry is `src/app.ts`, config `tsconfig.json`, helper `src/gone.ts`.\n",
    "src/app.ts": "export {};\n",
    "tsconfig.json": "{}\n",
  });
  const findings = scan(dir).findings;
  assert.equal(findings.filter((f) => f.rule === "foreign-context").length, 0, "not a foreign file");
  const dead = findings.filter((f) => f.rule === "dead-path");
  assert.equal(dead.length, 1);
  assert.match(dead[0].message, /src\/gone\.ts/);
});

// applyFixes is exported, so a caller's finding must not escape the root.
test("--fix refuses to write outside the scanned root", async () => {
  const dir = workspace("repo", { "CLAUDE.md": "# App\n\nEntry: `old.ts`.\n" });
  const outside = path.join(path.dirname(dir), "outside.md");
  fs.writeFileSync(outside, "# untouched\n");

  const { applied, skipped } = await applyFixes(
    dir,
    [
      {
        rule: "dead-path",
        severity: "error",
        file: "../outside.md",
        line: 1,
        message: "`untouched` does not exist.",
        fix: { oldText: "untouched", newText: "owned" },
      },
    ],
    { yes: true },
  );
  assert.equal(applied.length, 0);
  assert.equal(skipped.length, 1);
  assert.equal(fs.readFileSync(outside, "utf8"), "# untouched\n", "the file outside the root is unchanged");
});
