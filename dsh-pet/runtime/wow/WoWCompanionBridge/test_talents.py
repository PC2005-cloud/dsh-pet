"""Committed trait evidence, real Lua/CRC interop, and independent live-session assembly."""
import base64
import copy
import json
import unittest
from pathlib import Path

from protocol import FrameError, TalentError, decode_frame, encode_frame, validate_talents
from state import CompanionState
from test_bridge import snapshot

ROOT = Path(__file__).resolve().parent.parent


def talents(**changes):
    result = json.loads((ROOT / 'WoWMapCompanion/tests/fixtures/lua-retail-talents.json').read_bytes())
    result.update(session='test-session', guid='Player-1-TEST')
    result.update(changes)
    return result


def fragments(record):
    data = json.dumps(record, separators=(',', ':'), ensure_ascii=False).encode()
    count = (len(data) + 239) // 240
    return [{'v': 1, 'kind': 'traits', 's': record['session'], 'g': record['guid'], 'id': record['id'], 'p': index + 1, 'n': count,
             'd': base64.b64encode(data[index * 240:(index + 1) * 240]).decode()} for index in range(count)]


class TalentProtocolTests(unittest.TestCase):
    def test_active_partial_and_staged_have_different_rank_evidence(self):
        value = validate_talents(talents())
        self.assertEqual(value['nodes'][0]['nodeID'], 9001)
        self.assertEqual(value['nodes'][0]['entries'][0]['entryID'], 101)
        staged = talents(status='staged', hasStagedChanges=True, complete=False, nodes=[], knownZeroNodes=[])
        self.assertEqual(validate_talents(staged)['nodes'], [])
        partial = talents(complete=False, truncated=True, knownZeroNodes=[])
        self.assertEqual(validate_talents(partial)['knownZeroNodes'], [])

    def test_bad_commit_evidence_identity_order_mapping_and_bounds_are_rejected(self):
        mutations = [
            lambda value: value.update(status='active', hasStagedChanges=True),
            lambda value: value.update(status='staged', hasStagedChanges=False),
            lambda value: value.update(status='unknown', complete=False),
            lambda value: value.update(configID=None),
            lambda value: value.update(configType=2),
            lambda value: value.update(clientBuild='70707'),
            lambda value: value.update(classID=0),
            lambda value: value.update(truncated=True),
            lambda value: value.update(treeIDs=[]),
            lambda value: value['knownZeroNodes'].append(copy.deepcopy(value['knownZeroNodes'][0])),
            lambda value: value['knownZeroNodes'][0].update(nodeID=9001),
            lambda value: value['nodes'][0].update(ranksPurchased=0, activeRank=0),
            lambda value: value['nodes'][0]['entries'][0].update(entryID=0),
            lambda value: value['nodes'][0]['entries'][0].update(rank=True),
            lambda value: value['nodes'][0]['conditions'][0].update(isMet=1),
        ]
        for mutation in mutations:
            value = talents()
            mutation(value)
            with self.subTest(value=value), self.assertRaises(FrameError):
                validate_talents(value)

    def test_malformed_fragments_are_talent_errors_without_poisoning_heartbeat(self):
        for changes in [{'n': 275}, {'p': 0}, {'d': '!'}, {'s': ''}]:
            with self.subTest(changes=changes), self.assertRaises(TalentError):
                encode_frame({**fragments(talents())[0], **changes})

    def test_both_real_lua_crc_streams_produce_the_typescript_bridge_view_fixture(self):
        for game, addon, magic in [('retail', 'WoWMapCompanion', 'WCP1'), ('forever', 'WoWForeverCompanion', 'WCF1')]:
            folder = ROOT / addon / 'tests/fixtures'
            record = json.loads((folder / f'lua-{game}-talents.json').read_bytes())
            self.assertEqual(validate_talents(record), record)
            state = CompanionState(clock=lambda: 0, wall_clock=lambda: 1700000000, game=game)
            state.ingest(snapshot(session=record['session'], guid=record['guid'], **{'class': record['class'], 'spec': record['specID']}))
            stream = (folder / f'lua-{game}-talents.bin').read_bytes()
            for offset in range(0, len(stream), 512):
                state.ingest(decode_frame(stream[offset:offset + 512], magic))
            self.assertEqual(state.view()['talents'], record)
            (folder / f'lua-{game}-talents-bridge.json').write_text(json.dumps(state.view(), ensure_ascii=False), encoding='utf-8')


