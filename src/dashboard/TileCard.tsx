import type { TileViewModel } from './tileView'

export interface TileCardProps {
  view: TileViewModel
}

//+_+// v1 section 7 line 508~518 의 표시 항목이다. Favicon / 제목 / Preview / 상태 / 마지막 갱신 시각
//+_+// Hover Toolbar 와 선택 표시는 S3 이후다. 이 컴포넌트는 아직 조작을 받지 않는다
export function TileCard({ view }: TileCardProps): React.JSX.Element {
  return (
    <article className="tile" style={{ gridArea: view.gridArea }}>
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
    </article>
  )
}
