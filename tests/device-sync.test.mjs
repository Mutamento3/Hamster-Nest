import test from 'node:test'
import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { parseSample, sampleRow, storeSamples, readDeviceSnapshot } from '../supabase/functions/_shared/device-sync.ts'
const owner='11111111-1111-4111-8111-111111111111', other='22222222-2222-4222-8222-222222222222'
const now=Date.parse('2026-10-14T12:00:00Z')
const sample=(kind='battery',offset=0,value={level:0,charging:false})=>({version:1,id:crypto.randomUUID(),owner,kind,observedAt:new Date(now+offset).toISOString(),deviceName:'test',value})
async function setup(){
 const db=new PGlite()
 await db.exec(`create table device_status(id uuid primary key,user_id uuid not null,source_app text,device_name text,created_at timestamptz default now(),battery_level integer,is_charging boolean,latitude double precision,longitude double precision,weather text,steps integer,step_count integer,raw_data jsonb default '{}');`)
 const from=()=>{
  const filters=[],orders=[];let row=null,count=100
  const api={select(){return api},eq(k,v){filters.push([k,'=',v]);return api},not(k,_op,v){filters.push([k,'is not',v]);return api},in(k,v){filters.push([k,'in',v]);return api},order(k,{ascending}){orders.push(`${k} ${ascending?'asc':'desc'}`);return api},limit(n){count=n;return api},insert(v){row=v;return api},then(resolve,reject){
   const run=async()=>{try{
    if(row){const cols=Object.keys(row);await db.query(`insert into device_status(${cols.join(',')}) values(${cols.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(row));return {data:null,error:null}}
    const params=[];const conditions=filters.map(([column,op,v])=>{const k=column.replace('raw_data->>trigger',"raw_data->>'trigger'").replace('raw_data->sample->>kind',"raw_data->'sample'->>'kind'");if(op==='is not')return `${k} is not null`;if(op==='in'){const list=v.map(x=>{params.push(x);return '$'+params.length});return `${k} in (${list.join(',')})`;}params.push(v);return `${k}=$${params.length}`;});
    const result=await db.query(`select * from device_status where ${conditions.join(' and ') || 'true'} ${orders.length?'order by '+orders.join(','):''} limit ${count}`,params)
    // Match REST timestamp serialization.
    return {data:result.rows.map(r=>({...r,created_at:new Date(r.created_at).toISOString()})),error:null}
   }catch(error){return {data:null,error}}};return run().then(resolve,reject)
  }};return api
 }
 return {db,client:{from}}
}
test('stable UUID replays return one receipt and one fact; different payload conflicts',async()=>{
 const {db,client}=await setup();try{const s=sample();const first=await storeSamples(client,owner,[s],now);assert.deepEqual(await storeSamples(client,owner,[s],now+1000),first);assert.equal((await db.query('select count(*) n from device_status')).rows[0].n,1);await assert.rejects(storeSamples(client,owner,[{...s,value:{level:80,charging:false}}],now),/conflict/);}finally{await db.close()}
})
test('bad owner, fields, future timestamps, mixed invalid batch rejected before writing',async()=>{
 const {db,client}=await setup();try{for(const invalid of [{...sample(),owner:other},sample('battery',300001),sample('location',0,{latitude:1,longitude:2,coordinateSystem:'GCJ02',accuracy:1}),sample('battery',0,{level:-1,charging:false}),sample('home_event',0,{regionId:'office',direction:'enter'})])await assert.rejects(storeSamples(client,owner,[sample(),invalid],now));assert.equal((await db.query('select count(*) n from device_status')).rows[0].n,0)}finally{await db.close()}
})
test('out of order uploads do not replace newer facts; null fields and legacy weather/steps survive',async()=>{
 const {db,client}=await setup();try{
 const later=sample('battery',0,{level:50,charging:false}),older=sample('battery',-600000,{level:10,charging:true});await storeSamples(client,owner,[later],now);await storeSamples(client,owner,[older],now+5000);
 await db.query("insert into device_status(id,user_id,created_at,weather,steps,latitude,longitude) values($1,$2,$3,'晴 20度',0,30,104)",[crypto.randomUUID(),owner,new Date(now-3600000)]);
 await storeSamples(client,owner,[sample('battery',1000,{level:null,charging:true})],now+2000);
 const value=await readDeviceSnapshot(client,owner,now+3000);assert.equal(value.fields.battery.value,50);assert.equal(value.fields.charging.value,true);assert.equal(value.fields.weather.value.text,'晴 20度');assert.equal(value.fields.steps.value,0);assert.equal(value.fields.location.timeBasis,'received');assert.equal(value.fields.home_event,null);
 const foreign=await readDeviceSnapshot(client,other,now);assert.ok(Object.values(foreign.fields).every(v=>v===null));
 }finally{await db.close()}
})
test('events retain original occurrence and receipt times; latest weather cannot erase location or battery',async()=>{
 const {db,client}=await setup();try{
 const event=sample('home_event',-300000,{regionId:'home',direction:'enter'});await storeSamples(client,owner,[event,sample()],now);
 const loc=sample('location',-1000,{latitude:30.1,longitude:104.1,coordinateSystem:'WGS84',accuracy:25});await storeSamples(client,owner,[loc],now);
 const v=await readDeviceSnapshot(client,owner,now);assert.equal(v.fields.home_event.observedAt,event.observedAt);assert.equal(v.fields.home_event.receivedAt,new Date(now).toISOString());assert.equal(v.fields.location.value.coordinateSystem,'WGS84');assert.equal(v.fields.battery.value,0);assert.equal(v.fields.charging.value,false);
 assert.equal(sampleRow(event,new Date(now).toISOString()).raw_data.trigger,'geofence_enter');
 }finally{await db.close()}
})
test('weather contract bounds attribution URLs and preserves observation and expiry provenance',()=>{
 const value={status:'ready',provider:'apple-weather',fetchedAt:new Date(now).toISOString(),observedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+900000).toISOString(),temperature:0,feelsLike:-1,condition:'clear',symbol:'sun.max',isDaylight:true,humidity:0.5,windKph:0,high:1,low:-1,rainChance:0,latitude:30.66,longitude:104.07,place:'测试城市',attribution:{lightMark:'https://weatherkit.apple.com/a.svg',darkMark:'https://weatherkit.apple.com/b.svg',legalURL:'https://weatherkit.apple.com/legal',legalText:'Apple Weather'}}
 const s=sample('weather',-1000,value);assert.equal(parseSample(s,owner,now),s);assert.throws(()=>parseSample({...s,value:{...value,attribution:{...value.attribution,legalURL:'https://evil.test'}}},owner,now));
})

test('endpoint verifies identity before reads or writes and rejects missing, foreign, expired auth and bad origins',async()=>{
 const {deviceSyncHandler}=await import('../supabase/functions/device-sync/handler.ts')
 const {db,client}=await setup();try{
 let identity={ok:true,userId:owner};let checks=0;
 const handler=deviceSyncHandler({owner,client,allowedOrigin:o=>o==='https://app.test',verify:async()=>{checks++;return identity}})
 const request=(body,headers={})=>new Request('https://edge.test',{method:'POST',headers:{authorization:'Bearer test',apikey:'public','content-type':'application/json',...headers},body:JSON.stringify(body)})
 assert.equal((await handler(new Request('https://edge.test',{method:'POST'}))).status,401);assert.equal(checks,0)
 assert.equal((await handler(request({action:'read',owner},{origin:'https://evil.test'}))).status,403);assert.equal(checks,0)
 identity={ok:true,userId:other};assert.equal((await handler(request({action:'read',owner}))).status,403)
 identity={ok:false,status:401,error:'expired'};assert.equal((await handler(request({action:'upload',owner,samples:[sample()]}))).status,401)
 identity={ok:true,userId:owner};assert.equal((await handler(request({action:'read',owner:other}))).status,400)
 const s=sample();assert.equal((await handler(request({action:'upload',owner,samples:[s]}))).status,200)
 const response=await handler(request({action:'read',owner}));assert.equal(response.status,200);assert.equal((await response.json()).fields.battery.value,0)
 assert.equal((await handler(request({action:'upload',owner,samples:[{...s,value:{level:70,charging:false}}]}))).status,409)
 }finally{await db.close()}
})

test('place initial observations never masquerade as home arrivals; history stays owner scoped and ordered',async()=>{
 const {db,client}=await setup();try{
 const value={placeId:'home',placeName:'家',configVersion:1,direction:'enter',phase:'initial'};
 const initial=sample('place_event',-2000,value); await storeSamples(client,owner,[initial],now);
 assert.equal(sampleRow(initial,new Date(now).toISOString()).raw_data.trigger,undefined);
 let result=await readDeviceSnapshot(client,owner,now);assert.equal(result.fields.home_event,null);assert.equal(result.placeEvents[0].value.phase,'initial');
 const transition=sample('place_event',-1000,{...value,direction:'exit',phase:'transition'});await storeSamples(client,owner,[transition],now);
 result=await readDeviceSnapshot(client,owner,now);assert.equal(result.fields.home_event.value,'exit');assert.equal(result.placeEvents.length,2);
 assert.equal(result.placeEvents[0].value.configVersion,1);assert.equal((await readDeviceSnapshot(client,other,now)).placeEvents.length,0);
 await assert.rejects(storeSamples(client,owner,[sample('place_event',0,{...value,configVersion:0})],now),/invalid/);
 await assert.rejects(storeSamples(client,owner,[sample('place_event',0,{...value,latitude:1})],now),/invalid/);
 }finally{await db.close()}
});

test('place history is bounded to fifty and ignores malformed raw records',async()=>{
 const {db,client}=await setup();try{
 for(let i=0;i<55;i++)await storeSamples(client,owner,[sample('place_event',-i*1000,{placeId:'home',placeName:'家',configVersion:1,direction:'enter',phase:'observation'})],now);
 const result=await readDeviceSnapshot(client,owner,now);assert.equal(result.placeEvents.length,50);assert.equal(result.fields.home_event,null);
 assert.equal(result.placeEvents[0].observedAt,new Date(now).toISOString());
 await db.query("insert into device_status(id,user_id,source_app,created_at,raw_data) values($1,$2,'expo_app',$3,$4)",[crypto.randomUUID(),owner,new Date(now+1000),{sample:{kind:'place_event'}}]);
 const after=await readDeviceSnapshot(client,owner,now+1000);assert.equal(after.placeEvents.length,49);
 }finally{await db.close()}
});