class TalentStateTests(unittest.TestCase):
    def setUp(self):
        self.now = [0.0]
        self.state = CompanionState(clock=lambda: self.now[0], wall_clock=lambda: 1700000000 + self.now[0])
        self.state.ingest(snapshot(**{'class': 'WARRIOR', 'spec': 71}))

    def send(self, record=None):
        for part in fragments(talents() if record is None else record):
            self.state.ingest(part)

    def test_only_complete_transfers_publish_immutable_committed_snapshots(self):
        parts = fragments(talents())
        for part in reversed(parts[1:]):
            self.state.ingest(part)
            self.assertIsNone(self.state.view()['talents'])
        self.state.ingest(parts[0])
        view = self.state.view()
        self.assertEqual(view['talents'], talents())
        self.assertEqual(view['talentsReceivedAt'], '2023-11-14T22:13:20.000+00:00')
        view['talents']['nodes'].clear()
        self.assertEqual(len(self.state.view()['talents']['nodes']), 1)

    def test_staged_transition_invalidates_active_without_exposing_preview_ranks(self):
        self.send()
        staged = talents(id=2, status='staged', hasStagedChanges=True, complete=False, nodes=[], knownZeroNodes=[])
        parts = fragments(staged)
        self.state.ingest(parts[0])
        self.assertIsNone(self.state.view()['talents'])
        for part in parts[1:]:
            self.state.ingest(part)
        self.assertEqual(self.state.view()['talents']['status'], 'staged')
        self.assertEqual(self.state.view()['talents']['nodes'], [])

    def test_replays_do_not_renew_or_restore_old_configurations(self):
        self.send()
        received = self.state.view()['talentsReceivedAt']
        self.now[0] = 2
        self.send()
        self.assertEqual(self.state.view()['talentsReceivedAt'], received)
        self.send(talents(id=2, configID=8, observedAt=1700000002))
        self.send()
        self.assertEqual(self.state.view()['talents']['configID'], 8)

    def test_spec_sampling_lag_hides_data_then_accepts_it_without_permanent_rejection(self):
        self.send(talents(specID=72))
        self.assertIsNone(self.state.view()['talents'])
        self.assertIsNone(self.state.view()['talentsError'])
        self.state.ingest(snapshot(seq=2, tick=2, **{'class': 'WARRIOR', 'spec': 72}))
        self.assertEqual(self.state.view()['talents']['specID'], 72)

    def test_conflict_and_excess_pending_revisions_do_not_block_tasks_or_inventory(self):
        from test_inventory import fragments as inventory_fragments, inventory
        from test_quests import fragments as quest_fragments, quests
        first = fragments(talents())[0]
        self.state.ingest(first)
        self.state.ingest({**first, 'd': base64.b64encode(b'conflict').decode()})
        self.assertIsNotNone(self.state.view()['talentsError'])
        for identifier in range(2, 10):
            self.state.ingest(fragments(talents(id=identifier))[0])
        self.assertLessEqual(len(self.state.talents_pending), 2)
        for part in inventory_fragments(inventory()):
            self.state.ingest(part)
        for part in quest_fragments(quests()):
            self.state.ingest(part)
        self.assertIsNotNone(self.state.view()['inventory'])
        self.assertIsNotNone(self.state.view()['quests'])

    def test_foreign_sessions_stale_paused_and_demo_never_supply_current_talents(self):
        self.send(talents(guid='Player-other'))
        self.assertIsNone(self.state.view()['talents'])
        self.send(talents(id=2))
        self.assertIsNotNone(self.state.view()['talents'])
        self.now[0] = 6
        self.assertIsNone(self.state.view()['talents'])
        self.state.ingest(snapshot(seq=2, tick=6000, **{'class': 'WARRIOR', 'spec': 71}))
        self.state.update_config({'paused': True})
        self.assertIsNone(self.state.view()['talents'])
        self.setUp()
        self.state.set_demo(True)
        self.send()
        self.assertIsNone(self.state.view()['talents'])

    def test_capture_time_is_bounded_and_new_session_clears_evidence(self):
        for observed in [1699998799, 1700000121]:
            self.setUp()
            self.send(talents(observedAt=observed))
            self.assertIsNone(self.state.view()['talents'])
        self.setUp(); self.send()
        self.state.ingest(snapshot(session='another-session', seq=2, tick=2, **{'class': 'WARRIOR', 'spec': 71}))
        self.assertIsNone(self.state.view()['talents'])
        self.assertIsNone(self.state.view()['talentsReceivedAt'])


if __name__ == '__main__':
    unittest.main()
