/** Project tab: the Projects the Router created, and one Project's goal, PM Session, latest report and controls. */
import { ApiError, usePoll, type ProjectRow } from './api.ts'
import { Button, Icon } from './controls.tsx'
import { useAction, usePanel } from './provider.tsx'
import { valueLabel } from './text.ts'
import { ConfirmButton, Hint, KeyValues, LoadState, MarkdownLite, PageHead, Section, SessionButton, When } from './widgets.tsx'

/** The status dot tone for a Project state: running, paused, or archived/ended history. */
const projectTone = (status: ProjectRow['status']): 'ongoing' | 'warning' | 'idle' =>
  status === 'paused' ? 'warning' : status === 'ended' || status === 'archived' ? 'idle' : 'ongoing'

function ProjectList() {
  const { t, call, navigate } = usePanel()
  const { data, error } = usePoll(() => call('GET projects'), [])
  return <>
    <PageHead title={t('tab.project')} />
    <Hint>{t('projectsIntro')}</Hint>
    <LoadState error={error} loading={!data} />
    {data && (data.items.length ? <ul className="dt-list">{data.items.map(project => <li key={project.id} className="dt-row dt-link">
      <div className="dt-row-main">
        <div className="dt-row-title">
          <button type="button" className="dt-open" onClick={() => navigate({ page: 'project', id: project.id })}>{project.title}</button>
        </div>
        <div className="dt-row-meta">
          <span className="dt-status-text" data-state={projectTone(project.status)}>{valueLabel(t, 'projectStatus', project.status)}</span>
          <span>{project.goal}</span>
          <When at={project.updatedAt} />
        </div>
        {project.latestReport && <div className="dt-row-quote"><MarkdownLite text={project.latestReport.summary} /></div>}
      </div>
    </li>)}</ul> : <Hint>{t('projectsEmpty')}</Hint>)}
  </>
}

function ProjectPage({ id }: { id: string }) {
  const { t, call, navigate, notify } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET projects/:id', { id }), [id])
  const reportArchive = (sessions: { failures: { sessionId: string; error: string }[] }, label: string) => {
    if (sessions.failures.length) notify(t('projectSessionsFailed', { action: label, count: String(sessions.failures.length) }))
  }
  const pause = useAction(async () => {
    await call('POST projects/:id/pause', { id, body: { paused: data?.status === 'active' } })
  }, { reload })
  const stop = useAction(async () => { await call('POST projects/:id/stop', { id }) }, { reload })
  const archive = useAction(async () => {
    const result = await call('POST projects/:id/archive', { id })
    reportArchive(result.sessions, t('archiveProject'))
  }, { reload })
  const unarchive = useAction(async () => {
    const result = await call('POST projects/:id/unarchive', { id })
    reportArchive(result.sessions, t('unarchiveProject'))
  }, { reload })
  if (!data) return <>
    <PageHead title={t('term.project')} />
    {error instanceof ApiError && error.missing ? <Hint>{t('projectNotFound')}</Hint> : <LoadState error={error} loading />}
  </>
  const report = data.latestReport
  return <>
    <PageHead title={data.title}>
      {data.status === 'archived'
        ? <Button variant="outline" size="sm" icon={<Icon name="history" size={14} />} disabled={unarchive.busy}
          onClick={() => { void unarchive.run() }}>{t('unarchiveProject')}</Button>
        : data.status !== 'ended' && <Button variant="outline" size="sm" icon={<Icon name="inbox" size={14} />}
          disabled={archive.busy} onClick={() => { void archive.run() }}>{t('archiveProject')}</Button>}
      {(data.status === 'active' || data.status === 'paused') && <>
        <Button variant="outline" size="sm" icon={<Icon name={data.status === 'paused' ? 'play' : 'pause'} size={14} />}
          disabled={pause.busy} onClick={() => { void pause.run() }}>
          {t(data.status === 'paused' ? 'resumeProject' : 'pauseProject')}
        </Button>
        <ConfirmButton variant="outline" icon="stop" label={t('stopProject')} title={t('stopProjectTitle')}
          message={t('stopProjectConfirm', { title: data.title })} onConfirm={stop.run} />
      </>}
      <SessionButton sessionId={data.pmSessionId} label={t('openPmSession')} />
    </PageHead>
    <div className="dt-row-meta dt-status-line">
      <span className="dt-status-text" data-state={projectTone(data.status)}>{valueLabel(t, 'projectStatus', data.status)}</span>
    </div>
    <Section title={t('projectGoal')}><p>{data.goal}</p></Section>
    <Section title={t('projectTickets')}>
      {data.tickets.length ? <ul className="dt-list">{data.tickets.map(ticket => <li key={ticket.id} className="dt-row dt-link">
        <div className="dt-row-main">
          <div className="dt-row-title">
            <button type="button" className="dt-open" onClick={() => navigate({ page: 'execution', id: ticket.id })}>{ticket.title}</button>
          </div>
          <div className="dt-row-meta">
            {ticket.threads.map(thread => <span key={thread.thread}>{thread.thread}{thread.context ? ` (${t('contextOnly')})` : ''}</span>)}
          </div>
        </div>
      </li>)}</ul> : <Hint>{t('projectNoTickets')}</Hint>}
    </Section>
    <Section title={t('projectPmSession')}>
      <KeyValues rows={[[t('projectPmSession'), data.pmSessionId], [t('projectCreated'), <When at={data.createdAt} />],
        [t('projectUpdated'), <When at={data.updatedAt} />]]} />
    </Section>
    <Section title={t('projectLatestReport')}>
      {report ? <><MarkdownLite text={report.summary} /><When at={report.at} /></> : <Hint>{t('projectNoReport')}</Hint>}
    </Section>
  </>
}

/** The Projects list, or one Project when the route names its id. */
export function ProjectsPage({ id }: { id?: string }) {
  return id === undefined ? <ProjectList /> : <ProjectPage id={id} />
}
