import { useCallback, useEffect, useRef, useState } from 'react'
import { Archive, ArrowRight, Check, CircleHelp, Download, LoaderCircle, Plus, RefreshCw, RotateCcw, X } from 'lucide-react'
import { apiFetch } from './api'
import { saveReceipt } from './club-receipt-api'
import './school-clubs.css'

type Program = {id:string; title:string; teacherName:string; scheduleNote:string; room:string; description:string; feeKopeks:number|null; billingUnit:'month'|'lesson'; archived:boolean}
type Enrollment = {id:string; programId:string; studentId:string; studentName:string; className:string; status:'active'|'paused'|'completed'; note:string; archived:boolean}
type Charge = {id:string; programTitle:string; studentName:string; className:string; period:string; quantity:number; unitAmountKopeks:number; amountKopeks:number; status:'draft'|'confirmed'|'cancelled'}
type Student = {id:string; name:string; className:string; archived:boolean}
type Data = {revision:number; programs:Program[]; enrollments:Enrollment[]; charges:Charge[]; students:Student[]}
type Quote = {hash:string; proposal:{programTitle:string; studentName:string; className:string; amountKopeks:number; unitAmountKopeks:number; quantity:number; period:string}}
type Editor = {kind:'program'|'enrollment'|'charge'; id?:string; fields:Record<string,string>}
const BASE='/api/school/clubs'
const money=(value:number)=>`${Math.trunc(value/100).toLocaleString('en-GB')},${String(value%100).padStart(2,'0')} ₽`
const parseFee=(value:string):number|null=>{
 if(!value.trim())return null
 if(!/^\d{1,7}([.,]\d{1,2})?$/.test(value.trim()))throw new Error('Введите тариф в рублях, не более двух знаков после запятой.')
 const [whole,decimal='']=value.trim().replace(',','.').split('.')
 const result=Number(whole)*100+Number(decimal.padEnd(2,'0'))
 if(result>100_000_000)throw new Error('Тариф превышает допустимый предел.')
 return result
}
async function request<T>(path:string,body?:unknown,method='POST'):Promise<T>{
 let response:Response
 try{response=await apiFetch(BASE+path,body===undefined?{}:{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})}
 catch{throw new Error('Нет связи с сервером. Введённые значения сохранены.')}
 const data=await response.json().catch(()=>null)
 if(!response.ok)throw new Error(typeof data?.detail==='string'?data.detail:response.status===409?'Данные изменились. Обновите раздел и проверьте форму.':'Не удалось сохранить. Проверьте заполнение полей.')
 return data as T
}

