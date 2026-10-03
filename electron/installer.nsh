; Braid 安装器钩子（electron-builder 的 `nsis.include` 指过来）
;
; 【这段在干什么】安装完成时把示例主题从 `resources\themes\` 拷到 **exe 同级的 `themes\`**。
;
; 【为什么要在安装时做，而不是首次运行时】那个目录是"可拔插主题"的入口：用户装完就该看见它，
; 摆在那儿才像这个软件的一部分。等第一次运行才由程序自己长出来，感觉更像运行时的临时产物
; （这一点是用户明确提的："分离度"更好）。
;
; 【源为什么在 resources 而不是 asar 内】asar 是单个文件，安装器读不进去；
; 所以 `electron-builder.yml` 里用 `extraResources` 把 `themes/` 放到 asar **之外**。
; asar 里那一份保留着，给开发态与"用户把目录删了"时的兜底用（见 `main.cjs`）。
;
; 【为什么先探一下目录】`themes/` 是**用户的目录**：
;  - 升级安装时不能覆盖他改过的主题，也不能把他删掉的示例塞回来（那会变成"删不掉的示例"）；
;  - 所以只在"整个目录空着"时才铺一遍 —— 与主进程 `ensureThemeDirectory()` 那条规则完全一致。
; 主进程那份仍然保留：用户把整个目录删掉后，下次启动还会补上（不该因为安装了就再也没有兜底）。

; 【改这个文件的两条注意】1) 它必须带 **UTF-8 BOM** —— 下面的中文注释在没有 BOM 时会让
; makensis 直接报 "Bad text encoding"（实测过）；2) `customInstall` 这个名字是 electron-builder
; 约定的钩子名，改了就不会被调用。

!include LogicLib.nsh

!macro customInstall
  ${IfNot} ${FileExists} "$INSTDIR\themes\*.*"
    CreateDirectory "$INSTDIR\themes"
    CopyFiles /SILENT "$INSTDIR\resources\themes\*.*" "$INSTDIR\themes"
  ${EndIf}
!macroend
