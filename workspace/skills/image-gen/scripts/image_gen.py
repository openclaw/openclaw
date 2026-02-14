#!/usr/bin/env python3
"""
image_gen.py — Atomic image generation tool using Google Gemini.

Interface: python image_gen.py --file request.json
Output:    JSON to stdout (success/error + metadata)

Supports:
  - generate: Create/transform images from text prompts + reference images
  - edit:     Iterative editing via chat sessions (multi-turn)

Requires: GEMINI_API_KEY env var or .env file in skill directory.
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------
try:
    from google import genai
    from google.genai import types
except ImportError:
    print(json.dumps({"success": False, "error": "google-genai not installed. Run: pip install google-genai"}))
    sys.exit(1)

try:
    from PIL import Image
except ImportError:
    print(json.dumps({"success": False, "error": "Pillow not installed. Run: pip install Pillow"}))
    sys.exit(1)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
SKILL_DIR = Path(__file__).resolve().parent.parent
DEFAULT_MODEL = "gemini-2.0-flash-exp"  # Fast, free-tier friendly
QUALITY_MODEL = "gemini-2.0-flash-exp"  # Same for now; swap when pro-image is GA
# When available:
# DEFAULT_MODEL = "gemini-2.5-flash-preview-04-17"  # or latest flash-image
# QUALITY_MODEL = "gemini-2.0-flash-exp"  # or gemini-3-pro-image-preview

MAX_INPUT_DIM = 2048  # Max dimension for input images (resize if larger)
CHAT_DIR = SKILL_DIR / "sessions"  # Chat session storage

VALID_ASPECT_RATIOS = ["1:1", "3:4", "4:3", "9:16", "16:9"]
VALID_OUTPUT_FORMATS = ["PNG", "JPEG", "WEBP"]

# System prompt for Gemini — photography expert execution context
SYSTEM_PROMPT = """You are a professional product photography and image generation expert.

ROLES OF LABELED IMAGES:
- [source] / [product]: THE ACTUAL PRODUCT — your output must faithfully represent this exact item
- [style_ref]: Reference for mood, lighting, atmosphere — match the FEEL, not the content
- [background]: Scene or backdrop reference — use as environmental context

CORE PRINCIPLES:
1. IDENTITY PRESERVATION: When a source/product image is provided, the output must be recognizably the SAME product. Preserve colors, text, logos, shape, proportions, and material characteristics exactly.
2. PHOTOGRAPHY QUALITY: Output should look like it was shot in a professional studio. Sharp focus, proper exposure, natural shadows, realistic material rendering.
3. MATERIAL PHYSICS: Render materials accurately — glass should be transparent with reflections, metal should have proper specular highlights, matte surfaces should absorb light naturally.
4. GROUNDING: Products must look physically present in their scene — contact shadows, proper perspective, consistent lighting direction.
5. CREATIVE ENHANCEMENT: Fix photography problems (bad lighting, cluttered backgrounds, color casts) while NEVER altering the product itself.

