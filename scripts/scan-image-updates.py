#!/usr/bin/env python3
"""Report only the vulnerabilities that bumping a pinned image tag would actually fix.

A plain `trivy image` run on this repo's pins reports well over a hundred HIGH/CRITICAL findings,
and almost none of them are actionable: `--ignore-unfixed` means "a fix exists in the upstream
package", not "a newer image exists that ships it". Most findings are OS or Go-stdlib CVEs in an
image that is already on its newest published tag, so there is nothing a maintainer of this repo
can do about them.

This script answers the only question worth acting on: for each pinned image, is there a newer tag
I could move the pin to, and which HIGH/CRITICAL vulnerabilities would that fix? It scans the
current pin and the newest same-flavour, same-major candidate tag, then reports the set difference.
Images already on their newest tag are silent.

Candidates are restricted to upstream stable branches — see EVEN_MINOR_IS_STABLE — so this never
proposes moving a pin onto a development branch such as nginx mainline.

Requires `trivy` and `crane` on PATH (override with TRIVY_CMD / CRANE_CMD, e.g. to run them via
docker locally).
"""

from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path

TRIVY = shlex.split(os.environ.get("TRIVY_CMD", "trivy"))
CRANE = shlex.split(os.environ.get("CRANE_CMD", "crane"))

# v-prefix, dotted numeric version, then a flavour suffix such as "-alpine".
TAG_RE = re.compile(r"^(v?)(\d+(?:\.\d+)*)(.*)$")

# Upstreams that publish development releases in the same tag namespace as stable ones, where
# "newest tag with the same major" would therefore walk a stable pin onto a development branch.
#
# nginx marks its mainline (development) branch with ODD MINOR versions and stable with even ones:
# nginx:stable-alpine is 1.30.x while nginx:mainline-alpine is 1.31.x, both published as plain
# 1.x.y-alpine tags.
EVEN_MINOR_IS_STABLE = {"nginx", "library/nginx", "docker.io/library/nginx"}

# Node ships ODD MAJOR versions as "Current" only — they never become LTS — while even majors
# (22, 24, 26) are the LTS line. The same-major constraint below already prevents a 24.x pin from
# being walked onto 25.x, so this is defence in depth: it keeps the rule true even if the pin is
# hand-edited or the Dependabot major-ignore is ever relaxed.
EVEN_MAJOR_IS_STABLE = {"node", "library/node", "docker.io/library/node"}


def is_stable_release(repo: str, parts: tuple[int, ...]) -> bool:
    """False for tags on an upstream's development branch rather than its stable/LTS line."""
    if repo in EVEN_MINOR_IS_STABLE and len(parts) >= 2:
        return parts[1] % 2 == 0
    if repo in EVEN_MAJOR_IS_STABLE and parts:
        return parts[0] % 2 == 0
    return True


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def collect_refs(root: Path) -> list[str]:
    """Read pinned references out of the files that actually deploy them."""
    refs: set[str] = set()
    for path in sorted(root.glob("docker-compose*.yml")):
        for m in re.finditer(r"^\s*image:\s*(\S+)", path.read_text(), re.M):
            refs.add(m.group(1))
    for path in sorted(root.rglob("Dockerfile")):
        if "node_modules" in path.parts:
            continue
        for m in re.finditer(r"^FROM\s+(\S+)", path.read_text(), re.M):
            refs.add(m.group(1))
    # Drop build-stage names (`FROM base AS ...`) and anything still holding a compose variable.
    return sorted(r for r in refs if ":" in r and "${" not in r)