export default function SchoolClubs({navigate}:{navigate:(page:string)=>void}){
 const [data,setData]=useState<Data|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState('')
 const [tab,setTab]=useState<'programs'|'enrollments'|'charges'>('programs'),[archived,setArchived]=useState(false),[query,setQuery]=useState('')
 const [editor,setEditor]=useState<Editor|null>(null),[open,setOpen]=useState(false),[formError,setFormError]=useState(''),[busy,setBusy]=useState(false),[quote,setQuote]=useState<Quote|null>(null)
 const [decision,setDecision]=useState<{id:string;action:'confirm'|'cancel'}|null>(null),[notice,setNotice]=useState('')
 const [downloading,setDownloading]=useState<string|null>(null)
 const dialog=useRef<HTMLDialogElement>(null),alive=useRef(true)
 const reload=useCallback(async()=>{setLoading(true);setError('');try{const next=await request<Data>('');if(alive.current)setData(next)}catch(cause){if(alive.current)setError((cause as Error).message)}finally{if(alive.current)setLoading(false)}},[])
 useEffect(()=>{alive.current=true;void reload();return()=>{alive.current=false}},[reload])
 useEffect(()=>{
  if(!open||!dialog.current)return
  const previous=document.activeElement as HTMLElement|null,node=dialog.current,overflow=document.body.style.overflow
  node.showModal();document.body.style.overflow='hidden'
  return()=>{node.close();document.body.style.overflow=overflow;previous?.isConnected&&previous.focus({preventScroll:true})}
 },[open])
 const begin=(value:Editor)=>{setEditor(value);setFormError('');setQuote(null);setOpen(true);setNotice('')}
 const setField=(key:string,value:string)=>{setEditor(old=>old?{...old,fields:{...old.fields,[key]:value}}:old);setQuote(null)}
 const fresh=()=>{
  if(tab==='programs')begin({kind:'program',fields:{title:'',teacherName:'',scheduleNote:'',room:'',description:'',fee:'',billingUnit:'month'}})
  else if(tab==='enrollments')begin({kind:'enrollment',fields:{programId:'',studentId:'',status:'active',note:''}})
  else begin({kind:'charge',fields:{enrollmentId:'',period:new Date().toLocaleDateString('sv-SE').slice(0,7),quantity:'1'}})
 }
 async function save(){
  if(!data||!editor||busy)return
  setBusy(true);setFormError('')
  try{
   const fields=editor.fields,expectedRevision=data.revision
   if(editor.kind==='program')await request('/programs'+(editor.id?'/'+encodeURIComponent(editor.id):''),{expectedRevision,record:{title:fields.title,teacherName:fields.teacherName,room:fields.room,scheduleNote:fields.scheduleNote,description:fields.description,feeKopeks:parseFee(fields.fee),billingUnit:fields.billingUnit}},editor.id?'PATCH':'POST')
   else if(editor.kind==='enrollment')await request('/enrollments'+(editor.id?'/'+encodeURIComponent(editor.id):''),{expectedRevision,record:fields},editor.id?'PATCH':'POST')
   else{
    const input={expectedRevision,enrollmentId:fields.enrollmentId,period:fields.period,quantity:Number(fields.quantity)}
    if(!quote){setQuote(await request<Quote>('/charges/preview',input));return}
    await request('/charges',{...input,expectedHash:quote.hash})
   }
   setOpen(false);setEditor(null);setQuote(null);setNotice('Запись сохранена.');await reload()
  }catch(cause){setFormError((cause as Error).message)}finally{setBusy(false)}
 }
 async function action(path:string){
  if(!data||busy)return
  setBusy(true);setError('');setNotice('')
  try{await request(path,{expectedRevision:data.revision});setDecision(null);setNotice('Изменение сохранено.');await reload()}
  catch(cause){setError((cause as Error).message)}finally{setBusy(false)}
 }
 async function downloadReceipt(id:string){
  setError('');setDownloading(id)
  try{await saveReceipt(`${BASE}/charges/${encodeURIComponent(id)}/receipt.pdf`,id)}
  catch(cause){if(alive.current)setError(cause instanceof Error?cause.message:'Could not download the receipt.')}
  finally{if(alive.current)setDownloading(null)}
 }
 const includes=(text:string)=>text.toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru'))
 const programs=(data?.programs||[]).filter(p=>p.archived===archived&&includes(p.title+' '+p.teacherName))
 const enrollments=(data?.enrollments||[]).filter(e=>e.archived===archived&&includes(e.studentName+' '+e.className+' '+(data?.programs.find(p=>p.id===e.programId)?.title||'')))
 const charges=(data?.charges||[]).filter(c=>includes(c.studentName+' '+c.programTitle+' '+c.period))
 const title=editor?.kind==='program'?'Программа':editor?.kind==='enrollment'?'Участник программы':'Предварительный расчёт'
 const field=(key:string,label:string,options?:{type?:string;required?:boolean;max?:number})=><label className="sc-field"><span>{label}</span><input type={options?.type||'text'} required={options?.required} maxLength={options?.max||200} value={editor?.fields[key]||''} onChange={event=>setField(key,event.target.value)}/></label>
 return <div className="sg-page sc-page cp-stack">
  <div className="sc-heading"><div className="sc-illustrated-heading"><img src={`${import.meta.env.BASE_URL}assets/school-clubs-glass.png`} width="76" height="76" alt="" decoding="async"/><div><h1>Кружки и программы</h1><p>Дополнительное образование и внутренний учёт.</p></div></div><button className="sg-control" aria-label="Обновить кружки" disabled={loading||busy} onClick={()=>void reload()}><RefreshCw size={17}/></button></div>
  <div className="sc-toolbar"><div className="sc-tabs" role="tablist" aria-label="Раздел дополнительного образования">{([['programs','Программы'],['enrollments','Участники'],['charges','Начисления']] as const).map(([id,label])=><button key={id} role="tab" aria-selected={tab===id} onClick={()=>{setTab(id);setQuery('');setNotice('')}}>{label}</button>)}</div><button className="sg-control sg-primary" disabled={!data||busy} onClick={fresh}><Plus size={16}/>{tab==='programs'?'Программа':tab==='enrollments'?'Участник':'Начисление'}</button></div>
  {notice&&<p className="sc-notice" role="status"><Check size={16}/>{notice}</p>}
  {error&&<div className="sc-error" role="alert"><p>{error}</p><button className="sg-control" onClick={()=>void reload()}>Повторить загрузку</button></div>}
  {loading&&!data?<div className="sg-panel sc-empty" role="status"><LoaderCircle className="sg-spin"/>Загружаем программы…</div>:data&&<>
   <div className="sc-filters"><label className="sc-search"><span className="sg-sr-only">Поиск в кружках</span><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Поиск…"/></label>{tab!=='charges'&&<label className="sc-archive-toggle"><input type="checkbox" checked={archived} onChange={e=>setArchived(e.target.checked)}/>Архив</label>}{editor&&!open&&<button className="sg-control" onClick={()=>setOpen(true)}>Продолжить заполнение</button>}</div>
   {tab==='programs'&&<section className="sg-panel sc-list" aria-label="Программы школы">{programs.map(p=><article className="sc-row" key={p.id}><div><h2>{p.title}</h2><p>{[p.teacherName,p.room?'Каб. '+p.room:'',p.scheduleNote].filter(Boolean).join(' · ')||'Подробности пока не указаны'}</p>{p.description&&<p>{p.description}</p>}</div><div className="sc-money">{p.feeKopeks===null?'Тариф не указан':money(p.feeKopeks)}{p.feeKopeks!==null&&<small>за {p.billingUnit==='month'?'месяц':'занятие'}</small>}</div><div className="sc-row-actions">{!p.archived&&<button className="sg-control" onClick={()=>begin({kind:'program',id:p.id,fields:{title:p.title,teacherName:p.teacherName,room:p.room,scheduleNote:p.scheduleNote,description:p.description,fee:p.feeKopeks===null?'':`${Math.trunc(p.feeKopeks/100)}.${String(p.feeKopeks%100).padStart(2,'0')}`,billingUnit:p.billingUnit}})}>Изменить</button>}<button className="sg-icon-button" aria-label={(p.archived?'Восстановить ':'В архив ')+p.title} disabled={busy} onClick={()=>void action(`/programs/${encodeURIComponent(p.id)}/${p.archived?'restore':'archive'}`)}>{p.archived?<RotateCcw size={17}/>:<Archive size={17}/>}</button></div></article>)}{!programs.length&&<div className="sc-empty"><h2>{query?'Программы не найдены':archived?'Архив пуст':'Добавьте первую программу'}</h2><p>{query?'Измените поисковый запрос.':'Название, преподавателя и условия указывает школа.'}</p>{!archived&&!query&&<button className="sg-control" onClick={fresh}><Plus size={16}/>Добавить программу</button>}</div>}</section>}
   {tab==='enrollments'&&<section className="sg-panel sc-list" aria-label="Участники программ">{enrollments.map(e=><article className="sc-row" key={e.id}><div><h2>{e.studentName}<small>{e.className}</small></h2><p>{data.programs.find(p=>p.id===e.programId)?.title||'Программа в архиве'}</p></div><span className="sc-status">{{active:'Занимается',paused:'Пауза',completed:'Завершено'}[e.status]}</span><div className="sc-row-actions">{!e.archived&&<button className="sg-control" onClick={()=>begin({kind:'enrollment',id:e.id,fields:{programId:e.programId,studentId:e.studentId,status:e.status,note:e.note}})}>Изменить</button>}<button className="sg-icon-button" disabled={busy} aria-label={(e.archived?'Восстановить ':'В архив ')+e.studentName} onClick={()=>void action(`/enrollments/${encodeURIComponent(e.id)}/${e.archived?'restore':'archive'}`)}>{e.archived?<RotateCcw size={17}/>:<Archive size={17}/>}</button></div></article>)}{!enrollments.length&&<div className="sc-empty"><h2>{query?'Участники не найдены':archived?'Архив пуст':'Участники пока не добавлены'}</h2><p>Запись связывает ученика из реестра с программой.</p><button className="sg-control" onClick={()=>navigate('students')}>Открыть учеников<ArrowRight size={16}/></button></div>}</section>}
   {tab==='charges'&&<><p className="sc-note"><CircleHelp size={16}/>Внутренний реестр начислений школы. Создание записи не проводит платёж.</p><section className="sg-panel sc-list" aria-label="Начисления школы">{charges.map(c=><article className="sc-row" key={c.id}><div><h2>{c.studentName}<small>{c.className}</small></h2><p>{c.programTitle} · {c.period}</p><span className="sc-status">{{draft:'Черновик',confirmed:'Подтверждено',cancelled:'Отменено'}[c.status]}</span></div><div className="sc-money">{money(c.amountKopeks)}<small>{c.quantity} × {money(c.unitAmountKopeks)}</small></div><div className="sc-row-actions">{c.status==='draft'&&<button className="sg-control" disabled={busy} onClick={()=>setDecision({id:c.id,action:'confirm'})}>Подтвердить</button>}{c.status==='confirmed'&&<button type="button" className="sg-control" disabled={busy||downloading!==null} onClick={()=>void downloadReceipt(c.id)}><Download size={16} aria-hidden="true"/>{downloading===c.id?'Downloading…':'Download PDF'}</button>}{c.status!=='cancelled'&&<button className="sg-control" disabled={busy} onClick={()=>setDecision({id:c.id,action:'cancel'})}>Отменить</button>}</div>{decision?.id===c.id&&<div className="sc-decision" role="group" aria-label="Подтверждение действия с начислением"><p>{decision.action==='confirm'?'Подтвердить начисление':'Отменить начисление'} {money(c.amountKopeks)} для {c.studentName}?</p><button className="sg-control sg-primary" disabled={busy} onClick={()=>void action(`/charges/${encodeURIComponent(c.id)}/${decision.action}`)}>Да, {decision.action==='confirm'?'подтвердить':'отменить'}</button><button className="sg-control" disabled={busy} onClick={()=>setDecision(null)}>Вернуться</button></div>}</article>)}{!charges.length&&<div className="sc-empty"><h2>{query?'Начисления не найдены':'Начислений пока нет'}</h2><p>Выберите участника и период, проверьте расчёт, затем сохраните черновик.</p></div>}</section></>}
  </>}
  <dialog ref={dialog} className="sc-dialog" aria-labelledby="sc-form-title" onKeyDown={event=>{if(event.key!=='Tab')return;const items=[...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]')].filter(e=>e.getClientRects().length);const first=items[0],last=items[items.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus()}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus()}}} onCancel={event=>{event.preventDefault();if(!busy)setOpen(false)}} onClick={event=>{if(event.target===event.currentTarget&&!busy)setOpen(false)}}><div className="sc-dialog-head"><h2 id="sc-form-title">{title}</h2><button className="sg-icon-button" disabled={busy} aria-label="Закрыть форму кружка" onClick={()=>setOpen(false)}><X size={20}/></button></div>{editor&&<form onSubmit={event=>{event.preventDefault();void save()}}>
   {editor.kind==='program'&&<>{field('title','Название программы',{required:true,max:160})}{field('teacherName','Преподаватель',{max:160})}<div className="sc-field-pair">{field('room','Кабинет',{max:80})}{field('scheduleNote','Когда проходят занятия',{max:500})}</div><label className="sc-field"><span>Описание</span><textarea maxLength={10000} value={editor.fields.description} onChange={e=>setField('description',e.target.value)}/></label><div className="sc-field-pair">{field('fee','Тариф, ₽')}<label className="sc-field"><span>Единица тарифа</span><select value={editor.fields.billingUnit} onChange={e=>setField('billingUnit',e.target.value)}><option value="month">За месяц</option><option value="lesson">За занятие</option></select></label></div><p className="sc-note">Если тариф ещё не утверждён, оставьте поле пустым.</p></>}
   {editor.kind==='enrollment'&&<><label className="sc-field"><span>Программа участника</span><select required disabled={!!editor.id} value={editor.fields.programId} onChange={e=>setField('programId',e.target.value)}><option value="">Выберите программу</option>{data?.programs.filter(p=>!p.archived||p.id===editor.fields.programId).map(p=><option key={p.id} value={p.id}>{p.title}</option>)}</select></label><label className="sc-field"><span>Ученик программы</span><select required disabled={!!editor.id} value={editor.fields.studentId} onChange={e=>setField('studentId',e.target.value)}><option value="">Выберите ученика</option>{data?.students.filter(s=>!s.archived||s.id===editor.fields.studentId).map(s=><option key={s.id} value={s.id}>{s.name} · {s.className}</option>)}</select></label>{!data?.students.some(s=>!s.archived)&&<p className="sc-note">Сначала добавьте учеников в реестр школы.</p>}<label className="sc-field"><span>Участие</span><select value={editor.fields.status} onChange={e=>setField('status',e.target.value)}><option value="active">Занимается</option><option value="paused">Пауза</option><option value="completed">Завершено</option></select></label>{field('note','Примечание',{max:2000})}</>}
   {editor.kind==='charge'&&<><label className="sc-field"><span>Участник для начисления</span><select required value={editor.fields.enrollmentId} onChange={e=>setField('enrollmentId',e.target.value)}><option value="">Выберите участника</option>{data?.enrollments.filter(e=>!e.archived&&e.status==='active').map(e=><option key={e.id} value={e.id}>{e.studentName} · {data.programs.find(p=>p.id===e.programId)?.title}</option>)}</select></label><div className="sc-field-pair">{field('period','Период начисления',{type:'month',required:true})}{field('quantity','Количество',{type:'number',required:true})}</div>{quote&&<div className="sc-quote" role="status"><h3>{quote.proposal.programTitle}</h3><p>{quote.proposal.studentName} · {quote.proposal.className}</p><p>{quote.proposal.quantity} × {money(quote.proposal.unitAmountKopeks)}</p><strong>{money(quote.proposal.amountKopeks)}</strong><small>Черновик за {quote.proposal.period}</small></div>}</>}
   {formError&&<div className="sc-error" role="alert"><p>{formError}</p><button type="button" className="sg-control" disabled={busy||loading} onClick={()=>void reload()}>Обновить данные, сохранив ввод</button></div>}
   <div className="sc-form-actions"><button type="submit" className="sg-control sg-primary" disabled={busy||loading}>{busy?<LoaderCircle size={16} className="sg-spin"/>:null}{editor.kind==='charge'?(quote?'Сохранить черновик':'Проверить расчёт'):'Сохранить'}</button><button type="button" className="sg-control" disabled={busy} onClick={()=>{setOpen(false);setEditor(null);setQuote(null)}}>Отменить ввод</button></div>
  </form>}</dialog>
 </div>
}
