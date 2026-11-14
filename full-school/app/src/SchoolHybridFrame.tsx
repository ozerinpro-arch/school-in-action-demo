import {createContext,useCallback,useContext,useEffect,useRef,useState,type ReactNode} from 'react'
import './school-hybrid.css'

export type SchoolHybridTheme='pink'|'blue'|'clear'
const STORAGE_KEY='school.hybrid.theme.v1'
const themes:SchoolHybridTheme[]=['pink','blue','clear']
const validTheme=(value:unknown):value is SchoolHybridTheme=>typeof value==='string'&&themes.includes(value as SchoolHybridTheme)
type HybridContext={theme:SchoolHybridTheme;active:boolean;setTheme:(theme:SchoolHybridTheme)=>void}
const Context=createContext<HybridContext|null>(null)
function initialTheme():SchoolHybridTheme{
 try{const value=window.localStorage.getItem(STORAGE_KEY);return validTheme(value)?value:'pink'}catch{return 'pink'}
}
export default function SchoolHybridFrame({children,active}:{children:ReactNode;active:boolean}){
 const [theme,updateTheme]=useState<SchoolHybridTheme>(initialTheme)
 const setTheme=useCallback((next:SchoolHybridTheme)=>{
  if(!validTheme(next))return
  updateTheme(next)
  try{window.localStorage.setItem(STORAGE_KEY,next)}catch{/* Theme controls remain usable when storage is unavailable. */}
 },[])
 return <Context.Provider value={{theme,active,setTheme}}><div className="school-hybrid" data-active={active?'true':'false'} data-school-theme={theme}>{children}</div></Context.Provider>
}
export function useSchoolHybrid(){
 const value=useContext(Context)
 if(!value)throw new Error('SchoolHybridFrame is required')
 return value
}
export function SchoolThemeSwitch({className=''}:{className?:string}){
 const {theme,active,setTheme}=useSchoolHybrid()
 if(!active)return null
 return <div className={'sh-theme-switch '+className} role="group" aria-label="Цветовая тема">{themes.map(value=><button key={value} type="button" aria-pressed={theme===value} onClick={()=>setTheme(value)}><span aria-hidden="true" className={'sh-theme-dot sh-theme-dot--'+value}/>{value==='pink'?'Розовый':value==='blue'?'Синий':'Прозрачный'}</button>)}</div>
}

/** Explicit confirmed UI actions only. Calling this hook never animates a render. */
export function useSchoolHybridMotion(){
 const {active,theme}=useSchoolHybrid(),enabled=useRef(active),animations=useRef(new Set<Animation>()),frame=useRef<number|null>(null)
 enabled.current=active
 const cancel=useCallback(()=>{
  if(frame.current!==null){window.cancelAnimationFrame(frame.current);frame.current=null}
  animations.current.forEach(animation=>animation.cancel());animations.current.clear()
 },[])
 useEffect(()=>{
  cancel()
  const media=typeof window.matchMedia==='function'?window.matchMedia('(prefers-reduced-motion: reduce)'):null
  const change=()=>cancel()
  window.addEventListener('resize',change);media?.addEventListener?.('change',change)
  return()=>{cancel();window.removeEventListener('resize',change);media?.removeEventListener?.('change',change)}
 },[active,theme,cancel])
 const play=useCallback((element:HTMLElement|null,kind:'tab'|'result'|'new')=>{
  cancel()
  if(!enabled.current||!element||typeof window.matchMedia!=='function'||window.matchMedia('(prefers-reduced-motion: reduce)').matches||typeof element.animate!=='function')return
  frame.current=window.requestAnimationFrame(()=>{
   frame.current=null
   if(!enabled.current||!element.isConnected||window.matchMedia('(prefers-reduced-motion: reduce)').matches)return
   const from=kind==='tab'?'translateY(7px)':kind==='new'?'translateY(9px) scale(.985)':'translateY(-5px) scale(.98)'
   const animation=element.animate([{opacity:0,transform:from},{opacity:1,transform:'translateY(0) scale(1)'}],{duration:kind==='result'?240:280,easing:'cubic-bezier(.22,.75,.22,1)'})
   animations.current.add(animation)
   const finish=()=>{animations.current.delete(animation)}
   animation.addEventListener('finish',finish,{once:true});animation.addEventListener('cancel',finish,{once:true})
  })
 },[cancel])
 return play
}
