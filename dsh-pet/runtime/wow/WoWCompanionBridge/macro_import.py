"""One desktop-owned import. JSON enters stdin, game receipts enter the pixel bridge.

The parent keeps stdin open. EOF cancels the operation. No macro body is executed here.
"""
from __future__ import annotations

import json
import re
import sys
import threading
import time
import uuid
from urllib.request import ProxyHandler, build_opener

from protocol import validate_macro


class ImportFailure(Exception):
    pass


def normalize(text):
    if not isinstance(text, str):
        raise ImportFailure("invalid-body")
    text = text.replace("\r\n", "\n").replace("\r", "\n").strip(" \t\n\v\f")
    if not text or len(text.encode("utf-8")) > 255 or re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", text):
        raise ImportFailure("invalid-body")
    if any(line.strip() and not line.lstrip().startswith(("/", "#")) for line in text.split("\n")):
        raise ImportFailure("invalid-body")
    return text


def body_hash(text):
    value = 5381
    for byte in text.encode("utf-8"):
        value = (value * 33 + byte) % 4294967296
    return value


class MacroImporter:
    """Only a fresh matching character can advance the open/paste/save state machine."""

    def __init__(self, read, native, cancelled, clock=time.monotonic, sleep=time.sleep):
        self.read, self.native, self.cancelled = read, native, cancelled
        self.clock, self.sleep = clock, sleep
        self.identity = None
        self.game = None

    def observe(self, allow_combat=False):
        if self.cancelled():
            raise ImportFailure("cancelled")
        self.native.check()
        value = self.read()
        snapshot, receipt = value.get("snapshot"), value.get("macroImport")
        if (value.get("status") != "live" or value.get("source") != "screen" or value.get("error")
                or value.get("game") != self.game or not isinstance(snapshot, dict) or not isinstance(receipt, dict)
                or snapshot.get("online") is not True or snapshot.get("dead") is not False
                or type(value.get("ageSeconds")) not in (int, float) or not 0 <= value["ageSeconds"] <= 2.5):
            raise ImportFailure("telemetry-unavailable")
        identity = (value.get("instanceId"), snapshot.get("account"), snapshot.get("guid"), snapshot.get("session"))
        if any(not isinstance(part, str) or not part for part in identity):
            raise ImportFailure("telemetry-unavailable")
        if self.identity is not None and identity != self.identity:
            raise ImportFailure("character-changed")
        self.identity = identity
        if (receipt.get("g"), receipt.get("s")) != (snapshot["guid"], snapshot["session"]):
            raise ImportFailure("character-changed")
        validate_macro(receipt)
        combat = snapshot.get("combat")
        if type(combat) is not bool or type(receipt.get("combat")) is not bool:
            raise ImportFailure("telemetry-unavailable")
        if not allow_combat and (combat or receipt["combat"]):
            raise ImportFailure("combat-started")
        return snapshot, receipt

    def wait(self, predicate, timeout=12):
        deadline = self.clock() + timeout
        while self.clock() < deadline:
            snapshot, receipt = self.observe()
            if predicate(receipt):
                return receipt
            self.sleep(0.1)
        raise ImportFailure("receipt-timeout")

    def acquire_focus(self):
        self.native.activate()
        deadline = self.clock() + 12
        stable_since = None
        while self.clock() < deadline:
            if self.cancelled():
                raise ImportFailure("cancelled")
            try:
                self.native.check()
                if stable_since is None:
                    stable_since = self.clock()
                if self.clock() - stable_since >= 0.25:
                    return
            except ImportFailure as error:
                if str(error) != "focus-lost":
                    raise
                stable_since = None
            self.sleep(0.05)
        raise ImportFailure("focus-not-acquired")

    def run(self, body, game):
        self.game = game
        body = normalize(body)
        self.native.copy(body)
        self.acquire_focus()
        # Combat can delay the first action. After the first key, combat cancels instead of resuming a partial import.
        deadline = self.clock() + 90
        while True:
            snapshot, receipt = self.observe(allow_combat=True)
            if not snapshot["combat"] and not receipt["combat"]:
                break
            if self.clock() >= deadline:
                raise ImportFailure("combat-timeout")
            self.sleep(0.1)
        if receipt.get("input") or receipt.get("st") in ("ready", "edited"):
            raise ImportFailure("input-busy")
        request_id = uuid.uuid4().hex
        serial = receipt["q"]
        _, current = self.observe()
        if current.get("input") or current.get("st") in ("ready", "edited"):
            raise ImportFailure("input-busy")
        self.native.press("enter")
        self.wait(lambda r: r["q"] > serial and r.get("chat") is True)
        _, current = self.observe()
        if current.get("chat") is not True:
            raise ImportFailure("input-changed")
        self.native.command("/import-marco " + request_id)
        ready = self.wait(lambda r: r.get("id") == request_id and r.get("st") == "ready" and r.get("focus") is True)
        self.native.copy(body)
        _, current = self.observe()
        if current.get("id") != request_id or current.get("focus") is not True or current.get("st") != "ready":
            raise ImportFailure("input-changed")
        self.native.press("paste")
        expected = (body_hash(body), len(body.encode("utf-8")))

        def pasted(r):
            if r["q"] <= ready["q"]:
                return False
            if r.get("id") != request_id or not r.get("focus"):
                raise ImportFailure("input-changed")
            if r.get("st") == "edited":
                if (r.get("hash"), r.get("bytes")) != expected:
                    raise ImportFailure("content-mismatch")
                return True
            return False

        received = self.wait(pasted)
        _, current = self.observe()
        if (current.get("id"), current.get("st"), current.get("focus"), current.get("hash"), current.get("bytes")) != (request_id, "edited", True, *expected):
            raise ImportFailure("input-changed")
        self.native.press("save")

        def saved(r):
            if r["q"] <= received["q"]:
                return False
            if r.get("id") != request_id:
                raise ImportFailure("input-changed")
            if r.get("st") == "error":
                raise ImportFailure("addon-" + str(r.get("r")))
            if r.get("st") == "closed":
                raise ImportFailure("input-changed")
            return r.get("st") == "saved" and (r.get("hash"), r.get("bytes")) == expected

        self.wait(saved)
        return {"ok": True, "code": "saved", "macroName": "WCP Import", "requestId": request_id}


def main():
    # The native module shares this exception class when this file is the entry point.
    sys.modules.setdefault("macro_import", sys.modules[__name__])
    from macro_native import WindowsMacroInput
    request = json.loads(sys.stdin.readline(16384))
    if request.get("game") not in ("retail", "forever"):
        raise ImportFailure("invalid-game")
    cancel = threading.Event()
    def watch_parent():
        sys.stdin.read()
        cancel.set()
    threading.Thread(target=watch_parent, daemon=True).start()
    port = {"retail": 18765, "forever": 18766}[request["game"]]
    opener = build_opener(ProxyHandler({}))
    def read():
        with opener.open(f"http://127.0.0.1:{port}/api/status", timeout=2) as response:
            return json.loads(response.read(1048576))
    native = WindowsMacroInput(request["window"])
    try:
        result = MacroImporter(read, native, cancel.is_set).run(request["body"], request["game"])
        print(json.dumps(result), flush=True)
    finally:
        native.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        code = str(error) if isinstance(error, ImportFailure) else "import-failed"
        print(json.dumps({"ok": False, "code": code}), flush=True)
