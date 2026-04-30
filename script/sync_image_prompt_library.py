#!/usr/bin/env python3
from __future__ import annotations

import datetime as dt
import json
import re
from pathlib import Path
from urllib.request import urlopen

SOURCE_REPO = "https://github.com/EvoLinkAI/awesome-gpt-image-2-prompts"
SOURCE_README = f"{SOURCE_REPO}/blob/main/README_zh-CN.md"
SOURCE_RAW = "https://raw.githubusercontent.com/EvoLinkAI/awesome-gpt-image-2-prompts/main/README_zh-CN.md"
OUTPUT_PATH = Path(__file__).resolve().parents[1] / "web/src/generated/image-prompt-library.json"


def parse_prompt_library(markdown: str) -> list[dict[str, object]]:
    lines = markdown.splitlines()
    current_category = ""
    items: list[dict[str, object]] = []

    for index, line in enumerate(lines):
        if line.startswith("## ") and "Case " not in line:
            current_category = line[3:].strip()

        match = re.match(
            r"^(#{2,3}) Case (\d+): \[(.*?)\]\((.*?)\) \(by \[@([^\]]+)\]\((.*?)\)\)",
            line,
        )
        if not match:
            continue

        probe = index + 1
        while probe < len(lines) and lines[probe].strip() != "**提示词：**":
            if re.match(r"^(#{2,3}) Case (\d+): ", lines[probe]):
                break
            probe += 1
        if probe >= len(lines) or lines[probe].strip() != "**提示词：**":
            continue

        probe += 1
        while probe < len(lines) and not lines[probe].strip():
            probe += 1
        if probe >= len(lines) or lines[probe].strip() != "```":
            continue

        probe += 1
        prompt_lines: list[str] = []
        while probe < len(lines) and lines[probe].strip() != "```":
            prompt_lines.append(lines[probe])
            probe += 1
        prompt = "\n".join(prompt_lines).strip()
        if not prompt:
            continue

        items.append(
            {
                "id": int(match.group(2)),
                "title": match.group(3).strip(),
                "category": current_category,
                "prompt": prompt,
                "source_url": match.group(4).strip(),
                "author_handle": match.group(5).strip(),
                "author_url": match.group(6).strip(),
            }
        )

    return items


def main() -> None:
    markdown = urlopen(SOURCE_RAW).read().decode("utf-8")
    items = parse_prompt_library(markdown)
    payload = {
        "source_repo": SOURCE_REPO,
        "source_readme": SOURCE_README,
        "source_license": "CC BY 4.0",
        "synced_at": dt.datetime.now(dt.UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "item_count": len(items),
        "items": items,
    }
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Synced {len(items)} prompts -> {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
