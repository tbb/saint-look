import test from 'node:test';
import assert from 'node:assert/strict';
import {structureAnswer,structureModel} from '../src/illustration-structure.mjs';
const value={sleeve_count:2,folded_sleeves:false,duplicated_parts:false,raised_hood:false,confidence:.99,evidence:'Two cuffs beside the torso.'};
const answer=(change={})=>({id:'v1_inspection',model:structureModel,status:'completed',steps:[{type:'model_output',content:[{type:'text',text:JSON.stringify({...value,...change})}]}]});
test('four connected sleeves are a concrete defect even when outer geometry passes',()=>{
 const result=structureAnswer(answer({sleeve_count:4,duplicated_parts:true,folded_sleeves:true,evidence:'Two cuffs on torso and two outer cuffs.'}));
 assert.equal(result.valid,false);assert.deepEqual(result.defects,['duplicated_parts','folded_sleeves']);
});
test('uncertain structure alone never establishes a defect',()=>{
 assert.equal(structureAnswer(answer({sleeve_count:4,duplicated_parts:true,confidence:.4})).valid,true);
 assert.equal(structureAnswer(answer()).valid,true);
 assert.equal(structureAnswer(answer({sleeve_count:0})).valid,true,'Trousers have no sleeves');
});
test('malformed or incomplete inspection is never treated as a successful check',()=>{
 for(const payload of [{...answer(),status:'in_progress'},{...answer(),model:'other'},{...answer(),id:null},answer({confidence:2}),answer({sleeve_count:'2'}),answer({raised_hood:null})])assert.throws(()=>structureAnswer(payload));
});
