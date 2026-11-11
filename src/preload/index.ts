/** 仅向本地界面开放明确定义的旅行功能，不暴露 Electron 原始 IPC。 */
import { contextBridge, ipcRenderer } from 'electron'
import type {
  AgentEvent,
  AppSettings,
  BrowserBounds,
  BrowserNavigationAction,
  BrowserState,
  BuiltinConnectorTestId,
  McpServerInput,
  RouteMode,
  TripBrief,
  TripBriefField,
  UserProvidedContentInput,
  TripwiseApi
} from '../shared/types.js'

/** 建立可移除的事件订阅，避免页面切换后残留监听器。 */
function subscribe<T>(channel: string, callback: (value: T) => void): () => void {
  /** 去掉 Electron 事件对象，只向 renderer 传递业务数据。 */
  const listener = (_event: Electron.IpcRendererEvent, value: T): void => callback(value)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: TripwiseApi = {
  getSnapshot: () => ipcRenderer.invoke('app:get-snapshot'),
  createTrip: (input?: Partial<TripBrief>) => ipcRenderer.invoke('trip:create', input),
  selectTrip: (tripId: string) => ipcRenderer.invoke('trip:select', tripId),
  createConversation: (tripId: string) => ipcRenderer.invoke('conversation:create', tripId),
  selectConversation: (tripId: string, conversationId: string) => ipcRenderer.invoke('conversation:select', tripId, conversationId),
  deleteConversation: (tripId: string, conversationId: string) => ipcRenderer.invoke('conversation:delete', tripId, conversationId),
  updateTripBrief: (tripId: string, brief: TripBrief, unknownFields: TripBriefField[]) => ipcRenderer.invoke('trip:update-brief', tripId, brief, unknownFields),
  applyTripBriefProposal: (tripId: string, conversationId: string, messageId: string) =>
    ipcRenderer.invoke('trip:apply-brief-proposal', tripId, conversationId, messageId),
  retrySource: (tripId: string, sourceId: string) => ipcRenderer.invoke('source:retry', tripId, sourceId),
  skipSourceRetry: (tripId: string, sourceId: string) => ipcRenderer.invoke('source:skip-retry', tripId, sourceId),
  deleteSource: (tripId: string, sourceId: string) => ipcRenderer.invoke('source:delete', tripId, sourceId),
  deleteTrip: (tripId: string) => ipcRenderer.invoke('trip:delete', tripId),
  exportTripBackup: (tripId: string) => ipcRenderer.invoke('trip:export-backup', tripId),
  importTripBackup: () => ipcRenderer.invoke('trip:import-backup'),
  sendMessage: (requestId: string, tripId: string, conversationId: string, content: string, resumeMessageId?: string) =>
    ipcRenderer.invoke('agent:send', requestId, tripId, conversationId, content, resumeMessageId),
  cancelAgent: (requestId: string) => ipcRenderer.invoke('agent:cancel', requestId),
  saveRevision: (tripId: string, conversationId: string, messageId: string, itineraryId?: string) =>
    ipcRenderer.invoke('revision:save', tripId, conversationId, messageId, itineraryId),
  setItineraryOptionRejected: (tripId: string, conversationId: string, messageId: string, itineraryId: string, rejected: boolean) =>
    ipcRenderer.invoke('revision:set-option-rejected', tripId, conversationId, messageId, itineraryId, rejected),
  saveEditedRevision: (tripId: string, baseRevisionId: string, itinerary) =>
    ipcRenderer.invoke('revision:save-edited', tripId, baseRevisionId, itinerary),
  searchMapPlaces: (tripId: string, city: string, query: string) =>
    ipcRenderer.invoke('places:map-search', tripId, city, query),
  estimateRoute: (tripId: string, city: string, origin: string, destination: string, mode: RouteMode, date?: string, time?: string) =>
    ipcRenderer.invoke('routes:estimate', tripId, city, origin, destination, mode, date, time),
  savePreparationItems: (tripId: string, conversationId: string, messageId: string) =>
    ipcRenderer.invoke('preparation:save', tripId, conversationId, messageId),
  setPreparationItemChecked: (tripId: string, itemId: string, checked: boolean) =>
    ipcRenderer.invoke('preparation:set-checked', tripId, itemId, checked),
  updatePreparationItem: (tripId: string, itemId: string, update) =>
    ipcRenderer.invoke('preparation:update', tripId, itemId, update),
  deletePreparationItem: (tripId: string, itemId: string) =>
    ipcRenderer.invoke('preparation:delete', tripId, itemId),
  activateRevision: (tripId: string, revisionId: string) => ipcRenderer.invoke('revision:activate', tripId, revisionId),
  updateSettings: (settings: AppSettings) => ipcRenderer.invoke('settings:update', settings),
  chooseOpenCliCommand: () => ipcRenderer.invoke('settings:choose-opencli-command'),
  saveMcpServer: (input: McpServerInput) => ipcRenderer.invoke('mcp:save-server', input),
  testMcpServer: (input: McpServerInput) => ipcRenderer.invoke('mcp:test-server', input),
  removeMcpServer: (serverId: string) => ipcRenderer.invoke('mcp:remove-server', serverId),
  saveSecrets: (input) => ipcRenderer.invoke('secrets:update', input),
  openLocalCredentialFile: () => ipcRenderer.invoke('secrets:open-local-file'),
  openSystemLogDirectory: () => ipcRenderer.invoke('system:open-log-directory'),
  getAmapMapConfig: () => ipcRenderer.invoke('map:get-amap-config'),
  getAmapMapFrameUrl: () => ipcRenderer.invoke('map:get-amap-frame-url'),
  testModel: () => ipcRenderer.invoke('model:test'),
  testBuiltinConnector: (provider: BuiltinConnectorTestId) => ipcRenderer.invoke('connector:test', provider),
  navigateResearch: (url: string) => ipcRenderer.invoke('research:navigate', url),
  navigateResearchHistory: (action: BrowserNavigationAction) => ipcRenderer.invoke('research:navigate-history', action),
  setResearchBounds: (bounds: BrowserBounds) => ipcRenderer.invoke('research:set-bounds', bounds),
  getResearchPageText: () => ipcRenderer.invoke('research:read-visible-page'),
  importVisiblePage: (tripId: string) => ipcRenderer.invoke('research:import-visible-page', tripId),
  importPastedContent: (tripId: string, input: UserProvidedContentInput) => ipcRenderer.invoke('research:import-pasted-content', tripId, input),
  exportTrip: (tripId: string) => ipcRenderer.invoke('trip:export', tripId),
  onAgentEvent: (callback: (event: AgentEvent) => void) => subscribe('agent:event', callback),
  onBrowserState: (callback: (state: BrowserState) => void) => subscribe('research:state', callback)
}

contextBridge.exposeInMainWorld('tripwise', api)
