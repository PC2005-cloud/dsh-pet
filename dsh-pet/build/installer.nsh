; dsh-pet 安装包的自定义 NSIS 片段（electron-builder 的 nsis.include）。
;
; 开机自启（ticket 09）由应用首次启动时通过 Electron 的登录项 API 写入
; HKCU\Software\Microsoft\Windows\CurrentVersion\Run；electron-builder 不知道这个值，
; 卸载时必须自己清理，否则卸载后应用仍会随登录启动。
;
; 两个约束：
;   1. 值名由 Electron 生成（electron.app.<app name>，随应用名/版本可能变化），不能写死；
;      按「值数据 = 当前安装目录下的 exe + --autostart」匹配，既不漏删也不误伤其它软件。
;   2. 任务管理器的「禁用」状态另存在 StartupApproved\Run 的同名值里，一并清理。
;
; 升级安装会先运行旧版卸载器（isUpdated=true）：此时绝不能删除启动项，否则升级后
; 开机自启静默丢失（初始化标记还在，应用不会再次自动开启）。

!include LogicLib.nsh

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
