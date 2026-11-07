-- Compare public item facts conservatively. No rating weights or simulated damage claims.
local _, ns = ...
local L = ns.L or function(text) return text end
local Compare = {}
ns.EquipmentCompare = Compare
local Public = ns.Protocol.Public
local slots = { INVTYPE_HEAD={1}, INVTYPE_NECK={2}, INVTYPE_SHOULDER={3}, INVTYPE_CHEST={5}, INVTYPE_ROBE={5},
    INVTYPE_WAIST={6}, INVTYPE_LEGS={7}, INVTYPE_FEET={8}, INVTYPE_WRIST={9}, INVTYPE_HAND={10},
    INVTYPE_FINGER={11,12}, INVTYPE_TRINKET={13,14}, INVTYPE_CLOAK={15}, INVTYPE_WEAPON={16},
    INVTYPE_WEAPONMAINHAND={16}, INVTYPE_2HWEAPON={16}, INVTYPE_RANGED={16}, INVTYPE_RANGEDRIGHT={16},
    INVTYPE_WEAPONOFFHAND={17}, INVTYPE_SHIELD={17}, INVTYPE_HOLDABLE={17} }
local primaryKeys = { [1]="ITEM_MOD_STRENGTH_SHORT", [2]="ITEM_MOD_AGILITY_SHORT", [4]="ITEM_MOD_INTELLECT_SHORT" }
local primaryValues = { ITEM_MOD_STRENGTH_SHORT=1, ITEM_MOD_AGILITY_SHORT=2, ITEM_MOD_INTELLECT_SHORT=4 }
local secondaryStats = {}
for _, suffix in ipairs({ "CRIT_RATING_SHORT", "HASTE_RATING_SHORT", "MASTERY_RATING_SHORT", "VERSATILITY",
    "LIFESTEAL_SHORT", "AVOIDANCE_SHORT", "SPEED_SHORT", "DODGE_RATING_SHORT", "PARRY_RATING_SHORT",
    "BLOCK_RATING_SHORT", "DEFENSE_SKILL_RATING_SHORT", "HIT_RATING_SHORT", "EXPERTISE_RATING_SHORT" }) do
    secondaryStats["ITEM_MOD_"..suffix] = true
end
local knownStats = { RESISTANCE0_NAME=true }
for _, suffix in ipairs({ "STRENGTH_SHORT", "AGILITY_SHORT", "INTELLECT_SHORT", "STAMINA_SHORT", "CRIT_RATING_SHORT",
    "HASTE_RATING_SHORT", "MASTERY_RATING_SHORT", "VERSATILITY", "DAMAGE_PER_SECOND_SHORT", "ARMOR_SHORT",
    "ATTACK_POWER_SHORT", "SPELL_POWER_SHORT", "DODGE_RATING_SHORT", "PARRY_RATING_SHORT", "BLOCK_RATING_SHORT",
    "DEFENSE_SKILL_RATING_SHORT", "HIT_RATING_SHORT", "EXPERTISE_RATING_SHORT", "LIFESTEAL_SHORT", "AVOIDANCE_SHORT", "SPEED_SHORT" }) do
    knownStats["ITEM_MOD_"..suffix] = true
end
local function Call(fn, ...)
    if type(fn) ~= "function" then return nil end
    local values = { pcall(fn, ...) }
    if not values[1] then return nil end
    for index=2,20 do values[index]=Public(values[index]) end
    return unpack(values,2,20)
end
local function Readable(value)
    value=Public(value)
    if type(value) ~= "table" or (canaccesstable and not canaccesstable(value)) then return nil end
    return value
end
local function Number(value, low, high)
    value=Public(value)
    if type(value)=="number" and value==value and value>=low and value<=high then return value end
end
local function Text(value)
    value=Public(value)
    if type(value)~="string" then return nil end
    value=string.gsub(value,"|H.-|h(.-)|h","%1")
    value=string.gsub(value,"|c%x%x%x%x%x%x%x%x","")
    value=string.gsub(value,"|r","")
    value=string.gsub(value,"|T.-|t","")
    value=string.gsub(value,"|A.-|a","")
    value=string.gsub(value,"[%z\1-\31\127]","")
    if string.find(value,"\194[\128-\159]") then return nil end
    if #value>128 then return nil end
    return value
