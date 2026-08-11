import type { BrowserTabInfo } from '../shared/types'

//+_+// chrome.tabs 를 직접 부르지 않는다. 어댑터는 serviceWorker 가 주입한다
export interface TabsBackend {
  get(tabId: number): Promise<BrowserTabInfo | null>
  onRemoved(listener: (tabId: number) => void): void
  onUpdated(listener: (tabId: number, changedUrl: string) => void): void
}

//+_+// 캡처 엔진이 필요로 하는 것만 둔다. Focus 는 Phase 4, Bind 와 Reopen 은 Phase 5 다
//+_+// autoDiscardable / Keep Alive / Mute 는 넣지 않는다. 요청되지 않았다
export class TabManager {
  private readonly backend: TabsBackend
  private readonly removedListeners: ((tabId: number) => void)[] = []
  private readonly navigatedListeners: ((tabId: number, url: string) => void)[] = []

  constructor(backend: TabsBackend) {
    this.backend = backend
    this.backend.onRemoved((tabId) => {
      for (const listener of this.removedListeners) {
        listener(tabId)
      }
    })
    this.backend.onUpdated((tabId, changedUrl) => {
      for (const listener of this.navigatedListeners) {
        listener(tabId, changedUrl)
      }
    })
  }

  async info(tabId: number): Promise<BrowserTabInfo | null> {
    return this.backend.get(tabId)
  }

  async exists(tabId: number): Promise<boolean> {
    return (await this.backend.get(tabId)) !== null
  }

  onTabRemoved(listener: (tabId: number) => void): void {
    this.removedListeners.push(listener)
  }

  //+_+// changeInfo.url 이 실린 갱신만 navigation 으로 본다. status 변화는 흘려보낸다
  onTabNavigated(listener: (tabId: number, url: string) => void): void {
    this.navigatedListeners.push(listener)
  }
}
