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
; 所以：只在安装器里用的函数必须用 !ifndef BUILD_UNINSTALLER 包起来，
;       只在卸载器里用的函数必须用 !ifdef BUILD_UNINSTALLER 包起来。
;
; 重要 2：不要写 HKCU\Software\Microsoft\Edge\Extensions\<id>（注册表外置扩展）。
; 实测新版 Edge 会直接屏蔽注册表外置的自签 CRX（chrome-extension:// 打不开，
; 报 ERR_BLOCKED_BY_CLIENT，Secure Preferences 里 disable_reasons=256）。
; 这里改成「把解压好的扩展目录放进数据目录的 browser-ext」，
; 用户在扩展页点一次「加载解压缩的扩展」即可，全程不碰浏览器注册表。
;
; 重要 3（1.4.1）：数据目录。
; 1.4.0 及以前 userData 固定落在 C:\Users\<用户>\AppData\Roaming\cutcut，
; 程序在 D 盘、480 MB 模型却占 C 盘。1.4.1 起由安装器把用户选的数据目录写进
; <安装目录>\data-dir.txt，主进程在 app ready 之前 app.setPath('userData', ...)。
; 默认值是「安装盘:\CutCut-data」，所以数据跟着程序走，C 盘不留东西。
; ============================================================

!include "MUI2.nsh"
!include "LogicLib.nsh"

; 数据目录：安装器算出来、安装完成时写进 data-dir.txt。
; 卸载器也要读（清理扩展目录），所以声明在 !ifndef 外面 —— 但两遍都真的用到了。
Var CC_DataDir

; ---------------- 仅安装器：算默认数据目录 + 可选功能页 ----------------

!ifndef BUILD_UNINSTALLER

  !include "nsDialogs.nsh"

  Var CC_OptMenu
  Var CC_OptExt
  Var CC_ChkMenu
  Var CC_ChkExt
  Var CC_DataLabel
  Var CC_BtnData

  /**
   * 依据 $INSTDIR 算出默认数据目录：<安装盘>:\CutCut-data
   * 例：$INSTDIR = D:\CutCut\  →  $CC_DataDir = D:\CutCut-data
   * 不是盘符路径（UNC）就退回 %APPDATA%\cutcut。
   */
  Function ccComputeDataDir
    StrCpy $0 "$INSTDIR" 2
    StrCpy $1 "$INSTDIR" 1 1
    ${If} $1 == ":"
      StrCpy $CC_DataDir "$0\CutCut-data"
    ${Else}
      StrCpy $CC_DataDir "$APPDATA\cutcut"
    ${EndIf}
  FunctionEnd

  /** 「更改…」按钮：弹出选文件夹对话框，把结果写回 $CC_DataDir 并刷新标签 */
  Function ccPickDataDir
    ${NSD_GetText} $CC_DataLabel $0
    nsDialogs::SelectFolderDialog "选择 CutCut 的数据目录（模型和设置会存在这里）" "$0"
    Pop $1
    ${If} $1 != error
      StrCpy $CC_DataDir "$1"
      ${NSD_SetText} $CC_DataLabel "$CC_DataDir"
    ${EndIf}
  FunctionEnd

  Function ccOptionsPageCreate
    ; 说明文字放页头副标题，省出正文纵向空间（1018 模板的正文只有 ~96u 高）
    !insertmacro MUI_HEADER_TEXT "选择功能" "只写当前用户，不需要管理员权限；下面两项不勾也能正常使用。"

    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ; 数据目录默认跟着安装盘；每次重建页面都重置，避免残留旧值
    Call ccComputeDataDir

    ${NSD_CreateCheckbox} 0 4u 100% 12u "图片文件右键菜单"
    Pop $CC_ChkMenu
    ${NSD_SetState} $CC_ChkMenu ${BST_CHECKED}

    ${NSD_CreateLabel} 10u 15u 90% 10u "资源管理器里右键任意图片 →「用 CutCut 抠出主体」。"
    Pop $0

    ${NSD_CreateCheckbox} 0 30u 100% 12u "网页图片右键菜单"
    Pop $CC_ChkExt
    ${NSD_SetState} $CC_ChkExt ${BST_CHECKED}

    ${NSD_CreateLabel} 10u 41u 90% 10u "扩展会放进数据目录的 browser-ext，装完后在应用里加载一次即可。"
    Pop $0

    ${NSD_CreateLabel} 10u 52u 90% 10u "不想装也没关系：复制图片后按 Ctrl+Alt+X 一样能抠。"
    Pop $0

    ${NSD_CreateHLine} 0 66u 100% 1u ""
    Pop $0

    ${NSD_CreateLabel} 0 72u 100% 10u "数据目录（模型、设置、缓存都放这里，不占系统盘）"
    Pop $0

    ${NSD_CreateLabel} 0 83u 69% 11u "$CC_DataDir"
    Pop $CC_DataLabel

    ${NSD_CreateButton} 71% 81u 29% 14u "更改…"
    Pop $CC_BtnData
    ${NSD_OnClick} $CC_BtnData ccPickDataDir

    nsDialogs::Show
  FunctionEnd

  Function ccOptionsPageLeave
    ${NSD_GetState} $CC_ChkMenu $CC_OptMenu
    ${NSD_GetState} $CC_ChkExt $CC_OptExt
    ${NSD_GetText} $CC_DataLabel $CC_DataDir
  FunctionEnd

  !macro customPageAfterChangeDir
    Page custom ccOptionsPageCreate ccOptionsPageLeave
  !macroend