end
local function Plain(value)
    value=Public(value)
    if type(value)~="string" then return nil end
    value=string.gsub(value,"|H.-|h(.-)|h","%1")
    value=string.gsub(value,"|c%x%x%x%x%x%x%x%x","")
    value=string.gsub(value,"|r","")
    value=string.gsub(value,"|T.-|t","")
    value=string.gsub(value,"|A.-|a","")
    value=string.gsub(value,"[%z\1-\31\127]","")
    if string.find(value,"\194[\128-\159]") then return nil end
    return string.match(value,"^%s*(.-)%s*$")
end
local statNames={}
for _, name in ipairs({"力量","敏捷","智力","耐力","暴击","爆击","急速","精通","全能","护甲","吸血","躲闪","招架","格挡","防御","命中","精准","速度",
    "Strength","Agility","Intellect","Stamina","Critical Strike","Haste","Mastery","Versatility","Armor","Leech","Dodge","Parry","Block","Defense","Hit","Expertise","Speed"}) do statNames[name]=true end
local metadata={}
for _, name in ipairs({"灵魂绑定","拾取绑定","拾取后绑定","装备后绑定","账号绑定","战团绑定","双手","单手","主手","副手","头部","颈部","肩部","背部","披风","胸部","手腕","腕部","手","手部","腰部","腿部","脚","脚部","手指","Soulbound","Binds when picked up","Binds when equipped","Two-Hand","One-Hand","Main Hand","Off Hand","Head","Neck","Shoulder","Back","Chest","Wrist","Hands","Waist","Legs","Feet","Finger"}) do metadata[name]=true end
for _, name in ipairs({"锤","斧","剑","法杖","长柄武器","匕首","拳套","弓","枪械","弩","魔杖",
    "Mace","Axe","Sword","Staff","Polearm","Dagger","Fist Weapon","Bow","Gun","Crossbow","Wand"}) do metadata[name]=true end
-- Read the client's own localized labels rather than translating tooltip data.
for key in pairs(knownStats) do
    local name=Plain(_G[key])
    if name then statNames[name]=true end
end
for _, key in ipairs({"ITEM_SOULBOUND","ITEM_BIND_ON_PICKUP","ITEM_BIND_ON_EQUIP","ITEM_ACCOUNTBOUND",
    "ITEM_BNETACCOUNTBOUND","ITEM_WARBOUND","INVTYPE_2HWEAPON","INVTYPE_WEAPON","INVTYPE_WEAPONMAINHAND",
    "INVTYPE_WEAPONOFFHAND","INVTYPE_HEAD","INVTYPE_NECK","INVTYPE_SHOULDER","INVTYPE_CLOAK","INVTYPE_CHEST",
    "INVTYPE_WRIST","INVTYPE_HAND","INVTYPE_WAIST","INVTYPE_LEGS","INVTYPE_FEET","INVTYPE_FINGER"}) do
    local name=Plain(_G[key])
    if name then metadata[name]=true end
