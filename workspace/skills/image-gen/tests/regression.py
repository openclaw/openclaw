#!/usr/bin/env python3
"""
Regression test suite for image_gen.py

Tests:
  1. Key loading from workspace root .env
  2. Prompt builder — all 12 specs
  3. Prompt builder — minimal (prompt only)
  4. Prompt builder — empty specs
  5. Output path generation
  6. Aspect ratio validation
  7. Generate — text-to-image (simple prompt)
  8. Generate — missing prompt and images (error case)
  9. Generate — text-to-image with specs
  10. Generate — with aspect ratio
  11. Edit — missing session_id (error case)
  12. Edit — missing prompt (error case)
  13. List sessions — empty
  14. Unknown command (error case)
  15. Invalid JSON file (error case)
  16. Generate — JPEG output format
  17. Generate — WEBP output format
  18. Generate — quality model selection
  19. Generate — lifestyle scene with specs
  20. Generate — social media vertical format

Live API tests (7-11, 16-20) require GOOGLE_API_KEY.
"""

import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "image_gen.py"
OUTPUT_DIR = Path(__file__).resolve().parent.parent / "output" / "test"
PYTHON = sys.executable

# Fix Windows encoding and buffering
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stdout.reconfigure(line_buffering=True)

# Track results
results = []
total = 0
passed = 0
failed = 0
skipped = 0


def run_tool(request: dict, timeout: int = 120) -> dict:
    """Write request to temp file, run tool, return parsed JSON output."""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False, dir=str(OUTPUT_DIR)) as f:
        json.dump(request, f)
        f.flush()
        req_path = f.name

    try:
        result = subprocess.run(
            [PYTHON, str(SCRIPT), "--file", req_path],
            capture_output=True, text=True, timeout=timeout,
            cwd=str(Path(__file__).resolve().parent.parent.parent.parent)  # workspace root
        )
        stdout = result.stdout.strip()
        if stdout:
            return json.loads(stdout)
        else:
            return {"success": False, "error": f"No stdout. stderr: {result.stderr[:500]}"}
    except subprocess.TimeoutExpired:
        return {"success": False, "error": "Timeout"}
    except json.JSONDecodeError as e:
        return {"success": False, "error": f"Invalid JSON output: {e}. stdout: {result.stdout[:500]}"}
    finally:
        os.unlink(req_path)


def test(name: str, result: dict, expect_success: bool, extra_checks: dict = None):
    """Record test result."""
    global total, passed, failed
    total += 1
    ok = result.get("success") == expect_success

    if ok and extra_checks:
        for key, expected in extra_checks.items():
            actual = result.get(key)
            if expected is not None and actual != expected:
                ok = False
                break

    status = "✅ PASS" if ok else "❌ FAIL"
    if ok:
        passed += 1
    else:
        failed += 1

    # Truncate long error messages for display
    display = {k: (v[:100] + "..." if isinstance(v, str) and len(v) > 100 else v) for k, v in result.items()}
    print(f"  {status} [{total}] {name}")
    if not ok:
        print(f"         Expected success={expect_success}, got: {display}")
    results.append({"test": total, "name": name, "status": "PASS" if ok else "FAIL", "result": display})


def test_skip(name: str, reason: str):
    """Skip a test."""
    global total, skipped
    total += 1
    skipped += 1
    print(f"  ⏭️  SKIP [{total}] {name} — {reason}")
    results.append({"test": total, "name": name, "status": "SKIP", "reason": reason})


def verify_image(result: dict) -> bool:
    """Check that output image exists and has non-zero size."""
    if not result.get("success"):
        return False
    path = result.get("path")
    if not path or not Path(path).exists():
        return False
    return Path(path).stat().st_size > 0


# =====================================================================
# Setup
# =====================================================================
print("\n" + "=" * 60)
print("IMAGE-GEN SKILL — REGRESSION TEST SUITE")
print("=" * 60)

OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# Check if API key is available
sys.path.insert(0, str(SCRIPT.parent))
from image_gen import load_env, build_prompt, get_output_path, VALID_ASPECT_RATIOS

api_key = load_env()
has_api = api_key is not None
print(f"\nAPI Key: {'✅ Found' if has_api else '❌ Not found (live tests will be skipped)'}")
print(f"Output dir: {OUTPUT_DIR}\n")

# =====================================================================
# Unit Tests (no API needed)
# =====================================================================
print("--- UNIT TESTS (no API) ---\n")

# Test 1: Key loading
test("Load API key from workspace .env", {"success": has_api}, True)

