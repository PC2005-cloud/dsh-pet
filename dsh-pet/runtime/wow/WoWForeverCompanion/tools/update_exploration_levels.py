"""Refresh offline exploration levels from the public wuxianwow MCP atlas tool."""
import json
from pathlib import Path
from urllib.request import Request, urlopen


def main():
    body = json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": "atlas", "arguments": {"kind": "区域", "limit": 200}},
    }).encode("utf-8")
    request = Request("https://wuxianwow.com/mcp", data=body, headers={
        "Content-Type": "application/json", "Accept": "application/json, text/event-stream",
        "User-Agent": "WoWForeverCompanion-atlas/1.13.0",
    })
    with urlopen(request, timeout=30) as response:
        envelope = json.load(response)
    result = envelope["result"]
    if result.get("isError"):
        raise ValueError("MCP atlas returned an error")
    data = json.loads(next(block["text"] for block in result["content"] if block["type"] == "text"))
    if data["outcome"] != "ok" or data["has_more"] or len(data["results"]) != data["total"]:
        raise ValueError("Atlas response is incomplete")
    lines = [
        "-- Source: 无限图鉴 wuxianwow.com, MCP atlas.",
        "-- Minimum and maximum exploration levels, not quest or enemy levels.",
        "-- Refresh with tools/update_exploration_levels.py. Missing levels stay absent.",
        "local _, ns = ...", "ns.ExplorationLevels = {",
    ]
    count = 0
    for row in data["results"]:
        level = row["level"]
        if level is None:
            continue
        map_id, minimum, maximum = row["id"], level["min"], level["max"]
        if not all(type(value) is int for value in (map_id, minimum, maximum)):
            raise ValueError("Invalid numeric exploration level")
        if map_id <= 0 or not 1 <= minimum <= maximum <= 60:
            raise ValueError("Exploration level out of range")
        title = row["title"].replace("\n", " ").replace("\r", " ")
        lines.append(f"    [{map_id}] = {{ min = {minimum}, max = {maximum} }}, -- {title}")
        count += 1
    if not count:
        raise ValueError("Atlas contains no exploration levels")
    lines.append("}")
    destination = Path(__file__).resolve().parents[1] / "ExplorationLevels.lua"
    destination.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Updated {count} maps: {destination}")


if __name__ == "__main__":
    main()
