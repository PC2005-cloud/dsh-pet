; dsh-pet 安装包的自定义 NSIS 片段（electron-builder 的 nsis.include）。
;
; 开机自启（ticket 09）的写入有两条路径，格式必须逐字一致：
;   1. 安装完成时（本文件的 customInstall）：spec 要求「默认开启，安装完成后即生效」。
;      若用户安装时取消「立即运行」，也要在重启后自启 —— 不能等到首次手动启动才写。
;   2. 应用首次启动时（desktop/main.mjs → src/host/autostart.ts）作为兜底：
;      安装器没写成功（如注册表被策略拦截）或非安装版形态时补写。
; 写入 HKCU\Software\Microsoft\Windows\CurrentVersion\Run：
;   值名 `electron.app.DSH Pet`（Electron 43 的默认命名，与 setLoginItemSettings 一致）；
;   值数据 `"<安装目录>\DSH Pet.exe" --autostart`（与 Electron 写入格式一致）。
; electron-builder 不知道这个值，卸载时必须自己清理，否则卸载后应用仍会随登录启动。
;
; 安装/卸载的两个约束：
;   1. 安装侧按当前产品名写入 `electron.app.DSH Pet`（Electron 43 实测的默认命名）；
;      卸载侧不能写死值名（Electron 生成的名称随应用名/版本可能变化），而是按
;      「值数据 = 当前安装目录下的 exe + --autostart」匹配，既不漏删也不误伤其它软件。
;   2. 任务管理器的「禁用」状态另存在 StartupApproved\Run 的同名值里，一并清理。
;
; 升级安装会先运行旧版卸载器（isUpdated=true）：此时绝不能删除启动项，否则升级后
; 开机自启静默丢失（初始化标记还在，应用不会再次自动开启）。
;
; 已知边界：安装器只认默认数据目录 `$PROFILE\.dsh\dsh-pet`。用户自定义 DSH_HOME 时，
; 应用首次启动会按真实 DSH_HOME 判定标记并补写（Run 值已存在，不会重复），
; 但安装器侧的「关掉后重装不写回」在自定义 DSH_HOME 下不生效（读不到用户的标记）。

!include LogicLib.nsh

; 安装完成：默认开启开机自启（只对从未初始化过的用户生效）。
;
; 标记文件与 src/host/autostart.ts 的 `autostart-initialized` 是同一个：
;   - 不存在 → 用户从未初始化过：写 Run 项 + 写标记（应用首次启动不再重复处理）；
;   - 已存在 → 用户之前主动关掉过自启（或升级安装）：绝不写回，保持用户选择。
; 注册表写入失败时不写标记，让应用首次启动还能重试；安装本身不因自启失败而中断。
!macro customInstall
  Push $0
  ${IfNot} ${FileExists} "$PROFILE\.dsh\dsh-pet\autostart-initialized"
    ClearErrors
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.DSH Pet" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --autostart'
    ${IfNot} ${Errors}
      CreateDirectory "$PROFILE\.dsh\dsh-pet"
      FileOpen $0 "$PROFILE\.dsh\dsh-pet\autostart-initialized" w
      ${If} $0 != ""
        FileWrite $0 "installed by DSH Pet installer$\r$\n"
        FileClose $0
      ${EndIf}
    ${EndIf}
  ${EndIf}
  Pop $0
!macroend

!macro customUnInstall
  ${IfNot} ${isUpdated}
    Push $0
    Push $1
    Push $2

    StrCpy $0 0
    ${Do}
      EnumRegValue $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" $0
      ${If} $1 == ""
        ${ExitDo}
      ${EndIf}
      ReadRegStr $2 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "$1"
      ${If} $2 == '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --autostart'
        DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "$1"
        DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "$1"
        ; 删除后后面的值前移：本次不递增索引，避免漏掉紧随其后的同名项
      ${Else}
        IntOp $0 $0 + 1
      ${EndIf}
    ${Loop}

    Pop $2
    Pop $1
    Pop $0
  ${EndIf}
!macroend
