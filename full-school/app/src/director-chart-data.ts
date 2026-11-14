/** Deterministic presentation of counted records, never capacity or norms. */
export type ChartMetric='lessonCount'|'scheduledMinutes'
export type LoadRow={name:string;lessonCount:number;scheduledMinutes:number}
export type DayLoad={day:number;lessonCount:number;scheduledMinutes:number}
export type DailyLoad=DayLoad&{name:string}
export type CatalogSort='name'|'lessonCount'|'scheduledMinutes'
export function ratioPercent(value:number,total:number):number|null{
 if(!Number.isSafeInteger(value)||!Number.isSafeInteger(total)||value<0||total<0||value>total)throw new RangeError('Invalid counted proportion')
 if(total===0)return null
 const numerator=BigInt(value)*10000n,denominator=BigInt(total)
 return Number((numerator*2n+denominator)/(denominator*2n))/100
}
export function selectedDays(rows:DayLoad[],day:number|null):DayLoad[]{
 const values=new Map(rows.map(r=>[r.day,r]))
 return(day===null?[0,1,2,3,4,5]:[day]).map(d=>values.get(d)??{day:d,lessonCount:0,scheduledMinutes:0})
}
export function catalogPage(rows:LoadRow[],search:string,sort:CatalogSort,page:number,size=12){
 const query=search.trim().toLocaleLowerCase('ru'),filtered=rows.filter(r=>r.name.toLocaleLowerCase('ru').includes(query))
 filtered.sort((a,b)=>sort==='name'?a.name.localeCompare(b.name,'ru'):b[sort]-a[sort]||a.name.localeCompare(b.name,'ru'))
 const pages=Math.max(1,Math.ceil(filtered.length/size)),current=Math.min(Math.max(1,page),pages)
 return{rows:filtered.slice((current-1)*size,current*size),page:current,pages,total:filtered.length,start:filtered.length?(current-1)*size+1:0,end:Math.min(current*size,filtered.length)}
}
export function participationTotal(rows:LoadRow[],metric:ChartMetric){return rows.reduce((n,r)=>n+r[metric],0)}
export function csvCell(value:string|number|null){
 const text=value==null?'':typeof value==='string'&&/^[\s\u0000-\u0020]*[=+@-]/u.test(value)?"'"+value:String(value)
 return'"'+text.replace(/"/g,'""')+'"'
}
