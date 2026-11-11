' 桌宠控制面板启动器：确保面板服务在跑，然后打开浏览器
' 用法: wscript.exe pet-panel-launch.vbs [serveronly]
'   serveronly —— 只确保服务在跑，不打开浏览器（用于开机自启）
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
srv = base & "\pet-panel-server.js"
node = "C:\Program Files\nodejs\node.exe"
serveronly = False
If WScript.Arguments.Count > 0 Then
  If LCase(WScript.Arguments(0)) = "serveronly" Then serveronly = True
End If

' 检查 3090 是否监听
Set exec = sh.Exec("cmd /c netstat -ano | findstr /r /c:"":3090 .*LISTENING""")
out = ""
Do While Not exec.StdOut.AtEndOfStream
  out = out & exec.StdOut.ReadAll
Loop
If InStr(out, ":3090") = 0 Then
  ' 服务没跑，启动它（隐藏窗口）
  If fso.FileExists(node) And fso.FileExists(srv) Then
    sh.Run """" & node & """ """ & srv & """", 0, False
    If Not serveronly Then WScript.Sleep 3000
  End If
End If

' 打开控制面板（serveronly 模式不打开）
If Not serveronly Then sh.Run "http://127.0.0.1:3090/", 1, False
