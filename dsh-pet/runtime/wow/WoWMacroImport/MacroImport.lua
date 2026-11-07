local API = {}
WoWCompanionMacroImport = API
local zh = GetLocale() == "zhCN" or GetLocale() == "zhTW"
local function L(cn, en) return zh and cn or en end
local frame, edit, message, button
local state, request, reason, serial = "idle", "", "", 0
local macroName = "WCP Import"
local messages = {
    empty = L("请输入宏内容。", "Enter a macro."),
    length = L("宏超过 255 UTF-8 字节，请缩短内容。", "The macro exceeds 255 UTF-8 bytes. Shorten it."),
    control = L("宏含有不支持的控制字符。", "The macro contains unsupported control characters."),
    command = L("每个非空行必须是已注册的斜杠命令或 #show / #showtooltip。", "Each nonempty line must use a registered slash command, #show, or #showtooltip."),
    lua = L("Lua 命令存在语法错误。", "The Lua command has a syntax error."),
    combat = L("战斗中不能创建或修改宏，请脱战后重新导入。", "Leave combat before importing a macro."),
    conflict = L("同名宏不属于本插件或已被手动修改，未覆盖。请先重命名该宏。", "The existing macro is not owned by this addon or was edited. Rename it before importing."),
    full = L("角色宏栏位已满。", "Character macro slots are full."),
    save = L("保存失败或读回内容不一致。", "Saving failed or the saved body did not match."),
    saved = L("已保存角色宏 WCP Import。可在 /macro 中拖到动作条使用。基础校验不保证技能和条件可用。", "Saved character macro WCP Import. Drag it from /macro to an action bar. Validation does not establish spell or condition availability."),
}

function API.Normalize(text)
    return (text:gsub("\r\n", "\n"):gsub("\r", "\n"):match("^%s*(.-)%s*$"))
end

-- The desktop checks the length and hash before it submits. This is correlation, not authentication.
function API.Hash(text)
    local value = 5381
    for i = 1, #text do value = (value * 33 + text:byte(i)) % 4294967296 end
    return value
end

function API.Validate(text)
    if type(text) ~= "string" then return nil, "empty" end
    text = API.Normalize(text)
    if text == "" then return nil, "empty" end
    if #text > 255 then return nil, "length" end
    if text:find("[%z\1-\8\11\12\14-\31\127]") then return nil, "control" end
    local commands = {}
    for key, value in pairs(_G) do
        if type(key) == "string" and key:match("^SLASH_.+%d+$") and type(value) == "string" then
            commands[value:lower()] = true
        end
    end
    local executable = false
    for line in (text .. "\n"):gmatch("(.-)\n") do
        line = line:match("^%s*(.-)%s*$")
        if line ~= "" then
            local token, args = line:match("^(%S+)%s*(.*)$")
            token = token:lower()
            if token ~= "#show" and token ~= "#showtooltip" then
                if not commands[token] then return nil, "command" end
                executable = true
                if (token == "/run" or token == "/script") and type(loadstring) == "function" then
                    if not loadstring(args) then return nil, "lua" end
                end
            end
        end
    end
    if not executable then return nil, "empty" end
    return text
end

local function SetResult(nextState, code)
    state, reason = nextState, code or ""
    if message then message:SetText(messages[code] or "") end
end

function API.Import(text)
    if InCombatLockdown() or UnitAffectingCombat("player") then SetResult("error", "combat"); return false, "combat" end
    local body, code = API.Validate(text)
    if not body then SetResult("error", code); return false, code end
    local generalCount, characterCount = GetNumMacros()
    local base = (Constants and Constants.MacroConsts and Constants.MacroConsts.MAX_ACCOUNT_MACROS) or MAX_ACCOUNT_MACROS or 120
    local maximum = (Constants and Constants.MacroConsts and Constants.MacroConsts.MAX_CHARACTER_MACROS) or MAX_CHARACTER_MACROS or 18
    local existing, matches = nil, 0
    for _, range in ipairs({{1, generalCount}, {base + 1, base + characterCount}}) do
        for index = range[1], range[2] do
            local name = GetMacroInfo(index)
            if name == macroName then existing, matches = index, matches + 1 end
        end
    end
    local db = WoWMacroImportDB
    if existing and (matches ~= 1 or existing <= base or not db or db.body ~= GetMacroBody(existing)) then
        SetResult("error", "conflict"); return false, "conflict"
    end
    if not existing and characterCount >= maximum then SetResult("error", "full"); return false, "full" end
    local ok, index
    if existing then ok, index = pcall(EditMacro, existing, macroName, 134400, body)
    else ok, index = pcall(CreateMacro, macroName, 134400, body, true) end
    if not ok or type(index) ~= "number" or index <= base or GetMacroBody(index) ~= body then
        SetResult("error", "save"); return false, "save"
    end
    WoWMacroImportDB = { body = body }
    SetResult("saved", "saved")
    return true
