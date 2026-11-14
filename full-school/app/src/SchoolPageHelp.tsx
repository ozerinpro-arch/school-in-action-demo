import content from './school-page-help-data.json'
import './school-page-help.css'

export default function SchoolPageHelp({page}:{page:string}) {
 const guide=content[page as keyof typeof content]
 if(!guide)return null
 return <details key={page} className="sg-panel sg-page-help">
  <summary>Как работать в этом разделе · {guide.title}</summary>
  <ol>{guide.steps.map(step=><li key={step}>{step}</li>)}</ol>
 </details>
}