!endif

; ---------------- 安装：写注册表 / 写数据目录 / 准备扩展目录 ----------------

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

  ; 数据目录：可选页没跑（静默安装）就按安装盘算默认值
  ${If} $CC_DataDir == ""
    Call ccComputeDataDir
  ${EndIf}
  CreateDirectory "$CC_DataDir"
  ClearErrors
  FileOpen $0 "$INSTDIR\data-dir.txt" w
  ${IfNot} ${Errors}
    FileWrite $0 "$CC_DataDir$\r$\n"
    FileClose $0
  ${EndIf}

  ${If} $CC_OptExt == ${BST_CHECKED}
    ; 扩展源目录随安装包分发在 resources\browser-ext，这里直接编译进安装器再解压，
    ; 因为 CopyFiles 不递归，会漏掉 icons\ 子目录（浏览器随后会报扩展损坏）。
    RMDir /r "$CC_DataDir\browser-ext"
    CreateDirectory "$CC_DataDir\browser-ext"
    SetOutPath "$CC_DataDir\browser-ext"
    File /r "${PROJECT_DIR}\browser-ext\*.*"
    SetOutPath "$INSTDIR"
  ${EndIf}
!macroend

; ---------------- 卸载：清注册表 / 清扩展目录 ----------------

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\image\shell\CutCut"
  ; 只删我们自己复制的那份；浏览器里已加载的条目由用户在扩展页手动移除。
  ; 数据目录本身（含 480 MB 模型）保留 —— 重装后能直接用，删了得重新下载。
  Call un.ccReadDataDir
  ${If} $CC_DataDir != ""
    RMDir /r "$CC_DataDir\browser-ext"
  ${EndIf}
!macroend

; 卸载器是独立进程，$CC_DataDir 不跨进程保留 —— 从安装目录的 data-dir.txt 读回来。
!ifdef BUILD_UNINSTALLER
  Function un.ccReadDataDir
    StrCpy $CC_DataDir ""
    ClearErrors
    FileOpen $0 "$INSTDIR\data-dir.txt" r
    ${If} ${Errors}
      Return
    ${EndIf}
    FileRead $0 $CC_DataDir
    FileClose $0
    ; FileRead 会把行尾的 $\r$\n 一起读进来，手动剥掉
    StrCpy $1 "$CC_DataDir" 1 -1
    ${If} $1 == "$\r"
      StrCpy $CC_DataDir "$CC_DataDir" -1
    ${EndIf}
    StrCpy $1 "$CC_DataDir" 1 -1
    ${If} $1 == "$\n"
      StrCpy $CC_DataDir "$CC_DataDir" -1
    ${EndIf}
  FunctionEnd
!endif
