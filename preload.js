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
    start:      (params)              => ipcRenderer.invoke('build:start',      params),
    renderHTML: (params)              => ipcRenderer.invoke('build:renderHTML', params),
    onLog:  (cb) => {
      ipcRenderer.removeAllListeners('build:log');
      ipcRenderer.on('build:log', (_, data) => cb(data));
    },
    onDone: (cb) => {
      ipcRenderer.removeAllListeners('build:done');
      ipcRenderer.on('build:done', (_, data) => cb(data));
    },
  },

  // ── Database API (Phase 1+) ───────────────────────────────────────────────
  db: {
    // Lifecycle
    init:      (workspacePath) => ipcRenderer.invoke('db:init', workspacePath),
    migrate:   (workspacePath) => ipcRenderer.invoke('db:migrate', workspacePath),
    // Church config
    getChurch: (workspacePath) => ipcRenderer.invoke('db:getChurch', workspacePath),
    saveChurch:(workspacePath, data) => ipcRenderer.invoke('db:saveChurch', workspacePath, data),
    // Hymns
    getHymns:  (workspacePath, filter) => ipcRenderer.invoke('db:getHymns', workspacePath, filter),
    addHymn:   (workspacePath, hymn)   => ipcRenderer.invoke('db:addHymn',   workspacePath, hymn),
    importHymns:(workspacePath, hymns, source) => ipcRenderer.invoke('db:importHymns', workspacePath, hymns, source),
    // Templates
    getTemplates: (workspacePath) => ipcRenderer.invoke('db:getTemplates', workspacePath),
    getTemplate:  (workspacePath, slug) => ipcRenderer.invoke('db:getTemplate', workspacePath, slug),
    // Services
    listServices: (workspacePath)    => ipcRenderer.invoke('db:listServices', workspacePath),
    getService:   (workspacePath, date) => ipcRenderer.invoke('db:getService', workspacePath, date),
    createService:(workspacePath, data) => ipcRenderer.invoke('db:createService', workspacePath, data),
    saveService:  (workspacePath, data) => ipcRenderer.invoke('db:saveService', workspacePath, data),
    deleteService:(workspacePath, date) => ipcRenderer.invoke('db:deleteService', workspacePath, date),
    // Order of worship
    getOrderItems:  (workspacePath, date)      => ipcRenderer.invoke('db:getOrderItems',  workspacePath, date),
    saveOrderItems: (workspacePath, date, items) => ipcRenderer.invoke('db:saveOrderItems', workspacePath, date, items),
    // Announcements
    getAnnouncements:  (workspacePath, date)        => ipcRenderer.invoke('db:getAnnouncements',  workspacePath, date),
    saveAnnouncements: (workspacePath, date, items) => ipcRenderer.invoke('db:saveAnnouncements', workspacePath, date, items),
    // Liturgy constants
    getLiturgyConstants: (workspacePath) => ipcRenderer.invoke('db:getLiturgyConstants', workspacePath),
    saveLiturgyConstant: (workspacePath, key, value, hymnId) => ipcRenderer.invoke('db:saveLiturgyConstant', workspacePath, key, value, hymnId),
    // Second page blocks
    getSecondPageBlocks: (workspacePath, date)       => ipcRenderer.invoke('db:getSecondPageBlocks', workspacePath, date),
    saveSecondPageBlock: (workspacePath, date, block) => ipcRenderer.invoke('db:saveSecondPageBlock', workspacePath, date, block),
    // Assets
    getAssets:  (workspacePath) => ipcRenderer.invoke('db:getAssets', workspacePath),
    saveAsset:  (workspacePath, asset) => ipcRenderer.invoke('db:saveAsset', workspacePath, asset),
    deleteAsset:(workspacePath, id)    => ipcRenderer.invoke('db:deleteAsset', workspacePath, id),
  },
});
