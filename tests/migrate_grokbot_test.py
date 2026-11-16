"""Run with python3 -m unittest discover -s tests -p '*_test.py'."""
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/migrate-grokbot.py'


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / 'old.db'
        self.destination = self.root / 'new.db'
        self.engines = self.root / 'engines'
        self.db = sqlite3.connect(self.source)
        self.addCleanup(self.db.close)
        self.db.executescript('''
          PRAGMA journal_mode=WAL;
          CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT);
          CREATE TABLE bots(id TEXT PRIMARY KEY,user_id TEXT,name TEXT,instructions TEXT,
            model TEXT,generation INTEGER,next_seq INTEGER,rev INTEGER,engine TEXT,provider TEXT,
            engine_port INTEGER,handback_at INTEGER);
          CREATE TABLE memories(id TEXT,bot_id TEXT,text TEXT,created_at INTEGER,
            status TEXT,kind TEXT,expires_at INTEGER,source TEXT);
          CREATE TABLE composio_sessions(user_id TEXT,session_id TEXT);
          CREATE TABLE rows(bot_id TEXT,generation INTEGER,seq INTEGER,kind TEXT,body TEXT);
          CREATE TABLE tasks(id TEXT,bot_id TEXT,title TEXT,state TEXT,note TEXT);
          CREATE TABLE routines(id TEXT,enabled INTEGER);
          CREATE TABLE auth_sessions(token TEXT);
          CREATE TABLE login_attempts(id TEXT);
          CREATE TABLE pending_turns(bot_id TEXT);
          CREATE TABLE screens(bot_id TEXT);
          CREATE TABLE computers(user_id TEXT);
          INSERT INTO users VALUES('usr_owner','owner@example.test');
          INSERT INTO bots VALUES('bot_alpha','usr_owner','Alpha','Keep instructions.','gpt-6-luna',3,9,12,'primary','old',8642,44);
          INSERT INTO composio_sessions VALUES('usr_owner','router-existing');
          INSERT INTO auth_sessions VALUES('old-cookie');
          INSERT INTO login_attempts VALUES('old-login');
          INSERT INTO pending_turns VALUES('bot_alpha');
          INSERT INTO screens VALUES('bot_alpha');
          INSERT INTO computers VALUES('usr_owner');
          INSERT INTO routines VALUES('routine_existing',0);
          INSERT INTO tasks VALUES('task_open','bot_alpha','Finish report','working','Awaiting research');
          INSERT INTO rows VALUES('bot_alpha',3,8,'message','{"role":"user","text":"Continue the report"}');
        ''')
        now = int(time.time() * 1000)
        self.db.executemany('INSERT INTO memories VALUES(?,?,?,?,?,?,?,?)', [
            ('good','bot_alpha','Keep this durable fact',1,'active','durable',None,'chat'),
            ('forgot','bot_alpha','Forgotten fact',2,'forgotten','durable',None,'chat'),
            ('old','bot_alpha','Superseded fact',3,'superseded','durable',None,'learned'),
            ('expired','bot_alpha','Expired fact',4,'active','durable',now-1000,'chat'),
            ('temp','bot_alpha','Temporary observation',5,'active','observation',now+86400000,'chat'),
        ])
        self.db.commit()

    def run_migration(self, *args):
        return subprocess.run([sys.executable, str(SCRIPT), '--source', str(self.source),
            '--destination', str(self.destination), '--engines-dir', str(self.engines), *args],
            capture_output=True, text=True)

    def test_preserves_identity_committed_wal_and_archived_history(self):
        result = self.run_migration()
        self.assertEqual(result.returncode, 0, result.stderr)
        with sqlite3.connect(self.destination) as target:
            self.assertEqual(target.execute('SELECT * FROM users').fetchall(), [('usr_owner','owner@example.test')])
            self.assertEqual(target.execute('SELECT * FROM composio_sessions').fetchall(), [('usr_owner','router-existing')])
            self.assertEqual(target.execute('SELECT instructions,model,generation,next_seq,rev,engine,provider,engine_port,handback_at FROM bots').fetchone(),
                ('Keep instructions.','gpt-6-luna',4,1,0,None,None,None,None))
            self.assertEqual(target.execute('SELECT count(*) FROM rows').fetchone(), (1,))
            self.assertEqual(target.execute('SELECT enabled FROM routines').fetchone(), (0,))

    def test_source_files_and_runtime_records_are_unchanged(self):
        before = self.source.read_bytes(), Path(str(self.source)+'-wal').read_bytes()
        result = self.run_migration()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.source.read_bytes(), Path(str(self.source)+'-wal').read_bytes()), before)
        self.assertEqual(self.db.execute('SELECT token FROM auth_sessions').fetchone(), ('old-cookie',))
        with sqlite3.connect(self.destination) as target:
            self.assertEqual([target.execute('SELECT count(*) FROM '+name).fetchone()[0] for name in
                ('auth_sessions','login_attempts','pending_turns','screens','computers')], [0,0,0,0,0])

    def test_exports_only_active_unexpired_durable_facts(self):
        result = self.run_migration()
        self.assertEqual(result.returncode, 0, result.stderr)
        home = self.engines / 'bot_alpha'
        self.assertEqual((home/'memories/MEMORY.md').read_text(), 'Keep this durable fact\n')
        handoff = (home/'MIGRATION-HANDOFF.md').read_text()
        self.assertIn('Keep this durable fact', handoff)
        self.assertIn('Finish report', handoff)
        self.assertIn('Continue the report', handoff)
        self.assertNotIn('Forgotten fact', handoff)
        self.assertNotIn('Superseded fact', handoff)
        self.assertNotIn('Expired fact', handoff)
        self.assertNotIn('Temporary observation', handoff)
        self.assertEqual((home/'memories/MEMORY.md').stat().st_mode & 0o777, 0o600)
        self.assertEqual(home.stat().st_mode & 0o777, 0o700)

    def test_refuses_existing_destination_without_touching_it(self):
        self.destination.write_text('keep')
        result = self.run_migration()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('exists', result.stderr)
        self.assertEqual(self.destination.read_text(), 'keep')
        self.assertFalse(self.engines.exists())

    def test_refuses_memory_over_budget_without_publishing_outputs(self):
        result = self.run_migration('--memory-char-limit','10')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('budget', result.stderr)
        self.assertFalse(self.destination.exists())
        self.assertFalse(self.engines.exists())

    def test_refuses_unsafe_bot_id_before_writing_outside_engines(self):
        self.db.execute("UPDATE bots SET id='../escape'")
        self.db.commit()
        result = self.run_migration()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('bot ID', result.stderr)
        self.assertFalse((self.root/'escape').exists())
        self.assertFalse(self.destination.exists())

    def test_accepts_legacy_bots_without_engine_columns(self):
        self.db.executescript('''
          ALTER TABLE bots DROP COLUMN engine;
          ALTER TABLE bots DROP COLUMN provider;
          ALTER TABLE bots DROP COLUMN engine_port;
          ALTER TABLE bots DROP COLUMN handback_at;
        ''')
        result = self.run_migration()
        self.assertEqual(result.returncode, 0, result.stderr)
        with sqlite3.connect(self.destination) as target:
            self.assertEqual(target.execute('SELECT id,model,generation FROM bots').fetchone(), ('bot_alpha','gpt-6-luna',4))

    def test_imported_working_tasks_require_confirmation(self):
        result = self.run_migration()
        self.assertEqual(result.returncode, 0, result.stderr)
        with sqlite3.connect(self.destination) as target:
            self.assertEqual(target.execute('SELECT state,note FROM tasks').fetchone(),
                ('needs_input','Imported from Grokbot; confirm whether this is still active. Awaiting research'))

    def test_refuses_existing_engine_homes(self):
        self.engines.mkdir()
        marker = self.engines / 'keep.txt'
        marker.write_text('keep')
        result = self.run_migration()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('exists', result.stderr)
        self.assertEqual(marker.read_text(), 'keep')
        self.assertFalse(self.destination.exists())


if __name__ == '__main__':
    unittest.main()
