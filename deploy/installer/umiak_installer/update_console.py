"""Fixed host-originated database operations over the existing pct console.

The control plane returns data, never host commands, executable paths or URLs.
Compatible with older quickstart images: the host supplies the JS source.
"""
import json

from . import stack
from .ct import run_in

SCRIPT = r"""
import pg from '/app/packages/db/node_modules/pg/lib/index.js';
const input=JSON.parse(await new Promise(resolve=>{
 let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>resolve(s));
}));
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
const c=await pool.connect();
try {
 await c.query('BEGIN');
 await c.query("SELECT pg_advisory_xact_lock(hashtextextended('umiak-quickstart:setup',0))");
 await c.query(`CREATE TABLE IF NOT EXISTS quickstart.updates(
  id boolean PRIMARY KEY DEFAULT true CHECK(id), settings jsonb NOT NULL,
  status jsonb NOT NULL DEFAULT '{}', history jsonb NOT NULL DEFAULT '[]')`);
 await c.query('INSERT INTO quickstart.updates(id,settings) VALUES(true,$1) ON CONFLICT DO NOTHING',
  [JSON.stringify(input.defaults)]);
 let row=(await c.query('SELECT * FROM quickstart.updates WHERE id=true')).rows[0];
 if(input.op==='fence') {
  let state=(await c.query('SELECT state FROM quickstart.setup WHERE id=true FOR UPDATE')).rows[0].state;
  if(state.buildQueue?.active || state.buildJob?.status==='running') throw Error('A template build is running; skipping update');
  state.platformMaintenance={startedAt:new Date().toISOString(),message:'Updating Umiak…'};
  await c.query('UPDATE quickstart.setup SET state=$1 WHERE id=true',[JSON.stringify(state)]);
 }
 if(input.op==='unfence') {
  await c.query("UPDATE quickstart.setup SET state=state-'platformMaintenance' WHERE id=true");
  await c.query(`UPDATE quickstart.setup SET state=jsonb_set(state,'{platform}',
   COALESCE(state->'platform','{}') || $1::jsonb) WHERE id=true`,
   [JSON.stringify({channel:row.settings.channel})]);
 }
 if(input.settings) {
  await c.query(`UPDATE quickstart.setup SET state=jsonb_set(state,'{platform}',
   COALESCE(state->'platform','{}') || $1::jsonb) WHERE id=true`,
   [JSON.stringify({channel:input.settings.channel})]);
  await c.query('UPDATE quickstart.updates SET settings=$1 WHERE id=true',[JSON.stringify(input.settings)]);
  row.settings=input.settings;
 }
 if(input.status) await c.query('UPDATE quickstart.updates SET status=$1 WHERE id=true',[JSON.stringify(input.status)]);
 if(input.record) {
  const history=[input.record,...row.history].slice(0,100);
  await c.query('UPDATE quickstart.updates SET history=$1 WHERE id=true',[JSON.stringify(history)]);
 }
 await c.query('COMMIT');console.log(JSON.stringify(row));
} catch(e) {await c.query('ROLLBACK');console.error(e.message);process.exitCode=1;}
finally {c.release();await pool.end();}
"""


class Console:
    def __init__(self, runner, current):
        self.runner, self.current = runner, current

    def call(self, op="read", **data):
        defaults = {"channel": self.current.channel, "auto": self.current.auto_update,
                    "paused": False, "start": "03:00", "end": "04:00"}
        command = stack.compose("exec", "-T", "quickstart", "node", "deploy/compose/quickstart/run.mjs",
                                "node", "--input-type=module", "-e", SCRIPT)
        return json.loads(run_in(self.runner, self.current.ct_id, *command,
                                 input=json.dumps(dict(data, op=op, defaults=defaults))))
