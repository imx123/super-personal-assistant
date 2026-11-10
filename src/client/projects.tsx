/** Project tab: the Projects the Router created, and one Project's goal, PM Session and latest report. */
import { ApiError, usePoll } from './api.ts'
import { usePanel } from './provider.tsx'
import { valueLabel } from './text.ts'
import { Hint, KeyValues, LoadState, MarkdownLite, PageHead, Section, SessionButton, When } from './widgets.tsx'

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
          <span className="dt-status-text">{valueLabel(t, 'projectStatus', project.status)}</span>
          <span>{project.goal}</span>
          <When at={project.updatedAt} />
        </div>
        {project.latestReport && <div className="dt-row-quote"><MarkdownLite text={project.latestReport.summary} /></div>}
      </div>
    </li>)}</ul> : <Hint>{t('projectsEmpty')}</Hint>)}
  </>
}

function ProjectPage({ id }: { id: string }) {
  const { t, call, navigate } = usePanel()
  const { data, error } = usePoll(() => call('GET projects/:id', { id }), [id])
  if (!data) return <>
    <PageHead title={t('term.project')} />
    {error instanceof ApiError && error.missing ? <Hint>{t('projectNotFound')}</Hint> : <LoadState error={error} loading />}
  </>
  const report = data.latestReport
  return <>
    <PageHead title={data.title}><SessionButton sessionId={data.pmSessionId} label={t('openPmSession')} /></PageHead>
    <div className="dt-row-meta dt-status-line">
      <span className="dt-status-text" data-state="ongoing">{valueLabel(t, 'projectStatus', data.status)}</span>
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
