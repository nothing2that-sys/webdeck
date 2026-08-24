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
  NOTICE_PROJECT_REQUIRED,
  NOTICE_RENAME_REQUIRED,
  failureNotice,
  hubRowClassName,
} from './screenText'

//+_+// WEBDECK_PLAN 8-2.3 6번. 프로젝트 목록 · 설명 · launchUrl 을 보이고 CRUD 를 받는다
//+_+// P8-D17. LIST_PROJECTS 하나로 다 받는다. GET_PROJECT_STATE 를 보내지 않으므로 임차가 없다
//+_+// activeProjectId 를 상태로 들이지 않는다. Rename 과 Delete 의 대상은 고른 행이다
export function Hub(): React.JSX.Element {
  const [projects, setProjects] = useState<Project[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [projectName, setProjectName] = useState('')
  const [projectDescription, setProjectDescription] = useState('')
  const [notice, setNotice] = useState(NOTICE_NONE)

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

  //+_+// 고른 행의 이름과 설명을 입력란에 채운다. Rename 이 지금 값을 지우고 시작하지 않게 한다
  const select = useCallback((project: Project) => {
    setSelectedProjectId(project.id)
    setProjectName(project.name)
    setProjectDescription(project.description ?? '')
  }, [])

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

  //+_+// J82 · 8-2.3 6번. New 는 만들고 허브에 머문다. 전환도 탭 열기도 하지 않는다
  const addProject = useCallback(async () => {
    const name = projectName.trim()
    if (name.length === 0) {
      setNotice(NOTICE_PROJECT_NAME_REQUIRED)
      return
    }
    const response = await createProject(name, projectDescription)
    if (!response.ok) {
      setNotice(failureNotice(response))
      return
    }
    setProjectName('')
    setProjectDescription('')
    setNotice(NOTICE_NONE)
    await loadProjects()
  }, [loadProjects, projectDescription, projectName])

  const renameSelectedProject = useCallback(async () => {
    if (selectedProjectId === null) {
      setNotice(NOTICE_PROJECT_REQUIRED)
      return
    }
    const name = projectName.trim()
    if (name.length === 0) {
      setNotice(NOTICE_RENAME_REQUIRED)
      return
    }
    const response = await renameProject(selectedProjectId, name, projectDescription)
    if (!response.ok) {
      setNotice(failureNotice(response))
      return
    }
    setNotice(NOTICE_NONE)
    await loadProjects()
  }, [loadProjects, projectDescription, projectName, selectedProjectId])

  //+_+// P5-D23. 마지막 하나여도 워커가 거부하지 않는다. 기본 프로젝트가 다시 선다
  const removeSelectedProject = useCallback(async () => {
    if (selectedProjectId === null) {
      setNotice(NOTICE_PROJECT_REQUIRED)
      return
    }
    const response = await deleteProject(selectedProjectId)
    if (!response.ok) {
      setNotice(failureNotice(response))
      return
    }
    setSelectedProjectId(null)
    setProjectName('')
    setProjectDescription('')
    setNotice(NOTICE_NONE)
    await loadProjects()
  }, [loadProjects, selectedProjectId])

  return (
    <div className="app">
      <header className="toolbar">
        <span className="toolbar-title">WebDeck</span>
        <input
          className="toolbar-input"
          value={projectName}
          placeholder="프로젝트 이름"
          onChange={(event) => {
            setProjectName(event.target.value)
          }}
        />
        <input
          className="toolbar-input"
          value={projectDescription}
          placeholder="설명"
          onChange={(event) => {
            setProjectDescription(event.target.value)
          }}
        />
        <button type="button" onClick={() => void addProject()}>
          New
        </button>
        <button type="button" onClick={() => void renameSelectedProject()}>
          Rename
        </button>
        <button type="button" onClick={() => void removeSelectedProject()}>
          Delete
        </button>
        <span className="toolbar-spacer" />
        <span className="toolbar-count">projects {projects.length}</span>
      </header>

      <ul className="hub-list">
        {projects.map((project) => (
          <li key={project.id} className={hubRowClassName(project.id === selectedProjectId)}>
            <div className="hub-row-head">
              <button
                type="button"
                className="hub-pick"
                onClick={() => {
                  select(project)
                }}
              >
                {project.name}
              </button>
              <span className="hub-description">{project.description ?? ''}</span>
              <span className="toolbar-spacer" />
              <button type="button" onClick={() => void open(project.id)}>
                Open
              </button>
            </div>
            <ul className="hub-urls">
              {project.tiles.length === 0 ? (
                <li className="hub-empty">{HUB_NO_TILES}</li>
              ) : (
                project.tiles.map((tile) => <li key={tile.id}>{tile.launchUrl}</li>)
              )}
            </ul>
          </li>
        ))}
      </ul>

      <footer className="statusbar">{notice}</footer>
    </div>
  )
}
