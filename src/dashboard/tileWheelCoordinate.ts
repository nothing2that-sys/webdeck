import type { TileFitMode } from '../shared/types'

//+_+// TASK-P11-01 (§8-6). 휠 이벤트의 타일 내 상대 좌표를 대상 탭 좌표로 환산한다
//+_+// chrome.* 를 부르지 않고 DOM 을 만지지 않는다. 숫자만 받아 숫자를 낸다
export interface TileWheelCoordinateInput {
  //+_+// 이미지가 그려진 박스 좌상단 기준 커서 위치 (CSS px)
  offsetX: number
  offsetY: number
  //+_+// 그 박스의 크기 (CSS px)
  boxWidth: number
  boxHeight: number
  //+_+// 캡처 원본 이미지의 픽셀 크기
  naturalWidth: number
  naturalHeight: number
  fitMode: TileFitMode
  //+_+// 기본 1. HANDOFF_P11.md §4 -- 디바이스 픽셀 비를 지금 읽지 않는다. 호출부는 상수 1 을 넘긴다
  scale: number
}

export interface TargetPoint {
  x: number
  y: number
}

//+_+// contain -- 원본 전체가 박스 안에 들어가고 남는 쪽에 여백(레터박스)이 생긴다. 배율은 min(...)
//+_+// cover -- 원본이 박스를 덮고 넘치는 쪽이 잘린다. 배율은 max(...)
//+_+// null 은 contain 에서 커서가 레터박스 여백 위에 있을 때만 나온다.  cover 는 박스 안 어디든
//+_+// 그림이 있으므로 null 이 안 나온다.  naturalWidth/naturalHeight/boxWidth/boxHeight 가 0
//+_+// 이하이면 0 나눗셈을 막기 위해 null 이다
export function tileWheelTargetPoint(input: TileWheelCoordinateInput): TargetPoint | null {
  const { offsetX, offsetY, boxWidth, boxHeight, naturalWidth, naturalHeight, fitMode, scale } = input
  if (boxWidth <= 0 || boxHeight <= 0 || naturalWidth <= 0 || naturalHeight <= 0) {
    return null
  }

  const widthRatio = boxWidth / naturalWidth
  const heightRatio = boxHeight / naturalHeight
  const drawScale =
    fitMode === 'contain' ? Math.min(widthRatio, heightRatio) : Math.max(widthRatio, heightRatio)
  const drawnWidth = naturalWidth * drawScale
  const drawnHeight = naturalHeight * drawScale

  if (fitMode === 'contain') {
    //+_+// 남는 여백은 양쪽으로 반씩 나뉜다. 커서에서 여백을 빼고 배율로 나눈다
    const marginX = (boxWidth - drawnWidth) / 2
    const marginY = (boxHeight - drawnHeight) / 2
    const localX = offsetX - marginX
    const localY = offsetY - marginY
    if (localX < 0 || localX > drawnWidth || localY < 0 || localY > drawnHeight) {
      return null
    }
    return { x: localX / drawScale / scale, y: localY / drawScale / scale }
  }

  //+_+// 잘려나간 초과분이 양쪽으로 반씩이므로 커서에 그만큼 더한 뒤 배율로 나눈다
  const overflowX = (drawnWidth - boxWidth) / 2
  const overflowY = (drawnHeight - boxHeight) / 2
  const localX = offsetX + overflowX
  const localY = offsetY + overflowY
  return { x: localX / drawScale / scale, y: localY / drawScale / scale }
}
