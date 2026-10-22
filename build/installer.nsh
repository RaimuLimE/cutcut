; ============================================================
; CutCut 安装器自定义段
; 由 electron-builder 通过 nsis.include 自动 include（默认 build/installer.nsh）
;
; 依赖的挂钩点（electron-builder 26.x 模板）：
;   customPageAfterChangeDir  assistedInstaller.nsh:42  —— 选完安装目录之后、开始安装之前
;   customInstall             installSection.nsh:81     —— 文件解压、写卸载信息之后
;   customUnInstall           uninstaller.nsh:156      —— 卸载时（删文件之前）
;
; 重要 1：本文件会被编译两次 —— 第一次是 BUILD_UNINSTALLER（只生成卸载器），
; 那一次 assistedInstaller.nsh 走的是 !else 分支，不会引用自定义页，
; 于是 ccOptionsPageCreate 变成「未被引用的函数」，而 electron-builder 把
; NSIS 的 warning 当 error（warning treated as error）→ 打包直接失败。
; 所以自定义页相关的定义必须用 !ifndef BUILD_UNINSTALLER 包起来。
;
; 重要 2：不要写 HKCU\Software\Microsoft\Edge\Extensions\<id>（注册表外置扩展）。
; 实测新版 Edge 会直接屏蔽注册表外置的自签 CRX（chrome-extension:// 打不开，
; 报 ERR_BLOCKED_BY_CLIENT，Secure Preferences 里 disable_reasons=256）。
; 这里改成「把解压好的扩展目录放到 %APPDATA%\cutcut\browser-ext」，
; 用户在扩展页点一次「加载解压缩的扩展」即可，全程不碰浏览器注册表。
; ============================================================

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

; ---------------- 可选功能页（仅安装器，不参与卸载器编译） ----------------
;
; 变量也必须在 !ifndef BUILD_UNINSTALLER 里声明：卸载器那一遍不引用它们，
; 声明在外面会报 warning 6001（Variable ... not referenced or never set），
; 而 electron-builder 把 warning 当 error。

!ifndef BUILD_UNINSTALLER

  !include "nsDialogs.nsh"

  Var CC_OptMenu
  Var CC_OptExt
  Var CC_ChkMenu
  Var CC_ChkExt

  Function ccOptionsPageCreate
    !insertmacro MUI_HEADER_TEXT "选择功能" "选择要一起安装的快捷功能，装好后也能在应用里随时改。"

    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 18u "只写当前用户，不需要管理员权限；都不勾也能正常使用 CutCut。"
    Pop $0

    ${NSD_CreateCheckbox} 0 26u 100% 12u "图片文件右键菜单"
    Pop $CC_ChkMenu
    ${NSD_SetState} $CC_ChkMenu ${BST_CHECKED}

    ${NSD_CreateLabel} 10u 38u 92% 12u "资源管理器里右键任意图片 →「用 CutCut 抠出主体」。"
    Pop $0

    ${NSD_CreateCheckbox} 0 56u 100% 12u "网页图片右键菜单"
    Pop $CC_ChkExt
    ${NSD_SetState} $CC_ChkExt ${BST_CHECKED}

    ${NSD_CreateLabel} 10u 68u 92% 46u "会把浏览器扩展准备好（%APPDATA%\cutcut\browser-ext）。\
装完后在应用的「系统集成」点「打开扩展页」，开启开发者模式，再点「加载解压缩的扩展」选这个目录。\
不想装也没关系：复制图片后按 Ctrl+Alt+X 一样能抠。"
    Pop $0

    nsDialogs::Show
  FunctionEnd

  Function ccOptionsPageLeave
    ${NSD_GetState} $CC_ChkMenu $CC_OptMenu
    ${NSD_GetState} $CC_ChkExt $CC_OptExt
  FunctionEnd

  !macro customPageAfterChangeDir
    Page custom ccOptionsPageCreate ccOptionsPageLeave
  !macroend

!endif

; ---------------- 安装：写注册表 / 准备扩展目录 ----------------

!macro customInstall
  ; 静默安装（/S）不会走可选页，此时变量是空串 —— 默认按「都装」处理
  ${If} $CC_OptMenu == ""
    StrCpy $CC_OptMenu ${BST_CHECKED}
  ${EndIf}
  ${If} $CC_OptExt == ""
    StrCpy $CC_OptExt ${BST_CHECKED}
  ${EndIf}

  ${If} $CC_OptMenu == ${BST_CHECKED}
    WriteRegStr HKCU "Software\Classes\SystemFileAssociations\image\shell\CutCut" "" "用 CutCut 抠出主体"
    WriteRegStr HKCU "Software\Classes\SystemFileAssociations\image\shell\CutCut" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
    WriteRegStr HKCU "Software\Classes\SystemFileAssociations\image\shell\CutCut" "MultiSelectModel" "Player"
    WriteRegStr HKCU "Software\Classes\SystemFileAssociations\image\shell\CutCut\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --cutout "%1"'
  ${EndIf}

  ${If} $CC_OptExt == ${BST_CHECKED}
    ; 扩展源目录随安装包分发在 resources\browser-ext，这里直接编译进安装器再解压，
    ; 因为 CopyFiles 不递归，会漏掉 icons\ 子目录（浏览器随后会报扩展损坏）。
    RMDir /r "$APPDATA\cutcut\browser-ext"
    CreateDirectory "$APPDATA\cutcut\browser-ext"
    SetOutPath "$APPDATA\cutcut\browser-ext"
    File /r "${PROJECT_DIR}\browser-ext\*.*"
    SetOutPath "$INSTDIR"
  ${EndIf}
!macroend

; ---------------- 卸载：清注册表 / 清扩展目录 ----------------

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\image\shell\CutCut"
  ; 只删我们自己复制的那份；浏览器里已加载的条目由用户在扩展页手动移除
  RMDir /r "$APPDATA\cutcut\browser-ext"
!macroend
