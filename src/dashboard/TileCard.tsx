import { useEffect, useRef, useState } from 'react'
import { GRID_COLUMNS } from '../shared/grid'
import type { DragMode } from './layoutDrag'
import {
  MIN_CAPTURE_INTERVAL_MS,
  INITIAL_SCROLL_CAPTURE_THROTTLE_STATE,
  onCaptureRequested,
  onSettled,
  onWheel as onWheelThrottle,
  shouldCapture,
} from './scrollCaptureThrottle'
import type { ScrollCaptureThrottleState } from './scrollCaptureThrottle'
import { tileWheelTargetPoint } from './tileWheelCoordinate'
import { tileClassName, tileSettingsDraft } from './tileView'
import type { TileSettingsDraft, TileViewModel } from './tileView'
import type { WebTile } from '../shared/types'

export interface TileCardProps {
  view: TileViewModel
  //+_+// P9-D8. 팝오버를 열 때 이 타일의 저장값으로 draft 를 채운다. TileViewModel 은 그 값들을 안 든다
  tile: WebTile
  editing: boolean
  dragClassName: string
  onFocus: () => void
  onDragStart: (mode: DragMode, event: React.PointerEvent) => void
  onDragMove: (event: React.PointerEvent) => void
  onDragEnd: () => void
  onDragCancel: () => void
  onReopen: () => void
  onBindExisting: () => void
  onRemove: () => void
  //+_+// P10-D18 (§8-5). 스크롤 스로틀이 정산 시점(onSettled)을 알아야 해 Promise 를 돌려받는다
  onRefreshPreview: () => Promise<void>
  onReloadPage: () => void
  onApplySettings: (draft: TileSettingsDraft) => void
  //+_+// P10-D22 (§8-5). 휠을 배경 탭에 전달한다. deltaX 는 싣지 않는다 (§8-5.4)
  //+_+// TASK-P11-01 (§8-6). x · y 는 tileWheelTargetPoint 로 이미 환산된 대상 탭 좌표다
  onScroll: (deltaY: number, x: number, y: number) => void
}

//+_+// Resize Handle 위에서 시작한 것만 크기 변경이다. 그 밖에서 시작한 것은 이동이다
function dragModeFor(event: React.PointerEvent): DragMode {
  const target = event.target
  return target instanceof HTMLElement && target.dataset.resize !== undefined ? 'resize' : 'move'
}

