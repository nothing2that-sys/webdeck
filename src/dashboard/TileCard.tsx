import type { DragMode } from './layoutDrag'
import type { TileViewModel } from './tileView'

export interface TileCardProps {
  view: TileViewModel
  selected: boolean
  editing: boolean
  dragClassName: string
  onSelect: () => void
  onFocus: () => void
  onDragStart: (mode: DragMode, event: React.PointerEvent) => void
  onDragMove: (event: React.PointerEvent) => void
  onDragEnd: () => void
  onDragCancel: () => void
  onReopen: () => void
  onBindExisting: () => void
  onRemove: () => void
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
  selected,
  editing,
  dragClassName,
  onSelect,
  onFocus,
  onDragStart,
  onDragMove,
  onDragEnd,
  onDragCancel,
  onReopen,
  onBindExisting,
  onRemove,
}: TileCardProps): React.JSX.Element {
  const className = ['tile', selected ? 'tile--selected' : '', editing ? 'tile--editing' : '', dragClassName]
    .filter((part) => part.length > 0)
    .join(' ')

  return (
    <article
      className={className}
      style={{ gridArea: view.gridArea }}
      onClick={onSelect}
      onDoubleClick={editing ? undefined : onFocus}
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

      <div className="tile-preview">
        {view.previewDataUrl === null ? (
          <span className="tile-preview-empty">no preview</span>
        ) : (
          <img
            className="tile-preview-image"
            style={{ objectFit: view.fitMode }}
            src={view.previewDataUrl}
            alt=""
            draggable={false}
          />
        )}
      </div>

      {view.status === 'DETACHED' ? (
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

      <footer className="tile-foot">
        <span>{view.lastCaptureLabel}</span>
        <span>{view.tabId === null ? 'tab -' : `tab ${String(view.tabId)}`}</span>
      </footer>

      {editing ? <span className="tile-resize" data-resize="" /> : null}
    </article>
  )
}