end

local function Save()
    if API.Import(edit:GetText()) then edit:ClearFocus() end
end

local function CreateUI()
    frame = CreateFrame("Frame", "WoWMacroImportFrame", UIParent, "BasicFrameTemplateWithInset")
    frame:SetSize(540, 350)
    frame:SetPoint("CENTER")
    frame:SetFrameStrata("DIALOG")
    frame:SetClampedToScreen(true)
    frame:EnableMouse(true)
    frame:SetMovable(true)
    frame:RegisterForDrag("LeftButton")
    frame:SetScript("OnDragStart", frame.StartMoving)
    frame:SetScript("OnDragStop", frame.StopMovingOrSizing)
    frame.TitleText:SetText(L("魔兽陪伴精灵 · 导入宏", "WoW Companion · Import macro"))
    local help = frame:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
    help:SetPoint("TOPLEFT", 18, -38)
    help:SetWidth(500)
    help:SetJustifyH("LEFT")
    help:SetText(L("粘贴宏内容，点击下方按钮或按 Ctrl+Enter 校验并导入。仅保存，不执行。", "Paste a macro, then click below or press Ctrl+Enter to validate and import. Saves without execution."))
    local scroll = CreateFrame("ScrollFrame", nil, frame, "UIPanelScrollFrameTemplate")
    scroll:SetPoint("TOPLEFT", 20, -75)
    scroll:SetPoint("BOTTOMRIGHT", -40, 115)
    edit = CreateFrame("EditBox", "WoWMacroImportEditBox", scroll)
    edit:SetMultiLine(true)
    edit:SetAutoFocus(false)
    edit:SetFontObject(ChatFontNormal)
    edit:SetWidth(475)
    edit:SetHeight(140)
    -- Never truncate an overlong paste into a different valid macro.
    edit:SetMaxLetters(0)
    scroll:SetScrollChild(edit)
    edit:SetScript("OnTextChanged", function()
        if frame:IsShown() then SetResult(API.Normalize(edit:GetText()) == "" and "ready" or "edited") end
    end)
    edit:SetScript("OnEscapePressed", function() frame:Hide() end)
    edit:SetScript("OnEnterPressed", function()
        if IsControlKeyDown() then
            local submittedRequest = request
            C_Timer.After(0, function()
                if frame:IsShown() and GetCurrentKeyBoardFocus() == edit and request == submittedRequest then Save() end
            end)
        else
            edit:Insert("\n")
        end
    end)
    button = CreateFrame("Button", nil, frame, "UIPanelButtonTemplate")
    button:SetSize(180, 28)
    button:SetPoint("BOTTOM", 0, 75)
    button:SetText(L("校验并导入", "Validate and import"))
    button:SetScript("OnClick", Save)
    message = frame:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
    message:SetPoint("BOTTOMLEFT", 20, 18)
    message:SetWidth(500)
    message:SetHeight(48)
    message:SetJustifyH("LEFT")
    frame:SetScript("OnHide", function() edit:ClearFocus(); SetResult("closed") end)
    table.insert(UISpecialFrames, "WoWMacroImportFrame")
end

function API.Open(value)
    if not frame then CreateUI() end
    request = type(value) == "string" and value:match("^%x%x%x%x%x%x%x%x%x%x%x%x%x%x%x%x%x%x%x%x%x%x%x%x%x%x%x%x%x%x%x%x$") or ""
    frame:Show()
    edit:SetText("")
    SetResult("ready")
    edit:SetFocus()
end

-- Called once per emitted macro frame by either companion telemetry addon.
function API.Telemetry()
    serial = serial + 1
    local body = edit and API.Normalize(edit:GetText()) or ""
    local focus = GetCurrentKeyBoardFocus()
    return { q = serial, id = request, st = state, r = reason, hash = API.Hash(body), bytes = #body,
        focus = frame and frame:IsShown() and focus == edit or false, input = focus ~= nil,
        chat = focus ~= nil and type(focus:GetName()) == "string" and focus:GetName():match("^ChatFrame%d+EditBox$") ~= nil,
        combat = InCombatLockdown() or UnitAffectingCombat("player") or false }
end

SLASH_WOWMACROIMPORT1 = "/import-marco"
SLASH_WOWMACROIMPORT2 = "/import-macro"
SlashCmdList.WOWMACROIMPORT = API.Open