//+_+// v1 section 7 line 508~518 의 표시 항목이다. Favicon / 제목 / Preview / 상태 / 마지막 갱신 시각
//+_+// v1 section 7.1. View Mode 에서는 Pointer 처리기를 달지 않는다. 그래서 드래그로 움직이지 않는다
//+_+// v1 section 15.6. fitMode 값이 그대로 CSS object-fit 이다. 매핑표를 만들지 않는다
export function TileCard({
  view,
  tile,
  editing,
  dragClassName,
  onFocus,
  onDragStart,
  onDragMove,
  onDragEnd,
  onDragCancel,
  onReopen,
  onBindExisting,
  onRemove,
  onRefreshPreview,
  onReloadPage,
  onApplySettings,
  onScroll,
}: TileCardProps): React.JSX.Element {
  //+_+// P9-D11. Hub.tsx 의 hoveredId/focusedId 패턴을 그대로 참고한다. 이 타일 하나 안의 지역 상태다
  const [hovered, setHovered] = useState(false)
  const [focusedWithin, setFocusedWithin] = useState(false)
  //+_+// P9-D8. 이 타일의 팝오버 열림 여부와 편집 중인 draft 를 여기서 든다
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [draft, setDraft] = useState<TileSettingsDraft>(() => tileSettingsDraft(tile))
  const gearRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  //+_+// TASK-P11-01 (§8-6). naturalWidth · naturalHeight 를 읽을 자리다. .tile-preview 가 아니라
  //+_+// 이 박스 기준으로 상대 좌표를 잡는다 - naturalWidth 와 짝이 맞아야 한다
  const previewImageRef = useRef<HTMLImageElement | null>(null)
  //+_+// P10-D18 (§8-5). 화면에 안 보이는 판정값이라 리렌더를 안 일으키는 ref 로 든다
  const throttleStateRef = useRef<ScrollCaptureThrottleState>(INITIAL_SCROLL_CAPTURE_THROTTLE_STATE)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  //+_+// P5-D34 의 연장이다. 톱니·팝오버가 이제 tile-preview 위 overlay 라 pointerdown 이
  //+_+// article 에서 드래그를 잡아채는 것과 같은 자리를 다툰다. Edit Layout 중엔 닫아 둔다
  useEffect(() => {
    if (editing) {
      setIsSettingsOpen(false)
    }
  }, [editing])

  //+_+// P9-D12. 바깥 클릭과 Escape 둘 다 여기서 감지한다. 톱니·팝오버 안쪽 클릭은 바깥이 아니다
  useEffect(() => {
    if (!isSettingsOpen) {
      return undefined
    }
    const handlePointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) {
        return
      }
      const insideGear = gearRef.current?.contains(event.target) ?? false
      const insidePopover = popoverRef.current?.contains(event.target) ?? false
      if (!insideGear && !insidePopover) {
        setIsSettingsOpen(false)
      }
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setIsSettingsOpen(false)
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isSettingsOpen])

  //+_+// J97 선례를 "선택" 대신 "열기" 에 적용한다. 열 때 한 번만 저장값을 읽는다
  const toggleSettings = (): void => {
    if (!isSettingsOpen) {
      setDraft(tileSettingsDraft(tile))
    }
    setIsSettingsOpen((current) => !current)
  }

  const closeSettings = (): void => {
    setIsSettingsOpen(false)
  }

  //+_+// P10-D18 (§8-5). attempt 를 부르는 시점 셋 중 "휠이 들어왔을 때" · "onSettled 후" 가 여기를 거친다
  //+_+// 세 번째(디바운스)는 scheduleDebounce 가 부른다
  const attemptCapture = (): void => {
    const now = Date.now()
    if (!shouldCapture(throttleStateRef.current, now, MIN_CAPTURE_INTERVAL_MS)) {
      return
    }
    throttleStateRef.current = onCaptureRequested(throttleStateRef.current, now)
    void onRefreshPreview().then(() => {
      throttleStateRef.current = onSettled(throttleStateRef.current)
      attemptCapture()
    })
  }

  //+_+// P10-D18. 휠 멈춤 후 1회 더 -- 마지막 휠로부터 MIN_CAPTURE_INTERVAL_MS 뒤의 디바운스 타이머 1개
  const scheduleDebounce = (): void => {
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current)
    }
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null
      attemptCapture()
    }, MIN_CAPTURE_INTERVAL_MS)
  }

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current)
      }
    }
  }, [])

  //+_+// P10-D20 (§8-5). 톱니는 막지 않는다 -- stopPropagation 을 안 부르므로 그 위의 휠도 그대로 버블한다
  //+_+// 팝오버 안의 휠은 이벤트 타깃으로 가른다 (popoverRef.contains).  isSettingsOpen 만으로 가르면
  //+_+// 팝오버가 열린 동안 프리뷰 나머지 영역의 휠까지 막혀 버린다
  //+_+// P10-D21. tabId 가 없으면 조용히 무시한다.  React 가 wheel 을 passive 로 등록해 (S0-2)
  //+_+// preventDefault 는 부르지 않는다 (P10-D19)
  //+_+// TASK-P11-01 (§8-6). img 박스 기준 상대 좌표를 환산해 싣는다. 환산이 null 이면(레터박스
  //+_+// 여백, 이미지 미로딩 등) 메시지를 안 보낸다. 스로틀도 건드리지 않는다 - 스크롤이 안 났는데
  //+_+// 캡처를 부를 이유가 없다
  const handleWheel = (event: React.WheelEvent<HTMLDivElement>): void => {
    if (view.tabId === null) {
      return
    }
    if (popoverRef.current?.contains(event.target as Node) === true) {
      return
    }
    const image = previewImageRef.current
    if (image === null) {
      return
    }
    const rect = image.getBoundingClientRect()
    const target = tileWheelTargetPoint({
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      boxWidth: rect.width,
      boxHeight: rect.height,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
      fitMode: view.fitMode,
      scale: 1,
    })
    if (target === null) {
      return
    }
    onScroll(event.deltaY, target.x, target.y)
    throttleStateRef.current = onWheelThrottle(throttleStateRef.current)
    attemptCapture()
    scheduleDebounce()
  }

  //+_+// P9-D22. selected 매개변수가 없어지면서 tileClassName 을 고치지 않던 이유(P9-D9)도 없어졌다
  const className = [tileClassName(editing, dragClassName), isSettingsOpen ? 'tile--settings-open' : '']
    .filter((part) => part.length > 0)
    .join(' ')
  //+_+// P9-D11. editing 중엔 톱니 자체를 비활성·비표시로 둔다. disabled 버튼은 Tab 순서에서도 빠진다
  const iconVisible = !editing && (hovered || focusedWithin)
  //+_+// P9-D15. 맨 오른쪽 열이면 왼쪽으로 뒤집는다. 그 밖엔 기본값(오른쪽 열림)을 쓴다
  const flipPopover = tile.x + tile.w >= GRID_COLUMNS
  const popoverClassName = flipPopover
    ? 'tile-settings-popover tile-settings-popover--flip'
    : 'tile-settings-popover'

  return (
    <article
      className={className}
      style={{ gridArea: view.gridArea }}
      onDoubleClick={editing ? undefined : onFocus}
      onMouseEnter={() => {
        setHovered(true)
      }}
      onMouseLeave={() => {
        setHovered(false)
      }}
      onFocus={() => {
        setFocusedWithin(true)
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setFocusedWithin(false)
        }
      }}
      onPointerDown={
        editing
          ? (event) => {
              //+_+// F1. 기본 동작을 막는다. 그러지 않으면 브라우저가 이미지 드래그와 텍스트 선택을 가져간다
              //+_+// 포인터를 브라우저가 가져가면 pointerup 이 오지 않고 pointercancel 만 온다
              event.preventDefault()
              onDragStart(dragModeFor(event), event)
            }
          : undefined
      }
      onPointerMove={editing ? onDragMove : undefined}
      onPointerUp={editing ? onDragEnd : undefined}
      onPointerCancel={editing ? onDragCancel : undefined}
    >
      <header className="tile-head">
        {view.favIconUrl === null ? (
          <span className="tile-favicon tile-favicon--empty" />
        ) : (
          //+_+// F1. img 는 draggable 기본값이 true 다. 끄지 않으면 네이티브 드래그가 먼저 발동한다
          <img className="tile-favicon" src={view.favIconUrl} alt="" draggable={false} />
        )}
        <span className="tile-title" title={view.title}>
          {view.title}
        </span>
        <span className={view.statusClassName}>{view.status}</span>
      </header>

      <div className="tile-preview" onWheel={handleWheel}>
        {view.previewDataUrl === null ? (
          <span className="tile-preview-empty">no preview</span>
        ) : (
          <img
            ref={previewImageRef}
            className="tile-preview-image"
            style={{ objectFit: view.fitMode }}
            src={view.previewDataUrl}
            alt=""
            draggable={false}
          />
        )}

        <button
          ref={gearRef}
          type="button"
          className="tile-gear"
          style={{ opacity: iconVisible ? 1 : 0 }}
          aria-label="타일 설정 열기"
          aria-expanded={isSettingsOpen}
          disabled={editing}
          onClick={toggleSettings}
        >
          ⚙
        </button>

        {isSettingsOpen ? (
          //+_+// TASK-P12-05 (S3). P12-D17. article 의 onDoubleClick 이 v1 §7.1 의 프리뷰 전환이다.
          //+_+// 팝오버는 설정 입력 영역이라 그 대상이 아니다. 여기서 막아야 입력칸 · 라벨 · 버튼 ·
          //+_+// 여백 어디를 더블클릭해도(예: 텍스트 전체 선택) 안쪽 자손 전부가 한 번에 덮인다
          <div
            ref={popoverRef}
            className={popoverClassName}
            onDoubleClick={(event) => {
              event.stopPropagation()
            }}
          >
            <div className="tile-settings-popover-head">
              <span>Tile</span>
              <button type="button" aria-label="타일 설정 닫기" onClick={closeSettings}>
                ×
              </button>
            </div>
            <input
              value={draft.customTitle}
              placeholder="Custom Tile Name"
              onChange={(event) => {
                setDraft((current) => ({ ...current, customTitle: event.target.value }))
              }}
            />
            <select
              value={draft.fitMode}
              onChange={(event) => {
                const fitMode = event.target.value === 'cover' ? 'cover' : 'contain'
                setDraft((current) => ({ ...current, fitMode }))
              }}
            >
              <option value="contain">fit · contain</option>
              <option value="cover">fit · cover</option>
            </select>
            <select
              value={draft.matchMode}
              onChange={(event) => {
                const matchMode =
                  event.target.value === 'origin'
                    ? 'origin'
                    : event.target.value === 'prefix'
                      ? 'prefix'
                      : 'exact'
                setDraft((current) => ({ ...current, matchMode }))
              }}
            >
              <option value="exact">match · exact</option>
              <option value="origin">match · origin</option>
              <option value="prefix">match · prefix</option>
            </select>
            <input
              value={draft.refreshIntervalOverrideMs}
              placeholder="주기 ms · 비우면 자동"
              onChange={(event) => {
                setDraft((current) => ({ ...current, refreshIntervalOverrideMs: event.target.value }))
              }}
            />
            <input
              value={draft.captureTimeoutOverrideMs}
              placeholder="타임아웃 ms · 비우면 5000"
              onChange={(event) => {
                setDraft((current) => ({ ...current, captureTimeoutOverrideMs: event.target.value }))
              }}
            />
            <button
              type="button"
              onClick={() => {
                onApplySettings(draft)
              }}
            >
              Apply
            </button>
            <button type="button" onClick={onRefreshPreview}>
              Refresh Preview
            </button>
            <button type="button" onClick={onReloadPage}>
              Reload Page
            </button>
            <button type="button" onClick={onRemove}>
              Remove Tile
            </button>
          </div>
        ) : null}
      </div>

      {view.showsRecoveryActions ? (
        <div className="tile-detached">
          <button type="button" disabled={editing} onClick={onReopen}>
            Reopen
          </button>
          <button type="button" disabled={editing} onClick={onBindExisting}>
            Bind Existing Tab
          </button>
          <button type="button" disabled={editing} onClick={onRemove}>
            Remove Tile
          </button>
        </div>
      ) : null}

      {view.status === 'LIVE' ? null : (
        <footer className="tile-foot">
          <span>{view.lastCaptureLabel}</span>
          <span>{view.tabLabel}</span>
        </footer>
      )}

      {editing ? <span className="tile-resize" data-resize="" /> : null}
    </article>
  )
}
