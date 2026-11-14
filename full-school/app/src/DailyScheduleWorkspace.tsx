import {useEffect,useId,useState} from 'react'
import {CalendarDays,ChevronUp} from 'lucide-react'
import DailyPlanningBrief from './DailyPlanningBrief'

type Props={schoolId:string;actorId:string;disabled?:boolean;active:boolean;openRequest:number;onRunCreated:(runId:string,targetDate:string)=>void;onOpenConditions:(targetDate:string)=>void;onOpenCalendar:(targetDate:string)=>void}

export default function DailyScheduleWorkspace({schoolId,actorId,disabled=false,active,openRequest,onRunCreated,onOpenConditions,onOpenCalendar}:Props){
 const [open,setOpen]=useState(false),[visited,setVisited]=useState(false),[focusRequest,setFocusRequest]=useState(0)
 const heading=useId(),body=useId()
 useEffect(()=>{if(openRequest>0){setOpen(true);setVisited(true);setFocusRequest(value=>value+1)}},[openRequest])
 function toggle(){if(disabled)return;if(!open){setVisited(true);setFocusRequest(value=>value+1)}setOpen(value=>!value)}
 return <div hidden={!active}><section className="sw-daily-entry cp-stack" aria-labelledby={heading}>
  <div className="sg-panel">
   <div className="sw-daily-heading"><div><h2 id={heading}>Ежедневное расписание</h2><p>Внесите ответы учителей после обзвона. Система учтёт их и составит оставшиеся занятия на выбранный день.</p></div><button type="button" className="sg-control sg-primary" aria-expanded={open} aria-controls={body} disabled={disabled} onClick={toggle}>{open?<ChevronUp size={18}/>:<CalendarDays size={18}/>}<span>{open?'Свернуть бриф':visited?'Продолжить бриф':'Составить на день'}</span></button></div>
   <ol className="sw-daily-steps" aria-label="Порядок ежедневного составления"><li>Ответы после звонков</li><li>Проверка остальных форм</li><li>Автоматический расчёт</li><li>Просмотр и согласование</li></ol>
   <p className="sw-daily-caption">Для точечной правки нажмите нужный урок в сетке ниже.</p>
  </div>
  <div id={body} hidden={!open}><DailyPlanningBrief schoolId={schoolId} actorId={actorId} disabled={disabled} active={active&&open} focusRequest={focusRequest} onRunCreated={onRunCreated} onOpenConditions={onOpenConditions} onOpenCalendar={onOpenCalendar}/></div>
 </section></div>
}
