import sqlite3
import tempfile
import unittest
from pathlib import Path
from urllib.parse import parse_qs

from service.indexer import SCHEMA
from service.server import SearchAPI


class SearchServiceTest(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "search.db"
        conn = sqlite3.connect(self.db_path)
        conn.executescript(SCHEMA)
        self._add_conversation(conn, "old", "Old terminal task", "gpt", "finished", "2026-01-01T10:00:00Z", 1.25)
        self._add_conversation(conn, "mid", "Review deployment", "claude", "finished", "2026-01-02T10:00:00Z", 0.5)
        self._add_conversation(conn, "new", "Newest deployment", "gpt", "running", "2026-01-03T10:00:00Z", 0.0)
        events = [
            ("old", 1, "old-1", "ActionEvent", "agent", "2026-01-01T10:00:00Z", "assistant", "terminal", "inspect logs"),
            ("mid", 1, "mid-1", "MessageEvent", "agent", "2026-01-02T10:00:00Z", "assistant", None, "kubernetes review"),
            ("mid", 2, "mid-2", "ActionEvent", "agent", "2026-01-02T10:01:00Z", "assistant", "browser", "open dashboard"),
            ("new", 1, "new-1", "MessageEvent", "user", "2026-01-03T10:00:00Z", "user", None, "kubernetes deploy"),
            ("new", 2, "new-2", "ActionEvent", "agent", "2026-01-03T10:01:00Z", "assistant", "terminal", "run deploy command"),
        ]
        conn.executemany(
            "INSERT INTO events (conversation_id, seq, event_id, kind, source, timestamp, role, tool_name, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            events,
        )
        conn.commit()
        conn.close()
        self.api = SearchAPI(str(self.db_path))

    def tearDown(self):
        connection = getattr(self.api._local, "conn", None)
        if connection is not None:
            connection.close()
        self.tempdir.cleanup()

    @staticmethod
    def _add_conversation(conn, conversation_id, title, model, status, updated_at, cost):
        conn.execute(
            """INSERT INTO conversations (
                id, title, model, status, created_at, updated_at, workspace_dir,
                tags_json, n_events, n_user_msgs, n_assistant_msgs, n_actions,
                n_observations, prompt_tokens, completion_tokens, cost,
                first_text, last_text, dir_mtime, indexed_at
            ) VALUES (?, ?, ?, ?, ?, ?, '', '{}', 2, 1, 1, 1, 0, 10, 5, ?, '', '', 0, 0)""",
            (conversation_id, title, model, status, updated_at, updated_at, cost),
        )

    def search(self, query=""):
        return self.api.search(parse_qs(query, keep_blank_values=True))

    def test_empty_query_returns_newest_conversation_first(self):
        result = self.search()
        self.assertEqual([row["id"] for row in result["conversations"]], ["new", "mid", "old"])
        self.assertEqual(result["sort"], "updated_at")
        self.assertEqual(result["order"], "desc")

    def test_metadata_filter_works_without_preceding_filters(self):
        result = self.search("status=finished")
        self.assertEqual([row["id"] for row in result["conversations"]], ["mid", "old"])

    def test_event_filters_work_in_browse_mode(self):
        terminal = self.search("tool=terminal")
        self.assertEqual([row["id"] for row in terminal["conversations"]], ["new", "old"])
        user = self.search("role=user")
        self.assertEqual([row["id"] for row in user["conversations"]], ["new"])
        combined = self.search("status=finished&kind=MessageEvent")
        self.assertEqual([row["id"] for row in combined["conversations"]], ["mid"])

    def test_full_text_search_returns_table_metadata(self):
        result = self.search("q=kubernetes")
        self.assertEqual(result["total"], 2)
        self.assertEqual({hit["conversation_id"] for hit in result["hits"]}, {"new", "mid"})
        for hit in result["hits"]:
            self.assertIn("n_events", hit)
            self.assertIn("n_user_msgs", hit)
            self.assertIn("n_assistant_msgs", hit)
            self.assertIn("cost", hit)

    def test_full_text_and_metadata_filters_combine(self):
        result = self.search("q=kubernetes&status=finished&model=claude")
        self.assertEqual(result["total"], 1)
        self.assertEqual(result["hits"][0]["conversation_id"], "mid")

    def test_agent_context_returns_bounded_evidence_windows(self):
        result = self.api.agent_context(parse_qs("q=kubernetes&limit=2&context=1"))
        self.assertEqual(result["returned_matches"], 2)
        self.assertEqual({row["id"] for row in result["conversations"]}, {"new", "mid"})
        newest = next(row for row in result["conversations"] if row["id"] == "new")
        self.assertEqual([event["seq"] for event in newest["events"]], [1, 2])
        self.assertTrue(newest["events"][0]["matched"])
        self.assertEqual(newest["events"][0]["event_id"], "new-1")
        self.assertEqual(newest["matches"][0]["event_id"], "new-1")
        self.assertFalse(newest["events"][1]["matched"])

    def test_agent_context_deduplicates_overlapping_windows(self):
        result = self.api.agent_context(parse_qs("q=deploy&limit=5&context=1"))
        conversation = result["conversations"][0]
        self.assertEqual(len(conversation["matches"]), 2)
        self.assertEqual([event["seq"] for event in conversation["events"]], [1, 2])

    def test_agent_context_requires_text_query(self):
        with self.assertRaisesRegex(ValueError, "q is required"):
            self.api.agent_context({})

    def test_agent_context_caps_event_text(self):
        long_text = "kubernetes " + ("x" * 500)
        self.api.conn.execute("UPDATE events SET text = ? WHERE event_id = 'new-1'", (long_text,))
        self.api.conn.commit()
        result = self.api.agent_context(parse_qs("q=kubernetes&role=user&limit=1&context=0&max_chars=10"))
        event = result["conversations"][0]["events"][0]
        self.assertEqual(result["max_event_chars"], 200)
        self.assertEqual(len(event["text"]), 200)
        self.assertTrue(event["truncated"])


if __name__ == "__main__":
    unittest.main()
