"""Task evidence, bounded cross-language assembly, and live character isolation."""
import base64
import copy
import json
import unittest
from pathlib import Path

from protocol import FrameError, QuestError, decode_frame, encode_frame, validate_quests
from state import CompanionState
from test_bridge import snapshot


def quests(**changes):
    value = {"v": 1, "id": 1, "session": "test-session", "guid": "Player-1-TEST", "observedAt": 1700000000, "source": "quest-log",
             "log": {"complete": True, "truncated": False, "total": 1, "entries": [
                 {"questID": 42, "title": "任务", "level": 15, "header": "地区", "readyForTurnIn": False, "failed": False, "objectivesComplete": True,
                  "objectives": [{"index": 1, "text": "目标2/3", "type": "item", "fulfilled": 2, "required": 3, "finished": False}]}]},
             "completion": {"source": "completed-api", "scope": "unknown", "complete": True, "truncated": False, "total": 2, "ids": [4, 9], "turnIns": []}}
    value.update(changes)
    return value


def fragments(record):
    data = json.dumps(record, separators=(",", ":"), ensure_ascii=False).encode()
    count = (len(data) + 239) // 240
    return [{"v": 1, "kind": "qlog", "s": record["session"], "g": record["guid"], "id": record["id"], "p": index + 1, "n": count,
             "d": base64.b64encode(data[index * 240:(index + 1) * 240]).decode()} for index in range(count)]


class QuestProtocolTests(unittest.TestCase):
    def test_evidence_scope_and_coverage_are_independent_from_objective_success(self):
        value = validate_quests(quests())
        self.assertTrue(value["log"]["entries"][0]["objectivesComplete"])
        self.assertFalse(value["log"]["entries"][0]["objectives"][0]["finished"])
        self.assertEqual(value["completion"]["turnIns"], [])
        self.assertEqual(value["completion"]["scope"], "unknown")

    def test_unknown_and_truncated_data_are_not_complete_empty_lists(self):
        value = quests(log={"complete": False, "truncated": False, "total": None, "entries": []},
                       completion={"source": "unknown", "scope": "unknown", "complete": False, "truncated": False, "total": None, "ids": [], "turnIns": []})
        self.assertIsNone(validate_quests(value)["log"]["total"])
        value["completion"]["complete"] = True
        with self.assertRaises(FrameError):
            validate_quests(value)

    def test_invalid_ids_flags_restricted_scope_duplicates_and_future_receipts_reject(self):
        mutations = [
            lambda value: value.update(observedAt=0),
            lambda value: value["completion"].update(scope="character"),
            lambda value: value["completion"].update(ids=[9, 4]),
            lambda value: value["completion"].update(source="unknown"),
            lambda value: value["completion"].update(truncated=True),
            lambda value: value["completion"].update(turnIns=[{"questID": 9, "observedAt": 1700000001}]),
            lambda value: value["log"].update(total=0),
            lambda value: value["log"]["entries"][0].update(title="bad\x85"),
            lambda value: value["log"]["entries"][0].update(readyForTurnIn=1),
            lambda value: value["log"]["entries"][0]["objectives"][0].update(fulfilled=-1),
            lambda value: value["log"]["entries"][0]["objectives"].append(copy.deepcopy(value["log"]["entries"][0]["objectives"][0])),
        ]
        for mutation in mutations:
            value = quests()
            mutation(value)
            with self.subTest(value=value), self.assertRaises(FrameError):
                validate_quests(value)

    def test_bad_fragments_are_task_errors_and_do_not_impersonate_heartbeat_failures(self):
        for change in [{"n": 138}, {"p": 0}, {"d": "!"}, {"g": ""}]:
            with self.subTest(change=change), self.assertRaises(QuestError):
                encode_frame({**fragments(quests())[0], **change})

    def test_real_lua_frames_for_both_clients_match_the_python_contract(self):
        for game, addon, magic in [("retail", "WoWMapCompanion", "WCP1"), ("forever", "WoWForeverCompanion", "WCF1")]:
            folder = Path(__file__).resolve().parent.parent / addon / "tests" / "fixtures"
            record = json.loads((folder / f"lua-{game}-quests.json").read_bytes())
            self.assertEqual(validate_quests(record), record)
            state = CompanionState(clock=lambda: 0, wall_clock=lambda: 1700000000, game=game)
            state.ingest(snapshot(session=record["session"], guid=record["guid"]))
            stream = (folder / f"lua-{game}-quests.bin").read_bytes()
            for offset in range(0, len(stream), 512):
                state.ingest(decode_frame(stream[offset:offset + 512], magic))
            self.assertEqual(state.view()["quests"], record)
            (folder / f"lua-{game}-quests-bridge.json").write_text(json.dumps(state.view(), ensure_ascii=False), encoding="utf-8")


