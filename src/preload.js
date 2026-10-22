'use strict'
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  info: () => ipcRenderer.invoke('app:info'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),
  pickImages: () => ipcRenderer.invoke('dialog:pickImages'),
  pickOutput: () => ipcRenderer.invoke('dialog:pickOutput'),
  cutout: (payload) => ipcRenderer.invoke('image:cutout', payload),
  saveAs: (payload) => ipcRenderer.invoke('image:saveAs', payload),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),

  // ---- 模型管理（1.3 起模型外置） ----
  modelList: () => ipcRenderer.invoke('model:list'),
  modelDownload: (id) => ipcRenderer.invoke('model:download', id),
  modelCancel: (id) => ipcRenderer.invoke('model:cancel', id),
  modelImport: (id) => ipcRenderer.invoke('model:import', id),
  modelRemove: (id) => ipcRenderer.invoke('model:remove', id),
  modelOpenDir: () => ipcRenderer.invoke('model:openDir'),
  onModelProgress: (cb) => {
    const h = (_e, p) => cb(p)
    ipcRenderer.on('model:progress', h)
    return () => ipcRenderer.removeListener('model:progress', h)
  },

  // ---- 系统集成（1.4：右键菜单 / 浏览器扩展 / 剪贴板） ----
  integrationState: () => ipcRenderer.invoke('integration:state'),
  setExplorerMenu: (on) => ipcRenderer.invoke('integration:menu', on),
  setBrowserExt: (on) => ipcRenderer.invoke('integration:ext', on),
  openExtPage: (browserId) => ipcRenderer.invoke('integration:openExtPage', browserId),
  showExtDir: () => ipcRenderer.invoke('integration:showExtDir'),
  cutoutClipboard: () => ipcRenderer.invoke('app:clipboard'),

  // 主进程把图片塞进来（右键打开 / 浏览器扩展 / 剪贴板热键）
  onOpenFiles: (cb) => {
    const h = (_e, list) => cb(list)
    ipcRenderer.on('app:openFiles', h)
    return () => ipcRenderer.removeListener('app:openFiles', h)
  },
  // 界面挂好监听后通知主进程：可以放排队中的图片了
  ready: () => ipcRenderer.send('app:ready'),
  onToast: (cb) => {
    const h = (_e, msg) => cb(msg)
    ipcRenderer.on('app:toast', h)
    return () => ipcRenderer.removeListener('app:toast', h)
  },

  // 拖拽的文件路径：Electron 32+ 必须用 webUtils 从 File 取真实路径
  pathForFile: (file) => {
    try {
      const { webUtils } = require('electron')
      return webUtils.getPathForFile(file)
    } catch { return file.path || '' }
  },
})
