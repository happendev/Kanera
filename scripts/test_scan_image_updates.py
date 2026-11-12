"""Registry failures and stable-tag selection are deterministic scanner logic, not browser flows."""
import contextlib
import importlib.util
import io
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("scan_image_updates", Path(__file__).with_name("scan-image-updates.py"))
scan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scan)


class ImageUpdateTests(unittest.TestCase):
    # Registry outages must fail coverage instead of appearing current; candidate filtering
    # must never switch image flavour, major version, or nginx stable/mainline branches.
    # Browser E2E cannot exercise release-gate decisions: unchanged CVEs must pass,
    # absent upgrades must not scan, and a candidate removing a high CVE must fail.
    def test_latest_image_does_not_block_or_scan_existing_findings(self):
        with patch.object(scan, "collect_refs", return_value=["nginx:1.30.6-alpine"]), \
                patch.object(scan, "newest_candidate", return_value=None), \
                patch.object(scan, "vulns") as vulns, \
                patch.dict(os.environ, {"GITHUB_STEP_SUMMARY": ""}), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(scan.main(), 0)
            vulns.assert_not_called()

    def test_only_findings_removed_by_an_available_image_block(self):
        for candidate_findings, expected in [({"CVE-existing": "HIGH"}, 0), ({}, 1)]:
            with self.subTest(candidate_findings=candidate_findings), \
                    patch.object(scan, "collect_refs", return_value=["nginx:1.30.5-alpine"]), \
                    patch.object(scan, "newest_candidate", return_value="nginx:1.30.6-alpine"), \
                    patch.object(scan, "vulns", side_effect=[{"CVE-existing": "HIGH"}, candidate_findings]), \
                    patch.dict(os.environ, {"GITHUB_STEP_SUMMARY": ""}), \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(scan.main(), expected)

    def test_registry_failure_does_not_mean_already_newest(self):
        with patch.object(scan, "run", return_value=subprocess.CompletedProcess([], 1, "", "rate limited")):
            with self.assertRaisesRegex(RuntimeError, "could not list tags"):
                scan.newest_candidate("grafana/grafana:13.2.3")

    def test_candidate_keeps_stable_branch_and_flavour(self):
        tags = "1.30.5-alpine\n1.30.6-alpine\n1.31.9-alpine\n1.32.1-alpine\n1.32.2-bookworm\n2.0.0-alpine\n"
        with patch.object(scan, "run", return_value=subprocess.CompletedProcess([], 0, tags, "")):
            self.assertEqual(scan.newest_candidate("nginx:1.30.5-alpine"), "nginx:1.32.1-alpine")

    def test_failed_tag_listing_fails_run_and_marks_summary_incomplete(self):
        with tempfile.TemporaryDirectory() as tmp:
            summary = Path(tmp) / "summary"
            with patch.dict(os.environ, {"GITHUB_STEP_SUMMARY": str(summary)}), \
                    patch.object(scan, "collect_refs", return_value=["grafana/grafana:13.2.3"]), \
                    patch.object(scan, "newest_candidate", side_effect=RuntimeError("rate limited")), \
                    contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(scan.main(), 1)
            self.assertIn("Image scan incomplete", summary.read_text())
            self.assertNotIn("No pinned image", summary.read_text())


if __name__ == "__main__":
    unittest.main()
