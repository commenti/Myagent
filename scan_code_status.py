#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
from pathlib import Path

CODE_EXTENSIONS = {
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".py", ".sh", ".bash", ".java", ".kt", ".kts",
    ".c", ".h", ".cpp", ".hpp", ".rs", ".go", ".rb",
    ".php", ".sql", ".css", ".scss", ".html", ".vue", ".svelte",
}

IGNORED_DIRS = {
    "node_modules", ".git", ".hg", ".svn", "dist", "build",
    "coverage", ".next", ".cache", "__pycache__",
}

IGNORED_NAMES = {".DS_Store"}
IGNORED_SUFFIXES = (".tmp", ".bak", ".swp", ".swo", "~")


def is_binary(path: Path) -> bool:
    try:
        data = path.read_bytes()
    except OSError:
        return True
    if b"\x00" in data:
        return True
    sample = data[:4096]
    if not sample:
        return False
    controls = sum(1 for b in sample if b < 9 or (13 < b < 32))
    return controls / len(sample) > 0.10


def remove_comments(text: str, suffix: str) -> str:
    c_like = {
        ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
        ".java", ".kt", ".kts", ".c", ".h", ".cpp", ".hpp",
        ".rs", ".go", ".php", ".css", ".scss", ".html",
        ".vue", ".svelte",
    }

    if suffix in c_like:
        text = re.sub(r"/\*.*?\*/", "", text, flags=re.DOTALL)

    result = []
    for line in text.splitlines():
        s = line.strip()
        if not s:
            continue

        if suffix in {".py", ".sh", ".bash", ".rb"} and s.startswith("#"):
            continue
        if suffix in {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
                      ".java", ".kt", ".kts", ".c", ".h", ".cpp", ".hpp",
                      ".rs", ".go", ".php", ".css", ".scss", ".html",
                      ".vue", ".svelte"} and s.startswith("//"):
            continue
        if suffix == ".sql" and s.startswith("--"):
            continue

        result.append(line)

    return "\n".join(result).strip()


def classify(path: Path) -> tuple[bool, str]:
    try:
        if path.stat().st_size == 0:
            return False, "empty"
        if is_binary(path):
            return False, "binary"
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False, "unreadable"

    if not text.strip():
        return False, "empty"

    cleaned = remove_comments(text, path.suffix.lower())
    if not cleaned:
        return False, "comments_only"

    return True, "code"


def scan(root: Path):
    with_code = []
    without_code = []

    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue

        rel = path.relative_to(root)
        parts = rel.parts

        if any(part in IGNORED_DIRS for part in parts[:-1]):
            continue
        if path.name in IGNORED_NAMES or path.name.endswith(IGNORED_SUFFIXES):
            continue
        if path.suffix.lower() not in CODE_EXTENSIONS:
            continue

        has_code, reason = classify(path)
        if has_code:
            with_code.append(path)
        else:
            without_code.append((path, reason))

    return with_code, without_code


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Scan a project recursively and list source files with/without code."
    )
    parser.add_argument(
        "root",
        nargs="?",
        default=".",
        help="Project folder (default: current folder)",
    )
    parser.add_argument(
        "--report",
        default="code-status-report.txt",
        help="Report filename (default: code-status-report.txt)",
    )
    args = parser.parse_args()

    root = Path(args.root).expanduser().resolve()
    if not root.is_dir():
        print(f"ERROR: Folder not found: {root}")
        return 1

    with_code, without_code = scan(root)

    print("\n" + "=" * 68)
    print("PROJECT CODE STATUS")
    print("=" * 68)
    print(f"Project: {root}")
    print(f"Source files scanned : {len(with_code) + len(without_code)}")
    print(f"Files with code      : {len(with_code)}")
    print(f"Files without code   : {len(without_code)}")

    print("\n[FILES WITH CODE]")
    print("-" * 68)
    for p in with_code:
        print(f"  [CODE]  {p.relative_to(root)}")
    if not with_code:
        print("  None")

    print("\n[FILES WITHOUT CODE]")
    print("-" * 68)
    for p, reason in without_code:
        print(f"  [EMPTY] {p.relative_to(root)} ({reason})")
    if not without_code:
        print("  None")

    print("\n" + "=" * 68)

    report = Path(args.report).expanduser()
    if not report.is_absolute():
        report = root / report

    try:
        with report.open("w", encoding="utf-8") as f:
            f.write("PROJECT CODE STATUS\n")
            f.write(f"Project: {root}\n")
            f.write(f"Source files scanned: {len(with_code) + len(without_code)}\n")
            f.write(f"Files with code: {len(with_code)}\n")
            f.write(f"Files without code: {len(without_code)}\n\n")
            f.write("FILES WITH CODE\n")
            for p in with_code:
                f.write(f"{p.relative_to(root)}\n")
            f.write("\nFILES WITHOUT CODE\n")
            for p, reason in without_code:
                f.write(f"{p.relative_to(root)}\t{reason}\n")
        print(f"Report saved: {report}")
    except OSError as e:
        print(f"WARNING: Could not save report: {e}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
