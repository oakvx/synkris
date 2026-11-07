import test from 'node:test';
import assert from 'node:assert/strict';
import {updatePrivacyRequest,pruneOldChatMessages,deleteChatData} from '../src/services/salon-operations.js';
test('privacy case can only close after operator command and without deleting bookings',async()=>{
  const queries=[];
  const db={async query(sql,args){queries.push({sql,args});return {rowCount:1};}};
  assert.deepEqual(await updatePrivacyRequest(db,9,'in_progress'),{ok:true});
  assert.deepEqual(await updatePrivacyRequest(db,9,'closed'),{ok:true});
  assert.deepEqual(queries[1].args,[9,'closed']);
  assert.match(queries[1].sql,/privacy_requests/);
  assert.doesNotMatch(queries[1].sql,/DELETE FROM .*appointments/);
  await assert.rejects(updatePrivacyRequest(db,9,'closed_now'),TypeError);
});
test('chat retention only affects old chat messages and has strict bounds',async()=>{
  const queries=[];const db={async query(sql,args){queries.push({sql,args});return {rowCount:3};}};
  assert.deepEqual(await pruneOldChatMessages(db,90),{deleted:3});
  assert.match(queries[0].sql,/DELETE FROM public.chat_messages/);
  assert.match(queries[0].sql,/LIMIT 1000/);
  assert.deepEqual(queries[0].args,[90]);
  await assert.rejects(pruneOldChatMessages(db,0),TypeError);
  await assert.rejects(pruneOldChatMessages(db,731),TypeError);
});
test('local erasure request records HMAC and deletes chat atomically',async()=>{
  const previous=process.env.ADMIN_TOKEN;process.env.ADMIN_TOKEN='x'.repeat(64);
  const calls=[];
  const client={async query(sql,args){calls.push({sql,args});return sql.includes('SELECT client_id')?{rows:[{client_id:3}]}:{rowCount:1};},release(){calls.push({sql:'RELEASE'});}};
  try{await deleteChatData({connect:async()=>client},'393331234567@c.us');}
  finally{if(previous===undefined)delete process.env.ADMIN_TOKEN;else process.env.ADMIN_TOKEN=previous;}
  const priv=calls.find(c=>c.sql.includes('INSERT INTO public.privacy_requests'));
  assert.equal(priv.args[0],3);
  assert.match(priv.args[1],/^[a-f0-9]{64}$/);
  assert.ok(!priv.args.includes('393331234567@c.us'));
  assert.ok(calls.some(c=>c.sql==='COMMIT'));
});
