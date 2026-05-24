"""Tests for prompts/loader.py and nodes/base.py prompt loading."""

from __future__ import annotations

import sys
import os
import unittest
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from prompts.loader import load_raw_prompt, load_prompt_template
from nodes.base import load_agent_prompt


class TestLoadRawPrompt(unittest.TestCase):
    """Tests for prompts/loader.py raw loading."""

    def setUp(self) -> None:
        self._tmpdir = tempfile.mkdtemp()
        self._file = os.path.join(self._tmpdir, "my_prompt.md")
        with open(self._file, "w", encoding="utf-8") as fh:
            fh.write("Hello, {name}!")

    def test_loads_existing_file(self) -> None:
        result = load_raw_prompt("my_prompt.md", self._tmpdir)
        self.assertEqual(result, "Hello, {name}!")

    def test_returns_empty_on_missing(self) -> None:
        result = load_raw_prompt("nonexistent.md", self._tmpdir)
        self.assertEqual(result, "")

    def test_path_traversal_returns_empty(self) -> None:
        """Prompt filename escaping base dir must return empty string."""
        import warnings

        with warnings.catch_warnings(record=True):
            warnings.simplefilter("always")
            result = load_raw_prompt("../outside.md", self._tmpdir)
        self.assertEqual(result, "")


class TestLoadPromptTemplate(unittest.TestCase):
    """Tests for load_prompt_template with optional LangChain."""

    def setUp(self) -> None:
        self._tmpdir = tempfile.mkdtemp()
        self._file = os.path.join(self._tmpdir, "tmpl.md")
        with open(self._file, "w", encoding="utf-8") as fh:
            fh.write("Do {task} for me.")

    def test_returns_none_or_template(self) -> None:
        result = load_prompt_template("tmpl.md", self._tmpdir, ["task"])
        # Either a LangChain PromptTemplate or None (when not installed)
        self.assertTrue(result is None or hasattr(result, "format"))

    def test_missing_file_returns_none(self) -> None:
        result = load_prompt_template("missing.md", self._tmpdir)
        self.assertIsNone(result)


class TestLoadAgentPrompt(unittest.TestCase):
    """Tests for nodes/base.py frontmatter stripping."""

    def setUp(self) -> None:
        self._tmpdir = tempfile.mkdtemp()

    def _write_agent(self, filename: str, content: str) -> None:
        with open(os.path.join(self._tmpdir, filename), "w", encoding="utf-8") as fh:
            fh.write(content)

    def test_strips_frontmatter(self) -> None:
        self._write_agent(
            "agent.md",
            "---\nname: Test Agent\nmodel: gpt-4\n---\n\nYou are helpful.",
        )
        result = load_agent_prompt("agent.md", self._tmpdir)
        self.assertEqual(result, "You are helpful.")
        self.assertNotIn("---", result)
        self.assertNotIn("name:", result)

    def test_no_frontmatter_returned_as_is(self) -> None:
        self._write_agent("plain.md", "Just a plain prompt.")
        result = load_agent_prompt("plain.md", self._tmpdir)
        self.assertEqual(result, "Just a plain prompt.")

    def test_missing_file_returns_empty(self) -> None:
        result = load_agent_prompt("missing.md", self._tmpdir)
        self.assertEqual(result, "")

    def test_agent_path_traversal_returns_empty(self) -> None:
        """Agent filename escaping base dir must return empty string without reading external files."""
        import warnings

        with warnings.catch_warnings(record=True):
            warnings.simplefilter("always")
            result = load_agent_prompt("../outside.agent.md", self._tmpdir)
        self.assertEqual(result, "")


if __name__ == "__main__":
    unittest.main()
