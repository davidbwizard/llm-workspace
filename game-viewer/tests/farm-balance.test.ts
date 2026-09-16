import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createFarm, command, advanceFarm, moveFarmer, validateFarm, getInteractionTarget } from '../farm/model.mjs';
import { createSaveStore, serializeFarm, parseFarm } from '../farm/storage.mjs';
import { guardStats } from '../farm/definitions.mjs';
import { plotPosition, animalPosition } from '../farm/world.mjs';

const edit = (s, group, kind, field, value) => command(s,{type:'balance',group,kind,field,value});
function enemy(s,x=330,y=160) { command(s,{type:'raid'});const m=s.monsters.at(-1);Object.assign(m,{x,y});return m; }

it('exposes independent base stats for every damageable type and leaves other farms untouched',()=>{
  const a=createFarm(),b=createFarm();
  expect(a.balance?.farmer.main).toMatchObject({maxHealth:100,armor:0,power:12});
  expect(Object.keys(a.balance.animals)).toEqual(['cow','sheep']);
  expect(a.balance.plots.land).toEqual({maxHealth:100,armor:0});
  edit(a,'guards','scout','power',40);
  expect(guardStats(a.guards[0],a.balance).power).toBe(40);
  expect(guardStats(b.guards[0],b.balance).power).toBe(7);
});

it('applies max health live by percentage, keeps progression, and does not revive ruined plots',()=>{
  const s=createFarm();s.coins=1000;s.mainHealth=50;s.animals[0].health=25;s.plots[0].health=40;
  s.plots[1].stage='dead';s.plots[1].health=0;const m=enemy(s);m.health=11;
  command(s,{type:'upgradeGuard',guardId:s.guards[0].id});s.guards[0].health=s.guards[0].maxHealth/2;
  edit(s,'farmer','main','maxHealth',200);edit(s,'animals','cow','maxHealth',400);
  edit(s,'plots','land','maxHealth',250);edit(s,'guards','scout','maxHealth',120);edit(s,'monsters','slime','maxHealth',44);
  expect(s.mainHealth).toBe(100);expect(s.animals[0].health).toBe(100);expect(s.plots[0].health).toBe(100);
  expect(s.plots[1].health).toBe(0);expect(s.plots[1].stage).toBe('dead');
  expect(s.guards[0].maxHealth).toBe(150);expect(s.guards[0].health).toBe(75);expect(m.health).toBe(22);
  expect(validateFarm(s)).toBe(true);
});

it('rejects unknown, blank, nonfinite and out-of-bounds edits atomically',()=>{
  for(const [group,kind,field,value] of [['animals','cow','maxHealth',0],['guards','scout','armor',NaN],['monsters','brute','power',Infinity],['farmer','main','interval',.001],['plots','land','power',10],['animals','__proto__','armor',2],['animals','cow','armor',''],['animals','cow','maxHealth',1.5]]){
    const s=createFarm(),before=structuredClone(s);expect(()=>edit(s,group,kind,field,value)).toThrow();expect(s).toEqual(before);
  }
});

it('uses edited damage and defense for both player and protector attacks',()=>{
  const s=createFarm();s.guards=[];s.policy.autoHeal=false;const m=enemy(s);Object.assign(s.farmer,{x:300,y:160});
  edit(s,'farmer','main','power',9);edit(s,'monsters','slime','armor',4);
  command(s,{type:'interact'});expect(m.health).toBe(17);
  edit(s,'monsters','slime','armor',100);advanceFarm(s,1);const before=m.health;
  command(s,{type:'interact'});expect(m.health).toBe(before);
  const b=createFarm();b.policy.autoHeal=false;const target=enemy(b);
  Object.assign(b.guards[0],{x:300,y:160});Object.assign(b.farmer,{x:166,y:105});
  edit(b,'guards','scout','power',10);edit(b,'guards','scout','armor',2);
  advanceFarm(b,.05);expect(target.health).toBe(12);expect(b.guards[0].health).toBe(59);
});

