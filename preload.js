const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  workspace: {
    open:           () => ipcRenderer.invoke('workspace:open'),
    get:            () => ipcRenderer.invoke('workspace:get'),
    listDates:      (workspacePath) => ipcRenderer.invoke('workspace:listDates', workspacePath),
    listServices:   (workspacePath) => ipcRenderer.invoke('workspace:listServices', workspacePath),
    createService:  (workspacePath, name, date, communion) => ipcRenderer.invoke('workspace:createService', workspacePath, name, date, communion),
    setServiceMeta: (workspacePath, folder, updates) => ipcRenderer.invoke('workspace:setServiceMeta', workspacePath, folder, updates),
  },
  communion: {
    getTemplate:  (workspacePath)          => ipcRenderer.invoke('communion:getTemplate', workspacePath),
    saveTemplate: (workspacePath, content) => ipcRenderer.invoke('communion:saveTemplate', workspacePath, content),
  },
  hymnal: {
    load: (workspacePath) => ipcRenderer.invoke('hymnal:load', workspacePath),
  },
  schedule: {
    read:  (workspacePath, date)      => ipcRenderer.invoke('csv:read',  workspacePath, date),
    write: (workspacePath, date, row) => ipcRenderer.invoke('csv:write', workspacePath, date, row),
  },
  announcements: {
    read:  (workspacePath, folder)        => ipcRenderer.invoke('announcements:read',  workspacePath, folder),
    write: (workspacePath, folder, items) => ipcRenderer.invoke('announcements:write', workspacePath, folder, items),
  },
  textfile: {
    read:  (workspacePath, filename)          => ipcRenderer.invoke('textfile:read',  workspacePath, filename),
    write: (workspacePath, filename, content) => ipcRenderer.invoke('textfile:write', workspacePath, filename, content),
  },
  elements: {
    list: (workspacePath) => ipcRenderer.invoke('elements:list', workspacePath),
  },
  order: {
    generate: (workspacePath, date, communion) => ipcRenderer.invoke('order:generate', workspacePath, date, communion),
    load:     (workspacePath, folder)          => ipcRenderer.invoke('order:load',     workspacePath, folder),
    save:     (workspacePath, folder, tsv)     => ipcRenderer.invoke('order:save',     workspacePath, folder, tsv),
  },
  config: {
    read:         (workspacePath)                => ipcRenderer.invoke('config:read',         workspacePath),
    write:        (workspacePath, config)        => ipcRenderer.invoke('config:write',        workspacePath, config),
    readService:  (workspacePath, folder)        => ipcRenderer.invoke('config:readService',  workspacePath, folder),
    writeService: (workspacePath, folder, config) => ipcRenderer.invoke('config:writeService', workspacePath, folder, config),
  },
  pdf: {
    load: (pdfPath) => ipcRenderer.invoke('pdf:load', pdfPath),
  },
  build: {
    start: (params) => ipcRenderer.send('build:start', params),
    onLog:  (cb) => {
      ipcRenderer.removeAllListeners('build:log');
      ipcRenderer.on('build:log', (_, data) => cb(data));
    },
    onDone: (cb) => {
      ipcRenderer.removeAllListeners('build:done');
      ipcRenderer.on('build:done', (_, data) => cb(data));
    },
  },
});
