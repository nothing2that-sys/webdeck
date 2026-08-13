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
}

//+_+// Resize Handle 위에서 시작한 것만 크기 변경이다. 그 밖에서 시작한 것은 이동이다
function dragModeFor(event: React.PointerEvent): DragMode {
  const target = event.target
  return target instanceof HTMLElement && target.dataset.resize !== undefined ? 'resize' : 'move'
}

//+_+// v1 section 7 line 508~518 의 표시 항목이다. Favicon / 제목 / Preview / 상태 / 마지막 갱신 시각
//+_+// v1 section 7.1. View Mode 에서는 Pointer 처리기를 달지 않는다. 그래서 드래그로 움직이지 않는다
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
              onDragStart(dragModeFor(event), event)
            }
          : undefined
      }
      onPointerMove={editing ? onDragMove : undefined}
      onPointerUp={editing ? onDragEnd : undefined}
    >
      <header className="tile-head">
        {view.favIconUrl === null ? (
          <span className="tile-favicon tile-favicon--empty" />
        ) : (
          <img className="tile-favicon" src={view.favIconUrl} alt="" />
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
          <img className="tile-preview-image" src={view.previewDataUrl} alt="" />
        )}
      </div>

      <footer className="tile-foot">
        <span>{view.lastCaptureLabel}</span>
        <span>{view.tabId === null ? 'tab -' : `tab ${String(view.tabId)}`}</span>
      </footer>

      {editing ? <span className="tile-resize" data-resize="" /> : null}
    </article>
  )
}