it('uses defense for farmer, livestock and bare plots and repairs ruined owned land',()=>{
  const s=createFarm();s.guards=[];s.policy.autoHeal=false;const m=enemy(s,230,135);
  edit(s,'plots','land','armor',2);advanceFarm(s,.05);expect(s.plots[0].health).toBe(99);
  edit(s,'monsters','slime','power',200);m.cooldown=0;advanceFarm(s,.05);
  expect(s.plots[0].stage).toBe('dead');expect(s.plots[0].unlocked).toBe(true);
  Object.assign(s.farmer,plotPosition(0));
  command(s,{type:'tend',plotId:'p1'});expect(s.plots[0].stage).toBe('empty');expect(s.plots[0].health).toBe(100);
  const a=createFarm();a.guards=[];a.policy.autoHeal=false;const raider=enemy(a,471,155);raider.kind='raider';
  edit(a,'animals','cow','armor',4);advanceFarm(a,.05);expect(a.animals[0].health).toBe(99);
  const f=createFarm();f.guards=[];f.policy.autoHeal=false;enemy(f);Object.assign(f.farmer,{x:300,y:160});
  edit(f,'farmer','main','armor',2);advanceFarm(f,.05);expect(f.mainHealth).toBe(99);
});

it('updates player movement, reach and cooldown without changing collection reach',()=>{
  const s=createFarm();s.guards=[];const m=enemy(s,380,160);Object.assign(s.farmer,{x:300,y:160});
  expect(getInteractionTarget(s)).toBeNull();edit(s,'farmer','main','reach',100);
  expect(getInteractionTarget(s)?.id).toBe(m.id);
  edit(s,'farmer','main','interval',2);command(s,{type:'interact'});expect(s.mainCooldown).toBe(2);
  edit(s,'farmer','main','interval',.1);expect(s.mainCooldown).toBe(.1);
  edit(s,'farmer','main','speed',40);Object.assign(s.farmer,{x:300,y:310});moveFarmer(s,1,0,.5);expect(s.farmer.x).toBe(320);
});

it('new entities, healing and new farms use the edited caps; reset retains health percentage',()=>{
  const s=createFarm();s.coins=1000;Object.assign(s.farmer,animalPosition(0));
  edit(s,'animals','cow','maxHealth',20);command(s,{type:'buy',item:'cow'});expect(s.animals.at(-1).health).toBe(20);
  s.animals[0].health=10;command(s,{type:'heal',targetId:s.animals[0].id});expect(s.animals[0].health).toBe(20);
  edit(s,'farmer','main','maxHealth',10);s.mainHealth=5;command(s,{type:'buy',item:'medicine'});command(s,{type:'heal',targetId:'main'});expect(s.mainHealth).toBe(10);
  expect(moveFarmer(s,1,0,.1)).toBe(true);
  edit(s,'monsters','slime','maxHealth',80);expect(enemy(s).maxHealth).toBe(80);
  const fresh=createFarm(s.balance);expect(fresh.mainHealth).toBe(10);expect(fresh.animals[0].health).toBe(20);
  s.mainHealth=5;command(s,{type:'resetBalance'});expect(s.mainHealth).toBe(50);expect(s.balance.monsters.slime.maxHealth).toBe(22);
  expect(fresh.balance.farmer.main.maxHealth).toBe(10);
});

it('persists config through local storage and upgrades older saves with defaults',()=>{
  const data=new Map(),store=createSaveStore({getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)});
  const s=createFarm();edit(s,'plots','land','armor',12);edit(s,'animals','sheep','maxHealth',350);store.save(s);
  const restored=store.load().state;expect(restored.balance.plots.land.armor).toBe(12);expect(restored.animals[1].health).toBe(350);
  expect(parseFarm(serializeFarm(restored))).toEqual(restored);
  const old=parseFarm(readFileSync(new URL('./fixtures/farm-v2.json',import.meta.url),'utf8'));
  expect(old.version).toBe(3);expect(old.coins).toBe(217);expect(old.mainHealth).toBe(50);expect(old.animals[0].health).toBe(20);
  expect(old.balance.plots.land.maxHealth).toBe(100);expect(validateFarm(old)).toBe(true);
  const bad=JSON.parse(serializeFarm(restored));bad.farm.balance.monsters.slime.armor=-1;expect(()=>parseFarm(JSON.stringify(bad))).toThrow();
});