def newest_candidate(ref: str) -> str | None:
    """Highest tag for `ref` sharing its prefix, flavour suffix, shape, and major version.

    Constraining to the same major mirrors the repo's Dependabot policy: majors change runtimes and
    on-disk formats (Postgres majors need pg_upgrade), so they stay a hand-reviewed migration rather
    than something a scanner nudges you into.
    """
    repo, _, tag = ref.rpartition(":")
    cur = TAG_RE.match(tag)
    if not cur:
        return None
    prefix, cur_ver, suffix = cur.group(1), cur.group(2), cur.group(3)
    cur_parts = tuple(int(p) for p in cur_ver.split("."))

    listed = run(CRANE + ["ls", repo])
    if listed.returncode != 0:
        print(f"  ! could not list tags for {repo}: {listed.stderr.strip()[:120]}", file=sys.stderr)
        return None

    best = None
    for cand in listed.stdout.split():
        m = TAG_RE.match(cand)
        if not m or m.group(1) != prefix or m.group(3) != suffix:
            continue
        parts = tuple(int(p) for p in m.group(2).split("."))
        # Same shape and same major, strictly newer.
        if len(parts) != len(cur_parts) or parts[0] != cur_parts[0] or parts <= cur_parts:
            continue
        if not is_stable_release(repo, parts):
            continue
        if best is None or parts > best[0]:
            best = (parts, cand)
    return f"{repo}:{best[1]}" if best else None


def vulns(ref: str, workdir: Path) -> dict[str, str] | None:
    """Map of CVE id -> severity for fixable HIGH/CRITICAL issues in `ref`."""
    out = workdir / (re.sub(r"[^A-Za-z0-9]", "_", ref) + ".json")
    res = run(TRIVY + [
        "image", "--scanners", "vuln", "--severity", "HIGH,CRITICAL",
        "--ignore-unfixed", "--no-progress", "--skip-db-update",
        "--format", "json", "--output", str(out), ref,
    ])
    if res.returncode != 0 or not out.exists():
        print(f"  ! scan failed for {ref}: {res.stderr.strip()[:200]}", file=sys.stderr)
        return None
    doc = json.loads(out.read_text())
    return {
        v["VulnerabilityID"]: v.get("Severity", "?")
        for r in (doc.get("Results") or [])
        for v in (r.get("Vulnerabilities") or [])
    }


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    refs = collect_refs(root)
    print(f"Checking {len(refs)} pinned images for actionable upgrades\n")

    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    rows: list[tuple[str, str, int, int, list[str]]] = []
    errors = False

    with tempfile.TemporaryDirectory() as tmp:
        workdir = Path(tmp)
        for ref in refs:
            candidate = newest_candidate(ref)
            if candidate is None:
                print(f"  {ref}\n      already newest — nothing to change")
                continue

            cur = vulns(ref, workdir)
            new = vulns(candidate, workdir)
            if cur is None or new is None:
                errors = True
                continue

            fixed = {k: v for k, v in cur.items() if k not in new}
            introduced = [k for k in new if k not in cur]
            crit = sum(1 for v in fixed.values() if v == "CRITICAL")
            high = sum(1 for v in fixed.values() if v == "HIGH")

            print(f"  {ref}  ->  {candidate.rpartition(':')[2]}")
            if fixed:
                print(f"      fixes {crit} CRITICAL / {high} HIGH: {', '.join(sorted(fixed))}")
                rows.append((ref, candidate.rpartition(":")[2], crit, high, sorted(fixed)))
            else:
                print("      newer tag available, but it fixes no HIGH/CRITICAL")
            if introduced:
                print(f"      NOTE: the newer tag adds {len(introduced)}: {', '.join(sorted(introduced)[:5])}")

    if summary:
        with open(summary, "a") as fh:
            if rows:
                fh.write("## Image upgrades that fix vulnerabilities\n\n")
                fh.write("| Image | Bump to | CRITICAL | HIGH | CVEs |\n| --- | --- | --- | --- | --- |\n")
                for ref, tag, crit, high, ids in rows:
                    fh.write(f"| `{ref}` | `{tag}` | {crit} | {high} | {', '.join(ids)} |\n")
            else:
                fh.write("No pinned image has a newer tag that fixes a HIGH/CRITICAL vulnerability.\n")

    if rows:
        print(f"\n{len(rows)} image(s) have an upgrade that fixes HIGH/CRITICAL vulnerabilities.")
        return 1
    if errors:
        print("\nScan errors occurred (see above).")
        return 1
    print("\nNothing actionable: no pinned image has a newer tag that fixes HIGH/CRITICAL issues.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
