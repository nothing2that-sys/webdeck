import { useCallback, useEffect, useState } from 'react'
import type { Project } from '../shared/types'
import {
  createProject,
  deleteProject,
  listProjects,
  openProjectTab,
  renameProject,
  setActiveProject,
} from './dashboardService'
import {
  HUB_NO_TILES,
  NOTICE_NONE,
  NOTICE_PROJECT_NAME_REQUIRED,
  NOTICE_RENAME_REQUIRED,
  failureNotice,
} from './screenText'

//+_+// WEBDECK_PLAN 8-4.1. 행 자체가 편집·삭제를 받는다. 위쪽 공용 폼을 두지 않는다
//+_+// P9-D3. New 도 목록 맨 위의 빈 행을 이 편집 모드로 여는 것으로 처리한다
const NEW_PROJECT_ID = 'new'

export function Hub(): React.JSX.Element {
  const [projects, setProjects] = useState<Project[]>([])
  const [notice, setNotice] = useState(NOTICE_NONE)
  //+_+// P9-D5. 선택 상태(li tabIndex/keydown)를 없앤 자리다. 지금 편집 중인 행 하나만 있다
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [draftDescription, setDraftDescription] = useState('')
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null)
  //+_+// P9-D2 는 타일 hover 이야기다. 이 hoveredId 는 허브 행 Edit·Delete 아이콘 노출 전용이다
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  //+_+// P9-D6. hoveredId 와 합치지 않는다. 마우스가 행을 벗어나도 포커스가 남아 있으면
  //+_+// 계속 보여야 하고, 그 반대(포커스는 없는데 마우스만 얹힌 채)도 마찬가지다
  const [focusedId, setFocusedId] = useState<string | null>(null)

  const loadProjects = useCallback(async () => {
    const response = await listProjects()
    if (!response.ok) {
      setNotice(failureNotice(response))
      return
    }
    if (response.type !== 'LIST_PROJECTS') {
      return
    }
    setProjects(response.projects)
  }, [])

  useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  const startEdit = useCallback((project: Project) => {
    setConfirmingDeleteId(null)
    setEditingId(project.id)
    setDraftName(project.name)
    setDraftDescription(project.description ?? '')
  }, [])

  const startNewProject = useCallback(() => {
    setConfirmingDeleteId(null)
    setEditingId(NEW_PROJECT_ID)
    setDraftName('')
    setDraftDescription('')
  }, [])

  //+_+// 새 행이면 projects 상태에 아직 없으므로 editingId 를 지우는 것만으로 목록에서 빠진다
  const cancelEdit = useCallback(() => {
    setEditingId(null)
    setDraftName('')
    setDraftDescription('')
  }, [])

  const saveEdit = useCallback(async () => {
    const name = draftName.trim()
    if (name.length === 0) {
      setNotice(editingId === NEW_PROJECT_ID ? NOTICE_PROJECT_NAME_REQUIRED : NOTICE_RENAME_REQUIRED)
      return
    }
    const response =
      editingId === NEW_PROJECT_ID
        ? await createProject(name, draftDescription)
        : await renameProject(editingId ?? '', name, draftDescription)
    if (!response.ok) {
      setNotice(failureNotice(response))
      return
    }
    setEditingId(null)
    setDraftName('')
    setDraftDescription('')
    setNotice(NOTICE_NONE)
    await loadProjects()
  }, [draftDescription, draftName, editingId, loadProjects])

  const startDeleteConfirm = useCallback((projectId: string) => {
    setEditingId(null)
    setConfirmingDeleteId(projectId)
  }, [])

  const cancelDeleteConfirm = useCallback(() => {
    setConfirmingDeleteId(null)
  }, [])

  const confirmDelete = useCallback(
    async (projectId: string) => {
      const response = await deleteProject(projectId)
      if (!response.ok) {
        setNotice(failureNotice(response))
        setConfirmingDeleteId(null)
        return
      }
      setConfirmingDeleteId(null)
      setNotice(NOTICE_NONE)
      await loadProjects()
    },
    [loadProjects],
  )

  //+_+// P8-D16. SET_ACTIVE_PROJECT 를 먼저 보내고 그다음 OPEN_PROJECT_TAB 이다
  //+_+// 앞이 실패하면 뒤를 보내지 않는다. 기록이 어긋난 채로 탭을 열지 않는다
  const open = useCallback(async (projectId: string) => {
    const active = await setActiveProject(projectId)
    if (!active.ok) {
      setNotice(failureNotice(active))
      return
    }
    const opened = await openProjectTab(projectId)
    if (!opened.ok) {
      setNotice(failureNotice(opened))
      return
    }
    setNotice(NOTICE_NONE)
  }, [])

  return (
    <div className="app">
      <header className="toolbar">
        <span className="toolbar-title">WebDeck</span>
        <button type="button" onClick={startNewProject}>
          New
        </button>
        <span className="toolbar-spacer" />
        <span className="toolbar-count">projects {projects.length}</span>
      </header>

      <ul className="hub-list">
        {editingId === NEW_PROJECT_ID ? (
          //+_+// P9-D21. 이 행은 editingId==='new' 일 때만 존재하므로 늘 "만드는 중"이다
          <li className="hub-row hub-row--creating" key={NEW_PROJECT_ID}>
            <div className="hub-row-head">
              <input
                value={draftName}
                placeholder="프로젝트 이름"
                onChange={(event) => {
                  setDraftName(event.target.value)
                }}
              />
              <input
                value={draftDescription}
                placeholder="설명"
                onChange={(event) => {
                  setDraftDescription(event.target.value)
                }}
              />
              <span className="toolbar-spacer" />
              <button type="button" onClick={() => void saveEdit()}>
                Save
              </button>
              <button type="button" onClick={cancelEdit}>
                Cancel
              </button>
            </div>
          </li>
        ) : null}

        {projects.map((project) => {
          const isEditing = editingId === project.id
          const isConfirmingDelete = confirmingDeleteId === project.id
          //+_+// P9-D6. 조건부 렌더링을 없앤 자리다. 버튼은 늘 DOM 에 있고 opacity 만 가른다
          const iconsVisible = hoveredId === project.id || focusedId === project.id

          return (
            <li
              key={project.id}
              className="hub-row"
              onMouseEnter={() => {
                setHoveredId(project.id)
              }}
              onMouseLeave={() => {
                setHoveredId((current) => (current === project.id ? null : current))
              }}
              onFocus={() => {
                setFocusedId(project.id)
              }}
              onBlur={(event) => {
                //+_+// P9-D6. 같은 행 안(Edit -> Delete 등)으로 포커스가 옮겨가는 것은 이탈이 아니다
                if (!event.currentTarget.contains(event.relatedTarget)) {
                  setFocusedId(null)
                }
              }}
            >
              {isEditing ? (
                <div className="hub-row-head">
                  <input
                    value={draftName}
                    placeholder="프로젝트 이름"
                    onChange={(event) => {
                      setDraftName(event.target.value)
                    }}
                  />
                  <input
                    value={draftDescription}
                    placeholder="설명"
                    onChange={(event) => {
                      setDraftDescription(event.target.value)
                    }}
                  />
                  <span className="toolbar-spacer" />
                  <button type="button" onClick={() => void saveEdit()}>
                    Save
                  </button>
                  <button type="button" onClick={cancelEdit}>
                    Cancel
                  </button>
                </div>
              ) : isConfirmingDelete ? (
                <div className="hub-row-head">
                  <span>정말 삭제?</span>
                  <span className="toolbar-spacer" />
                  <button type="button" onClick={() => void confirmDelete(project.id)}>
                    예
                  </button>
                  <button type="button" onClick={cancelDeleteConfirm}>
                    아니오
                  </button>
                </div>
              ) : (
                <div className="hub-row-head">
                  <span className="hub-pick">{project.name}</span>
                  <span className="hub-description">{project.description ?? ''}</span>
                  <span className="toolbar-spacer" />
                  <button type="button" onClick={() => void open(project.id)}>
                    Open
                  </button>
                  <button
                    type="button"
                    aria-label={`Edit ${project.name}`}
                    style={{ opacity: iconsVisible ? 1 : 0 }}
                    onClick={() => {
                      startEdit(project)
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${project.name}`}
                    style={{ opacity: iconsVisible ? 1 : 0 }}
                    onClick={() => {
                      startDeleteConfirm(project.id)
                    }}
                  >
                    Delete
                  </button>
                </div>
              )}
              <ul className="hub-urls">
                {project.tiles.length === 0 ? (
                  <li className="hub-empty">{HUB_NO_TILES}</li>
                ) : (
                  project.tiles.map((tile) => <li key={tile.id}>{tile.launchUrl}</li>)
                )}
              </ul>
            </li>
          )
        })}
      </ul>

      <footer className="statusbar">{notice}</footer>
    </div>
  )
}
