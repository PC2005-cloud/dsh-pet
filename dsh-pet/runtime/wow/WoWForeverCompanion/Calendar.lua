local _, ns = ...
local Calendar = {}
ns.Calendar = Calendar
local storage, batch, loginDay, cursor, entered, loaded, nextTry

local function Day(t)
    if type(t) ~= "table" or not t.year or not t.month or not t.monthDay then return nil end
    return string.format("%04d-%02d-%02d", t.year, t.month, t.monthDay)
end

local function Tomorrow(t)
    local y, m, d = t.year, t.month, t.monthDay + 1
    local leap = y % 4 == 0 and (y % 100 ~= 0 or y % 400 == 0)
    local days = {31, leap and 29 or 28,31,30,31,30,31,31,30,31,30,31}
    if d > days[m] then d, m = 1, m + 1 end
    if m > 12 then m, y = 1, y + 1 end
    return {year=y, month=m, monthDay=d}
end

function Calendar.Collect(now)
    local today, tomorrow = Day(now), Tomorrow(now)
    local month = C_Calendar.GetMonthInfo(0)
    local items, seen = {}, {}
    for _, day in ipairs({now, tomorrow}) do
        local offset = (day.year - month.year) * 12 + day.month - month.month
        local count = C_Calendar.GetNumDayEvents(offset, day.monthDay)
        if type(count) ~= "number" or count > 200 then return nil end
        for i = 1, count do
            local event = C_Calendar.GetDayEvent(offset, day.monthDay, i)
            if not event then return nil end
            local kind = event.calendarType
            local title, times = event.title, {}
            if kind == "HOLIDAY" then
                local holiday = C_Calendar.GetHolidayInfo(offset, day.monthDay, i)
                if not holiday then return nil end
                title = holiday.name
                times = {{action="start", time=holiday.startTime, due=today}, {action="end", time=holiday.endTime, due=Day(tomorrow)}}
            elseif kind == "RAID_LOCKOUT" then
                local raid = C_Calendar.GetRaidInfo(offset, day.monthDay, i)
                if not raid then return nil end
                title = raid.name
                if raid.difficultyName and raid.difficultyName ~= "" then title = title .. " (" .. raid.difficultyName .. ")" end
                times = {{action="reset", time=raid.time, due=today}, {action="reset_soon", time=raid.time, due=Day(tomorrow)}}
            elseif kind == "PLAYER" or kind == "GUILD_EVENT" or kind == "GUILD_ANNOUNCEMENT" or kind == "COMMUNITY_EVENT" then
                local status = Enum and Enum.CalendarStatus
                local excluded = status and (event.inviteStatus == status.Declined or event.inviteStatus == status.Out)
                if not excluded then
                    times = {{action="personal_start", time=event.startTime, due=today}}
                    -- Point-in-time appointments have no independent ending to announce.
                    if Day(event.endTime) and Day(event.startTime) and (Day(event.endTime) ~= Day(event.startTime)
                        or event.endTime.hour ~= event.startTime.hour or event.endTime.minute ~= event.startTime.minute) then
                        times[#times+1] = {action="personal_end", time=event.endTime, due=Day(tomorrow)}
                    end
                end
            end
            for _, reminder in ipairs(times) do
                local t = reminder.time
                if Day(t) == reminder.due and type(title) == "string" and #title <= 160 then
                    local when = string.format("%s %02d:%02d", Day(t), t.hour, t.minute)
                    local key = title .. reminder.action .. when
                    if not seen[key] then
                        seen[key] = true
                        items[#items+1] = {title=title, action=reminder.action, when=when}
                    end
                end
            end
        end
    end
    if #items > 32 then return nil end
    table.sort(items, function(a,b) return a.when .. a.action .. a.title < b.when .. b.action .. b.title end)
    return {day=today, items=items}
end

function Calendar.Initialize(db)
    storage = db
    local events = CreateFrame("Frame")
    events:RegisterEvent("PLAYER_ENTERING_WORLD")
    events:RegisterEvent("CALENDAR_UPDATE_EVENT_LIST")
    events:SetScript("OnEvent", function(_, event)
        if event == "PLAYER_ENTERING_WORLD" and not entered then
            entered = true
            nextTry = GetTime() + 5
            if C_Calendar and C_Calendar.OpenCalendar then pcall(C_Calendar.OpenCalendar) end
        elseif event == "CALENDAR_UPDATE_EVENT_LIST" then loaded = true end
    end)
end

function Calendar.Next()
    if not entered or not C_DateAndTime or not C_Calendar then return nil end
    local now = C_DateAndTime.GetCurrentCalendarTime()
    loginDay = loginDay or Day(now)
    if Day(now) ~= loginDay then return nil end
    local realm, guid = GetRealmName(), UnitGUID("player")
    if not guid then return nil end
    if not storage.calendarV2 or storage.calendarV2.day ~= loginDay then
        storage.calendarV2 = {day=loginDay, characters={}}
    end
    local cached = storage.calendarV2.characters[guid]
    if not batch and cached and cached.realm == realm then batch = cached end
    if not batch and loaded and GetTime() >= nextTry then
        nextTry = GetTime() + 5
        local ok, result = pcall(Calendar.Collect, now)
        if ok and result then
            batch = result
            batch.realm = realm
            storage.calendarV2.characters[guid] = batch
        end
    end
    if not batch then return nil end
    local n = #batch.items
    cursor = (cursor or 0) % math.max(n,1) + 1
    local item = batch.items[cursor] or {title="", action="none", when=""}
    return {day=batch.day, p=cursor, n=n, title=item.title, action=item.action, when=item.when}
end