# Test 2: Prompt builder — all 12 specs
req_full = {
    "prompt": "Professional studio shot",
    "specs": {
        "extraction": {"target_description": "red jar in center", "edge_treatment": "clean"},
        "fidelity": {"preserve_colors": "exact", "preserve_text": "all labels", "hero_features": "ribbed grip"},
        "background": {"treatment": "solid", "color": "white"},
        "lighting": {"type": "soft diffused", "direction": "upper-left", "shadows": "soft contact"},
        "composition": {"product_coverage": "75%", "camera_angle": "slightly elevated"},
        "scene": {"environment": "kitchen", "mood": "warm"},
        "placement": {"surface": "marble counter", "position": "center"},
        "material_treatment": {"primary_material": "PET plastic", "rendering_notes": "slight sheen"},
        "enhancement": {"sharpness": "high", "cleanup": "remove dust"},
        "focus": {"focus_point": "label", "depth_of_field": "shallow"},
        "custom_spec": {"instruction": "premium feel", "color_palette": "warm neutrals"},
        "output": {"format": "PNG", "aspect_ratio": "1:1", "filename": "test_hero"}
    }
}
prompt = build_prompt(req_full)
has_all = all(kw in prompt for kw in ["EXTRACTION", "FIDELITY", "BACKGROUND", "LIGHTING", "COMPOSITION",
                                        "SCENE", "PLACEMENT", "MATERIAL", "ENHANCEMENT", "FOCUS", "CREATIVE DIRECTION"])
test("Prompt builder — all 12 specs composed",
     {"success": has_all}, True)

# Test 3: Prompt builder — minimal
prompt_min = build_prompt({"prompt": "A cute cat"})
test("Prompt builder — minimal (prompt only)",
     {"success": prompt_min == "A cute cat"}, True)

# Test 4: Prompt builder — empty
prompt_empty = build_prompt({})
test("Prompt builder — empty request",
     {"success": prompt_empty == ""}, True)

# Test 5: Output path generation
out_path = get_output_path({"specs": {"output": {"filename": "test_file", "format": "JPEG"}},
                            "output_dir": str(OUTPUT_DIR)})
test("Output path generation",
     {"success": str(out_path).endswith("test_file.jpg")}, True)

