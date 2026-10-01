import assert from 'node:assert/strict';
import test from 'node:test';
import {vaultSetup,vaultDrawRequest} from './vault-query.ts';
import {DEFAULT_GLOBAL_FILTERS} from '../../global-filters.ts';
import {InvalidPageQueryError} from '../repositories/page-errors.ts';
test('Vault request is bounded, owner-free and does not accept caller-selected winners or counts',()=>{
  const setup={session:null,mood:null,goal:null,collectionId:null,genres:[],globalFilters:DEFAULT_GLOBAL_FILTERS,deferredIds:[]};
  const draw={...setup,requestKey:'11111111-1111-4111-8111-111111111111',quick:true,arm:'control',previousId:null,cycleIds:[],excludeIds:[]};
  assert.deepEqual(vaultSetup(setup),setup);assert.equal(vaultDrawRequest(draw).quick,true);
  for(const value of [{...draw,account_id:2},{...draw,winnerId:'5'},{...draw,eligiblePoolCount:5},{...draw,quick:false},
    {...draw,cycleIds:Array(10001).fill('5')},{...draw,excludeIds:['0']},{...draw,genres:['a','b','c','d']},
    {...draw,globalFilters:{...DEFAULT_GLOBAL_FILTERS,account_id:2}},
    {...draw,collectionId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',session:'short'},
  ])assert.throws(()=>vaultDrawRequest(value),InvalidPageQueryError);
});
