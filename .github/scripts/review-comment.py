#!/usr/bin/env python3
"""Builds the automatic review's comment, and works out its status, from the
files review-prepare.sh wrote and opencode's output. review-post.sh posts it.

Reads, in $OUT: risk, risk.md, failed, checks.md, files, upstream.md, and
review.raw, opencode's output, used only when OPENCODE_OUTCOME is "success".
Writes, in $OUT: comment.md, state, description, version (patch, minor,
major, or empty when the review gave none), and breaking (yes, no, or empty
when the review gave no release note).

Needs OUT, GH_REPO, SHA, MODEL and RUN_URL. Run it from the repo root: a
`path:line` in a finding becomes a link only when the file exists.
"""

import os
import re
from pathlib import Path

OUT = Path(os.environ["OUT"])
REPO = os.environ.get("GH_REPO", "")
SHA = os.environ.get("SHA", "")
MODEL = os.environ.get("MODEL", "")
RUN_URL = os.environ.get("RUN_URL", "")
RAN = os.environ.get("OPENCODE_OUTCOME") == "success"
MARKER = "<!-- sst-community-review -->"


def read(name, default=""):
    path = OUT / name
    return path.read_text() if path.exists() else default


def lines(name):
    return [line for line in read(name).splitlines() if line.strip()]


def cell(text):
    """Text that fits in one table cell."""
    return " ".join(text.split()).replace("|", "\\|")


risk = read("risk").strip()
risk_why = read("risk.md").strip()
failed = int(read("failed", "0").strip() or 0)
checks = lines("checks.md")
pr_files = set(read("files").split())
upstream = lines("upstream.md")

# opencode's output, with colors stripped and mentions broken, so the text
# can't ping anyone.
raw = read("review.raw") if RAN else ""
raw = re.sub(r"\x1b\[[0-9;]*m", "", raw)
raw = re.sub(r"@(?=\w)", "@​", raw)[:50000]

# The review's sections, by heading. A review without a Findings heading
# didn't finish: the model ran out of steps, and opencode had it write up its
# progress instead. That text is kept as notes, and nothing is read from it.
sections = {}
name = None
for line in raw.splitlines():
    heading = re.match(r"^#+\s*(.+?)\s*$", line)
    if heading:
        name = heading.group(1).lower()
        sections[name] = []
    elif name is not None:
        sections[name].append(line)
sections = {k: "\n".join(v).strip() for k, v in sections.items()}


def section(prefix):
    for key, body in sections.items():
        if key.startswith(prefix):
            return body
    return ""


finished = any(key.startswith("findings") for key in sections)
summary = section("summary")

# The version: patch, minor or major, then why. It becomes the `semver:`
# label that next-version.sh counts. `main` doesn't take breaking changes for
# now, so a major fails the status.
version, version_why = "", ""
found = re.search(r"\b(patch|minor|major)\b", section("version"), re.I)
if found:
    version = found.group(1).lower()
    version_why = re.sub(r"^[`*_\s:,.\-–—]+", "", section("version")[found.end():])
    version_why = version_why[:1].upper() + version_why[1:]

# The line the change would get in the release notes, or None. next-version.sh
# reads it back from the comment, under the same heading.
has_note = any(key.startswith("release note") for key in sections)
note = section("release note")
if re.match(r"^[*_]*none\b", note, re.I):
    note = ""
# A change that breaks something for someone who upgrades, including a new
# minimum requirement, starts its note with "Breaking:". The release notes put
# those first, and next-version.sh checks they do.
breaking = bool(re.match(r"^[*_]*breaking\b", note, re.I))


# Each finding is a list item tagged [blocking] or [suggestion]. The verdict
# is worked out here from the tags, which varies less between runs than
# asking the model for one. An untagged item counts as a suggestion.
def parse_findings(text):
    items = []
    for line in text.splitlines():
        bullet = re.match(r"^\s*(?:[-*]|\d+\.)\s+", line)
        if bullet:
            items.append(line[bullet.end():].rstrip())
        elif items and line.strip():
            items[-1] += "\n  " + line.strip()
    result = []
    for item in items:
        tag = re.match(r"^[*_`]*\[(blocking|suggestion)\][*_`]*\s*[:\-–—]?\s*", item, re.I)
        kind = tag.group(1).lower() if tag else "suggestion"
        result.append((kind, linkify(item[tag.end():] if tag else item)))
    return result


# A `path:line` or `path:line-line` becomes a link to those lines at the pull
# request's latest commit, when the path is a file in the repo or the pull
# request. Lines in a finding can be off, but the file is usually right.
def link(match):
    path, start, end = match.group("path"), match.group("start"), match.group("end")
    if path not in pr_files and not Path(path).is_file():
        return match.group(0)
    label = f"{path}:{start}" + (f"-{end}" if end else "")
    anchor = f"L{start}" + (f"-L{end}" if end else "")
    return f"[`{label}`](https://github.com/{REPO}/blob/{SHA}/{path}#{anchor})"