end
local localizedNumericPatterns={}
for _, key in ipairs({"ITEM_LEVEL","DURABILITY_TEMPLATE","ITEM_MIN_LEVEL","WEAPON_SPEED","DAMAGE_TEMPLATE","DPS_TEMPLATE","ARMOR_TEMPLATE"}) do
    local template=Plain(_G[key])
    if template then
        local parts,index,numeric={},1,false
        while index<=#template do
            local token=string.match(string.sub(template,index),"^%%[%d$]*[%.%d]*[dfs]")
            if token then parts[#parts+1]="[%d,%.]+"; numeric=true; index=index+#token
            else
                local char=string.sub(template,index,index)
                parts[#parts+1]=char==" " and "%s*" or string.gsub(char,"([%(%)%.%%%+%-%*%?%[%]%^%$])","%%%1")
                index=index+1
            end
        end
        if numeric then localizedNumericPatterns[#localizedNumericPatterns+1]="^"..table.concat(parts).."$" end
    end
end
local function SimpleLine(value,item)
    local input=value
    value=Plain(value)
    if not value then return input==nil end
    if value=="" then return true end
    if value==item.name or value==item.type or value==item.subtype or metadata[value] then return true end
    -- Rank icons have already been removed by Plain; an empty quality label and a
    -- creator credit describe crafting metadata, not an unmeasured item effect.
    if value=="品质：" or value=="品质:" or value=="Quality:" then return true end
    if string.match(value,"^<由[^<>]+制造>$") or string.match(value,"^<Made by [^<>]+>$")
        or string.match(value,"^<Crafted by [^<>]+>$") then return true end
    for _, pattern in ipairs(localizedNumericPatterns) do if string.match(value,pattern) then return true end end
    local name=string.match(value,"^[%+%-]?[%d,%.]+%s*(.+)$")
    if name and statNames[name] then return true end
    return string.match(value,"^[%d,%.]+%s*点护甲$")
        or string.match(value,"^物品等级%s*[%d%.]+$") or string.match(value,"^Item Level%s+[%d%.]+$")
        or string.match(value,"^耐久度%s*%d+%s*/%s*%d+$") or string.match(value,"^Durability%s+%d+%s*/%s*%d+$")
        or string.match(value,"^需要等级%s*%d+$") or string.match(value,"^Requires Level%s+%d+$")
        or string.match(value,"^速度%s*[%d%.]+$") or string.match(value,"^Speed%s+[%d%.]+$")
        or string.match(value,"^%d+%s*%-%s*%d+点伤害$") or string.match(value,"^%d+%s*%-%s*%d+ Damage$")
        or string.match(value,"^（每秒伤害[%d%.]+点）$") or string.match(value,"^%([%d%.]+ damage per second%)$")
end
local function Tooltip(link,item,provided)
    local lines=provided
    if not lines then
        local data=Readable(Call(C_TooltipInfo and C_TooltipInfo.GetHyperlink,link))
        lines=data and Readable(data.lines)
    end
    if not lines then return true,false end
    local complex,count=false,0
    for _, line in ipairs(lines) do
        if type(line)=="string" then
            -- Acquisition records join the two public tooltip columns with a middle dot.
            local left,right=string.match(line,"^(.-) · (.-)$")
            if not SimpleLine(left or line,item) or (right and not SimpleLine(right,item)) then complex=true end
            count=count+1
        else
            line=Readable(line)
            if not line or (issecretvalue and (issecretvalue(line.leftText) or issecretvalue(line.rightText))) then return true,false end
            if not SimpleLine(line.leftText,item) or not SimpleLine(line.rightText,item) then complex=true end
            count=count+1
        end
        if count>48 then return true,false end
    end
    return complex,count>0
end
local function Item(link,record)
    local name,_,_,_,_,itemType,subtype,_,equipLoc=Call(C_Item and C_Item.GetItemInfo,link)
    local item={itemID=tonumber(type(link)=="string" and string.match(link,"item:(%d+)")) or 0,
        name=Text(name) or "",itemLevel=Number(Call(C_Item and C_Item.GetDetailedItemLevelInfo,link),0,100000) or -1,
        equipLoc=Text(equipLoc) or "",type=Text(itemType) or "",subtype=Text(subtype) or "",stats={},complex=false,complete=false}
    local stats=Readable(Call(C_Item and C_Item.GetItemStats,link))
    local complete=stats~=nil
    if stats then
        for key,value in pairs(stats) do
            key,value=Public(key),Number(value,-1e12,1e12)
            if type(key)~="string" or #key>64 or not value or #item.stats>=32 then complete=false
            else item.stats[#item.stats+1]={key=key,value=value} end
        end
        table.sort(item.stats,function(a,b) return a.key<b.key end)
    end
    local tooltipComplete
    item.complex,tooltipComplete=Tooltip(link,item,record and record.tooltip)
    local enchant=type(link)=="string" and tonumber(string.match(link,"item:%d+:(%-?%d+)"))
    if enchant and enchant~=0 then item.complex=true end
    if Call(C_Item and C_Item.GetItemSpell,link)~=nil then item.complex=true end
    local sockets=Call(C_Item and C_Item.GetItemNumSockets,link)
    if Number(sockets,1,100) then item.complex=true end
    if item.equipLoc=="INVTYPE_TRINKET" then item.complex=true end
    item.complete=complete and tooltipComplete and item.itemID>0 and item.name~="" and item.itemLevel>=0
        and item.equipLoc~="" and item.type~="" and item.subtype~=""
        and (not record or (record.infoComplete and record.statsComplete and record.tooltipComplete and not record.truncated)) or false
    return item
end
local function Inventory(slot)
    local location=ItemLocation and Call(ItemLocation.CreateFromEquipmentSlot,ItemLocation,slot)
    local exists=location and Call(C_Item and C_Item.DoesItemExist,location)
    if exists==false then return {itemID=0,name=L("空槽"),itemLevel=-1,equipLoc="",type="",subtype="",stats={},complex=false,complete=true} end
    if exists~=true then return nil end
    local link=Call(GetInventoryItemLink,"player",slot)
    if type(link)~="string" then return nil end
    return Item(link)
end
local function Canonical(value) return value=="INVTYPE_ROBE" and "INVTYPE_CHEST" or value end
function Compare.Evaluate(value)
    local function Result(verdict,reason) return {verdict=verdict,reason=reason} end
    if not value.usable then return Result("not_upgrade","unusable") end
    if value.specMatch==false then return Result("not_upgrade","wrong_spec") end
    local old,new=value.current,value.candidate
    if value.slot==0 or not old then return Result("review","no_target") end
    if not old.complete or not new.complete then return Result("review","incomplete") end
    if value.specMatch==nil or value.spec==0 or not primaryKeys[value.primary] then return Result("review","unknown_spec") end
    if old.complex or new.complex or old.equipLoc=="INVTYPE_TRINKET" or new.equipLoc=="INVTYPE_TRINKET" then return Result("review","complex_item") end
    if old.itemID==0 then return Result("upgrade","empty_slot") end
    if Canonical(old.equipLoc)~=Canonical(new.equipLoc) or old.type~=new.type or old.subtype~=new.subtype then return Result("review","weapon_change") end
    local before,after,keys={},{},{}
    for _, pair in ipairs({{old.stats,before},{new.stats,after}}) do
        for _, stat in ipairs(pair[1]) do
            if not knownStats[stat.key] then return Result("review","incomplete") end
            if not primaryValues[stat.key] or primaryValues[stat.key]==value.primary then pair[2][stat.key]=stat.value; keys[stat.key]=true end
        end
    end
    local up,down,otherLoss=false,false,false
    for key in pairs(keys) do
        local delta=(after[key] or 0)-(before[key] or 0)
        if delta>0.000001 then up=true
        elseif delta < -0.000001 then down=true; if not secondaryStats[key] then otherLoss=true end end
    end
    if up and not down and new.itemLevel>=old.itemLevel then return Result("upgrade","stats_upgrade") end
    if down and not up then return Result("not_upgrade","weaker_stats") end
    if not up and not down then return Result("not_upgrade","equivalent") end
    local primary=primaryKeys[value.primary]
    if down and not otherLoss and new.itemLevel>old.itemLevel and (after[primary] or 0)>(before[primary] or 0)+0.000001 then
        return Result("review","primary_upgrade_tradeoff")
    end
    return Result("review","stat_tradeoff")
end
function Compare.CanOffer(assessment)
    return assessment.verdict=="upgrade" or (assessment.verdict=="review" and assessment.reason=="primary_upgrade_tradeoff")
end
function Compare.Describe(value)
    local old,new={},{}
    for _, pair in ipairs({{value.current and value.current.stats or {},old},{value.candidate.stats,new}}) do
        for _, stat in ipairs(pair[1]) do
            if knownStats[stat.key] and (not primaryValues[stat.key] or primaryValues[stat.key]==value.primary) then pair[2][stat.key]=stat.value end
        end
    end
    local labels={ITEM_MOD_STRENGTH_SHORT=L("力量"),ITEM_MOD_AGILITY_SHORT=L("敏捷"),ITEM_MOD_INTELLECT_SHORT=L("智力"),
        ITEM_MOD_STAMINA_SHORT=L("耐力"),ITEM_MOD_CRIT_RATING_SHORT=L("爆击"),ITEM_MOD_HASTE_RATING_SHORT=L("急速"),
        ITEM_MOD_MASTERY_RATING_SHORT=L("精通"),ITEM_MOD_VERSATILITY=L("全能"),RESISTANCE0_NAME=L("护甲"),
        ITEM_MOD_ARMOR_SHORT=L("护甲"),ITEM_MOD_DAMAGE_PER_SECOND_SHORT=L("武器每秒伤害"),ITEM_MOD_LIFESTEAL_SHORT=L("吸血"),
        ITEM_MOD_AVOIDANCE_SHORT=L("闪避"),ITEM_MOD_SPEED_SHORT=L("速度"),ITEM_MOD_DODGE_RATING_SHORT=L("躲闪"),
        ITEM_MOD_PARRY_RATING_SHORT=L("招架"),ITEM_MOD_BLOCK_RATING_SHORT=L("格挡"),ITEM_MOD_DEFENSE_SKILL_RATING_SHORT=L("防御"),
        ITEM_MOD_HIT_RATING_SHORT=L("命中"),ITEM_MOD_EXPERTISE_RATING_SHORT=L("精准"),ITEM_MOD_ATTACK_POWER_SHORT=L("攻击强度"),
        ITEM_MOD_SPELL_POWER_SHORT=L("法术强度")}
    local keys,known={},{}
    for key in pairs(old) do keys[#keys+1]=key; known[key]=true end
    for key in pairs(new) do if not known[key] then keys[#keys+1]=key end end
    table.sort(keys)
    local gains,losses={},{}
    for _, key in ipairs(keys) do
        local before,after=old[key] or 0,new[key] or 0
        local text=string.format("%s %s→%s",_G[key] or labels[key] or key,string.format("%.6g",before),string.format("%.6g",after))
        if after>before+0.000001 then gains[#gains+1]=text elseif after<before-0.000001 then losses[#losses+1]=text end
    end
    return L("提高：")..(#gains>0 and table.concat(gains,"、") or L("无"))..L("\n下降：")..(#losses>0 and table.concat(losses,"、") or L("无"))
end
function Compare.Capture(owner,record,forcedSlot)
    local currentSpec,primary
    local specialization=C_SpecializationInfo
    local index=Call(specialization and specialization.GetSpecialization or GetSpecialization)
    if index then
        local id,_,_,_,_,stat=Call(specialization and specialization.GetSpecializationInfo or GetSpecializationInfo,index)
        currentSpec,primary=Number(id,1,2147483647),Number(stat,1,4)
    end
    if currentSpec~=owner.spec or not primaryKeys[primary] then primary=0 end
    local candidate=Item(record.link,record)
    local target=forcedSlot
    if not target then
        local choices=slots[record.equipLoc]
        if record.equipLoc=="INVTYPE_WEAPON" and Call(CanDualWield)==true then choices={16,17} end
        if record.equipLoc=="INVTYPE_RANGED" or record.equipLoc=="INVTYPE_RANGEDRIGHT" then
            local shown=Call(C_PaperDollInfo and C_PaperDollInfo.IsRangedSlotShown)
            if shown==true then choices={18} elseif shown~=false then choices=nil end
        end
        local lowest
        for _, slot in ipairs(choices or {}) do
            local item=Inventory(slot)
            if item and (not lowest or item.itemLevel<lowest.itemLevel) then target,lowest=slot,item end
        end
    end
    local class=Text(owner.class) or ""
    local spec=Number(owner.spec,0,2147483647) or 0
    local match
    local specs=Readable(Call(C_Item and C_Item.GetItemSpecInfo,record.link))
    if specs and #specs>0 and currentSpec==spec then
        match=false
        for _, id in ipairs(specs) do
            id=Number(id,1,2147483647)
            if not id then match=nil; break end
            if id==spec then match=true end
        end
    end
    -- The Ret weapon profile is explicit, even when a broad item spec table permits class-wide use.
    if class=="PALADIN" and spec==70 and (record.equipLoc=="INVTYPE_WEAPON" or record.equipLoc=="INVTYPE_WEAPONMAINHAND"
        or record.equipLoc=="INVTYPE_WEAPONOFFHAND" or record.equipLoc=="INVTYPE_SHIELD" or record.equipLoc=="INVTYPE_HOLDABLE") then match=false end
    local equipped=Call(C_Item and C_Item.IsEquippableItem,record.link)
    -- IsUsableItem describes an item's use action; passive armor can return false.
    -- Equippability, level, complete facts and the spec checks below gate dressing.
    local playerLevel=Number(Call(UnitLevel,"player"),0,255)
    local required=Number(record.requiredLevel,0,255)
    if type(equipped)~="boolean" or not playerLevel or not required then candidate.complete=false end
    local worn=target and Inventory(target) or nil
    if not worn then target=0 end
    local value={v=1,id=record.id,session=owner.session,guid=owner.guid,class=class,spec=spec,primary=primary or 0,
        observedAt=math.floor(Number(Call(GetServerTime),0,4102444800) or 0),slot=target or 0,
        usable=equipped~=false and (not playerLevel or not required or playerLevel>=required),
        specMatch=match,current=worn,candidate=candidate}
    return value,Compare.Evaluate(value)
end
