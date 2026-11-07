import unittest
from pathlib import Path
import test_macro_import
from test_bridge import snapshot
from protocol import validate_calendar, FrameError, encode_frame, decode_frame
from state import CompanionState


def frame(**changes):
    result = dict(v=1, kind="calendar", s="test-session", g="Player-1-TEST", day="2026-12-31",
                  p=1, n=1, title="Holiday", action="end", when="2027-01-01 06:00")
    result.update(changes)
    return result


class CalendarTests(unittest.TestCase):
    def test_personal_and_reset_actions_obey_their_dates(self):
        for action, when in (("reset", "2026-12-31 06:00"), ("reset_soon", "2027-01-01 06:00"),
                             ("personal_start", "2026-12-31 19:00"), ("personal_end", "2027-01-01 20:00")):
            value = frame(action=action, when=when)
            self.assertEqual(decode_frame(encode_frame(value)), value)
            with self.assertRaises(FrameError):
                validate_calendar(frame(action=action, when="2027-01-02 06:00"))

    def test_private_entries_lockouts_and_declined_invites(self):
        fixture = test_macro_import.LuaTests()
        fixture.setUp()
        lua = fixture.lua
        lua.execute(b'''
        ns={}; current={year=2026,month=12,monthDay=31,hour=5,minute=0}
        tomorrow={year=2027,month=1,monthDay=1,hour=6,minute=0}
        Enum={CalendarStatus={Declined=3,Out=5}}
        entries={
          {calendarType="PLAYER",title="Appointment",startTime=current,endTime=current},
          {calendarType="PLAYER",title="Declined",startTime=current,inviteStatus=3},
          {calendarType="GUILD_EVENT",title="Guild",startTime=current,endTime=tomorrow},
          {calendarType="RAID_LOCKOUT"},
          {calendarType="PLAYER",title="Out",startTime=current,inviteStatus=5}
        }
        C_Calendar={
          GetMonthInfo=function() return {year=2026,month=12} end,
          GetNumDayEvents=function() return #entries end,
          GetDayEvent=function(_,_,i) return entries[i] end,
          GetRaidInfo=function() return {name="Raid",difficultyName="Heroic",time=tomorrow} end
        }
        ''')
        for folder in ("WoWMapCompanion", "WoWForeverCompanion"):
            source = Path(__file__).resolve().parent.parent / folder / "Calendar.lua"
            lua.execute(source.read_bytes(), b"test", lua.globals().ns)
            items = lua.globals().ns.Calendar.Collect(lua.globals().current)[b"items"]
            result = {(i[b"title"], i[b"action"]) for i in items.values()}
            self.assertEqual(result, {(b"Appointment", b"personal_start"), (b"Guild", b"personal_start"),
                                      (b"Guild", b"personal_end"), (b"Raid (Heroic)", b"reset_soon")})

    def test_roundtrip_and_invalid_dates(self):
        for magic in ("WCP1", "WCF1"):
            self.assertEqual(decode_frame(encode_frame(frame(), magic), magic), frame())
        for changes in ({"day":"2026-02-30"}, {"when":"2027-01-02 06:00"}, {"action":"run"}, {"p":2}, {"n":True}):
            with self.subTest(changes=changes), self.assertRaises(FrameError):
                validate_calendar(frame(**changes))

    def test_complete_batch_and_session_isolation(self):
        state = CompanionState()
        state.ingest(snapshot())
        state.ingest(frame(n=2, p=2))
        self.assertIsNone(state.view()["calendar"])
        state.ingest(frame(n=2, action="start", when="2026-12-31 07:00"))
        self.assertEqual(len(state.view()["calendar"]["items"]), 2)
        state.ingest(snapshot(session="new", tick=2))
        self.assertIsNone(state.view()["calendar"])
        state.ingest(frame())
        self.assertIsNone(state.view()["calendar"])

    def test_demo_paused_and_empty(self):
        state = CompanionState()
        state.ingest(snapshot())
        state.ingest(frame(n=0,title="",action="none",when=""))
        self.assertEqual(state.view()["calendar"]["items"], [])
        state.config["paused"] = True
        self.assertIsNone(state.view()["calendar"])

    def test_real_lua_cross_year_and_duplicate_holidays(self):
        fixture = test_macro_import.LuaTests()
        fixture.setUp()
        lua = fixture.lua
        lua.execute(b'''
        ns={}; current={year=2026,month=12,monthDay=31,hour=5,minute=0}
        C_Calendar={
          GetMonthInfo=function() return {year=2027,month=2} end,
          GetNumDayEvents=function(offset,day) assert(offset==-2 or offset==-1); return 1 end,
          GetDayEvent=function() return {calendarType="HOLIDAY"} end,
          GetHolidayInfo=function() return {name="Holiday",startTime=current,endTime={year=2027,month=1,monthDay=1,hour=6,minute=0}} end,
          OpenCalendar=function() end
        }
        C_DateAndTime={GetCurrentCalendarTime=function() return current end}
        function GetRealmName() return "Realm" end
        function UnitGUID() return "Player-1" end
        clock=0; function GetTime() return clock end
        ''')
        source = Path(__file__).resolve().parent.parent / "WoWMapCompanion" / "Calendar.lua"
        lua.execute(source.read_bytes(), b"test", lua.globals().ns)
        calendar = lua.globals().ns.Calendar
        result = calendar.Collect(lua.globals().current)
        self.assertEqual(result[b"day"], b"2026-12-31")
        self.assertEqual(len(result[b"items"]), 2)
        self.assertEqual(result[b"items"][2][b"when"], b"2027-01-01 06:00")
        lua.execute(b'originalCreate=CreateFrame; function CreateFrame(...) local f=originalCreate(...); lastFrame=f; return f end; db={}')
        calendar.Initialize(lua.globals().db)
        listener = lua.globals().lastFrame
        listener.scripts[b"OnEvent"](listener, b"PLAYER_ENTERING_WORLD")
        self.assertIsNone(calendar.Next())
        listener.scripts[b"OnEvent"](listener, b"CALENDAR_UPDATE_EVENT_LIST")
        lua.globals().clock = 6
        self.assertEqual(calendar.Next()[b"n"], 2)
        lua.execute(source.read_bytes(), b"test", lua.globals().ns)
        calendar = lua.globals().ns.Calendar
        calendar.Initialize(lua.globals().db)
        listener = lua.globals().lastFrame
        listener.scripts[b"OnEvent"](listener, b"PLAYER_ENTERING_WORLD")
        self.assertEqual(calendar.Next()[b"n"], 2)
        lua.execute(b'current={year=2027,month=1,monthDay=1,hour=0,minute=1}')
        self.assertIsNone(calendar.Next())
        lua.execute(b'current={year=2026,month=12,monthDay=31,hour=5,minute=0}; function UnitGUID() return "Player-2" end')
        lua.execute(source.read_bytes(), b"test", lua.globals().ns)
        other = lua.globals().ns.Calendar
        other.Initialize(lua.globals().db)
        listener = lua.globals().lastFrame
        listener.scripts[b"OnEvent"](listener, b"PLAYER_ENTERING_WORLD")
        self.assertIsNone(other.Next())
        lua.execute(b'current={year=2028,month=2,monthDay=28,hour=5,minute=0}; C_Calendar.GetMonthInfo=function() return {year=2028,month=2} end; C_Calendar.GetNumDayEvents=function(_,day) assert(day==28 or day==29);return 0 end')
        self.assertEqual(len(calendar.Collect(lua.globals().current)[b"items"]), 0)