LOCATION = r"(?P<path>[\w.-]+(?:/[\w.-]+)*\.\w+):(?P<start>\d+)(?:-(?P<end>\d+))?"


def linkify(text):
    text = re.sub(rf"`{LOCATION}`", link, text)
    return re.sub(rf"(?<![\w/`\[.]){LOCATION}(?![\w`])", link, text)


findings = parse_findings(section("findings"))
blocking = [text for kind, text in findings if kind == "blocking"]
suggestions = [text for kind, text in findings if kind == "suggestion"]

if failed:
    state, description = "failure", f"{failed} check(s) failed. See the review comment."
elif version == "major":
    state, description = "failure", "The review marks this as a breaking change, which main doesn't take for now."
elif blocking:
    state, description = "failure", f"The review has {len(blocking)} blocking finding(s). See the review comment."
elif finished:
    state, description = "success", "Checks passed, and the review has no blocking findings."
elif RAN:
    state, description = "success", "Checks passed. The AI review didn't finish."
else:
    state, description = "success", "Checks passed. The AI review didn't run."


def plural(count, word):
    return f"{count} {word}" + ("" if count == 1 else "s")


if not finished:
    result = "⚪ The AI review didn't finish" if RAN else "⚪ The AI review didn't run"
elif blocking:
    result = f"❌ {plural(len(blocking), 'blocking finding')} · {plural(len(suggestions), 'suggestion')}"
elif suggestions:
    result = f"✅ No blocking findings · {plural(len(suggestions), 'suggestion')}"
else:
    result = "✅ No findings"

risk_icon = {"low": "🟢", "medium": "🟠", "high": "🔴"}.get(risk, "⚪")
if failed:
    checks_row = f"❌ {failed} of {len(checks)} failed"
else:
    checks_row = f"✅ All {len(checks)} passed"

out = [MARKER, "## Automatic review", ""]
if state == "failure":
    out += [
        "> [!CAUTION]",
        "> **Before a committer reviews this, please fix what's marked ❌ below**, or reply if you disagree. Pushing a fix runs this again.",
        "",
    ]
if version == "major":
    out += [
        "> [!WARNING]",
        "> **This looks like a breaking change**, and `main` doesn't take breaking changes for now. The blocking findings say what breaks. If it isn't one, reply saying why, and a committer decides.",
        "",
    ]
if breaking and version != "major":
    out += [
        "> [!WARNING]",
        "> **This changes what users need**, so the release notes will list it under Breaking changes. Check that the drafted release note below says what they have to do.",
        "",
    ]
out += ["| | |", "|---|---|", f"| **Result** | {result} |", f"| **Risk** | {risk_icon} {risk} · {cell(risk_why)} |"]
if version:
    out.append(f"| **Version** | `{version}`" + (f" · {cell(version_why)}" if version_why else "") + " |")
out.append(f"| **Checks** | {checks_row} |")
if upstream:
    out.append(f"| **Upstream** | {'<br>'.join(cell(line) for line in upstream)} |")
out.append("")

if failed:
    out += ["**Checks to fix**", ""] + [line for line in checks if "❌" in line] + [""]

if finished:
    if summary:
        out += ["### Summary", "", summary, ""]
    if blocking:
        out += [f"### 🔴 Blocking ({len(blocking)})", ""] + [f"- {text}" for text in blocking] + [""]
    if suggestions:
        out += [f"### 💡 Suggestions ({len(suggestions)})", ""] + [f"- {text}" for text in suggestions] + [""]
    if has_note:
        heading = "### Release note (draft) ⚠️ breaking" if breaking else "### Release note (draft)"
        out += [heading, "", note or "_None: users won't notice this change._", ""]
elif RAN:
    out += ["> [!NOTE]", f"> The AI review ran out of steps before it finished ([run]({RUN_URL})). The checks above still apply.", ""]
    if raw.strip():
        out += ["<details><summary>What it wrote before it stopped</summary>", "", raw.strip(), "", "</details>", ""]
else:
    out += ["> [!NOTE]", f"> The AI review didn't run this time ([run]({RUN_URL})). The checks above still apply.", ""]

out.append(
    f"<sub>A first pass by [opencode](https://opencode.ai) with the free `{MODEL}` model ([run]({RUN_URL})). "
    "It can be wrong. A committer still reviews and approves every pull request. "
    "Pushing, or editing the title or description, runs it again.</sub>"
)

(OUT / "comment.md").write_text("\n".join(out) + "\n")
(OUT / "state").write_text(state + "\n")
(OUT / "description").write_text(description + "\n")
(OUT / "version").write_text(version + "\n")
(OUT / "breaking").write_text(("yes" if breaking else "no" if has_note else "") + "\n")