# Test 6: Aspect ratio validation
all_valid = all(r in VALID_ASPECT_RATIOS for r in ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"])
test("All 10 aspect ratios valid",
     {"success": all_valid and len(VALID_ASPECT_RATIOS) == 10}, True)

# =====================================================================
# Integration Tests (API required)
# =====================================================================
print("\n--- INTEGRATION TESTS (API required) ---\n")

# Test 7: Generate — simple text-to-image
if has_api:
    r = run_tool({
        "command": "generate",
        "prompt": "A simple red circle on a white background",
        "specs": {"output": {"format": "PNG", "aspect_ratio": "1:1", "filename": "test_simple"}},
        "output_dir": str(OUTPUT_DIR)
    })
    test("Generate — simple text-to-image", r, True)
    if r.get("success"):
        img_ok = verify_image(r)
        test("Generate — output file exists and non-empty", {"success": img_ok}, True)
    else:
        test_skip("Generate — output file exists and non-empty", "generation failed")
else:
    test_skip("Generate — simple text-to-image", "no API key")
    test_skip("Generate — output file exists and non-empty", "no API key")

# Test 9: Generate — with full specs
if has_api:
    r = run_tool({
        "command": "generate",
        "prompt": "A professional product photo of a glass water bottle on a marble surface, soft studio lighting",
        "specs": {
            "background": {"treatment": "solid", "color": "light grey"},
            "lighting": {"type": "soft diffused", "direction": "upper-left at 45 degrees"},
            "composition": {"product_coverage": "70%", "camera_angle": "slightly elevated"},
            "enhancement": {"sharpness": "high", "contrast": "moderate"},
            "focus": {"focus_point": "bottle label", "depth_of_field": "moderate"},
            "output": {"format": "PNG", "aspect_ratio": "1:1", "filename": "test_specs"}
        },
        "output_dir": str(OUTPUT_DIR)
    })
    test("Generate — text-to-image with full specs", r, True)
else:
    test_skip("Generate — text-to-image with full specs", "no API key")

# Test 10: Generate — 16:9 aspect ratio
if has_api:
    r = run_tool({
        "command": "generate",
        "prompt": "A wide panoramic sunset over mountains, orange and purple sky",
        "specs": {"output": {"format": "JPEG", "aspect_ratio": "16:9", "filename": "test_wide"}},
        "output_dir": str(OUTPUT_DIR)
    })
    test("Generate — 16:9 landscape aspect ratio", r, True)
    if r.get("success") and r.get("width") and r.get("height"):
        is_wide = r["width"] > r["height"]
        test("Generate — 16:9 output is wider than tall", {"success": is_wide}, True)
    else:
        test_skip("Generate — 16:9 output is wider than tall", "no dimensions")
else:
    test_skip("Generate — 16:9 landscape aspect ratio", "no API key")
    test_skip("Generate — 16:9 output is wider than tall", "no API key")

# Test: Error cases (no API needed for these since they fail before API call)

# Test: Missing prompt AND images
r = run_tool({"command": "generate"})
test("Generate — missing prompt and images (error)", r, False)

# Test: Edit — missing session_id
r = run_tool({"command": "edit", "prompt": "make it blue"})
test("Edit — missing session_id (error)", r, False)

# Test: Edit — missing prompt
r = run_tool({"command": "edit", "session_id": "test"})
# This will hit API without prompt — should fail
test("Edit — missing prompt (error)", r, False)

# Test: List sessions
r = run_tool({"command": "list_sessions"})
test("List sessions — returns success", r, True)

# Test: Unknown command
r = run_tool({"command": "foobar"})
test("Unknown command (error)", r, False)

# Test 16: JPEG format
if has_api:
    r = run_tool({
        "command": "generate",
        "prompt": "A bright yellow sunflower against a blue sky",
        "specs": {"output": {"format": "JPEG", "aspect_ratio": "1:1", "filename": "test_jpeg"}},
        "output_dir": str(OUTPUT_DIR)
    })
    test("Generate — JPEG output format", r, True)
    if r.get("success"):
        test("Generate — JPEG file extension", {"success": r.get("path", "").endswith(".jpg")}, True)
    else:
        test_skip("Generate — JPEG file extension", "generation failed")
else:
    test_skip("Generate — JPEG output format", "no API key")
    test_skip("Generate — JPEG file extension", "no API key")

# Test 17: WEBP format
if has_api:
    r = run_tool({
        "command": "generate",
        "prompt": "A minimalist logo design with the letter P in blue",
        "specs": {"output": {"format": "WEBP", "aspect_ratio": "1:1", "filename": "test_webp"}},
        "output_dir": str(OUTPUT_DIR)
    })
    test("Generate — WEBP output format", r, True)
    if r.get("success"):
        test("Generate — WEBP file extension", {"success": r.get("path", "").endswith(".webp")}, True)
    else:
        test_skip("Generate — WEBP file extension", "generation failed")
else:
    test_skip("Generate — WEBP output format", "no API key")
    test_skip("Generate — WEBP file extension", "no API key")

# Test 19: Lifestyle scene
if has_api:
    r = run_tool({
        "command": "generate",
        "prompt": "A cozy kitchen scene with a ceramic coffee mug on a wooden table, morning sunlight streaming through window, steam rising from the mug",
        "specs": {
            "scene": {"environment": "rustic kitchen", "mood": "warm and cozy", "time_of_day": "morning"},
            "lighting": {"type": "natural window light", "color_temperature": "warm golden"},
            "focus": {"focus_point": "mug", "depth_of_field": "shallow with bokeh background"},
            "output": {"format": "JPEG", "aspect_ratio": "4:3", "filename": "test_lifestyle"}
        },
        "output_dir": str(OUTPUT_DIR)
    })
    test("Generate — lifestyle scene with specs", r, True)
else:
    test_skip("Generate — lifestyle scene with specs", "no API key")

# Test 20: Social media vertical
if has_api:
    r = run_tool({
        "command": "generate",
        "prompt": "A bold, eye-catching product showcase image. A sleek water bottle centered against a vibrant gradient background from deep blue to teal. Modern and premium design feel.",
        "specs": {
            "background": {"treatment": "gradient", "scene_description": "deep blue to teal gradient"},
            "composition": {"product_coverage": "50%", "position": "center", "negative_space": "top 30% for text"},
            "output": {"format": "JPEG", "aspect_ratio": "9:16", "filename": "test_vertical"}
        },
        "output_dir": str(OUTPUT_DIR)
    })
    test("Generate — social media 9:16 vertical", r, True)
    if r.get("success") and r.get("width") and r.get("height"):
        is_tall = r["height"] > r["width"]
        test("Generate — 9:16 output is taller than wide", {"success": is_tall}, True)
    else:
        test_skip("Generate — 9:16 output is taller than wide", "no dimensions")
else:
    test_skip("Generate — social media 9:16 vertical", "no API key")
    test_skip("Generate — 9:16 output is taller than wide", "no API key")

# =====================================================================
# Summary
# =====================================================================
print("\n" + "=" * 60)
print(f"RESULTS: {passed} passed / {failed} failed / {skipped} skipped / {total} total")
if failed == 0:
    print("🎉 ALL TESTS PASSED!")
else:
    print(f"⚠️  {failed} TESTS FAILED")
print("=" * 60 + "\n")

# Write results to file
results_path = OUTPUT_DIR / "regression_results.json"
with open(results_path, "w") as f:
    json.dump({"passed": passed, "failed": failed, "skipped": skipped, "total": total, "tests": results}, f, indent=2)
print(f"Results saved to: {results_path}")

sys.exit(0 if failed == 0 else 1)