When given a text-only prompt (no source image), generate the described image with the same professional quality standards."""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def load_env():
    """Load API key from env or .env file."""
    key = os.environ.get("GEMINI_API_KEY")
    if key:
        return key
    env_file = SKILL_DIR / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if line.startswith("GEMINI_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


def load_image(path_str: str) -> Image.Image:
    """Load an image from a local path, resizing if needed."""
    p = Path(path_str)
    if not p.exists():
        raise FileNotFoundError(f"Image not found: {path_str}")
    img = Image.open(p)
    # Convert to RGB if needed (handles RGBA, P mode, etc.)
    if img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGB")
    # Resize if too large
    w, h = img.size
    if max(w, h) > MAX_INPUT_DIM:
        ratio = MAX_INPUT_DIM / max(w, h)
        img = img.resize((int(w * ratio), int(h * ratio)), Image.LANCZOS)
    return img


def build_prompt(req: dict) -> str:
    """
    Compose a rich plain-text prompt from the request.

    Takes the user's 'prompt' field and optional 'specs' dict,
    weaving them into a natural language prompt that Gemini responds best to.
    """
    parts = []

    # Main prompt/instruction
    prompt = req.get("prompt", "").strip()
    if prompt:
        parts.append(prompt)

    # Compose specs into natural language
    specs = req.get("specs", {})
    if not specs:
        return "\n\n".join(parts) if parts else ""

    spec_lines = []

    if "extraction" in specs:
        s = specs["extraction"]
        desc = s.get("target_description", "")
        if desc:
            spec_lines.append(f"EXTRACTION: Isolate and extract {desc}.")
        if s.get("isolation"):
            spec_lines.append(f"Isolation method: {s['isolation']}.")
        if s.get("edge_treatment"):
            spec_lines.append(f"Edge treatment: {s['edge_treatment']}.")
        if s.get("targets"):
            for i, t in enumerate(s["targets"]):
                bbox = t.get("bbox", "")
                lbl = t.get("image_label", "source")
                spec_lines.append(f"Target {i+1}: region {bbox} in [{lbl}].")

    if "fidelity" in specs:
        s = specs["fidelity"]
        preserves = []
        for field in ["preserve_colors", "preserve_artwork", "preserve_text",
                       "preserve_texture", "preserve_shape"]:
            if s.get(field):
                preserves.append(f"{field.replace('preserve_', '')}: {s[field]}")
        if preserves:
            spec_lines.append(f"FIDELITY — Preserve: {'; '.join(preserves)}.")
        if s.get("hero_features"):
            spec_lines.append(f"Hero features to emphasize: {s['hero_features']}.")

    if "background" in specs:
        s = specs["background"]
        treatment = s.get("treatment", "")
        if treatment:
            spec_lines.append(f"BACKGROUND: {treatment}.")
        if s.get("color"):
            spec_lines.append(f"Background color: {s['color']}.")
        if s.get("scene_description"):
            spec_lines.append(f"Background scene: {s['scene_description']}.")

    if "lighting" in specs:
        s = specs["lighting"]
        desc_parts = []
        for field in ["type", "direction", "quality", "color_temperature"]:
            if s.get(field):
                desc_parts.append(f"{field}: {s[field]}")
        if desc_parts:
            spec_lines.append(f"LIGHTING: {', '.join(desc_parts)}.")
        if s.get("shadows"):
            spec_lines.append(f"Shadows: {s['shadows']}.")
        if s.get("special_requirements"):
            spec_lines.append(f"Lighting notes: {s['special_requirements']}.")

    if "composition" in specs:
        s = specs["composition"]
        desc_parts = []
        for field in ["product_coverage", "position", "camera_angle", "negative_space"]:
            if s.get(field):
                desc_parts.append(f"{field.replace('_', ' ')}: {s[field]}")
        if desc_parts:
            spec_lines.append(f"COMPOSITION: {', '.join(desc_parts)}.")
        if s.get("crop_instruction"):
            spec_lines.append(f"Crop: {s['crop_instruction']}.")

    if "scene" in specs:
        s = specs["scene"]
        desc_parts = []
        for field in ["environment", "style", "mood", "time_of_day"]:
            if s.get(field):
                desc_parts.append(f"{field.replace('_', ' ')}: {s[field]}")
        if desc_parts:
            spec_lines.append(f"SCENE: {', '.join(desc_parts)}.")
        if s.get("props_and_context"):
            spec_lines.append(f"Props/context: {s['props_and_context']}.")

    if "placement" in specs:
        s = specs["placement"]
        desc_parts = []
        for field in ["position", "scale", "surface", "interaction"]:
            if s.get(field):
                desc_parts.append(f"{field}: {s[field]}")
        if desc_parts:
            spec_lines.append(f"PLACEMENT: {', '.join(desc_parts)}.")

    if "material_treatment" in specs:
        s = specs["material_treatment"]
        if s.get("primary_material"):
            spec_lines.append(f"MATERIAL: {s['primary_material']}.")
        if s.get("rendering_notes"):
            spec_lines.append(f"Material rendering: {s['rendering_notes']}.")
        if s.get("preserve_details"):
            spec_lines.append(f"Preserve material details: {s['preserve_details']}.")

    if "enhancement" in specs:
        s = specs["enhancement"]
        desc_parts = []
        for field in ["sharpness", "contrast", "color_treatment", "detail_enhancement", "cleanup"]:
            if s.get(field):
                desc_parts.append(f"{field.replace('_', ' ')}: {s[field]}")
        if desc_parts:
            spec_lines.append(f"ENHANCEMENT: {', '.join(desc_parts)}.")

    if "focus" in specs:
        s = specs["focus"]
        desc_parts = []
        for field in ["focus_point", "depth_of_field", "falloff"]:
            if s.get(field):
                desc_parts.append(f"{field.replace('_', ' ')}: {s[field]}")
        if desc_parts:
            spec_lines.append(f"FOCUS: {', '.join(desc_parts)}.")

    if "custom_spec" in specs:
        s = specs["custom_spec"]
        if s.get("instruction"):
            spec_lines.append(f"CREATIVE DIRECTION: {s['instruction']}.")
        for field in ["style_reference", "color_palette", "texture_overlay",
                       "special_effect", "artistic_intent"]:
            if s.get(field):
                spec_lines.append(f"{field.replace('_', ' ').title()}: {s[field]}.")
        if s.get("extra"):
            for k, v in s["extra"].items():
                spec_lines.append(f"{k}: {v}.")

    # Output specs are handled separately (aspect_ratio, size go to config)
    # but include filename hint in prompt if present
    if "output" in specs and specs["output"].get("filename"):
        pass  # filename is handled by the caller, not in the prompt

    if spec_lines:
        parts.append("SPECIFICATIONS:\n" + "\n".join(spec_lines))

    return "\n\n".join(parts)


def get_output_config(specs: dict) -> dict:
    """Extract GenerateContentConfig params from output spec."""
    output = specs.get("output", {})
    config = {}

    aspect_ratio = output.get("aspect_ratio", "1:1")
    if aspect_ratio in VALID_ASPECT_RATIOS:
        config["aspect_ratio"] = aspect_ratio

    # Image size (resolution) — only for pro model
    size = output.get("size", "")
    if size in ("1K", "2K", "4K"):
        config["image_size"] = size

    return config


def get_output_path(req: dict) -> Path:
    """Determine output file path."""
    output_dir = Path(req.get("output_dir", str(SKILL_DIR / "output")))
    output_dir.mkdir(parents=True, exist_ok=True)

    specs = req.get("specs", {})
    output = specs.get("output", {})

    filename = output.get("filename", f"gen_{int(time.time())}")
    fmt = output.get("format", "PNG").upper()
    if fmt not in VALID_OUTPUT_FORMATS:
        fmt = "PNG"

    ext = {"PNG": ".png", "JPEG": ".jpg", "WEBP": ".webp"}[fmt]
    return output_dir / f"{filename}{ext}"


def save_image(img: Image.Image, path: Path, fmt: str = "PNG") -> dict:
    """Save PIL image and return metadata."""
    fmt = fmt.upper()
    if fmt not in VALID_OUTPUT_FORMATS:
        fmt = "PNG"

    save_kwargs = {}
    if fmt == "JPEG":
        save_kwargs["quality"] = 95
        # JPEG doesn't support alpha
        if img.mode == "RGBA":
            img = img.convert("RGB")
    elif fmt == "WEBP":
        save_kwargs["quality"] = 95

    img.save(str(path), format=fmt, **save_kwargs)

    return {
        "path": str(path),
        "width": img.size[0],
        "height": img.size[1],
        "format": fmt,
        "size_bytes": path.stat().st_size,
    }


# ---------------------------------------------------------------------------
# Chat Session Management (for iterative editing)
# ---------------------------------------------------------------------------
def get_session_path(session_id: str) -> Path:
    """Get path to a chat session file."""
    CHAT_DIR.mkdir(parents=True, exist_ok=True)
    return CHAT_DIR / f"{session_id}.json"


def load_session(session_id: str) -> dict | None:
    """Load a saved chat session."""
    p = get_session_path(session_id)
    if p.exists():
        return json.loads(p.read_text())
    return None


def save_session(session_id: str, data: dict):
    """Save chat session state."""
    p = get_session_path(session_id)
    p.write_text(json.dumps(data, indent=2))


# ---------------------------------------------------------------------------
# Core Operations
# ---------------------------------------------------------------------------
def do_generate(client: genai.Client, req: dict) -> dict:
    """
    Generate an image from prompt + optional reference images.

    Request fields:
      - prompt (str): Natural language description of what to create/transform
      - images (list): Optional labeled images [{path, label}]
      - specs (dict): Optional structured specs (12 types)
      - model (str): Optional model override
      - output_dir (str): Optional output directory
    """
    # Build the text prompt
    text_prompt = build_prompt(req)
    if not text_prompt and not req.get("images"):
        return {"success": False, "error": "Need at least a prompt or input images."}

    # Build content parts
    contents = []

    # Add labeled images
    images = req.get("images", [])
    for img_spec in images:
        label = img_spec.get("label", "source")
        img_path = img_spec.get("path", "")
        if not img_path:
            continue
        try:
            pil_img = load_image(img_path)
            contents.append(f"[{label}] image:")
            contents.append(pil_img)
        except Exception as e:
            return {"success": False, "error": f"Failed to load image '{img_path}': {e}"}

    # Add text prompt
    if text_prompt:
        contents.append(text_prompt)

    if not contents:
        return {"success": False, "error": "No content to send (empty prompt and no images)."}

    # Config
    specs = req.get("specs", {})
    output_config = get_output_config(specs)
    model = req.get("model", DEFAULT_MODEL)

    config = types.GenerateContentConfig(
        response_modalities=["TEXT", "IMAGE"],
        system_instruction=SYSTEM_PROMPT,
    )

    # Add image config if we have output specs
    if output_config:
        config.image_config = types.ImageConfig(**output_config)

    # Call Gemini
    try:
        response = client.models.generate_content(
            model=model,
            contents=contents,
            config=config,
        )
    except Exception as e:
        return {"success": False, "error": f"Gemini API error: {e}"}

    # Extract image from response
    if not response.candidates or not response.candidates[0].content.parts:
        text = getattr(response, 'text', '')
        return {"success": False, "error": f"No image in response. Model said: {text or '(empty)'}"}

    output_path = get_output_path(req)
    fmt = specs.get("output", {}).get("format", "PNG").upper()
    if fmt not in VALID_OUTPUT_FORMATS:
        fmt = "PNG"

    result_image = None
    model_text = ""

    for part in response.candidates[0].content.parts:
        if hasattr(part, 'inline_data') and part.inline_data and part.inline_data.mime_type.startswith("image/"):
            result_image = part.as_image()
        elif hasattr(part, 'text') and part.text:
            model_text += part.text

    if result_image is None:
        return {"success": False, "error": f"No image generated. Model said: {model_text or '(empty)'}"}

    # Save
    metadata = save_image(result_image, output_path, fmt)
    result = {"success": True, **metadata}
    if model_text:
        result["model_notes"] = model_text.strip()

    return result


def do_edit(client: genai.Client, req: dict) -> dict:
    """
    Edit an existing image via chat session (multi-turn).

    Request fields:
      - session_id (str): Chat session identifier (creates new if doesn't exist)
      - prompt (str): Edit instruction
      - images (list): Optional new reference images to add
      - specs (dict): Optional structured specs
      - model (str): Optional model override
      - output_dir (str): Optional output directory
    """
    session_id = req.get("session_id", "")
    if not session_id:
        return {"success": False, "error": "session_id required for edit command."}

    text_prompt = build_prompt(req)
    if not text_prompt:
        return {"success": False, "error": "prompt required for edit command."}

    model = req.get("model", DEFAULT_MODEL)
    specs = req.get("specs", {})
    output_config = get_output_config(specs)

    config = types.GenerateContentConfig(
        response_modalities=["TEXT", "IMAGE"],
        system_instruction=SYSTEM_PROMPT,
    )
    if output_config:
        config.image_config = types.ImageConfig(**output_config)

    # Build message contents
    contents = []

    # Add any new reference images
    images = req.get("images", [])
    for img_spec in images:
        label = img_spec.get("label", "source")
        img_path = img_spec.get("path", "")
        if not img_path:
            continue
        try:
            pil_img = load_image(img_path)
            contents.append(f"[{label}] image:")
            contents.append(pil_img)
        except Exception as e:
            return {"success": False, "error": f"Failed to load image '{img_path}': {e}"}

    contents.append(text_prompt)

    # Use chat for multi-turn
    # Note: google-genai chat doesn't persist across process calls,
    # so for true multi-turn we'd need to replay history.
    # For now, each "edit" is a new call but with the previous output as input.
    session = load_session(session_id)

    if session and session.get("last_output_path"):
        # Load previous output as context
        prev_path = session["last_output_path"]
        try:
            prev_img = load_image(prev_path)
            contents = [f"[previous_output] Here is the current image:", prev_img] + contents
        except Exception:
            pass  # If previous output is gone, just proceed without it

    try:
        response = client.models.generate_content(
            model=model,
            contents=contents,
            config=config,
        )
    except Exception as e:
        return {"success": False, "error": f"Gemini API error: {e}"}

    # Extract image
    if not response.candidates or not response.candidates[0].content.parts:
        text = getattr(response, 'text', '')
        return {"success": False, "error": f"No image in response. Model said: {text or '(empty)'}"}

    output_path = get_output_path(req)
    fmt = specs.get("output", {}).get("format", "PNG").upper()
    if fmt not in VALID_OUTPUT_FORMATS:
        fmt = "PNG"

    result_image = None
    model_text = ""

    for part in response.candidates[0].content.parts:
        if hasattr(part, 'inline_data') and part.inline_data and part.inline_data.mime_type.startswith("image/"):
            result_image = part.as_image()
        elif hasattr(part, 'text') and part.text:
            model_text += part.text

    if result_image is None:
        return {"success": False, "error": f"No image generated. Model said: {model_text or '(empty)'}"}

    metadata = save_image(result_image, output_path, fmt)

    # Save session state
    turn = (session.get("turn", 0) if session else 0) + 1
    save_session(session_id, {
        "session_id": session_id,
        "model": model,
        "turn": turn,
        "last_output_path": str(output_path),
        "last_prompt": text_prompt[:500],
    })

    result = {"success": True, "session_id": session_id, "turn": turn, **metadata}
    if model_text:
        result["model_notes"] = model_text.strip()

    return result


def do_list_sessions(req: dict) -> dict:
    """List active chat sessions."""
    CHAT_DIR.mkdir(parents=True, exist_ok=True)
    sessions = []
    for f in CHAT_DIR.glob("*.json"):
        try:
            data = json.loads(f.read_text())
            sessions.append({
                "session_id": data.get("session_id", f.stem),
                "turn": data.get("turn", 0),
                "last_prompt": data.get("last_prompt", ""),
            })
        except Exception:
            pass
    return {"success": True, "sessions": sessions}


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(description="Gemini Image Generation Tool")
    parser.add_argument("--file", required=True, help="Path to JSON request file")
    args = parser.parse_args()

    # Load request
    req_path = Path(args.file)
    if not req_path.exists():
        print(json.dumps({"success": False, "error": f"Request file not found: {args.file}"}))
        sys.exit(1)

    try:
        req = json.loads(req_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        print(json.dumps({"success": False, "error": f"Invalid JSON: {e}"}))
        sys.exit(1)

    command = req.get("command", "generate")

    # List sessions doesn't need API key
    if command == "list_sessions":
        print(json.dumps(do_list_sessions(req), indent=2))
        return

    # Load API key
    api_key = load_env()
    if not api_key:
        print(json.dumps({
            "success": False,
            "error": "GEMINI_API_KEY not found. Set it as env var or in skills/image-gen/.env"
        }))
        sys.exit(1)

    # Create client
    client = genai.Client(api_key=api_key)

    # Dispatch
    if command == "generate":
        result = do_generate(client, req)
    elif command == "edit":
        result = do_edit(client, req)
    else:
        result = {"success": False, "error": f"Unknown command: {command}. Use: generate, edit, list_sessions"}

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