class QuestStateTests(unittest.TestCase):
    def setUp(self):
        self.now = [0.0]
        self.state = CompanionState(clock=lambda: self.now[0], wall_clock=lambda: 1700000000 + self.now[0])
        self.state.ingest(snapshot())

    def send(self, value=None):
        for fragment in fragments(quests() if value is None else value):
            self.state.ingest(fragment)

    def test_only_full_transfers_supply_immutable_observations_and_received_time(self):
        value = quests()
        parts = fragments(value)
        for part in reversed(parts[1:]):
            self.state.ingest(part)
            self.assertIsNone(self.state.view()["quests"])
        self.state.ingest(parts[0])
        view = self.state.view()
        self.assertEqual(view["quests"], value)
        self.assertEqual(view["questsReceivedAt"], "2023-11-14T22:13:20.000+00:00")
        view["quests"]["log"]["entries"].clear()
        self.assertEqual(self.state.view()["quests"], value)

    def test_replayed_parts_do_not_refresh_or_replace_newer_revision(self):
        self.send()
        received = self.state.view()["questsReceivedAt"]
        self.now[0] = 2
        self.send()
        self.assertEqual(self.state.view()["questsReceivedAt"], received)
        self.send(quests(id=2, observedAt=1700000002))
        self.send()
        self.assertEqual(self.state.view()["quests"]["id"], 2)

    def test_partial_new_revision_hides_old_data_without_blocking_inventory(self):
        from test_inventory import fragments as inventory_fragments, inventory
        self.send()
        self.state.ingest(fragments(quests(id=2))[0])
        self.assertIsNone(self.state.view()["quests"])
        for part in inventory_fragments(inventory()):
            self.state.ingest(part)
        self.assertIsNotNone(self.state.view()["inventory"])
        self.send(quests(id=2))
        self.assertEqual(self.state.view()["quests"]["id"], 2)

    def test_conflicting_fragments_and_excess_inflight_are_bounded(self):
        parts = fragments(quests())
        self.state.ingest(parts[0])
        self.state.ingest({**parts[0], "d": base64.b64encode(b"conflict").decode()})
        self.assertIsNotNone(self.state.view()["questsError"])
        self.assertIsNone(self.state.view()["quests"])
        for identifier in range(2, 10):
            self.state.ingest(fragments(quests(id=identifier))[0])
        self.assertLessEqual(len(self.state.quests_pending), 2)

    def test_foreign_identity_stale_paused_demo_and_old_capture_are_never_current(self):
        self.send(quests(guid="Player-other"))
        self.assertIsNone(self.state.view()["quests"])
        self.send(quests(id=2))
        self.assertIsNotNone(self.state.view()["quests"])
        self.now[0] = 6
        self.assertIsNone(self.state.view()["quests"])
        self.state.ingest(snapshot(seq=2, tick=6000))
        self.state.update_config({"paused": True})
        self.assertIsNone(self.state.view()["quests"])
        self.setUp()
        self.send(quests(observedAt=1699998799))
        self.assertIsNone(self.state.view()["quests"])

    def test_new_session_does_not_inherit_completion_receipts(self):
        self.send()
        self.state.ingest(snapshot(session="next-session", seq=2, tick=100))
        self.assertIsNone(self.state.view()["quests"])
        self.assertIsNone(self.state.view()["questsReceivedAt"])


if __name__ == '__main__':
    unittest.main()
