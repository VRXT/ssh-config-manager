#!/usr/bin/env node
// Keeps CHANGELOG.md and the version number in step.
//
//   node scripts/changelog.js stamp            "## Unreleased" -> "## <package.json version>"
//                                              (run by `npm version`, see the "version" script)
//   node scripts/changelog.js check [version]  fails unless the top section is "## <version>"
//   node scripts/changelog.js notes [version]  prints that version's section (GitHub Release text)
//
// CHANGELOG_FILE overrides the file, for tests.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const file = process.env.CHANGELOG_FILE || path.join(root, 'CHANGELOG.md');
const [mode, arg] = process.argv.slice(2);
const version = (arg || require(path.join(root, 'package.json')).version).replace(/^v/, '');

const fail = msg => {
  console.error(`changelog: ${msg}`);
  process.exit(1);
};

const text = fs.readFileSync(file, 'utf8');
const lines = text.split(/\r?\n/);
/** [{ title, start, end }] for every "## …" section, top to bottom */
const sections = [];
lines.forEach((line, i) => {
  const m = /^##\s+(.+?)\s*$/.exec(line);
  if (m) {
    if (sections.length) {
      sections[sections.length - 1].end = i;
    }
    sections.push({ title: m[1], start: i, end: lines.length });
  }
});
const isVersion = s => s.title === version || s.title.startsWith(version + ' ');
const isUnreleased = s => /^unreleased$/i.test(s.title);
const body = s => lines.slice(s.start + 1, s.end).join('\n').trim();

if (mode === 'stamp') {
  const u = sections.find(isUnreleased);
  if (sections.some(isVersion)) {
    if (u && body(u)) {
      fail(`there is a "## ${version}" section and an "## Unreleased" one with entries. Merge them by hand.`);
    }
    console.log(`changelog: "## ${version}" is already there.`);
  } else if (!u || !body(u)) {
    fail(`nothing to release: add the changes for ${version} under "## Unreleased" first.`);
  } else {
    lines[u.start] = `## ${version}`;
    fs.writeFileSync(file, lines.join(text.includes('\r\n') ? '\r\n' : '\n'));
    console.log(`changelog: "## Unreleased" is now "## ${version}".`);
  }
} else if (mode === 'check') {
  const top = sections[0];
  if (!top) {
    fail('no "## <version>" sections found.');
  }
  if (!isVersion(top)) {
    fail(`the top section is "## ${top.title}", expected "## ${version}". Rename it (or run: node scripts/changelog.js stamp).`);
  }
  if (!body(top)) {
    fail(`the "## ${version}" section is empty.`);
  }
  console.log(`changelog: top section is "## ${version}".`);
} else if (mode === 'notes') {
  const s = sections.find(isVersion);
  if (!s) {
    fail(`no "## ${version}" section.`);
  }
  console.log(body(s));
} else {
  fail('usage: changelog.js stamp | check [version] | notes [version]');
}
