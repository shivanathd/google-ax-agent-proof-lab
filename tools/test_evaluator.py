#!/usr/bin/env python3
"""Test the evaluator itself using temporary synthetic observation bundles."""
import copy
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
path = ROOT / "docs/spec/active/2026-10-28-agent-proof-lab/evals/evaluate.py"
spec = importlib.util.spec_from_file_location("evaluator", path)
evaluator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evaluator)


class EvaluatorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        (self.directory / "capture.json").write_text('{"synthetic_test":true}\n')
        self.bundle = {
            "schema_version": 1, "case_id": "F2-A2", "profile": "local", "mode": "scripted",
            "execution": "EXECUTED", "run_id": "test-run", "candidate_revision": "test-revision",
            "fixture_sha256": "fixture-hash", "collector": "unit-fixture", "observed_at": "2026-10-28T00:00:00Z",
            "evidence": [{"path": "capture.json",
                          "sha256": hashlib.sha256((self.directory / "capture.json").read_bytes()).hexdigest(),
                          "source": "unit fixture, not integration evidence"}],
            "observations": copy.deepcopy(evaluator.CASES["F2-A2"]["expected"])
        }

    def tearDown(self):
        self.temp.cleanup()

    def status(self):
        return evaluator.inspect_bundle(self.bundle, "F2-A2", self.directory)[0]

    def test_consistent_fixture(self):
        self.assertEqual(self.status(), "PASS")

    def test_missing_fact_not_zero(self):
        del self.bundle["observations"]["additional_business_records"]
        self.assertEqual(self.status(), "FAIL")

    def test_boolean_not_integer(self):
        self.bundle["observations"]["additional_business_records"] = False
        self.assertEqual(self.status(), "FAIL")

    def test_forged_success_not_accepted(self):
        self.bundle["observations"]["additional_business_records"] = 2
        self.bundle["status"] = "PASS"
        self.assertEqual(self.status(), "FAIL")

    def test_tampered_hash(self):
        (self.directory / "capture.json").write_text("changed")
        self.assertEqual(self.status(), "FAIL")

    def test_missing_file(self):
        (self.directory / "capture.json").unlink()
        self.assertEqual(self.status(), "FAIL")

    def test_path_escape(self):
        self.bundle["evidence"][0]["path"] = "../outside.json"
        self.assertEqual(self.status(), "FAIL")

    def test_replay_not_live_integration(self):
        self.bundle["mode"] = "fixture-replay"
        self.assertEqual(self.status(), "FAIL")

    def test_blocker_not_pass(self):
        self.bundle["execution"] = "BLOCKED"
        self.bundle["reason"] = "No implementation"
        self.assertEqual(self.status(), "BLOCKED")

    def test_root_resolution(self):
        self.assertEqual(evaluator.ROOT, ROOT)


if __name__ == "__main__":
    unittest.main()
